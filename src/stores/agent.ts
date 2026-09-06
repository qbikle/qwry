// Ask threads (AGENT-SPEC section 9, AGENT-UX 1-7). Threads belong to a
// connection: switching connections switches threads, and each thread holds
// its own dedicated read-only session for as long as it is open.
//
// The loop itself lives in src/agent/loop.ts and knows nothing about this
// store; everything it wants to say arrives as an AskEvent. That is what lets
// the eval harness run the same loop headless (EVAL.md section 3).
//
// LESSONS 3 is the rule this file is written around: profile id, thread id and
// session id are captured at entry and never re-read from the store after an
// await. `getState().active` answers a different question by then.

import { create } from "zustand";
import {
  agentAnswerPut,
  agentAnswersList,
  agentConnect,
  agentGate,
  agentWritePreview,
  agentHistoryPairs,
  agentThreadCreate,
  agentThreadDelete,
  agentThreadList,
  agentThreadSessionSet,
  agentThreadTruncate,
  agentTurnAdd,
  agentTurnsList,
  agentTurnsShift,
  agentTurnUpdate,
  cancel as cancelSession,
  disconnect,
} from "../ipc/commands";
import type {
  AgentAnswer,
  AgentHistoryPair,
  AgentTurn,
  WritePreview,
  WriteVerb,
} from "../ipc/types";
import { headToken } from "../editor/statements";
import { useConnections } from "./connections";
import { useAsk, type AskBlock } from "./ask";
import { useSchema } from "./schema";
import { useSaved, visibleSaved, type SavedQuery } from "./saved";
import { useSettings, writesAllowed } from "./settings";
import { useSidePane } from "./sidePane";
import { useKnowledge } from "./knowledge";
import { driftLabel } from "./checks";
import { createTauriTools } from "../agent/tools.tauri";
import { tauriPlatform } from "../agent/platform.tauri";
import { providerFor, tierOf } from "../agent/providers/index";
import type { Provider, ProviderId } from "../agent/providers/types";
import {
  runAsk,
  type AskAnswer,
  type AskErrorKind,
  type AskEvent,
  type AskPhase,
  type WriteMode,
} from "../agent/loop";
import { RUN_SQL_TIMEOUT_MS } from "../agent/tools";
import { suggestFollowUps } from "../agent/followups";
import {
  canonicalToken,
  MENTION_TEXT_CAP,
  clip,
  type Mention,
  parseMentions,
  resolveMentions,
} from "../agent/mentions";
import { buildAssumptions, extractSql } from "../agent/extract";
import { answerText } from "../agent/display";
import type {
  AnswerStatus,
  Assumption,
  KnowledgeRow,
  SanityFragment,
  Thread,
  ToolCallRecord,
  ToolName,
  ToolResultRecord,
  TraceStep,
} from "../agent/types";

/** One tool call as the thinking strip shows it (AGENT-UX 2). `ms` and
 * `result` are null while the call is still running; once it has both, the
 * trace drawer can open the chip before the answer lands. */
export interface ToolChip {
  id: string;
  /** one of the five tools, or A4's `preview`: the dry run is not a tool the
   * model can call, but it is work the user waits on, so it wears the strip's
   * own chip and the `run` chip's species (AGENT-UX 13.2) */
  name: ToolName | "preview";
  label: string;
  ms: number | null;
  isError: boolean;
  /** raw argument JSON as the model wrote it */
  args: string;
  result: string | null;
}

/** One question and everything that came back for it. The question echo stays
 * even when the answer fails, because a dead end is never the UI (LESSONS 9). */
export interface Exchange {
  id: string;
  /** appdb agent_turns row of the ASSISTANT turn; null until persisted */
  turnId: number | null;
  /** appdb agent_turns row of the USER turn; null until persisted. A cut names
   * a thread's rows by these two ids rather than by any boundary, because
   * neither `idx` nor write order can be read as one: an exchange that failed
   * before persist() owns no rows at all, and a Retry on it writes them after
   * its successors'. Absent means null, which is what a harness fixture means */
  userTurnId?: number | null;
  /** the `idx` of the USER turn's row; its answer's is `idx + 1`. Null until
   * the pair is persisted (absent is null, as a harness fixture means it).
   * This is where the thread's order lives: a new pair is allocated from its
   * NEIGHBOURS' idx, never from the exchange's position on screen, which a
   * reload compacts over the gap an unpersisted exchange leaves */
  idx?: number | null;
  question: string;
  /** the answer slot's text: the model's last text block, streamed */
  text: string;
  /** a tool call closed the block on screen: the next delta replaces it
   * instead of appending (the old prose stays visible until then) */
  textStale?: boolean;
  thinking: string;
  chips: ToolChip[];
  answer: AskAnswer | null;
  error: { kind: AskErrorKind; message: string; retryAfterMs?: number } | null;
  streaming: boolean;
  provider: string;
  model: string;
  /** present while a retry (applyPending, fixIt, retry, restartFrom) streams
   * over this exchange: the landed shape it is replacing. A cancelled retry
   * puts it back exactly (a Stop never costs an answer, AGENT-UX 7); any
   * verdict drops it */
  prior?: PriorAnswer;
  /** a Restart forgot this exchange's own answer (W7): `prior` still holds it
   * for the Stop, but nothing of it is on screen, so the new run's text
   * streams instead of being held back behind an answer that is still there */
  forgot?: boolean;
  /** A4: the exchange's final SQL is a change. `proposed` = it passed the
   * write gate and nothing ran; `ran` = the user ran it in a query tab.
   * Absent on every read answer, which is `answered` by omission */
  status?: AnswerStatus;
  /** A4: the dry run behind the block's preview face. Absent while it is in
   * flight (the strip's `preview` chip is spinning), null when it failed */
  preview?: WritePreview | null;
  /** A4: what the TAB reported after Run, read from the tab's own outcome and
   * never from the preview's count (LESSONS 13) */
  ranRows?: number;
  /** A4: the SESSION KEY of the query tab the statement ran in (connections'
   * `skey(profileId, tabId)`, the key `txTabs` is indexed by): the headline
   * reads `uncommitted` while that tab's transaction is open and drops the
   * word the moment it commits, rolls back or closes. Never persisted */
  ranTab?: string;
  /** the tab an `Explain with Ask` named (A2 item 5): the echo paints the
   * token quoting this name as a pill and never resolves it again, because a
   * closed tab must not un-pill a bubble. The pill names what was SENT, a
   * fact about the exchange and not about the workspace */
  tabName?: string;
  /** what that entry point attached under the tags' own header: the tab's
   * statement, the check's drift. Kept on the exchange so every re-run asks
   * with it again (a Retry that dropped it would ask about a query nobody
   * sent) */
  context?: string;
  /** the canvas block this question was asked ABOUT (A3 item 4): the first
   * block its `@` tags named. Add to Canvas on the answer reads it and lands
   * the new block directly under that one, so a comment stands where the
   * thing it comments on stands (LESSONS 4: provenance is structural). It
   * lives on the EXCHANGE and not beside the canvas's own blocks because
   * `Ask` on a block runs before there is any exchange to key a pairing by;
   * the tag in the question is the only record that exists at that moment,
   * and it is also the record when the user types the token by hand.
   * Session-lived like the block registry it points into: a reloaded thread
   * has no answer to "where did this come from" and says so by having none */
  askedFrom?: string;
}

/** What a retry replaces: kept whole so restorePrior() is exact. */
export interface PriorAnswer {
  text: string;
  thinking: string;
  chips: ToolChip[];
  answer: AskAnswer | null;
  error: Exchange["error"];
  /** A4: the write state that stood with it (a proposal's dry run, a run's
   * rows and tab). Sparse, and absent on an exchange that had none, so a
   * restore puts the exchange back exactly, which is what a cancelled retry
   * is owed */
  write?: WriteState;
}

/** A4: the four fields a change leaves on an exchange, kept together so a
 * stash carries them and a new verdict clears them in one move. */
type WriteState = Partial<Pick<Exchange, "status" | "preview" | "ranRows" | "ranTab">>;

/** One assumption chip's wanted state, carried into a re-ask as a stated
 * constraint and reapplied to the landed chips (applyFlips). */
export interface Flip {
  id: string;
  label: string;
  active: boolean;
}

interface AgentState {
  /** the connection whose threads are on screen; pushed by the shell */
  activeProfileId: string | null;
  threads: Record<string, Thread[]>;
  /** per profile; null = a fresh composer with no persisted thread yet */
  activeThread: Record<string, string | null>;
  exchanges: Record<string, Exchange[]>;
  /** per thread: its dedicated agent session (agent_connect) */
  sessions: Record<string, string>;
  phase: Record<string, AskPhase | null>;
  busy: Record<string, boolean>;
  /** per exchange, the chips whose WANTED state differs from the answer's
   * (chip id → wanted active). A chip click writes here and nothing runs; the
   * floating pill applies the whole set as ONE re-ask (applyPending). Keys
   * return to the answer's state are deleted, so an empty set is no entry */
  pending: Record<string, Record<string, boolean>>;
  /** per THREAD, the three next questions (W7): one row, under the last
   * answer, read from everything the thread asked and answered rather than
   * from one exchange. Cleared the moment a run starts, so the chips never
   * stand beside a question they did not come from */
  followUps: Record<string, string[]>;
  /** A4: per EXCHANGE, its proposed statement is on its way to a query tab.
   * Not `busy`, which is the THREAD's: the run belongs to the tab, and ⌘.
   * cannot stop it, so claiming the thread is busy would offer a Stop that
   * stops nothing (LESSONS 9). The band reads it to hold its own press */
  writing: Record<string, boolean>;

