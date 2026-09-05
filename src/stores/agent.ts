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
  agentThreadCreate,
  agentThreadDelete,
  agentThreadList,
  agentTurnAdd,
  agentTurnsList,
  cancel as cancelSession,
  disconnect,
} from "../ipc/commands";
import type { AgentTurn } from "../ipc/types";
import { useSchema } from "./schema";
import { useSettings } from "./settings";
import { createTauriTools } from "../agent/tools.tauri";
import { tauriPlatform } from "../agent/platform.tauri";
import { providerFor, tierOf } from "../agent/providers/index";
import type { Provider, ProviderId } from "../agent/providers/types";
import { runAsk, type AskAnswer, type AskErrorKind, type AskEvent, type AskPhase } from "../agent/loop";
import { suggestFollowUps } from "../agent/followups";
import { buildAssumptions, extractSql } from "../agent/extract";
import type {
  Assumption,
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
  name: ToolName;
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
  question: string;
  /** the answer slot's text: the model's last text block, streamed */
  text: string;
  thinking: string;
  chips: ToolChip[];
  answer: AskAnswer | null;
  error: { kind: AskErrorKind; message: string; retryAfterMs?: number } | null;
  streaming: boolean;
  provider: string;
  model: string;
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

  setActiveProfile: (profileId: string | null) => void;
  loadThreads: (profileId: string) => Promise<void>;
  newThread: (profileId: string) => void;
  openThread: (profileId: string, threadId: string) => Promise<void>;
  deleteThread: (profileId: string, threadId: string) => Promise<void>;
  ask: (question: string) => Promise<void>;
  cancel: () => void;
  toggleAssumption: (exchangeId: string, chipId: string) => Promise<void>;
  /** Fix It (AGENT-UX 7): one more repair pass over a failed exchange, from
   * the SQL as the user left it in the editable field */
  fixIt: (exchangeId: string, sql: string) => Promise<void>;
  /** the retry a provider error offers: the same question, asked again */
  retry: (exchangeId: string) => Promise<void>;
  /** thread closed or connection disconnected: the session goes with it */
  closeThread: (threadId: string) => Promise<void>;
  dropProfile: (profileId: string) => Promise<void>;
}

/** Not state: an AbortController is not serialisable and nothing renders it. */
const controllers = new Map<string, AbortController>();
/** threads whose user pressed cancel while no controller existed yet (the
 * first ask() is still inside agentConnect, a real wait over a bastion):
 * runInto() honours it the moment the connection lands */
const cancelRequested = new Set<string>();
/** Threads whose provider has already been given a session id to resume. */
const resumed = new Set<string>();

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

  setActiveProfile: (profileId) => set({ activeProfileId: profileId }),

  loadThreads: async (profileId) => {
    const rows = await agentThreadList(profileId);
    const threads: Thread[] = rows.map((r) => ({
      id: r.id,
      profileId: r.profile_id,
      title: r.title,
      createdAt: r.created_at,
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
        followUps: [],
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
    await agentThreadDelete(threadId);
    set((s) => {
      const exchanges = { ...s.exchanges };
      delete exchanges[threadId];
      return {
        exchanges,
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

  ask: async (question) => {
    const text = question.trim();
    if (!text) return;
    // capture everything the run depends on BEFORE the first await
    const profileId = get().activeProfileId;
    if (!profileId) return;
    const snapshot = useSchema.getState().snapshots[profileId];
    const choice = modelChoice(profileId);

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
      question: text,
      text: "",
      thinking: "",
      chips: [],
      answer: null,
      error: null,
      streaming: true,
      provider: choice?.providerId ?? "",
      model: choice?.model ?? "",
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
      persistUserTurn: true,
    });
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
      persistUserTurn: false,
      flip: { id: chipId, label: chip.label, active: flipped },
    });
  },

  fixIt: async (exchangeId, sql) => {
    const found = locateExchange(get, exchangeId);
    if (!found) return;
    const { profileId, threadId, exchange, snapshot, choice } = found;
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
      persistUserTurn: false,
    });
  },

  retry: async (exchangeId) => {
    const found = locateExchange(get, exchangeId);
    if (!found) return;
    const { profileId, threadId, exchange, snapshot, choice } = found;
    rearm(set, threadId, exchangeId);
    await runInto(set, get, {
      profileId,
      threadId,
      exchangeId,
      question: exchange.question,
      askText: exchange.question,
      snapshot,
      choice,
      // a provider failure never reached persist(): the user turn is still
      // unwritten, so this run writes it; a persisted exchange keeps its rows
      persistUserTurn: exchange.turnId === null,
    });
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
}));

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
  return { profileId, threadId, exchange, snapshot, choice };
}

/** put an exchange back into its streaming shape for a re-run: the new run's
 * prose streams fresh (text deltas append, so the old text would otherwise be
 * its prefix); the previous answer stays until the new one replaces it */
function rearm(set: Setter, threadId: string, exchangeId: string) {
  set((s) => ({
    exchanges: {
      ...s.exchanges,
      [threadId]: (s.exchanges[threadId] ?? []).map((e) =>
        e.id === exchangeId
          ? { ...e, streaming: true, chips: [], error: null, text: "", thinking: "" }
          : e,
      ),
    },
    busy: { ...s.busy, [threadId]: true },
  }));
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
  persistUserTurn: boolean;
  flip?: { id: string; label: string; active: boolean };
}

