// The turn loop (AGENT-SPEC section 4): code prefilter, curated context, a
// tool turn, a run turn, then the post step that turns the model's last text
// into an answer the UI can show.
//
// Provider-neutral by construction (section 7): tool arguments are untrusted
// text, every failure goes BACK to the model as text rather than throwing, and
// a turn cap ends every path. Nothing here imports Tauri or a store at runtime;
// the app supplies AgentTools and a Provider, the eval harness supplies its own
// (EVAL.md section 3), and both run this same file.

import {
  PEEK_MAX,
  PROBE_MAX,
  PROSE_STRIKES,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  isProseRefusal,
  type AgentTools,
} from "./tools";
import type { Tier } from "./providers/registry";
import type {
  AgentEvent,
  Msg,
  Provider,
  StopReason,
  ToolCall,
  ToolResult,
} from "./providers/types";
import type {
  AgentRun,
  Assumption,
  SanityFragment,
  TokenUsage,
  ToolName,
  TraceStep,
  Verdict,
} from "./types";
import type { SchemaSnapshot } from "../stores/schema";
import { buildMeta, candidates, indexFor, mustIncludeFor, recallOf } from "./context";
import { type Mention, mentionContext, mentionTags } from "./mentions";
import { isRisky } from "./risk";
import { probeNoun } from "./probeNoun";
import {
  PROMPT_VERSION,
  SMALL_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  askMessage,
  repairMessage,
  smallAskMessage,
  writesMessage,
} from "./prompt";
import { buildAssumptions, extractSql } from "./extract";
import { answerText } from "./display";

/** Thread-level cap (AGENT-SPEC section 4.5). `claude -p` takes a per
 * invocation `--max-turns`, so the thread total is subtracted there. */
export const MAX_TURNS = 12;

/** Repairs the small tier gets after its one shot (section 4.7). */
export const SMALL_REPAIRS = 2;

/** The turn cap's own sentence (AGENT-UX 7, LESSONS 13). `turns` is the
 * number the USER watched: an `ownsLoop` provider reports its child's own
 * `num_turns` and this loop's counter is used only where there is no child.
 * The bug the lesson is written from is that counter reaching the sentence:
 * `stopped after 1 turns` for a run that spent twelve. Singular at one,
 * because a plural on a 1 reads as a placeholder nobody filled in. */
export const turnCapMessage = (turns: number): string =>
  `stopped after ${turns} ${turns === 1 ? "turn" : "turns"}`;

/** The two sentences a refused change gets (A4, AGENT-UX 7 and 13.7). Error
 * register: lowercase lead, no period. They differ because the ways out
 * differ: a connection with edits off has a switch to offer, production has
 * none, and offering one there would be a dead end (LESSONS 9). */
export const WRITES_OFF = "edits are off for this connection";
export const WRITES_OFF_PROD = "edits are off on production";

export type AskPhase = "context" | "thinking" | "tools" | "running" | "post" | "done";

/** The five ways an Ask ends badly. Each maps to an affordance in AGENT-UX 7,
 * so a new kind means a new affordance, not a new message: `writesoff` (A4)
 * is the model proposing a change on a connection whose edits are off, where
 * nothing ran and the way out is Settings, never Fix It. */
export type AskErrorKind = "provider" | "sql" | "turncap" | "cancelled" | "writesoff";

export type AskEvent =
  | { type: "status"; phase: AskPhase }
  | { type: "toolStart"; id: string; name: ToolName; label: string; args: string }
  | {
      type: "toolEnd";
      id: string;
      name: ToolName;
      ms: number;
      isError: boolean;
      /** the call's arguments and result text, so a finished chip can open in
       * the trace drawer before the answer lands */
      args: string;
      result: string;
    }
  | { type: "text"; delta: string }
  | {
      /** the text block a tool call just ended: pre-tool narration, trace
       * material and never answer text (AGENT-UX 2.3). The answer slot starts
       * over; the block stays in the turn's raw text for the trace. */
      type: "narration";
      text: string;
    }
  | { type: "thinking"; delta: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "answer"; answer: AskAnswer }
  | {
      type: "error";
      kind: AskErrorKind;
      message: string;
      /** a rate-limited provider stated a wait (AGENT-UX 7) */
      retryAfterMs?: number;
    };