  setActiveProfile: (profileId: string | null) => void;
  loadThreads: (profileId: string) => Promise<void>;
  newThread: (profileId: string) => void;
  openThread: (profileId: string, threadId: string) => Promise<void>;
  deleteThread: (profileId: string, threadId: string) => Promise<void>;
  ask: (question: string, opts?: AskOpts) => Promise<void>;
  /** `Ask` on a canvas block (A3 item 4): there is no comment composer on the
   * canvas, because a comment on a result IS a question about it. The pane
   * opens in Ask with the block's name at the end of the draft as one `@`
   * token and the composer focused; the user types the rest, and the answer
   * is a normal exchange that remembers where it was asked from */
  askAbout: (block: AskBlock) => void;
  cancel: () => void;
  /** the W2 immediate re-run of one chip; kept for callers, no longer wired
   * to a chip click (a click toggles the pending set instead) */
  toggleAssumption: (exchangeId: string, chipId: string) => Promise<void>;
  /** flip a chip's wanted state; the key leaves when it returns to the
   * answer's own state. Refused while the thread is busy */
  togglePending: (exchangeId: string, chipId: string) => void;
  discardPending: (exchangeId: string) => void;
  /** the pill: one re-ask carrying every flip of the exchange's pending set
   * as a constraint; the set stays until a verdict lands, so a cancel keeps it */
  applyPending: (exchangeId: string) => Promise<void>;
  /** Fix It (AGENT-UX 7): one more repair pass over a failed exchange, from
   * the SQL as the user left it in the editable field */
  fixIt: (exchangeId: string, sql: string) => Promise<void>;
  /** the retry a provider error offers: the same question, asked again */
  retry: (exchangeId: string) => Promise<void>;
  /** Continue (AGENT-UX 7): the turn cap cut the run short, so the SAME
   * provider session is asked to finish, with a fresh budget and no
   * re-inspection. Refused on anything but a capped exchange */
  continueFrom: (exchangeId: string) => Promise<void>;
  /** cut the thread at an exchange: everything after it (and the exchange
   * itself when `inclusive`) leaves the state and appdb, and the thread
   * mints a fresh provider session, because a resumed one remembers the
   * turns the cut deleted and cannot be rewound. Refused while busy */
  truncateThread: (threadId: string, fromExchangeId: string, inclusive: boolean) => Promise<void>;
  /** send from edit mode: the thread is cut from that exchange inclusive and
   * the new question lands where the old one stood */
  askFrom: (exchangeId: string, question: string) => Promise<void>;
  /** Restart (W7): cut every exchange AFTER this one, re-mint the provider
   * session, forget this exchange's own answer and ask its question again, so
   * the model inspects the database instead of answering from a session that
   * remembers what it said. `prior` keeps the old answer for the Stop. The
   * confirm belongs to the UI, which knows what the user is looking at */
  restartFrom: (exchangeId: string) => Promise<void>;
  /** A4 item 6: run a proposed change in the connection's ACTIVE query tab,
   * inside a transaction the tab already knows how to commit or roll back
   * (AGENT-UX 13.6). Never automatic: only the block's own danger button
   * calls it, only on a standing `proposed` exchange, and only once. What the
   * TAB reports lands on the exchange and persists as `ran` */
  runWrite: (exchangeId: string) => Promise<void>;
  /** thread closed or connection disconnected: the session goes with it */
  closeThread: (threadId: string) => Promise<void>;
  dropProfile: (profileId: string) => Promise<void>;
  /** Delete All in the Threads sheet: every thread of the connection, one
   * appdb delete each, then the list reloaded from appdb (the truth) */
  deleteAllThreads: (profileId: string) => Promise<void>;
  /** `Explain with Ask` (A2 item 5), from the editor's context menu and the
   * palette: one ordinary question about the statement the tab holds. The
   * caller opens the pane and picks the statement (the selection, else the
   * one at the caret, else the tab) */
  explainWithAsk: (sql: string, tabName: string) => Promise<void>;
  /** `Ask Why` on a failed check (A2 item 6b): the check as a saved-query
   * tag, its drift as the line under it */
  askWhy: (check: SavedQuery) => Promise<void>;
}

/** What a code entry point sends beside the question (A2 items 5 and 6).
 * `context` is one more line under the same header the `@` tags use, because
 * it is the same fact, what this question came with (DESIGN rule 15). */
export interface AskOpts {
  context?: string;
  tabName?: string;
}

/** A4: does the write gate read this statement as exactly one INSERT /
 * UPDATE / DELETE (AGENT-SPEC 8.7)? A refusal is not an error here: a SELECT,
 * two statements and a DDL all answer false and take the read path they
 * always took, where the read gate answers them in its own words. A gate that
 * cannot be reached answers false too, and false is the read path, which is
 * the safe one. */
const isWrite = async (sql: string): Promise<boolean> => {
  try {
    return (await agentGate(sql, "write")).allowed;
  } catch (e) {
    console.error("agent write gate failed", e);
    return false;
  }
};

/** A4: the tab's run path, reached by import so the Ask chunk never pulls the
 * editor and grid modules in behind it (the lazy-bundle line W3 measured). */
const runInTab = async (profileId: string, sql: string, tabName?: string) => {
  const { runStatementInTab } = await import("./results");
  return runStatementInTab(profileId, sql, tabName);
};

/** The calls this store makes out of itself: the two model ones, and A4's
 * three (the write gate, the dry run, the tab's run). A seam, not a switch:
 * the store's own tests stand scripted ones in here (agent-pending.test.ts),
 * because a bun module mock is process-global and reached the loop's own
 * tests. */
export const runner = {
  runAsk,
  suggestFollowUps,
  isWrite,
  writePreview: agentWritePreview,
  runInTab,
};

/** Not state: an AbortController is not serialisable and nothing renders it. */
const controllers = new Map<string, AbortController>();
/** threads whose user pressed cancel while no controller existed yet (the
 * first ask() is still inside agentConnect, a real wait over a bastion):
 * runInto() honours it the moment the connection lands */
const cancelRequested = new Set<string>();
/** Threads whose provider has already been given a session id to resume. */
const resumed = new Set<string>();
/** Threads cut since their last run: the next run replays the kept exchanges
 * in its user message, because the cut minted a session that has never heard
 * of them. Cleared when a run lands, so the replay is carried once and a
 * failed or cancelled first attempt keeps it for the next. */
const cutPending = new Set<string>();

/** What a Continue sends (AGENT-UX 7). The session already holds the
 * inspection and the half-written answer, so the message is the instruction
 * and nothing else: re-stating the question would invite the model to start
 * over, which is what the cap already made it pay for. */
const CONTINUE_ASK = "Continue: finish the answer from where you stopped, with the final SQL";

const TITLE_CAP = 80;
const title = (question: string) =>
  question.trim().length > TITLE_CAP ? `${question.trim().slice(0, TITLE_CAP)}…` : question.trim();

export interface ModelChoice {
  providerId: ProviderId;
  model: string;
  /** the provider's base URL override from Settings; absent = preset default */
  baseUrl?: string;
}

/** The provider and model this connection asks with: its own override first,
 * then the app-wide choice (AGENT-SPEC section 9), plus the provider's base
 * URL override so the run reaches the URL Settings probed. Exported for the
 * panel's empty-state switch and the picker pill, which show the same
 * resolution. */
export function modelChoice(profileId: string): ModelChoice | null {
  const s = useSettings.getState();
  const per = s.agentByConn[profileId];
  const provider = per?.provider ?? s.agentProvider;
  const model = per?.model ?? s.agentModel;
  if (!provider || !model) return null;
  const baseUrl = s.agentBaseUrls[provider];
  return baseUrl
    ? { providerId: provider as ProviderId, model, baseUrl }
    : { providerId: provider as ProviderId, model };
}

/** A failed verdict reloaded from appdb, in the shape the failure block
 * reads. `agent_answers` keeps the status and the SQL but not the error text
 * or the turn count, so the messages say only what is known (LESSONS 9). */
function errorFromStatus(
  status: string | undefined,
  sql: string | null,
): Exchange["error"] {
  switch (status) {
    case "failed":
      return sql !== null
        ? { kind: "sql", message: "the query failed. The error text is not kept in the history" }
        : { kind: "provider", message: "the run failed. The error text is not kept in the history" };
    case "turn_cap":
      return { kind: "turncap", message: "stopped at the turn cap" };
    case "cancelled":
      return { kind: "cancelled", message: "cancelled" };
    default:
      return null;
  }
}

function verdictFromStatus(
  status: string | undefined,
  sql: string | null,
  rowCount: number | null,
  message: string,
): AskAnswer["verdict"] {
  switch (status) {
    // A4: both are one verdict, a statement that cleared the write gate; what
    // separates them is `Exchange.status` and the rows the tab reported. A row
    // that kept no statement is not a proposal any more, whatever it says
    case "proposed":
    case "ran":
      return sql !== null ? { status: "proposed", sql } : { status: "answered", sql, rowCount };
    case "failed":
      return { status: "failed", sql, message };
    case "turn_cap":
      return { status: "turn_cap", sql, turns: 0 };
    case "cancelled":
      return { status: "cancelled", sql };
    default:
      return { status: "answered", sql, rowCount };
  }
}

const parseJson = <T,>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/** Rebuild the trace of a reloaded thread from what appdb kept. Rows the
 * database never held (the result grid, the sanity probes) stay absent rather
 * than being invented. */
function traceFromTurn(turn: AgentTurn): TraceStep[] {
  const calls = parseJson<ToolCallRecord[]>(turn.tool_calls_json, []);
  const results = parseJson<ToolResultRecord[]>(turn.tool_results_json, []);
  return results.map((r) => ({
    step: "tool" as const,
    ms: 0,
    id: r.id,
    name: r.name,
    args: calls.find((c) => c.id === r.id)?.args ?? "",
    result: r.result,
    isError: r.isError,
  }));
}