async function runInto(set: Setter, get: () => AgentState, args: RunArgs) {
  const { threadId, exchangeId, profileId } = args;
  cancelRequested.delete(threadId);
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
    failExchange(set, threadId, exchangeId, "cancelled", "cancelled");
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
        patchExchange(set, threadId, exchangeId, (e) => ({ ...e, text: e.text + ev.delta }));
        break;
      case "narration":
        // a tool call closed the block: it belongs to the trace, and the answer
        // slot starts over for the block that follows (AGENT-UX 2.3)
        patchExchange(set, threadId, exchangeId, (e) => ({ ...e, text: "" }));
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
    answer = await runAsk({
      question: args.askText,
      snapshot: args.snapshot,
      tools: createTauriTools({ sessionId, snapshot: args.snapshot }),
      provider,
      model: args.choice.model,
      tier: tierOf(args.choice.model, args.choice.providerId).tier,
      signal: controller.signal,
      thread: { id: threadId, firstCall: !resumed.has(threadId) },
      onEvent,
    });
    resumed.add(threadId);
  } catch (e) {
    const mine = authoritative();
    if (mine) controllers.delete(threadId);
    patchExchange(set, threadId, exchangeId, (x) => ({
      ...x,
      streaming: false,
      error: { kind: "provider", message: firstLine(e) },
    }));
    if (mine) set((s) => ({ busy: { ...s.busy, [threadId]: false } }));
    return;
  }
  const mine = authoritative();
  if (mine) controllers.delete(threadId);

  const assumptions = args.flip
    ? applyFlip(answer.assumptions, args.flip)
    : answer.assumptions;
  const landed: AskAnswer = { ...answer, assumptions };
  patchExchange(set, threadId, exchangeId, (e) => ({
    ...e,
    streaming: false,
    text: answer.text || e.text,
    answer: landed,
  }));
  if (mine) {
    set((s) => ({ busy: { ...s.busy, [threadId]: false }, phase: { ...s.phase, [threadId]: null } }));
  }

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
}

/** The follow-up call (AGENT-SPEC 4.6) for one landed answer. The patch lands
 * only while that same answer object is still the exchange's: a re-run that
 * replaced it in the meantime keeps its own state. The call is recorded as a
 * trace step, because nothing sent to a provider is hidden (spec 8.4). */
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
  if (args.provider.ownsLoop) return;
  const exchange = (get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId);
  if (!exchange) return;
  const asked = (get().exchanges[threadId] ?? []).map((e) => e.question);
  const out = await suggestFollowUps({
    question: exchange.question,
    answer: landed.text,
    sql: landed.sql,
    asked,
    provider: args.provider,
    model: args.model,
    signal: args.signal,
  });
  if (!out.step) return;
  const step = out.step;
  patchExchange(set, threadId, exchangeId, (e) =>
    e.answer === landed
      ? { ...e, answer: { ...landed, followUps: out.questions, trace: [...landed.trace, step] } }
      : e,
  );
}

/** The toggled chip keeps the state the user chose, whatever the re-run's own
 * assumptions line said; if the model dropped it entirely, it is still shown,
 * because the user turned it off on purpose. */
function applyFlip(
  chips: Assumption[],
  flip: { id: string; label: string; active: boolean },
): Assumption[] {
  const hit = chips.find((c) => c.id === flip.id || c.label === flip.label);
  if (hit) return chips.map((c) => (c === hit ? { ...c, active: flip.active } : c));
  return [...chips, { id: flip.id, label: flip.label, source: "model", active: flip.active }];
}

async function persist(set: Setter, get: () => AgentState, args: RunArgs, answer: AskAnswer) {
  const { threadId, exchangeId } = args;
  const provider = args.choice.providerId;
  const model = args.choice.model;
  const existing = (get().exchanges[threadId] ?? []).find((e) => e.id === exchangeId);
  try {
    let turnId = existing?.turnId ?? null;
    if (turnId === null) {
      const idx = (get().exchanges[threadId] ?? []).length * 2;
      if (args.persistUserTurn) {
        await agentTurnAdd({
          thread_id: threadId,
          idx: Math.max(idx - 2, 0),
          role: "user",
          content: args.question,
          model,
          provider,
          prompt_version: answer.promptVersion,
          ms: 0,
        });
      }
      const calls: ToolCallRecord[] = [];
      const results: ToolResultRecord[] = [];
      for (const step of answer.trace) {
        if (step.step !== "tool") continue;
        calls.push({ id: step.id, name: step.name, args: step.args });
        results.push({ id: step.id, name: step.name, result: step.result, isError: step.isError });
      }
      turnId = await agentTurnAdd({
        thread_id: threadId,
        idx: Math.max(idx - 1, 0),
        role: "assistant",
        content: answer.text,
        tool_calls_json: JSON.stringify(calls),
        tool_results_json: JSON.stringify(results),
        usage_json: JSON.stringify(answer.usage),
        model,
        provider,
        prompt_version: answer.promptVersion,
        ms: answer.ms,
      });
      patchExchange(set, threadId, exchangeId, (e) => ({ ...e, turnId }));
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

function firstLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.split("\n")[0].trim() || "the request failed";
}