export interface AskAnswer {
  verdict: Verdict;
  sql: string | null;
  /** the rows the grid shows; null when nothing ran */
  run: AgentRun | null;
  assumptions: Assumption[];
  sanity: SanityFragment[];
  trace: TraceStep[];
  /** the model's LAST text block: what the answer slot shows, streamed
   * already but kept for persistence. Earlier blocks of the same turn (the
   * narration before a tool call) live only in the trace's turn rows. */
  text: string;
  turns: number;
  ms: number;
  usage: TokenUsage;
  promptVersion: string;
  /** what the prefilter chose, and whether it contained the gold tables when
   * a bench question supplied them (EVAL.md section 1) */
  candidates: string[];
  recall: boolean | null;
  risky: boolean;
}

export interface AskRequest {
  question: string;
  snapshot: SchemaSnapshot;
  tools: AgentTools;
  provider: Provider;
  model: string;
  tier: Tier;
  signal: AbortSignal;
  onEvent?: (ev: AskEvent) => void;
  /** thread continuity for `ownsLoop` providers; stateless ones ignore it.
   * `session` is the provider session to open or resume (the thread id until
   * a cut re-mints it); `replay` is the compact transcript of the exchanges a
   * cut KEPT, prefixed to this run's user message so the first call after a
   * cut starts from a session that remembers nothing. Never in the system
   * prompt: PROMPT_VERSION and the eval's prompt bytes must not move. */
  thread?: { id: string; session?: string; firstCall: boolean; replay?: string };
  /** what the user tagged with `@`, already resolved by the caller against
   * the connection it belongs to (W6). The tagged tables lead the candidate
   * block and every tag is spelled out under it; the question itself is sent
   * with its `@` tokens exactly as typed. Absent on the eval path, where the
   * message must stay byte-identical to the measured one. */
  mentions?: Mention[];
  /** A4 item 7: the row `Ask to Edit` attached, as `column = value` lines
   * under a line naming the table and the primary key. It rides in the SAME
   * `TAGGED BY THE USER:` block the `@` tags use, under them: it is one more
   * thing the user pointed at, and a second header would be a second grammar
   * for one idea (DESIGN rule 15). Absent on the eval path. */
  rowContext?: string;
  /** what the connection allows the model to propose (A4). Absent on the
   * eval path and nowhere else: the app passes it for every run, edits on or
   * off, because the loop's job when they are off is to REFUSE a write the
   * model wrote rather than hand it to a tool that would refuse it in the
   * gate's words (AGENT-SPEC 8.9). */
  writes?: WriteMode;
  /** injectable clock so the harness can be deterministic */
  now?: () => number;
  maxTurns?: number;
  /** bench only: gold SQL, so the answer can carry prefilter recall */
  goldSql?: string | null;
}

/** A4: the connection's edits permission, resolved by the caller before its
 * first await (LESSONS 3), and the gate that reads the statement. */
export interface WriteMode {
  /** the connection's switch, already resolved against production, where the
   * switch has no row at all (AGENT-UX 13.1) */
  on: boolean;
  /** the connection is production: the refusal names it and offers no
   * Settings, because there is none to offer there */
  prod?: boolean;
  /** the write gate (Rust, a pure AST call with no session): is this exactly
   * ONE INSERT / UPDATE / DELETE (AGENT-SPEC 8.7)? Anything else, a SELECT
   * and a pair of statements alike, is false and takes the read path it
   * always took, where the read gate answers it in its own words. */
  isWrite: (sql: string) => Promise<boolean>;
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/** Reject as soon as the signal aborts, and always drop the listener: an Ask
 * that ran to completion must not leave a handler on a long-lived controller. */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Cancelled();
  let onAbort: (() => void) | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

const firstLine = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0].trim() || "unknown error";
};

/** A4: which sentence a refused change gets. Production has no switch to
 * point at, so it never offers one (AGENT-UX 13.7, LESSONS 9). */
const writeRefusal = (w: WriteMode): string => (w.prod ? WRITES_OFF_PROD : WRITES_OFF);

/** The `TAGGED BY THE USER:` block's lines: what the `@` tags resolved to,
 * and then the row Record View attached (A4 item 7). One block, because both
 * are the same fact (the user pointed at this), and an empty result keeps the
 * header off the message entirely. */
const taggedContext = (mentions: readonly Mention[], row?: string): string =>
  [mentionContext(mentions), (row ?? "").trim()].filter(Boolean).join("\n");

/** Whitespace-insensitive statement identity. Case is preserved on purpose:
 * `'Paid'` and `'paid'` are different queries. */
const sameSql = (a: string, b: string) =>
  a.trim().replace(/;+$/, "").replace(/\s+/g, " ") ===
  b.trim().replace(/;+$/, "").replace(/\s+/g, " ");