export const useAgent = create<AgentState>((set, get) => ({
  activeProfileId: null,
  threads: {},
  activeThread: {},
  exchanges: {},
  sessions: {},
  phase: {},
  busy: {},
  pending: {},
  followUps: {},
  writing: {},

  setActiveProfile: (profileId) => set({ activeProfileId: profileId }),

  loadThreads: async (profileId) => {
    const rows = await agentThreadList(profileId);
    const threads: Thread[] = rows.map((r) => ({
      id: r.id,
      profileId: r.profile_id,
      title: r.title,
      createdAt: r.created_at,
      sessionKey: r.session_key ?? r.id,
    }));
    set((s) => ({ threads: { ...s.threads, [profileId]: threads } }));
  },

  newThread: (profileId) =>
    set((s) => ({ activeThread: { ...s.activeThread, [profileId]: null } })),

  openThread: async (profileId, threadId) => {
    set((s) => ({ activeThread: { ...s.activeThread, [profileId]: threadId } }));
    if (get().exchanges[threadId]) return;
    // the conversation and its verdicts are two tables and one round trip:
    // agent_turns holds what was said, agent_answers what it concluded
    const [turns, answers] = await Promise.all([
      agentTurnsList(threadId),
      agentAnswersList(threadId),
    ]);
    const byTurn = new Map(answers.map((a) => [a.turn_id, a]));
    const exchanges: Exchange[] = [];
    for (const turn of turns) {
      if (turn.role === "user") {
        exchanges.push({
          id: `turn-${turn.id}`,
          turnId: null,
          userTurnId: turn.id,
          // the row's own slot, carried so the next pair is placed after it:
          // the position this exchange takes on screen is not it (a thread
          // with a gap compacts, the rows do not renumber)
          idx: turn.idx,
          question: turn.content,
          text: "",
          thinking: "",
          chips: [],
          answer: null,
          error: null,
          streaming: false,
          provider: turn.provider,
          model: turn.model,
        });
        continue;
      }
      if (turn.role !== "assistant") continue;
      const current = exchanges[exchanges.length - 1];
      if (!current) continue;
      const stored = byTurn.get(turn.id);
      // the SQL the verdict recorded is the truth; the model's text is the
      // fallback for a turn with no answer row
      const sql = stored?.sql ?? extractSql(turn.content).sql;
      const error = errorFromStatus(stored?.status, sql);
      current.turnId = turn.id;
      current.text = turn.content;
      current.error = error;
      // A4: a change and how far it got. The dry run is NOT persisted (it
      // described a moment that has passed), so a reloaded proposal shows its
      // statement with no band, and a reloaded `ran` reads the rows the tab
      // reported and never `uncommitted`, which belongs to a live tab alone
      if (sql !== null && (stored?.status === "proposed" || stored?.status === "ran")) {
        current.status = stored.status;
        if (stored.status === "ran") current.ranRows = stored.row_count ?? 0;
      }
      current.answer = {
        verdict: verdictFromStatus(stored?.status, sql, stored?.row_count ?? null, error?.message ?? ""),
        sql,
        run: null,
        // the recorded chips are the ones the user last saw, toggles included;
        // re-deriving them is the fallback for a turn with no answer row
        assumptions: stored
          ? parseJson<Assumption[]>(stored.assumptions_json, [])
          : buildAssumptions({ text: turn.content, sql, question: current.question }),
        sanity: parseJson<SanityFragment[]>(stored?.sanity_json, []),
        trace: traceFromTurn(turn),
        text: turn.content,
        turns: 0,
        ms: turn.ms,
        usage: parseJson(turn.usage_json, { input: 0, output: 0 }),
        promptVersion: turn.prompt_version,
        candidates: [],
        recall: null,
        risky: false,
      };
    }
    set((s) => ({ exchanges: { ...s.exchanges, [threadId]: exchanges } }));
    // follow-ups are not persisted (appdb has no column for them yet): the
    // newest answered exchange gets them recomputed, older ones go without
    const last = exchanges[exchanges.length - 1];
    const choice = modelChoice(profileId);
    if (last?.answer && last.answer.verdict.status === "answered" && choice) {
      let provider: Provider | null = null;
      try {
        provider = providerFor(choice, tauriPlatform);
      } catch {
        // an unusable model choice costs the reloaded chips, never the thread
      }
      if (provider) {
        void followUpsInto(set, get, {
          threadId,
          exchangeId: last.id,
          landed: last.answer,
          provider,
          model: choice.model,
          signal: new AbortController().signal,
        });
      }
    }
  },

  deleteThread: async (profileId, threadId) => {
    await get().closeThread(threadId);
    cutPending.delete(threadId);
    await agentThreadDelete(threadId);
    set((s) => {
      const exchanges = { ...s.exchanges };
      const gone = s.exchanges[threadId] ?? [];
      delete exchanges[threadId];
      let pending = s.pending;
      for (const e of gone) pending = without(pending, e.id);
      return {
        exchanges,
        pending,
        followUps: without(s.followUps, threadId),
        threads: {
          ...s.threads,
          [profileId]: (s.threads[profileId] ?? []).filter((t) => t.id !== threadId),
        },
        activeThread: {
          ...s.activeThread,
          [profileId]: s.activeThread[profileId] === threadId ? null : s.activeThread[profileId],
        },
      };
    });
  },

  ask: async (question, opts) => {
    const text = question.trim();
    if (!text) return;
    // capture everything the run depends on BEFORE the first await
    const profileId = get().activeProfileId;
    if (!profileId) return;
    const snapshot = useSchema.getState().snapshots[profileId];
    const choice = modelChoice(profileId);
    // the `@` tags, resolved against what this connection has RIGHT NOW and
    // before the thread create below, like every other capture here. A tab's
    // own token is claimed by the tab: a saved query of the same name must
    // not answer for it (the quoted ladder collides, A2 item 5)
    const tabToken = opts?.tabName ? canonicalToken("tab", { name: opts.tabName }).slice(1) : null;
    const mentions = mentionsFor(get, profileId, get().activeThread[profileId], text).filter(
      (m) => m.token !== tabToken,
    );
    // the first canvas block the question named (the ladder's fifth rung): the
    // exchange remembers where it was asked from, so Add to Canvas on the
    // reply lands under that block instead of at the document's end
    const askedFrom = mentions.find((m) => m.kind === "block")?.ref.id;
    // the row Record View attached, read and CLEARED in one call: a row's
    // values are true of the question asked over them and of no later one
    // (LESSONS 3). Before the first await, like everything else here
    const rowContext = useAsk.getState().takeAskContext(profileId);

    let threadId = get().activeThread[profileId];
    // a question typed into a busy thread would abort the live run through
    // the controller swap in runInto(); the composer refuses it, and so does
    // the store, so no caller can cancel an answer by accident
    if (threadId && get().busy[threadId]) return;
    if (!threadId) {
      const row = await agentThreadCreate(profileId, title(text));
      threadId = row.id;
      const thread: Thread = {
        id: row.id,
        profileId: row.profile_id,
        title: row.title,
        createdAt: row.created_at,
        sessionKey: row.session_key ?? row.id,
      };
      set((s) => ({
        threads: { ...s.threads, [profileId]: [thread, ...(s.threads[profileId] ?? [])] },
        activeThread: { ...s.activeThread, [profileId]: row.id },
        exchanges: { ...s.exchanges, [row.id]: s.exchanges[row.id] ?? [] },
      }));
    }
    const tid = threadId;

    const exchange: Exchange = {
      id: crypto.randomUUID(),
      turnId: null,
      userTurnId: null,
      idx: null,
      question: text,
      text: "",
      thinking: "",
      chips: [],
      answer: null,
      error: null,
      streaming: true,
      provider: choice?.providerId ?? "",
      model: choice?.model ?? "",
      ...(opts?.tabName ? { tabName: opts.tabName } : {}),
      ...(opts?.context ? { context: opts.context } : {}),
      ...(askedFrom ? { askedFrom } : {}),
    };
    set((s) => ({
      exchanges: { ...s.exchanges, [tid]: [...(s.exchanges[tid] ?? []), exchange] },
      busy: { ...s.busy, [tid]: true },
    }));

    if (!snapshot) {
      failExchange(set, tid, exchange.id, "provider", "the schema for this connection is not loaded yet");
      return;
    }
    if (!choice) {
      failExchange(set, tid, exchange.id, "provider", "no model is configured. Choose one in Settings › Models");
      return;
    }
    await runInto(set, get, {
      profileId,
      threadId: tid,
      exchangeId: exchange.id,
      question: text,
      askText: text,
      snapshot,
      choice,
      mentions,
      ...(rowContext ? { rowContext } : {}),
    });
  },

  askAbout: (block) => {
    const profileId = get().activeProfileId;
    if (!profileId) return;
    useAsk.getState().rememberBlock(block);
    // the pane opens in Ask and never closes: `Ask` on a block is a request
    // to write, not a radio press (AGENT-UX section 1)
    useSidePane.getState().show("ask");
    // the token, then a space: the caret parks after it exactly as a pick
    // from the `@` popover leaves it (AGENT-UX 1a). A block with no name to
    // quote (an empty note) gets the composer and no token: `@""` names
    // nothing and would sit in the draft as a tag that never resolves
    const name = block.name.trim();
    if (name) useAsk.getState().prefill(profileId, `${canonicalToken("block", block)} `);
    else useAsk.getState().requestFocus();
  },

  cancel: () => {
    const profileId = get().activeProfileId;
    const threadId = profileId ? get().activeThread[profileId] : null;
    if (!threadId) return;
    const controller = controllers.get(threadId);
    if (controller) controller.abort();
    else cancelRequested.add(threadId);
    // the loop stops asking, and the session stops working: a probe that is
    // already in flight belongs to the database, not to the AbortController
    const sessionId = get().sessions[threadId];
    if (sessionId) void cancelSession(sessionId).catch(() => {});
  },

  toggleAssumption: async (exchangeId, chipId) => {
    const profileId = get().activeProfileId;
    if (!profileId) return;
    const threadId = get().activeThread[profileId];
    if (!threadId) return;
    if (get().busy[threadId]) return;
    const exchange = (get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId);
    const chip = exchange?.answer?.assumptions.find((a) => a.id === chipId);
    if (!exchange || !chip) return;
    const snapshot = useSchema.getState().snapshots[profileId];
    const choice = modelChoice(profileId);
    if (!snapshot || !choice) return;
    const mentions = mentionsFor(get, profileId, threadId, exchange.question);

    // v1 re-asks with the assumption stated as a constraint rather than
    // rewriting the SQL: the model knows which predicate the words meant, and
    // a text rewrite of someone else's query is how a silent wrong answer
    // gets made (DECISIONS, this wave).
    const flipped = !chip.active;
    const askText =
      `${exchange.question}\n\nAdditional constraint: ` +
      (flipped ? `apply this assumption: ${chip.label}` : `do not apply this assumption: ${chip.label}`);

    rearm(set, threadId, exchangeId);
    await runInto(set, get, {
      profileId,
      threadId,
      exchangeId,
      question: exchange.question,
      askText,
      snapshot,
      choice,
      mentions,
      flips: [{ id: chipId, label: chip.label, active: flipped }],
    });
  },

  togglePending: (exchangeId, chipId) => {
    const found = findExchange(get, exchangeId);
    if (!found || get().busy[found.threadId]) return;
    const chip = found.exchange.answer?.assumptions.find((a) => a.id === chipId);
    if (!chip) return;
    set((s) => {
      const mine = { ...(s.pending[exchangeId] ?? {}) };
      const wanted = !(chipId in mine ? mine[chipId] : chip.active);
      if (wanted === chip.active) delete mine[chipId];
      else mine[chipId] = wanted;
      return {
        pending:
          Object.keys(mine).length === 0
            ? without(s.pending, exchangeId)
            : { ...s.pending, [exchangeId]: mine },
      };
    });
  },

  discardPending: (exchangeId) => set((s) => ({ pending: without(s.pending, exchangeId) })),

  applyPending: async (exchangeId) => {
    const found = locateExchange(get, exchangeId);
    if (!found) return;
    const { profileId, threadId, exchange, snapshot, choice, mentions } = found;
    const flips = pendingFlips(exchange, get().pending[exchangeId]);
    if (flips.length === 0) return;
    // the toggleAssumption shape, every flip listed: the model knows which
    // predicate the words meant, and a text rewrite of its query is how a
    // silent wrong answer gets made
    const askText =
      `${exchange.question}\n\nAdditional constraint${flips.length > 1 ? "s" : ""}: ` +
      flips
        .map((f) =>
          f.active ? `apply this assumption: ${f.label}` : `do not apply this assumption: ${f.label}`,
        )
        .join("; ");
    rearm(set, threadId, exchangeId);
    await runInto(set, get, {
      profileId,
      threadId,
      exchangeId,
      question: exchange.question,
      askText,
      snapshot,
      choice,
      mentions,
      flips,
    });
  },

  fixIt: async (exchangeId, sql) => {
    const found = locateExchange(get, exchangeId);
    if (!found) return;
    const { profileId, threadId, exchange, snapshot, choice, mentions } = found;
    const reason = exchange.error?.message ?? "the last query failed";
    // the same re-ask shape as a chip toggle: the model gets the question, the
    // failure, and the user's corrected SQL as the starting point; it never
    // gets someone else's query silently rewritten for it
    const askText =
      `${exchange.question}\n\nThe previous attempt failed: ${reason}\n` +
      `Start from this SQL, corrected where needed:\n${sql.trim()}`;
    rearm(set, threadId, exchangeId);
    await runInto(set, get, {
      profileId,
      threadId,
      exchangeId,
      question: exchange.question,
      askText,
      snapshot,
      choice,
      mentions,
    });
  },

  retry: async (exchangeId) => {
    const found = locateExchange(get, exchangeId);
    if (!found) return;
    const { profileId, threadId, exchange, snapshot, choice, mentions } = found;
    rearm(set, threadId, exchangeId);
    await runInto(set, get, {
      profileId,
      threadId,
      exchangeId,
      question: exchange.question,
      askText: exchange.question,
      snapshot,
      choice,
      mentions,
    });
  },

  continueFrom: async (exchangeId) => {
    const found = locateExchange(get, exchangeId);
    if (!found) return;
    const { profileId, threadId, exchange, snapshot, choice, mentions } = found;
    // only a run the cap cut short has somewhere to continue from; every
    // other failure is a Retry, and an answered exchange is finished
    if (exchange.error?.kind !== "turncap") return;
    // no cut and no re-mint: the point is the session that already holds the
    // inspection, so the model picks up where it stopped instead of paying
    // for describe and peek a second time
    rearm(set, threadId, exchangeId);
    await runInto(set, get, {
      profileId,
      threadId,
      exchangeId,
      question: exchange.question,
      askText: CONTINUE_ASK,
      snapshot,
      choice,
      mentions,
      persistUserTurn: false,
    });
  },

  truncateThread: async (threadId, fromExchangeId, inclusive) => {
    // everything the cut depends on, read before the first await (LESSONS 3)
    if (get().busy[threadId]) return;
    const exchanges = get().exchanges[threadId] ?? [];
    const at = exchanges.findIndex((e) => e.id === fromExchangeId);
    if (at < 0) return;
    const keep = inclusive ? at : at + 1;
    // a cut that removes nothing is not a cut: the provider still remembers
    // exactly what is on screen, so its session stands
    if (keep >= exchanges.length) return;
    const gone = exchanges.slice(keep);
    set((s) => {
      let pending = s.pending;
      for (const e of gone) pending = without(pending, e.id);
      return { exchanges: { ...s.exchanges, [threadId]: exchanges.slice(0, keep) }, pending };
    });
    // claude -p resumes a session that remembers the cut turns and cannot be
    // rewound: the thread starts a new one, and its first call replays what
    // the cut kept (runInto)
    const sessionKey = mintSessionKey(set, get, threadId);
    // the cut NAMES its rows, because no boundary describes them: an exchange
    // whose run failed before persist() owns none, and a Retry on it writes
    // its pair after its own successors', so neither the row count nor the id
    // order of a thread says where the cut falls
    const cutRows = gone.flatMap(rowsOf);
    try {
      if (cutRows.length > 0) await agentThreadTruncate(threadId, cutRows);
      await agentThreadSessionSet(threadId, sessionKey);
    } catch (e) {
      // history is a convenience: a lost write costs the thread its record of
      // the cut, never the thread on screen
      console.error("agent thread truncate failed", e);
    }
  },

  askFrom: async (exchangeId, question) => {
    const text = question.trim();
    if (!text) return;
    const found = findExchange(get, exchangeId);
    if (!found || get().busy[found.threadId]) return;
    await get().truncateThread(found.threadId, exchangeId, true);
    // the cut's appdb round trip is a gap the user can switch threads in, and
    // ask() writes to whatever is on screen then (LESSONS 3): the send is
    // checked against the thread it was aimed at before it lands
    const profileId = get().activeProfileId;
    if (!profileId || get().activeThread[profileId] !== found.threadId) return;
    // ask() appends to the truncated thread, so the new exchange lands on the
    // spot the edited one stood on, turn rows included
    await get().ask(text);
  },

  restartFrom: async (exchangeId) => {
    const found = locateExchange(get, exchangeId);
    if (!found) return;
    const { profileId, threadId, exchange, snapshot, choice, mentions } = found;
    const exchanges = get().exchanges[threadId] ?? [];
    const at = exchanges.findIndex((e) => e.id === exchangeId);
    // W7: a Restart that resumed the session answered from memory in five
    // seconds with no tool call, which is a repeat, not a restart. Every
    // Restart re-mints, so the model inspects the database again; the cut
    // takes what came AFTER (the answers below would answer a question that
    // is being asked again), and the newest exchange, with nothing after it,
    // re-mints on its own
    if (at >= 0 && at + 1 < exchanges.length) {
      await get().truncateThread(threadId, exchangeId, false);
    } else {
      const sessionKey = mintSessionKey(set, get, threadId);
      try {
        await agentThreadSessionSet(threadId, sessionKey);
      } catch (e) {
        console.error("agent thread session set failed", e);
      }
    }
    // the answer is forgotten, not kept on screen: the chips have to be what
    // the user watches. `prior` still holds it, so a Stop puts it back
    rearm(set, threadId, exchangeId, true);
    await runInto(set, get, {
      profileId,
      threadId,
      exchangeId,
      question: exchange.question,
      askText: exchange.question,
      snapshot,
      choice,
      mentions,
    });
  },

  runWrite: async (exchangeId) => {
    // everything the run depends on, read BEFORE the first await (LESSONS 3):
    // the tab this lands in is chosen from the connection that is on screen
    // NOW, and the statement is the one the user is looking at
    const profileId = get().activeProfileId;
    if (!profileId) return;
    const threadId = get().activeThread[profileId];
    if (!threadId || get().busy[threadId]) return;
    const exchange = (get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId);
    // only a standing proposal runs, and only once: `ran` is the record that
    // the statement already reached a tab, and a second press must not send
    // it twice. Undoing one is the tab's transaction, not another run
    if (!exchange || exchange.status !== "proposed" || get().writing[exchangeId]) return;
    const sql = exchange.answer?.sql;
    if (!sql) return;
    set((s) => ({ writing: { ...s.writing, [exchangeId]: true } }));
    let out: Awaited<ReturnType<typeof runInTab>> | null = null;
    try {
      out = await runner.runInTab(profileId, sql, title(exchange.question));
    } catch (e) {
      // the tab's own pane carries what went wrong; the proposal stands
      console.error("agent write run failed", e);
    }
    set((s) => ({ writing: without(s.writing, exchangeId) }));
    // a confirm said no, another query held the tab, or the statement errored
    // there: the proposal stands exactly as it was, and the tab shows why,
    // which is where the user was looking when it happened
    if (!out || !out.ran || out.error !== null) return;
    const landed = out;
    const rows = landed.rows ?? 0;
    patchExchange(set, threadId, exchangeId, (e) => ({
      ...e,
      status: "ran",
      ranRows: rows,
      ranTab: landed.tabKey,
    }));
    await persistRan(get, threadId, exchangeId, rows);
  },

  closeThread: async (threadId) => {
    controllers.get(threadId)?.abort();
    controllers.delete(threadId);
    resumed.delete(threadId);
    const sessionId = get().sessions[threadId];
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[threadId];
      return { sessions };
    });
    if (sessionId) await disconnect(sessionId).catch(() => {});
  },

  dropProfile: async (profileId) => {
    const ids = (get().threads[profileId] ?? []).map((t) => t.id);
    for (const id of ids) await get().closeThread(id);
    set((s) => ({ activeThread: { ...s.activeThread, [profileId]: null } }));
  },

  deleteAllThreads: async (profileId) => {
    // ids captured before the first await (LESSONS 3); each delete goes
    // through deleteThread so a session closes before its rows go, and a
    // failure midway leaves the rest for the reload to show truthfully
    const ids = (get().threads[profileId] ?? []).map((t) => t.id);
    try {
      for (const id of ids) await get().deleteThread(profileId, id);
    } finally {
      await get().loadThreads(profileId);
    }
  },

  explainWithAsk: async (sql, tabName) => {
    const statement = clip(sql.trim());
    if (!statement) return;
    const name = oneLine(tabName);
    // the tab is named the way a saved query and a thread are, quoted, and by
    // the same writer (canonicalToken), so the echo wears one pill and the
    // model reads one line under the tags
    await get().ask(name ? `Explain this query ${canonicalToken("tab", { name })}` : "Explain this query", {
      context: name ? `tab "${name}":\n${statement}` : `tab:\n${statement}`,
      ...(name ? { tabName: name } : {}),
    });
  },

  askWhy: async (check) => {
    const name = oneLine(check.name);
    if (!name) return;
    // the drift the failed row already prints: one reading of one fact, in
    // the row and in the question's context line (LESSONS 13)
    const drift = driftLabel(check);
    const token = canonicalToken("saved", { id: check.id, name, sql: check.sql });
    await get().ask(`Why did ${token} fail its check?`, {
      context: drift ? `check "${name}": ${drift}` : `check "${name}"`,
    });
  },
}));

