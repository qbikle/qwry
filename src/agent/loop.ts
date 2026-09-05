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
  TOOL_NAMES,
  TOOL_SCHEMAS,
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
import { buildMeta, candidates, indexFor, recallOf } from "./context";
import { isRisky } from "./risk";
import { probeNoun } from "./probeNoun";
import {
  PROMPT_VERSION,
  SMALL_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  askMessage,
  repairMessage,
  smallAskMessage,
} from "./prompt";
import { buildAssumptions, extractSql } from "./extract";

/** Thread-level cap (AGENT-SPEC section 4.5). `claude -p` takes a per
 * invocation `--max-turns`, so the thread total is subtracted there. */
export const MAX_TURNS = 12;

/** Repairs the small tier gets after its one shot (section 4.7). */
export const SMALL_REPAIRS = 2;

export type AskPhase = "context" | "thinking" | "tools" | "running" | "post" | "done";

/** The four ways an Ask ends badly. Each maps to an affordance in AGENT-UX 7,
 * so a new kind means a new affordance, not a new message. */
export type AskErrorKind = "provider" | "sql" | "turncap" | "cancelled";

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
  /** three next questions (spec 4.6); empty until the store's follow-ups call
   * lands, and always empty from the loop itself */
  followUps: string[];
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
  /** thread continuity for `ownsLoop` providers; stateless ones ignore it */
  thread?: { id: string; firstCall: boolean };
  /** injectable clock so the harness can be deterministic */
  now?: () => number;
  maxTurns?: number;
  /** bench only: gold SQL, so the answer can carry prefilter recall */
  goldSql?: string | null;
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
  const picked = candidates(req.question, meta);
  const risky = isRisky(req.question);
  const userMsg = askMessage({
    question: req.question,
    index: indexFor(meta, picked),
    totalTables: meta.tables.length,
    risky,
  });
  trace.push({
    step: "context",
    ms: Math.round(now() - started),
    candidates: picked,
    text: userMsg,
  });

  const base = {
    trace,
    usage,
    promptVersion: PROMPT_VERSION,
    candidates: picked,
    recall: recallOf(picked, req.goldSql, meta),
    risky,
  };
  const finish = (
    verdict: Verdict,
    extra: { sql: string | null; run: AgentRun | null; text: string; turns: number } & {
      assumptions?: Assumption[];
      sanity?: SanityFragment[];
      /** the wait a rate-limited provider stated, forwarded to the UI */
      retryAfterMs?: number;
    },
  ): AskAnswer => {
    trace.push({ step: "verdict", ms: Math.round(now() - started), verdict });
    const answer: AskAnswer = {
      ...base,
      verdict,
      sql: extra.sql,
      run: extra.run,
      text: extra.text,
      turns: extra.turns,
      assumptions: extra.assumptions ?? [],
      sanity: extra.sanity ?? [],
      followUps: [],
      ms: Math.round(now() - started),
    };
    if (verdict.status !== "answered") {
      // the ONE error emit per verdict: a failed verdict that carries SQL is
      // a SQL failure (Fix It over the last statement), one without SQL is
      // the provider's (Retry). The store keeps the last error it sees, so a
      // second emit here would relabel every SQL failure as a provider one.
      const kind: AskErrorKind =
        verdict.status === "cancelled"
          ? "cancelled"
          : verdict.status === "turn_cap"
            ? "turncap"
            : verdict.sql !== null
              ? "sql"
              : "provider";
      emit({
        type: "error",
        kind,
        message:
          verdict.status === "failed"
            ? verdict.message
            : verdict.status === "turn_cap"
              ? `stopped after ${verdict.turns} turns`
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
  let text = "";
  // where the current text block starts inside `text`: a tool call closes the
  // block before it, and only the block after the last call is the answer
  let answerFrom = 0;
  const lastBlock = () => text.slice(answerFrom);

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
        continue;
      }

      // an `ownsLoop` provider that exhausted its own turn budget did not
      // finish the conversation; the model's last text is not an answer
      if (stop === "turnCap") {
        return finish({ status: "turn_cap", sql: runs.last?.sql ?? null, turns }, {
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
      const answer = lastBlock();
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

    return finish({ status: "turn_cap", sql: runs.last?.sql ?? null, turns }, {
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
      { role: "user", content: smallAskMessage(described.textForModel, req.question) },
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