// ---- tool dispatch ---------------------------------------------------------

const isName = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim())
    ? (v as string[])
    : null;

/** The chip the thinking strip shows while this call runs (AGENT-UX 2):
 * status register, lowercase, the object named. */
function chipLabel(name: ToolName, args: Record<string, unknown>): string {
  switch (name) {
    case "list_tables":
      return "tables";
    case "describe_tables": {
      const names = strings(args.names) ?? [];
      const extra = names.length > 1 ? ` +${names.length - 1}` : "";
      return `describe ${names[0] ?? ""}${extra}`.trim();
    }
    case "peek_values":
      return `peek ${typeof args.column === "string" ? args.column : ""}`.trim();
    case "run_sql":
      return "run";
    case "probe": {
      const noun = probeNoun(strings(args.sqls) ?? []);
      return noun === null ? "probe" : `probe ${noun}`;
    }
  }
}

/** Hand-written mirror of tools.schema.json. The schema file is the wire
 * contract every provider renders; this is the gate that turns a model's
 * approximation of it into either a call or an error the model can read. */
async function callTool(
  tools: AgentTools,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; result: unknown }> {
  switch (name) {
    case "list_tables": {
      const out = await tools.listTables();
      return { text: out.textForModel, isError: !!out.error, result: out.result };
    }
    case "describe_tables": {
      const names = strings(args.names);
      if (!names) {
        return {
          text: "ERROR: describe_tables needs `names`, an array of table names",
          isError: true,
          result: null,
        };
      }
      const out = await tools.describeTables(names.slice(0, 40));
      return { text: out.textForModel, isError: !!out.error, result: out.result };
    }
    case "peek_values": {
      const table = args.table;
      const column = args.column;
      if (typeof table !== "string" || typeof column !== "string" || !table || !column) {
        return {
          text: "ERROR: peek_values needs `table` and `column`",
          isError: true,
          result: null,
        };
      }
      const raw = typeof args.limit === "number" ? Math.trunc(args.limit) : 20;
      const limit = Math.max(1, Math.min(raw, PEEK_MAX));
      const out = await tools.peekValues(table, column, limit);
      return { text: out.textForModel, isError: !!out.error, result: out.result };
    }
    case "run_sql": {
      const sql = args.sql;
      if (typeof sql !== "string" || !sql.trim()) {
        return { text: "ERROR: run_sql needs `sql`, one statement", isError: true, result: null };
      }
      const out = await tools.runSql(sql);
      return { text: out.textForModel, isError: !!out.error, result: out.result };
    }
    case "probe": {
      const sqls = strings(args.sqls);
      if (!sqls) {
        return {
          text: "ERROR: probe needs `sqls`, an array of 1 to 6 statements",
          isError: true,
          result: null,
        };
      }
      const out = await tools.probe(sqls.slice(0, PROBE_MAX));
      return { text: out.textForModel, isError: !!out.error, result: out.result };
    }
  }
}

/** The user message a run actually sends. A cut thread's first call carries
 * the kept exchanges as a prefix, because its provider session is brand new
 * (store: cutPending). Everything else, the eval path included, sends the
 * message askMessage() built, byte for byte. */
function withReplay(req: AskRequest, userMsg: string): string {
  const replay = req.thread?.replay;
  return replay ? `${replay}\n\n${userMsg}` : userMsg;
}

// ---- the loop --------------------------------------------------------------