/** whitespace collapsed onto one line: a tag's token cannot hold a newline
 * and neither can a context line's head */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// ---- the one place a run is driven ----------------------------------------

type Setter = (fn: (s: AgentState) => Partial<AgentState>) => void;

/** Everything a re-run of an existing exchange depends on, captured in one
 * go BEFORE any await (LESSONS 3). Null when the exchange is gone or the
 * connection has no schema or model to run with. */
function locateExchange(get: () => AgentState, exchangeId: string) {
  const profileId = get().activeProfileId;
  if (!profileId) return null;
  const threadId = get().activeThread[profileId];
  if (!threadId || get().busy[threadId]) return null;
  const exchange = (get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId);
  if (!exchange) return null;
  const snapshot = useSchema.getState().snapshots[profileId];
  const choice = modelChoice(profileId);
  if (!snapshot || !choice) return null;
  // the question is re-asked as the user wrote it, tags included: they are
  // resolved again HERE, against the connection as it stands now, so a table
  // dropped since the first ask simply stops being context (LESSONS 5)
  const mentions = mentionsFor(get, profileId, threadId, exchange.question);
  return { profileId, threadId, exchange, snapshot, choice, mentions };
}

/** The `@` tags of one question, resolved against this connection as it
 * stands: its snapshot, the bookmarks it sees, its OTHER threads. Sync by
 * design, so every caller can run it before its first await (LESSONS 3), and
 * built fresh each time: a resolution cache is a stale cache. */
function mentionsFor(
  get: () => AgentState,
  profileId: string,
  threadId: string | null,
  text: string,
): Mention[] {
  const raw = parseMentions(text);
  if (raw.length === 0) return [];
  return resolveMentions(raw, {
    snapshot: useSchema.getState().snapshots[profileId],
    saved: visibleSaved(useSaved.getState().queries, profileId),
    threads: get().threads[profileId] ?? [],
    currentThreadId: threadId,
    blocks: Object.values(useAsk.getState().blocks),
  });
}

/** the appdb rows an exchange owns: its question's turn and its answer's, by
 * the ids their writes returned. An exchange whose run failed before persist()
 * owns none, and a Retry on such an exchange writes its rows after everything
 * that already stood below it, so these ids are the only honest account of
 * what a cut removes (AGENT-SPEC §9) */
function rowsOf(e: Exchange): number[] {
  const rows: number[] = [];
  if (e.userTurnId != null) rows.push(e.userTurnId);
  if (e.turnId !== null) rows.push(e.turnId);
  return rows;
}

/** the connection a thread belongs to, from the loaded lists rather than
 * from what is on screen: a cut is about the thread it names, not about the
 * navigation (LESSONS 4) */
function profileOf(get: () => AgentState, threadId: string): string | null {
  for (const [profileId, threads] of Object.entries(get().threads)) {
    if (threads.some((t) => t.id === threadId)) return profileId;
  }
  return null;
}

/** Put a brand-new provider session key on a thread and forget that the old
 * one was ever resumed. `claude -p` resumes a session that remembers every
 * turn and cannot be rewound, so a cut (W4) and a Restart (W7) both need one
 * the provider has never heard; the next run replays what stands (cutPending,
 * read in runInto). Sync, so the key is on screen before any await; the
 * caller writes it to appdb.
 *
 * The one place this shape lives: two callers minting their own uuid is two
 * accounts of which session a thread is on. */
function mintSessionKey(set: Setter, get: () => AgentState, threadId: string): string {
  const profileId = profileOf(get, threadId);
  const sessionKey = crypto.randomUUID();
  set((s) => ({
    threads: profileId
      ? {
          ...s.threads,
          [profileId]: (s.threads[profileId] ?? []).map((t) =>
            t.id === threadId ? { ...t, sessionKey } : t,
          ),
        }
      : s.threads,
  }));
  resumed.delete(threadId);
  cutPending.add(threadId);
  return sessionKey;
}

/** the provider session a thread resumes: its own key, or the thread id for
 * every thread that has never been cut */
function threadSession(get: () => AgentState, threadId: string): string {
  const profileId = profileOf(get, threadId);
  const thread = profileId
    ? (get().threads[profileId] ?? []).find((t) => t.id === threadId)
    : undefined;
  return thread?.sessionKey ?? threadId;
}

/** How much of a cut thread's replay the model is given. Two thousand
 * characters is a few hundred tokens: enough for the four or five exchanges a
 * follow-up actually refers back to, small enough that a long thread's first
 * question after a cut is not mostly history. */
const REPLAY_CAP = 2000;

/** The little an exchange contributes to a replay. Exchange satisfies it;
 * so does a pair of appdb turns, which is what a `@thread` tag replays. */
interface ReplayExchange {
  question: string;
  text: string;
  answer: { sql: string | null; text: string } | null;
}

/** The kept exchanges as the first call after a cut states them: one block
 * each, oldest dropped first until the whole fits under the cap. Sent as a
 * prefix of the user message and nowhere else, so PROMPT_VERSION and the
 * eval's prompt bytes do not move (loop.ts withReplay). A `@thread` tag
 * replays another thread through this same helper, headless and under its
 * own cap, because two replay formats would drift apart by the second one. */
export function replayOf(
  exchanges: readonly ReplayExchange[],
  opts: { head?: string; cap?: number } = {},
): string {
  const head = opts.head ?? "Earlier in this thread:";
  const cap = opts.cap ?? REPLAY_CAP;
  const blocks = exchanges.map((e) => {
    const sql = e.answer?.sql ?? null;
    const said = firstSentence(answerText(e.answer?.text ?? e.text));
    return `Q: ${e.question}\nSQL: ${sql ?? "none"}\nA: ${said || "none"}`;
  });
  const body = () => blocks.join("\n\n");
  const size = () => (head ? head.length + 2 : 0) + body().length;
  while (blocks.length > 0 && size() > cap) blocks.shift();
  if (blocks.length === 0) return "";
  return head ? `${head}\n\n${body()}` : body();
}

/** A tagged thread's exchanges, rebuilt from its appdb rows the way a
 * reloaded thread rebuilds them (openThread): each user turn with the
 * assistant turn that answered it, and the SQL out of the verdict its answer
 * row recorded. The text is the fallback only when it FENCED its SQL:
 * extractSql falls back to `how: "raw"` and returns the whole prose, and a
 * paragraph sent under `SQL:` is a lie the model reads as one (LESSONS 9).
 * An exchange with neither replays as `SQL: none`, which is the truth. */
export function replayPairs(
  turns: readonly AgentTurn[],
  answers: readonly AgentAnswer[] = [],
): ReplayExchange[] {
  const byTurn = new Map(answers.map((a) => [a.turn_id, a]));
  const out: ReplayExchange[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      out.push({ question: turn.content, text: "", answer: null });
      continue;
    }
    if (turn.role !== "assistant") continue;
    const current = out[out.length - 1];
    if (!current) continue;
    const found = extractSql(turn.content);
    current.text = turn.content;
    current.answer = {
      sql: byTurn.get(turn.id)?.sql ?? (found.how === "raw" ? null : found.sql),
      text: turn.content,
    };
  }
  return out;
}

/** Fill each `@thread` tag with the replay the loop sends under it: one
 * round trip per tagged thread, on the way to the run and never during
 * resolution, which is sync by law. History is a convenience (the cut's
 * rule): a thread whose rows cannot be read is still tagged, by name, with
 * no replay under it. */
async function withThreadReplays(mentions: readonly Mention[]): Promise<Mention[]> {
  if (!mentions.some((m) => m.kind === "thread")) return [...mentions];
  const out: Mention[] = [];
  for (const m of mentions) {
    if (m.kind !== "thread") {
      out.push(m);
      continue;
    }
    let replay = "";
    try {
      // what was said and what was concluded, the two tables openThread reads
      const [turns, answers] = await Promise.all([
        agentTurnsList(m.ref.id),
        agentAnswersList(m.ref.id),
      ]);
      replay = replayOf(replayPairs(turns, answers), { head: "", cap: MENTION_TEXT_CAP });
    } catch (e) {
      console.error("agent thread replay failed", e);
    }
    out.push(replay ? { ...m, ref: { ...m.ref, replay } } : m);
  }
  return out;
}