export async function runAsk(req: AskRequest): Promise<AskAnswer> {
  const now = req.now ?? (() => Date.now());
  const emit = (ev: AskEvent) => req.onEvent?.(ev);
  const maxTurns = req.maxTurns ?? MAX_TURNS;
  const started = now();
  const trace: TraceStep[] = [];
  const usage: TokenUsage = { input: 0, output: 0 };

  // 4.1 prefilter + 4.2 context: code, milliseconds, zero tokens
  emit({ type: "status", phase: "context" });
  const meta = buildMeta(req.snapshot);
  const mentions = req.mentions ?? [];
  const picked = candidates(req.question, meta, undefined, mustIncludeFor(meta, mentions));
  const risky = isRisky(req.question);
  const userMsg = withReplay(
    req,
    askMessage({
      question: req.question,
      index: indexFor(meta, picked),
      totalTables: meta.tables.length,
      risky,
      context: taggedContext(mentions, req.rowContext),
    }) +
      // A4: last, after the risk block when both fire (the risk block
      // instructs the next turn's probes, this one the final fence). Absent
      // whenever edits are off, which is what keeps the eval's bytes and
      // every baseline row exactly where v4 left them (EVAL 4)
      (req.writes?.on ? writesMessage() : ""),
  );
  trace.push({
    step: "context",
    ms: Math.round(now() - started),
    candidates: picked,
    text: userMsg,
    // absent, not empty: a question that tagged nothing has no tagged line
    ...(mentions.length > 0 ? { mentions: mentionTags(mentions) } : {}),
  });

  const base = {
    trace,
    usage,
    promptVersion: PROMPT_VERSION,
    candidates: picked,
    recall: recallOf(picked, req.goldSql, meta),
    risky,
  };
  // the count the USER watched work (LESSONS 13). An `ownsLoop` provider ran
  // the turns itself and reports its own `num_turns` off its result line; a
  // provider this loop drives reports none, and then the loop's counter IS
  // what the user watched. Set once per invocation, read by every finish, so
  // the turn-cap sentence, the trace's verdict and the footer are one number
  // in three slots and never three readings of two counters (DESIGN rule 14).
  const child: { turns: number | null } = { turns: null };
  const finish = (
    verdict: Verdict,
    extra: { sql: string | null; run: AgentRun | null; text: string; turns: number } & {
      assumptions?: Assumption[];
      sanity?: SanityFragment[];
      /** the wait a rate-limited provider stated, forwarded to the UI */
      retryAfterMs?: number;
      /** the affordance this failure gets when the verdict alone does not
       * name it: a refused change is a `failed` verdict carrying SQL, which
       * would otherwise read as the repair loop's own (A4, AGENT-UX 7) */
      errorKind?: AskErrorKind;
    },
  ): AskAnswer => {
    trace.push({ step: "verdict", ms: Math.round(now() - started), verdict });
    const answer: AskAnswer = {
      ...base,
      verdict,
      sql: extra.sql,
      run: extra.run,
      text: extra.text,
      turns: child.turns ?? extra.turns,
      assumptions: extra.assumptions ?? [],
      sanity: extra.sanity ?? [],
      ms: Math.round(now() - started),
    };
    // `proposed` is neither: a statement that cleared the write gate and has
    // not run is the answer to the question asked (A4, AGENT-UX 13.2)
    if (verdict.status !== "answered" && verdict.status !== "proposed") {
      // the ONE error emit per verdict: a failed verdict that carries SQL is
      // a SQL failure (Fix It over the last statement), one without SQL is
      // the provider's (Retry). The store keeps the last error it sees, so a
      // second emit here would relabel every SQL failure as a provider one.
      const kind: AskErrorKind =
        extra.errorKind ??
        (verdict.status === "cancelled"
          ? "cancelled"
          : verdict.status === "turn_cap"
            ? "turncap"
            : verdict.sql !== null
              ? "sql"
              : "provider");
      emit({
        type: "error",
        kind,
        message:
          verdict.status === "failed"
            ? verdict.message
            : verdict.status === "turn_cap"
              ? turnCapMessage(verdict.turns)
              : "cancelled",
        ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
      });
    }
    emit({ type: "status", phase: "done" });
    emit({ type: "answer", answer });
    return answer;
  };

  if (req.tier === "small") {
    return runSmall(req, { meta, picked, now, emit, trace, usage, finish, maxTurns });
  }

  const messages: Msg[] = [{ role: "user", content: userMsg }];
  const peeked: { column: string; id: string }[] = [];
  const sanity: SanityFragment[] = [];
  // a box, not a `let`: the assignment happens inside the Promise.all callback
  // and control-flow narrowing does not follow a variable across that boundary
  const runs: { last: { sql: string; run: AgentRun } | null } = { last: null };
  let turns = 0;
  // consecutive run_sql calls the gate refused as prose (W7): the model
  // answered in words, handed the words to run_sql, and would re-explain
  // itself once per refusal until the turn cap. Reset by any run_sql the
  // gate read as a statement, broken or not
  let proseStrikes = 0;
  let text = "";
  // where the current text block starts inside `text`: a tool call closes the
  // block before it, and only the block after the last call is the answer
  let answerFrom = 0;
  const lastBlock = () => text.slice(answerFrom);
  // the last block that still says something once fences, the Assumptions
  // line and tables are stripped: a final block that is only the SQL (the
  // model wrote its prose, ran once more, then closed with the statement)
  // keeps that prose in the answer instead of an empty slot
  let lastProse = "";
  const noteProse = (block: string) => {
    if (answerText(block).trim()) lastProse = block;
  };
  /** what the model actually said, for an ending that is not the post step:
   * the open block when it says something, else the last block that did */
  const proseSaid = () => (answerText(lastBlock()).trim() ? lastBlock() : lastProse);
  /** the prose spiral's exit (W7): the model had already given its answer in
   * words, so the exchange is ANSWERED with those words and no statement */
  const proseAnswer = () => {
    const said = proseSaid();
    return finish({ status: "answered", sql: null, rowCount: null }, {
      sql: null,
      run: null,
      text: said,
      turns,
      assumptions: buildAssumptions({ text: said, sql: null, question: req.question }),
      sanity: sanityLine(peeked, sanity),
    });
  };

  try {
    while (turns < maxTurns) {
      if (req.signal.aborted) throw new Cancelled();
      turns++;
      emit({ type: "status", phase: "thinking" });
      const turnStart = now();

      const calls: ToolCall[] = [];
      const owned: ToolResult[] = [];
      const openedAt = new Map<string, number>();
      let thinking = "";
      let stop: StopReason | null = null;
      let failure: { kind: string; message: string; retryAfterMs?: number } | null = null;
      noteProse(lastBlock());
      text = "";
      answerFrom = 0;

      const stream = req.provider.chat({
        system: SYSTEM_PROMPT,
        messages,
        tools: [...TOOL_SCHEMAS],
        model: req.model,
        signal: req.signal,
        thread: req.thread
          ? {
              id: req.thread.id,
              session: req.thread.session,
              firstCall: req.thread.firstCall && turns === 1,
              turnsRemaining: maxTurns - turns + 1,
            }
          : undefined,
      });

      for await (const ev of stream as AsyncIterable<AgentEvent>) {
        if (req.signal.aborted) throw new Cancelled();
        if ("text" in ev) {
          text += ev.text;
          emit({ type: "text", delta: ev.text });
        } else if ("thinking" in ev) {
          thinking += ev.thinking;
          emit({ type: "thinking", delta: ev.thinking });
        } else if ("toolCall" in ev) {
          if (text.length > answerFrom) {
            const block = lastBlock();
            noteProse(block);
            if (block.trim()) emit({ type: "narration", text: block });
            answerFrom = text.length;
          }
          calls.push(ev.toolCall);
          openedAt.set(ev.toolCall.id, now());
          const name = isName(ev.toolCall.name) ? ev.toolCall.name : "run_sql";
          emit({
            type: "toolStart",
            id: ev.toolCall.id,
            name,
            label: isName(ev.toolCall.name)
              ? chipLabel(name, asRecord(safeParse(ev.toolCall.args)))
              : ev.toolCall.name,
            args: ev.toolCall.args,
          });
        } else if ("toolResult" in ev) {
          owned.push(ev.toolResult);
          const name = isName(ev.toolResult.name) ? ev.toolResult.name : "run_sql";
          const ms = Math.round(now() - (openedAt.get(ev.toolResult.id) ?? now()));
          emit({
            type: "toolEnd",
            id: ev.toolResult.id,
            name,
            ms,
            isError: !!ev.toolResult.isError,
            args: calls.find((c) => c.id === ev.toolResult.id)?.args ?? "",
            result: ev.toolResult.result,
          });
        } else if ("usage" in ev) {
          usage.input += ev.usage.input;
          usage.output += ev.usage.output;
          if (ev.usage.cacheRead !== undefined) {
            usage.cacheRead = (usage.cacheRead ?? 0) + ev.usage.cacheRead;
          }
          if (ev.usage.cacheWrite !== undefined) {
            usage.cacheWrite = (usage.cacheWrite ?? 0) + ev.usage.cacheWrite;
          }
          emit({ type: "usage", usage: ev.usage });
        } else if ("done" in ev) {
          stop = ev.done.stopReason;
          // the child's own count when it reports one: every status naming a
          // turn count names the turns the user watched, never this loop's
          // counter (W7, LESSONS 13)
          if (ev.done.turns !== undefined) child.turns = ev.done.turns;
        } else {
          failure = ev.error;
          break;
        }
      }

      trace.push({
        step: "turn",
        ms: Math.round(now() - turnStart),
        index: turns - 1,
        text,
        thinking: thinking || undefined,
        usage: { ...usage },
      });

      if (failure) {
        if (failure.kind === "cancelled") throw new Cancelled();
        return finish({ status: "failed", sql: null, message: failure.message }, {
          sql: null,
          run: null,
          text: lastBlock(),
          turns,
          retryAfterMs: failure.retryAfterMs,
        });
      }
      if (req.signal.aborted) throw new Cancelled();

      // `ownsLoop`: the provider ran the tools itself. Record what it did and
      // never re-execute (AGENT-SPEC section 7).
      if (req.provider.ownsLoop) {
        for (const res of owned) {
          const call = calls.find((c) => c.id === res.id);
          // the name is recorded as the provider reported it: a tool outside
          // the five must show up in the trace by its own name, never be
          // laundered into the run_sql count
          trace.push({
            step: "tool",
            ms: 0,
            id: res.id,
            name: res.name,
            args: call?.args ?? "",
            result: res.result,
            isError: !!res.isError,
          });
        }
      } else if (calls.length > 0) {
        emit({ type: "status", phase: "tools" });
        messages.push({ role: "assistant", content: text, toolCalls: calls });
        const results = await raceAbort(
          Promise.all(
            calls.map(async (call): Promise<ToolResult> => {
              const t = now();
              const parsed = safeParse(call.args);
              let out: { text: string; isError: boolean; result: unknown };
              if (!isName(call.name)) {
                out = {
                  text: `ERROR: unknown tool '${call.name}'. Valid tools: ${TOOL_NAMES.join(", ")}`,
                  isError: true,
                  result: null,
                };
              } else if (parsed === undefined) {
                out = {
                  text: `ERROR: arguments were not valid JSON: ${call.args.slice(0, 200)}`,
                  isError: true,
                  result: null,
                };
              } else {
                const args = asRecord(parsed);
                try {
                  out = await callTool(req.tools, call.name, args);
                } catch (e) {
                  out = { text: `ERROR: ${firstLine(e)}`, isError: true, result: null };
                }
                if (call.name === "peek_values" && typeof args.column === "string") {
                  peeked.push({ column: args.column, id: call.id });
                }
                if (call.name === "run_sql" && !out.isError && out.result) {
                  runs.last = { sql: String(args.sql), run: out.result as AgentRun };
                }
                if (call.name === "probe" && Array.isArray(out.result)) {
                  for (const p of out.result as { fragment: SanityFragment | null }[]) {
                    if (p.fragment) sanity.push({ ...p.fragment, stepId: call.id });
                  }
                }
              }
              const name = isName(call.name) ? call.name : "run_sql";
              const ms = Math.round(now() - t);
              trace.push({
                step: "tool",
                ms,
                id: call.id,
                name,
                args: call.args,
                result: out.text,
                isError: out.isError,
              });
              emit({
                type: "toolEnd",
                id: call.id,
                name,
                ms,
                isError: out.isError,
                args: call.args,
                result: out.text,
              });
              return { id: call.id, name: call.name, result: out.text, isError: out.isError };
            }),
          ),
          req.signal,
        );
        messages.push({ role: "tool", results });
        for (const r of results) {
          if (r.name !== "run_sql") continue;
          proseStrikes = r.isError && isProseRefusal(r.result) ? proseStrikes + 1 : 0;
        }
        if (proseStrikes >= PROSE_STRIKES) return proseAnswer();
        continue;
      }

      // the adapter cut a prose spiral off mid-conversation (W7): its own
      // strike count is the authority, this loop never saw the refusals
      if (stop === "proseLoop") return proseAnswer();

      // an `ownsLoop` provider that exhausted its own turn budget did not
      // finish the conversation; the model's last text is not an answer
      if (stop === "turnCap") {
        return finish({ status: "turn_cap", sql: runs.last?.sql ?? null, turns: child.turns ?? turns }, {
          sql: runs.last?.sql ?? null,
          run: runs.last?.run ?? null,
          text: lastBlock(),
          turns,
          sanity: sanityLine(peeked, sanity),
        });
      }

      if (stop === "toolCalls" && calls.length === 0) {
        // the provider said it wanted tools and named none: nothing to run, so
        // treat the text as final rather than looping on an empty turn
        stop = "stop";
      }

      // 4.6 post: the model is done talking, so the answer is assembled here
      emit({ type: "status", phase: "post" });
      const last = lastBlock();
      // a SQL-only closing block rides behind the last prose: the display
      // strip shows the prose, the fence and the Assumptions line still parse
      const answer = answerText(last).trim() || !lastProse ? last : `${lastProse}\n\n${last}`;
      // the fence normally closes the last block; a model that stated the SQL
      // before running it and said only "done" after keeps its statement
      let found = extractSql(answer);
      if (found.how === "raw" || found.how === "none") {
        const whole = extractSql(text);
        if (whole.how !== "raw" && whole.how !== "none") found = whole;
      }
      const { sql } = found;
      if (!sql) {
        return finish({ status: "answered", sql: null, rowCount: null }, {
          sql: null,
          run: null,
          text: answer,
          turns,
          assumptions: buildAssumptions({ text: answer, sql: null, question: req.question }),
          sanity: sanityLine(peeked, sanity),
        });
      }

      // A4: the statement the model settled on is a CHANGE, so it is never
      // executed here. Edits on, it ends the exchange as a proposal the user
      // runs in a query tab (AGENT-UX 13.2); edits off, it ends as the one
      // failure whose way out is Settings, never a run_sql the read gate
      // would refuse in gate words the question cannot act on (AGENT-SPEC
      // 8.9). Everything the gate does not read as exactly one INSERT /
      // UPDATE / DELETE falls through to the path it always took.
      if (req.writes && (await raceAbort(req.writes.isWrite(sql), req.signal))) {
        const shared = {
          sql,
          run: null,
          text: answer,
          turns,
          assumptions: buildAssumptions({ text: answer, sql, question: req.question }),
          sanity: sanityLine(peeked, sanity),
        };
        return req.writes.on
          ? finish({ status: "proposed", sql }, shared)
          : finish(
              { status: "failed", sql, message: writeRefusal(req.writes) },
              { ...shared, errorKind: "writesoff" },
            );
      }

      const prior = runs.last;
      let run = prior && sameSql(prior.sql, sql) ? prior.run : null;
      if (!run) {
        emit({ type: "status", phase: "running" });
        const t = now();
        const out = await raceAbort(req.tools.runSql(sql), req.signal);
        trace.push({
          step: "tool",
          ms: Math.round(now() - t),
          id: `final-${turns}`,
          name: "run_sql",
          args: JSON.stringify({ sql }),
          result: out.textForModel,
          isError: !!out.error,
        });
        if (out.error || !out.result) {
          if (turns < maxTurns) {
            messages.push({ role: "assistant", content: text });
            messages.push({ role: "user", content: repairMessage(out.error ?? out.textForModel) });
            continue;
          }
          return finish(
            { status: "failed", sql, message: out.error ?? out.textForModel },
            { sql, run: null, text: answer, turns },
          );
        }
        run = out.result;
      }

      return finish({ status: "answered", sql, rowCount: run.rowCount }, {
        sql,
        run,
        text: answer,
        turns,
        assumptions: buildAssumptions({ text: answer, sql, question: req.question }),
        sanity: sanityLine(peeked, sanity),
      });
    }

    return finish({ status: "turn_cap", sql: runs.last?.sql ?? null, turns: child.turns ?? turns }, {
      sql: runs.last?.sql ?? null,
      run: runs.last?.run ?? null,
      text: lastBlock(),
      turns,
      sanity: sanityLine(peeked, sanity),
    });
  } catch (e) {
    if (e instanceof Cancelled) {
      return finish({ status: "cancelled", sql: runs.last?.sql ?? null }, {
        sql: runs.last?.sql ?? null,
        run: runs.last?.run ?? null,
        text: lastBlock(),
        turns,
        sanity: sanityLine(peeked, sanity),
      });
    }
    return finish({ status: "failed", sql: null, message: firstLine(e) }, {
      sql: null,
      run: null,
      text: lastBlock(),
      turns,
      sanity: sanityLine(peeked, sanity),
    });
  }
}