/** How many answered questions the EARLIER ANSWERS block picks from. The
 * block sends at most three; the rest are the pool it scores against this
 * question's words (prompt.ts historyMessage). */
const HISTORY_READ = 20;

/** This connection's earlier answers. History is a convenience, the same rule
 * a tagged thread's replay follows: a read that fails costs the question
 * nothing and the run goes on without it (LESSONS 5). */
async function historyFor(profileId: string): Promise<AgentHistoryPair[]> {
  try {
    return await agentHistoryPairs(profileId, HISTORY_READ);
  } catch (e) {
    console.error("agent history read failed", e);
    return [];
  }
}

/** the answer in one line: its first sentence, whitespace collapsed */
function firstSentence(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  const end = flat.match(/^.*?[.!?](?=\s|$)/);
  return (end ? end[0] : flat).slice(0, 300);
}

/** the exchange by id in the connection's active thread; null when gone */
function findExchange(get: () => AgentState, exchangeId: string) {
  const profileId = get().activeProfileId;
  const threadId = profileId ? get().activeThread[profileId] : null;
  if (!threadId) return null;
  const exchange = (get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId);
  return exchange ? { threadId, exchange } : null;
}

/** put an exchange back into its streaming shape for a re-run, with its
 * landed shape stashed as `prior`: the strip shows the new run's chips while
 * the old prose, grid and footer stay on screen (text deltas are held back
 * until the verdict, see runInto), and a cancel restores the stash exactly */
function rearm(set: Setter, threadId: string, exchangeId: string, forget = false) {
  set((s) => ({
    exchanges: {
      ...s.exchanges,
      [threadId]: (s.exchanges[threadId] ?? []).map((e) =>
        e.id === exchangeId ? stashPrior(e, forget) : e,
      ),
    },
    busy: { ...s.busy, [threadId]: true },
  }));
}

/** the retry's opening move: keep what is on screen, clear what the new run
 * writes (chips, error, thinking); the text stays visible as the prior prose */
export function stashPrior(e: Exchange, forget = false): Exchange {
  const stashed: Exchange = {
    ...e,
    prior: {
      text: e.text,
      thinking: e.thinking,
      chips: e.chips,
      answer: e.answer,
      error: e.error,
      write: writeState(e),
    },
    streaming: true,
    chips: [],
    error: null,
    thinking: "",
  };
  // a Restart forgets this exchange's own answer (W7): the run has to look
  // like a run, so the slot empties and the new text streams into it. A4: the
  // proposal it forgets takes its dry run with it, or the block would stand
  // over a preview of an answer that is no longer on screen. The stash still
  // holds both, and a Stop puts them back exactly
  return forget
    ? { ...clearWrite(stashed), forgot: true, text: "", textStale: false, answer: null }
    : stashed;
}

/** a cancelled retry: the exchange exactly as it was before rearm() */
export function restorePrior(e: Exchange): Exchange {
  if (!e.prior) return { ...e, streaming: false };
  const { prior, forgot: _forgot, ...rest } = e;
  return {
    ...clearWrite(rest),
    ...(prior.write ?? {}),
    text: prior.text,
    thinking: prior.thinking,
    chips: prior.chips,
    answer: prior.answer,
    error: prior.error,
    streaming: false,
  };
}

/** the write state an exchange carries right now, sparse: a key it does not
 * have is not written, so a stash and a restore are exact inverses */
function writeState(e: Exchange): WriteState {
  const out: WriteState = {};
  if (e.status !== undefined) out.status = e.status;
  if (e.preview !== undefined) out.preview = e.preview;
  if (e.ranRows !== undefined) out.ranRows = e.ranRows;
  if (e.ranTab !== undefined) out.ranTab = e.ranTab;
  return out;
}

/** A4: a new verdict over an exchange takes whatever the last one left with
 * it. A Restart over a proposal must not leave the old dry run, its row count
 * or its tab standing under a new answer, which is the same rule as never
 * repainting one connection's rows under another's chrome (LESSONS 4). */
function clearWrite(e: Exchange): Exchange {
  if (
    e.status === undefined &&
    e.preview === undefined &&
    e.ranRows === undefined &&
    e.ranTab === undefined
  ) {
    return e;
  }
  const { status: _s, preview: _p, ranRows: _r, ranTab: _t, ...rest } = e;
  return rest;
}

/** the same question answered from the live stores for the run being sent,
 * with the gate reached through the seam so a test can stand its own in. The
 * prod flag is the PROFILE's, never the rail's (LESSONS 4). */
function writeMode(profileId: string): WriteMode {
  const prod =
    useConnections.getState().profiles.find((p) => p.id === profileId)?.is_prod === true;
  return {
    on: writesAllowed(useSettings.getState().agentWrites, profileId, prod),
    prod,
    isWrite: (sql) => runner.isWrite(sql),
  };
}

/** A4: the verb of a statement, for a `ran` exchange reloaded from appdb,
 * whose dry run is long gone (it was a dry run of a moment that has passed
 * and nothing persists it). The statement itself is what appdb kept, and its
 * head is the honest source for the headline's verb. */
export function writeVerbOf(sql: string | null): WriteVerb | null {
  const head = (sql ? headToken(sql) : "").toUpperCase();
  return head === "INSERT" || head === "UPDATE" || head === "DELETE" ? head : null;
}

/** a verdict landed: the prior has been replaced */
function dropPrior(e: Exchange): Exchange {
  if (!e.prior) return e;
  const { prior: _prior, forgot: _forgot, ...rest } = e;
  return rest;
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** the flips a pending set asks of an answer's chips, in chip order; a chip
 * the answer no longer has is dropped rather than invented */
export function pendingFlips(exchange: Exchange, wanted: Record<string, boolean> | undefined): Flip[] {
  if (!wanted) return [];
  const out: Flip[] = [];
  for (const c of exchange.answer?.assumptions ?? []) {
    const w = wanted[c.id];
    if (w !== undefined && w !== c.active) out.push({ id: c.id, label: c.label, active: w });
  }
  return out;
}

/** the retry pill's face for one exchange's pending set (control register:
 * Title Case per WRITING rule 1, `with` lowercase as a short preposition; no
 * ellipsis, it acts). Exactly one chip turned off names it in the singular;
 * only chips turned off, the plural; any chip turned on is a change */
export function retryLabel(pending: Record<string, boolean>): string {
  const wanted = Object.values(pending);
  if (wanted.length === 0 || wanted.some((on) => on)) return "Retry with Changes";
  return wanted.length === 1 ? "Retry Without Assumption" : "Retry Without Assumptions";
}

/** the exchange the pill targets: the newest one with a non-empty pending set */
export function pendingTarget(
  exchanges: readonly Exchange[],
  pending: Record<string, Record<string, boolean>>,
): string | null {
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const set = pending[exchanges[i].id];
    if (set && Object.keys(set).length > 0) return exchanges[i].id;
  }
  return null;
}

/** a run that ended in a cancel: a retry puts its prior answer back exactly
 * (nothing was lost, and the pending set stays so the pill returns); a fresh
 * question keeps `cancelled` with its partial text (AGENT-UX 7) */
function cancelExchange(set: Setter, threadId: string, exchangeId: string, clearBusy: boolean) {
  patchExchange(set, threadId, exchangeId, (e) =>
    e.prior
      ? restorePrior(e)
      : { ...e, streaming: false, error: { kind: "cancelled", message: "cancelled" } },
  );
  if (clearBusy) set((s) => ({ busy: { ...s.busy, [threadId]: false } }));
}

function patchExchange(
  set: Setter,
  threadId: string,
  exchangeId: string,
  fn: (e: Exchange) => Exchange,
) {
  set((s) => ({
    exchanges: {
      ...s.exchanges,
      [threadId]: (s.exchanges[threadId] ?? []).map((e) => (e.id === exchangeId ? fn(e) : e)),
    },
  }));
}

function failExchange(
  set: Setter,
  threadId: string,
  exchangeId: string,
  kind: AskErrorKind,
  message: string,
) {
  patchExchange(set, threadId, exchangeId, (e) => ({
    ...e,
    streaming: false,
    error: { kind, message },
  }));
  set((s) => ({ busy: { ...s.busy, [threadId]: false } }));
}

interface RunArgs {
  profileId: string;
  threadId: string;
  exchangeId: string;
  /** what the user typed, echoed and persisted */
  question: string;
  /** what the model is asked, which a chip toggle extends */
  askText: string;
  snapshot: ReturnType<typeof useSchema.getState>["snapshots"][string];
  choice: ModelChoice;
  /** the question's `@` tags, resolved by the caller before its first await */
  mentions?: Mention[];
  /** A4 item 7: the row Record View attached with `Ask to Edit`, already
   * taken from the seam by the caller before its first await. Rides in the
   * mention grammar's own `TAGGED BY THE USER:` block, under the table's
   * line, so a sentence like `set status to shipped` can be answered with a
   * WHERE that names THIS row */
  rowContext?: string;
  /** chip states the user chose, reapplied to the landed chips whatever the
   * re-run's own Assumptions line said */
  flips?: Flip[];
  /** false for a Continue (W7): the run is not a new question, so it creates
   * no rows. It rewrites the ones the capped run left, and a capped run that
   * left none leaves history as it found it */
  persistUserTurn?: boolean;
}

async function runInto(set: Setter, get: () => AgentState, args: RunArgs) {
  const { threadId, exchangeId, profileId } = args;
  cancelRequested.delete(threadId);
  // A4: the connection's edits permission, read before the first await like
  // every other thing this run depends on (LESSONS 3)
  const writes = writeMode(profileId);
  // the follow-up row leaves the instant a question is sent (W7): it belongs
  // to the thread as it stood, and a chip beside a running question suggests
  // what to ask next while the last thing asked has no answer. A cancelled
  // retry is no verdict, so its row comes back with everything else
  const keptFollowUps = get().followUps[threadId];
  set((s) => ({ followUps: without(s.followUps, threadId) }));
  // the session the provider resumes and, after a cut, the transcript of what
  // the cut kept: both read before the first await (LESSONS 3). The exchange
  // being asked is not in its own replay
  const sessionKey = threadSession(get, threadId);
  // what this connection knows, read here with everything else the run
  // depends on (LESSONS 3). The rows load with the connection, oldest first,
  // which is the order the prompt's capped block drops from
  const knowledge: KnowledgeRow[] = useKnowledge.getState().rows[profileId] ?? [];
  const onScreen = get().exchanges[threadId] ?? [];
  const asked = onScreen.findIndex((e) => e.id === exchangeId);
  // what a code entry point attached to this question, read off the exchange
  // so every re-run (Retry, Fix It, Restart, a chip toggle) asks with it
  // again rather than only the first send
  const attached = asked < 0 ? undefined : onScreen[asked].context;
  const replay = cutPending.has(threadId)
    ? replayOf(asked < 0 ? onScreen : onScreen.slice(0, asked))
    : "";
  let sessionId = get().sessions[threadId];
  if (!sessionId) {
    try {
      sessionId = await agentConnect(profileId);
    } catch (e) {
      failExchange(set, threadId, exchangeId, "provider", firstLine(e));
      return;
    }
    set((s) => ({ sessions: { ...s.sessions, [threadId]: sessionId } }));
  }
  if (cancelRequested.delete(threadId)) {
    // cancelled while connecting: the session is kept for the next question,
    // the question itself never reaches the model
    cancelExchange(set, threadId, exchangeId, true);
    return;
  }

  const controller = new AbortController();
  controllers.get(threadId)?.abort();
  controllers.set(threadId, controller);
  // a run superseded by a newer ask()/toggle on the same thread must not
  // clear the flags the live run owns when its own (aborted) work settles
  const authoritative = () => controllers.get(threadId) === controller;

  const onEvent = (ev: AskEvent) => {
    switch (ev.type) {
      case "status":
        set((s) => ({ phase: { ...s.phase, [threadId]: ev.phase } }));
        break;
      case "toolStart":
        patchExchange(set, threadId, exchangeId, (e) => ({
          ...e,
          chips: [
            ...e.chips,
            {
              id: ev.id,
              name: ev.name,
              label: ev.label,
              ms: null,
              isError: false,
              args: ev.args,
              result: null,
            },
          ],
        }));
        break;
      case "toolEnd":
        patchExchange(set, threadId, exchangeId, (e) => ({
          ...e,
          chips: e.chips.map((c) =>
            c.id === ev.id
              ? { ...c, ms: ev.ms, isError: ev.isError, args: ev.args || c.args, result: ev.result }
              : c,
          ),
        }));
        break;
      case "text":
        // a retry keeps the prior prose on screen until its verdict lands
        // (the landed answer.text replaces it then); a fresh question, and a
        // Restart that forgot its answer, stream into an empty slot
        patchExchange(set, threadId, exchangeId, (e) =>
          e.prior && !e.forgot
            ? e
            : e.textStale
              ? { ...e, text: ev.delta, textStale: false }
              : { ...e, text: e.text + ev.delta },
        );
        break;
      case "narration":
        // a tool call closed the block: it belongs to the trace, and the block
        // that follows replaces it on screen when its first delta lands; until
        // then the prose stays (a blank slot under running chips read as lost
        // text, and a SQL-only closing block never replaces it at all)
        patchExchange(set, threadId, exchangeId, (e) =>
          e.prior && !e.forgot ? e : { ...e, textStale: true },
        );
        break;
      case "thinking":
        patchExchange(set, threadId, exchangeId, (e) => ({
          ...e,
          thinking: e.thinking + ev.delta,
        }));
        break;
      case "error":
        patchExchange(set, threadId, exchangeId, (e) => ({
          ...e,
          error:
            ev.retryAfterMs !== undefined
              ? { kind: ev.kind, message: ev.message, retryAfterMs: ev.retryAfterMs }
              : { kind: ev.kind, message: ev.message },
        }));
        break;
      default:
        break;
    }
  };

  let answer: AskAnswer;
  let provider: Provider;
  try {
    // a persisted provider id no adapter claims throws here, inside the same
    // net as the run: the exchange fails with the message, busy clears
    provider = providerFor(args.choice, tauriPlatform);
    const [mentions, history] = await Promise.all([
      withThreadReplays(args.mentions ?? []),
      historyFor(profileId),
    ]);
    answer = await runner.runAsk({
      question: args.askText,
      snapshot: args.snapshot,
      tools: createTauriTools({ sessionId, snapshot: args.snapshot }),
      provider,
      model: args.choice.model,
      tier: tierOf(args.choice.model, args.choice.providerId).tier,
      signal: controller.signal,
      thread: replay
        ? { id: threadId, session: sessionKey, firstCall: !resumed.has(threadId), replay }
        : { id: threadId, session: sessionKey, firstCall: !resumed.has(threadId) },
      // A4: what this connection lets the model propose, read at the run's
      // entry rather than at its verdict minutes later, when the switch may
      // have moved (LESSONS 3)
      writes,
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(args.rowContext ? { rowContext: args.rowContext } : {}),
      ...(attached ? { context: attached } : {}),
      knowledge,
      history,
      onEvent,
    });
    resumed.add(threadId);
    // the replay is carried once: a run that never landed keeps it for the
    // next attempt, since its session may never have heard the history
    cutPending.delete(threadId);
  } catch (e) {
    const mine = authoritative();
    if (mine) controllers.delete(threadId);
    if (controller.signal.aborted) {
      // the loop answers a cancel with a verdict; a throw under an aborted
      // signal is the same cancel from outside it and settles the same way
      cancelExchange(set, threadId, exchangeId, mine);
      return;
    }
    patchExchange(set, threadId, exchangeId, (x) => ({
      ...dropPrior(x),
      streaming: false,
      error: { kind: "provider", message: firstLine(e) },
    }));
    set((s) => ({ pending: without(s.pending, exchangeId) }));
    if (mine) set((s) => ({ busy: { ...s.busy, [threadId]: false } }));
    return;
  }
  const mine = authoritative();

  const landed: AskAnswer = { ...answer, assumptions: applyFlips(answer.assumptions, args.flips ?? []) };
  // a cancelled retry is no verdict on the question: the prior answer comes
  // back exactly and its pending set stays, so the pill returns; every other
  // verdict replaces the prior and settles the set (the landed chips already
  // wear the flips)
  const cancelledRetry =
    answer.verdict.status === "cancelled" &&
    !!(get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId)?.prior;
  // A4: the loop finished, the exchange did not. A proposal's other half is
  // its dry run (AGENT-UX 13.2), so the exchange keeps its streaming face
  // (the strip's `preview` chip spins in it) and the thread stays busy until
  // that lands. The controller stays registered with it, or ⌘. would reach
  // nothing while the pane says work is happening
  const proposal =
    !cancelledRetry && mine && landed.verdict.status === "proposed" ? landed.verdict.sql : null;
  if (mine && proposal === null) controllers.delete(threadId);
  if (cancelledRetry) {
    patchExchange(set, threadId, exchangeId, restorePrior);
    // a Stop costs nothing (AGENT-UX 7), the row of chips included
    if (keptFollowUps) set((s) => ({ followUps: { ...s.followUps, [threadId]: keptFollowUps } }));
  } else {
    patchExchange(set, threadId, exchangeId, (e) => ({
      ...clearWrite(dropPrior(e)),
      streaming: proposal !== null,
      text: answer.text || e.text,
      answer: landed,
      ...(proposal !== null ? { status: "proposed" as const } : {}),
    }));
    set((s) => ({ pending: without(s.pending, exchangeId) }));
  }
  if (mine) {
    set((s) => ({
      busy: { ...s.busy, [threadId]: proposal !== null },
      phase: { ...s.phase, [threadId]: proposal !== null ? "running" : null },
    }));
  }
  // the verdict on screen is still the prior one, and so is appdb's row: a
  // cancelled retry must not write `cancelled` over an answered turn
  if (cancelledRetry) return;

  // the answer is on screen; the follow-up chips arrive when they exist
  // (AGENT-UX 2), on the same signal so a cancel or a newer ask ends them
  if (mine && answer.verdict.status === "answered") {
    void followUpsInto(set, get, {
      threadId,
      exchangeId,
      landed,
      provider,
      model: args.choice.model,
      signal: controller.signal,
    });
  }

  await persist(set, get, args, landed);

  // the dry run comes after the answer is on screen and its row is written,
  // so a preview that fails or is stopped costs the exchange nothing it
  // already had: the statement stands, with Insert as its manual route
  if (proposal !== null) {
    await previewInto(set, { profileId, threadId, exchangeId, sql: proposal, controller });
  }
}

/** A4 item 3: the dry run behind a proposal (AGENT-UX 13.2). It runs on its
 * own short-lived session in Rust and always rolls back, so the only thing
 * that can be lost here is the preview itself: a failure leaves the exchange
 * a proposal with no band, and a Stop leaves it exactly the same with the
 * chip wearing the hollow ring a stopped call wears (LESSONS 9). */