/** "checked payment_status values" first, then whatever the probes showed.
 * Each fragment names the call that produced it; a column peeked twice keeps
 * its first call. */
function sanityLine(
  peeked: { column: string; id: string }[],
  probes: SanityFragment[],
): SanityFragment[] {
  const seen = new Set<string>();
  const out: SanityFragment[] = [];
  for (const { column, id } of peeked) {
    if (seen.has(column)) continue;
    seen.add(column);
    out.push({ text: `checked ${column} values`, warn: false, stepId: id });
  }
  return [...out, ...probes];
}

function safeParse(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- small tier (section 4.7) ---------------------------------------------

interface SmallCtx {
  meta: ReturnType<typeof buildMeta>;
  picked: string[];
  now: () => number;
  emit: (ev: AskEvent) => void;
  trace: TraceStep[];
  usage: TokenUsage;
  maxTurns: number;
  finish: (
    verdict: Verdict,
    extra: { sql: string | null; run: AgentRun | null; text: string; turns: number } & {
      assumptions?: Assumption[];
      sanity?: SanityFragment[];
      retryAfterMs?: number;
      errorKind?: AskErrorKind;
    },
  ) => AskAnswer;
}

/** Code prefilter, curated schema, ONE model call producing SQL, execute, and
 * at most two repairs. No tools: tool loops collapse below about 7B, and the
 * repair loop was the biggest measured lever on this tier. */
async function runSmall(req: AskRequest, ctx: SmallCtx): Promise<AskAnswer> {
  const { now, emit, trace, usage, finish } = ctx;
  let text = "";
  let sql: string | null = null;
  try {
    const t = now();
    const described = await raceAbort(req.tools.describeTables(ctx.picked), req.signal);
    trace.push({
      step: "tool",
      ms: Math.round(now() - t),
      id: "small-schema",
      name: "describe_tables",
      args: JSON.stringify({ names: ctx.picked }),
      result: described.textForModel,
      isError: !!described.error,
    });

    const messages: Msg[] = [
      { role: "user", content: withReplay(req, smallAskMessage(described.textForModel, req.question)) },
    ];
    const attempts = Math.min(SMALL_REPAIRS + 1, ctx.maxTurns);
    let lastError = "no SQL code block found in response";

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (req.signal.aborted) throw new Cancelled();
      emit({ type: "status", phase: "thinking" });
      const turnStart = now();
      text = "";
      let failure: { kind: string; message: string; retryAfterMs?: number } | null = null;
      const stream = req.provider.chat({
        system: SMALL_SYSTEM_PROMPT,
        messages,
        tools: [],
        model: req.model,
        signal: req.signal,
      });
      for await (const ev of stream as AsyncIterable<AgentEvent>) {
        if (req.signal.aborted) throw new Cancelled();
        if ("text" in ev) {
          text += ev.text;
          emit({ type: "text", delta: ev.text });
        } else if ("thinking" in ev) {
          emit({ type: "thinking", delta: ev.thinking });
        } else if ("usage" in ev) {
          usage.input += ev.usage.input;
          usage.output += ev.usage.output;
          emit({ type: "usage", usage: ev.usage });
        } else if ("error" in ev) {
          failure = ev.error;
          break;
        }
      }
      trace.push({
        step: "turn",
        ms: Math.round(now() - turnStart),
        index: attempt,
        text,
        usage: { ...usage },
      });
      if (failure) {
        if (failure.kind === "cancelled") throw new Cancelled();
        return finish({ status: "failed", sql: null, message: failure.message }, {
          sql: null,
          run: null,
          text,
          turns: attempt + 1,
          retryAfterMs: failure.retryAfterMs,
        });
      }

      sql = extractSql(text).sql;
      // A4: this tier is told to write a SELECT and gets no WRITES block, so
      // a change here is the model going off script. It is still never run:
      // the same gate, the same two endings as the hybrid path (AGENT-SPEC
      // 8.9), because which tier answered is not a reason to run a write
      if (sql && req.writes && (await raceAbort(req.writes.isWrite(sql), req.signal))) {
        const shared = { sql, run: null, text, turns: attempt + 1 };
        return req.writes.on
          ? finish({ status: "proposed", sql }, shared)
          : finish(
              { status: "failed", sql, message: writeRefusal(req.writes) },
              { ...shared, errorKind: "writesoff" },
            );
      }
      if (sql) {
        emit({ type: "status", phase: "running" });
        const t1 = now();
        const out = await raceAbort(req.tools.runSql(sql), req.signal);
        trace.push({
          step: "tool",
          ms: Math.round(now() - t1),
          id: `small-run-${attempt}`,
          name: "run_sql",
          args: JSON.stringify({ sql }),
          result: out.textForModel,
          isError: !!out.error,
        });
        if (!out.error && out.result) {
          return finish({ status: "answered", sql, rowCount: out.result.rowCount }, {
            sql,
            run: out.result,
            text,
            turns: attempt + 1,
            assumptions: buildAssumptions({ text: null, sql, question: req.question }),
          });
        }
        lastError = out.error ?? out.textForModel;
      }
      if (attempt < attempts - 1) {
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: repairMessage(lastError) });
      }
    }

    return finish({ status: "failed", sql, message: lastError }, {
      sql,
      run: null,
      text,
      turns: attempts,
    });
  } catch (e) {
    if (e instanceof Cancelled) {
      return finish({ status: "cancelled", sql }, { sql, run: null, text, turns: 1 });
    }
    return finish({ status: "failed", sql, message: firstLine(e) }, {
      sql,
      run: null,
      text,
      turns: 1,
    });
  }
}