async function previewInto(
  set: Setter,
  args: {
    profileId: string;
    threadId: string;
    exchangeId: string;
    sql: string;
    controller: AbortController;
  },
) {
  const { threadId, exchangeId, controller } = args;
  const chipId = `preview-${exchangeId}`;
  // the chip goes up BEFORE the call: a pane that sits still while work
  // happens is a pane that reads as broken
  patchExchange(set, threadId, exchangeId, (e) => ({
    ...e,
    chips: [
      ...e.chips,
      { id: chipId, name: "preview", label: "preview", ms: null, isError: false, args: "", result: null },
    ],
  }));
  const started = Date.now();
  const settle = () => {
    patchExchange(set, threadId, exchangeId, (e) => ({ ...e, streaming: false }));
    if (controllers.get(threadId) !== controller) return;
    controllers.delete(threadId);
    set((s) => ({ busy: { ...s.busy, [threadId]: false }, phase: { ...s.phase, [threadId]: null } }));
  };
  // a Stop lands the moment it is pressed, not when the round trip returns:
  // the IPC cannot be recalled, and Rust rolls its transaction back either way
  let stopped = false;
  const onStop = () => {
    stopped = true;
    settle();
  };
  controller.signal.addEventListener("abort", onStop, { once: true });
  let preview: WritePreview | null = null;
  let failure = "";
  try {
    preview = await runner.writePreview(args.profileId, args.sql, previewTimeoutMs());
  } catch (e) {
    failure = firstLine(e);
  }
  controller.signal.removeEventListener("abort", onStop);
  if (stopped) return;
  patchExchange(set, threadId, exchangeId, (e) => ({
    ...e,
    preview,
    chips: e.chips.map((c) =>
      c.id === chipId
        ? {
            ...c,
            ms: Math.round(Date.now() - started),
            isError: preview === null,
            result: preview === null ? failure : "",
          }
        : c,
    ),
  }));
  settle();
}

/** The dry run's own timeout, read the way `run_sql`'s is (tools.tauri.ts):
 * the statement_timeout setting, and the section 5 default when it is 0,
 * which means "no timeout" for a SESSION and is not a shape one statement
 * inside a rolled-back transaction has. */
function previewTimeoutMs(): number {
  const ms = useSettings.getState().statementTimeoutSecs * 1000;
  return ms > 0 ? ms : RUN_SQL_TIMEOUT_MS;
}

/** The follow-up call (AGENT-SPEC 4.6) for a THREAD (W7). The chips stand
 * once, under the last answer, so what they suggest is read from the whole
 * conversation: the same compact transcript a cut replays (`replayOf`, one
 * Q / SQL / first sentence per exchange, oldest dropped under the cap).
 *
 * The result lands only while the answer that asked for it is still the
 * exchange's: a re-run that replaced it in the meantime keeps its own state.
 * The call is recorded as a trace step on that answer, because nothing sent
 * to a provider is hidden (spec 8.4). */
async function followUpsInto(
  set: Setter,
  get: () => AgentState,
  args: {
    threadId: string;
    exchangeId: string;
    landed: AskAnswer;
    provider: Provider;
    model: string;
    signal: AbortSignal;
  },
) {
  const { threadId, exchangeId, landed } = args;
  const onScreen = get().exchanges[threadId] ?? [];
  if (!onScreen.some((e) => e.id === exchangeId)) return;
  const out = await runner.suggestFollowUps({
    thread: replayOf(onScreen, { head: "" }),
    asked: onScreen.map((e) => e.question),
    provider: args.provider,
    model: args.model,
    signal: args.signal,
  });
  if (!out.step) return;
  const step = out.step;
  if ((get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId)?.answer !== landed) return;
  set((s) => ({ followUps: { ...s.followUps, [threadId]: out.questions } }));
  patchExchange(set, threadId, exchangeId, (e) =>
    e.answer === landed ? { ...e, answer: { ...landed, trace: [...landed.trace, step] } } : e,
  );
}

/** The toggled chip keeps the state the user chose, whatever the re-run's own
 * assumptions line said; if the model dropped it entirely, it is still shown,
 * because the user turned it off on purpose. */
function applyFlip(chips: Assumption[], flip: Flip): Assumption[] {
  const hit = chips.find((c) => c.id === flip.id || c.label === flip.label);
  if (hit) return chips.map((c) => (c === hit ? { ...c, active: flip.active } : c));
  return [...chips, { id: flip.id, label: flip.label, source: "model", active: flip.active }];
}

export function applyFlips(chips: Assumption[], flips: readonly Flip[]): Assumption[] {
  let out = chips;
  for (const flip of flips) out = applyFlip(out, flip);
  return out;
}

/** The `idx` a new pair takes: the slot after the nearest EARLIER exchange
 * that owns rows (0 when there is none), and, when the nearest LATER one is
 * already sitting there, the slot the tail was shifted out of.
 *
 * Neighbours, never the position on screen: a reloaded thread compacts over
 * the exchange that failed before persisting, so position × 2 lands on rows
 * the thread is still showing (LESSONS 1). The shift and the insert are two
 * IPC calls rather than one transaction, accepted deliberately: a failure
 * between them leaves a hole in the indices, which nothing reads, where a
 * shared slot would pair an answer with somebody else's question. */
async function allocateIdx(
  set: Setter,
  threadId: string,
  exchanges: readonly Exchange[],
  at: number,
): Promise<number> {
  let prev: number | null = null;
  for (let i = at - 1; i >= 0 && prev === null; i--) prev = exchanges[i].idx ?? null;
  let next: number | null = null;
  for (let i = at + 1; i < exchanges.length && next === null; i++) next = exchanges[i].idx ?? null;
  const base = prev === null ? 0 : prev + 2;
  if (next !== null && next < base + 2) {
    const from = next;
    const by = base + 2 - from;
    await agentTurnsShift(threadId, from, by);
    // the rows moved, so the exchanges holding them move with them: the state
    // is the only account of which slot belongs to whom until the next reload
    set((s) => ({
      exchanges: {
        ...s.exchanges,
        [threadId]: (s.exchanges[threadId] ?? []).map((e) =>
          e.idx != null && e.idx >= from ? { ...e, idx: e.idx + by } : e,
        ),
      },
    }));
  }
  return base;
}

async function persist(set: Setter, get: () => AgentState, args: RunArgs, answer: AskAnswer) {
  const { threadId, exchangeId } = args;
  const provider = args.choice.providerId;
  const model = args.choice.model;
  const exchanges = get().exchanges[threadId] ?? [];
  const at = exchanges.findIndex((e) => e.id === exchangeId);
  // a cut or a closed thread took the exchange off screen while the answer was
  // still in the air: writing it now would leave a row no thread shows
  if (at < 0) return;
  const existing = exchanges[at];
  const calls: ToolCallRecord[] = [];
  const results: ToolResultRecord[] = [];
  for (const step of answer.trace) {
    if (step.step !== "tool") continue;
    calls.push({ id: step.id, name: step.name, args: step.args });
    results.push({ id: step.id, name: step.name, result: step.result, isError: step.isError });
  }
  const said = {
    content: answer.text,
    tool_calls_json: JSON.stringify(calls),
    tool_results_json: JSON.stringify(results),
    usage_json: JSON.stringify(answer.usage),
    model,
    provider,
    prompt_version: answer.promptVersion,
    ms: answer.ms,
  };
  try {
    let turnId = existing.turnId;
    if (turnId === null) {
      // a Continue is not a new question (W7): it has only the rows the
      // capped run left to rewrite, and a run that left none leaves history
      // as it found it rather than writing an answer with no question
      if (args.persistUserTurn === false) return;
      // `idx` is the thread's order: the question's slot and its answer's one
      // above it, ALLOCATED BETWEEN NEIGHBOURS (allocateIdx) and never read
      // out of the exchange's position on screen. A position is not a slot: a
      // reload compacts over the gap an exchange that failed before persisting
      // leaves, while every row keeps the idx it was written with, so a
      // position doubled would hand the next question the slots the last kept
      // exchange is already using (LESSONS 1, AGENT-SPEC §9). Gaps in the
      // indices are fine and expected; a collision costs an answer its
      // question, so the tail is shifted whenever a slot is not free
      let idx = existing.idx ?? null;
      if (idx === null) {
        idx = await allocateIdx(set, threadId, exchanges, at);
        // recorded before the row that takes it, so a failed write reuses the
        // slot the shift already freed instead of shifting a second time
        const allocated = idx;
        patchExchange(set, threadId, exchangeId, (e) => ({ ...e, idx: allocated }));
      }
      let userTurnId = existing.userTurnId ?? null;
      if (userTurnId === null) {
        userTurnId = await agentTurnAdd({
          thread_id: threadId,
          idx,
          role: "user",
          content: args.question,
          model,
          provider,
          prompt_version: answer.promptVersion,
          ms: 0,
        });
        // recorded before the answer's own write, so a failure there costs the
        // answer row and never leaves the question written twice
        patchExchange(set, threadId, exchangeId, (e) => ({ ...e, userTurnId }));
      }
      turnId = await agentTurnAdd({ thread_id: threadId, idx: idx + 1, role: "assistant", ...said });
      patchExchange(set, threadId, exchangeId, (e) => ({ ...e, turnId }));
    } else {
      // a re-run answers the same question in the same place: the turn is
      // rewritten, or a reload pairs the old prose with the new SQL and shows
      // an answer nobody was given (LESSONS 1)
      await agentTurnUpdate({ id: turnId, ...said });
    }
    await agentAnswerPut({
      turn_id: turnId,
      sql: answer.sql,
      row_count: answer.run?.rowCount ?? null,
      assumptions_json: JSON.stringify(answer.assumptions),
      sanity_json: JSON.stringify(answer.sanity),
      status: answer.verdict.status,
    });
  } catch (e) {
    // history is a convenience; losing it must never cost the answer on screen
    console.error("agent history write failed", e);
  }
}

/** A4: the proposal ran, so its answer row moves from `proposed` to `ran` and
 * carries the rows the TAB affected (AGENT-SPEC 9). One `agentAnswerPut`, the
 * same one every verdict writes: no new table and no migration this wave, and
 * whether that run was committed is the tab's transaction to say, never a
 * column here. History is a convenience: losing it costs the record, never
 * what is on screen. */
async function persistRan(
  get: () => AgentState,
  threadId: string,
  exchangeId: string,
  rows: number,
) {
  const exchange = (get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId);
  const answer = exchange?.answer;
  if (!exchange || !answer || exchange.turnId === null) return;
  try {
    await agentAnswerPut({
      turn_id: exchange.turnId,
      sql: answer.sql,
      row_count: rows,
      assumptions_json: JSON.stringify(answer.assumptions),
      sanity_json: JSON.stringify(answer.sanity),
      status: "ran",
    });
  } catch (e) {
    console.error("agent history write failed", e);
  }
}

function firstLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.split("\n")[0].trim() || "the request failed";
}
