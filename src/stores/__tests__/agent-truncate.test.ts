// Jumping back (W4): a cut takes the exchanges after it out of the state and
// out of appdb, mints the thread a provider session that never heard them,
// and hands the next run a compact replay of what it kept. Restart cuts what
// came after and re-mints on every exchange (W7: a resumed session answers
// from memory instead of inspecting), a send from edit mode cuts inclusive
// and lands the new question on the spot the old one stood, turn rows
// included. And every pair of rows takes an `idx` allocated between its
// NEIGHBOURS, which is what keeps a reloaded thread's answers on the
// questions they answered.
//
// W7 also lives here: Continue resumes the SAME session after a turn cap and
// creates no rows, and the follow-up chips belong to the THREAD, one row read
// from the whole conversation and gone the instant a question is sent.
//
// The loop is stood in through the store's `runner` seam and the backend
// through Tauri's own mock transport (@tauri-apps/api/mocks), so every
// `invoke` this file drives is recorded in the order the store made it. The
// mock keeps the turn rows it is handed, so a test can relaunch the app over
// a thread it just wrote and read back exactly what appdb would hold.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { baseAgentSettings, minimalSnapshot } from "./fixtures";

// agent.ts pulls in settings.ts, which paints the theme onto the document at
// import, and sidePane.ts, which reads localStorage; bun has neither. An
// in-memory storage and a do-nothing element stand in and leave again after
// (bun test shares one global scope across files)
const mem = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => undefined,
});
const shimmed = ["window", "localStorage", "document"].filter((k) => !(k in globalThis));
for (const k of shimmed) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });
}

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const agent = await import("../agent");
const { useAgent, replayOf, runner } = agent;
const realFollowUps = runner.suggestFollowUps;
type Exchange = import("../agent").Exchange;
const { cancelCanvasSaves } = await import("../canvas");
const { useSchema } = await import("../schema");
const { useSettings } = await import("../settings");
type AskRequest = Parameters<typeof runner.runAsk>[0];

const realRunAsk = runner.runAsk;
// a cut removes the blocks those exchanges wrote, and the canvas schedules its
// own debounced write for it: dropped here rather than left to land on a
// transport this suite has already torn down (cancelCanvasSaves' own contract)
afterEach(() => void cancelCanvasSaves());

afterAll(() => {
  cancelCanvasSaves();
  runner.runAsk = realRunAsk;
  runner.suggestFollowUps = realFollowUps;
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- the backend seam -----------------------------------------------------------

interface Invoked {
  cmd: string;
  args: Record<string, unknown>;
}
/** an appdb turn row, as agent_turns_list hands it back */
interface TurnRow {
  id: number;
  thread_id: string;
  idx: number;
  role: string;
  content: string;
  tool_calls_json: string | null;
  tool_results_json: string | null;
  usage_json: string | null;
  model: string;
  provider: string;
  prompt_version: string;
  ms: number;
  created_at: string;
}
interface AnswerRow {
  turn_id: number;
  sql: string | null;
  row_count: number | null;
  status: string;
}
let calls: Invoked[] = [];
let nextTurnId = 100;
/** the rows appdb holds: what a write puts here is what the next reload reads */
let stored: { turns: TurnRow[]; answers: AnswerRow[] } = { turns: [], answers: [] };

function installIpc() {
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    if (cmd === "agent_turn_add") {
      const turn = args.turn as Omit<TurnRow, "id" | "created_at">;
      const id = nextTurnId++;
      stored.turns.push({
        ...turn,
        // the question's row is written without the answer's columns
        tool_calls_json: turn.tool_calls_json ?? null,
        tool_results_json: turn.tool_results_json ?? null,
        usage_json: turn.usage_json ?? null,
        id,
        created_at: "2026-09-06",
      });
      return id;
    }
    if (cmd === "agent_turns_shift") {
      const { threadId, fromIdx, by } = args as { threadId: string; fromIdx: number; by: number };
      for (const r of stored.turns) if (r.thread_id === threadId && r.idx >= fromIdx) r.idx += by;
      return undefined;
    }
    if (cmd === "agent_answer_put") {
      const answer = args.answer as AnswerRow;
      stored.answers = [...stored.answers.filter((a) => a.turn_id !== answer.turn_id), answer];
      return undefined;
    }
    if (cmd === "agent_connect") return "session-ipc";
    // the store's own read: thread order is `idx`, ties broken by write order
    if (cmd === "agent_turns_list") {
      return stored.turns
        .filter((r) => r.thread_id === args.threadId)
        .sort((a, b) => a.idx - b.idx || a.id - b.id);
    }
    if (cmd === "agent_answers_list") return stored.answers;
    return undefined;
  });
}

const cmds = () => calls.map((c) => c.cmd);
const argsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
/** the slots the writes since the last reset asked for, in write order */
const written = () =>
  argsOf("agent_turn_add").map((a) => {
    const turn = a.turn as { idx: number; role: string };
    return [turn.role, turn.idx];
  });

/** an appdb turn row the way a thread on record holds it */
const row = (threadId: string, id: number, idx: number, content: string): TurnRow => ({
  id,
  thread_id: threadId,
  idx,
  role: idx % 2 === 0 ? "user" : "assistant",
  content,
  tool_calls_json: null,
  tool_results_json: null,
  usage_json: null,
  model: "claude-sonnet-5",
  provider: "claude-code",
  prompt_version: "v2",
  ms: 1,
  created_at: "2026-09-06",
});

const answerRow = (turnId: number, sql: string | null, status = "answered"): AnswerRow => ({
  turn_id: turnId,
  sql,
  row_count: 1,
  status,
});

// ---- the loop seam --------------------------------------------------------------

/** every request the store handed the loop, and the exchange shape the store
 * was in when it did (a re-run's `prior` is only visible mid-flight) */
let seen: { req: AskRequest; priorAt: (Exchange | undefined)[] }[] = [];

const answeredRun: typeof realRunAsk = async (req) => {
  seen.push({
    req,
    priorAt: (useAgent.getState().exchanges[TID] ?? []).map((e) => (e.prior ? e : undefined)),
  });
  req.onEvent?.({ type: "text", delta: "answered." });
  return {
    verdict: { status: "answered", sql: "SELECT 3", rowCount: 1 },
    sql: "SELECT 3",
    run: { columns: ["n"], rows: [["3"]], rowCount: 1, capped: false, ms: 2 },
    assumptions: [],
    sanity: [],
    trace: [],
    text: "answered.",
    turns: 1,
    ms: 7,
    usage: { input: 1, output: 1 },
    promptVersion: "v2",
    candidates: [],
    recall: null,
    risky: false,
  };
};

/** every follow-up call the store made, and the three questions it answers
 * with (the side call itself is a model call; the seam stands in for it) */
let followUpCalls: { thread: string; asked: string[] }[] = [];
const CHIPS = ["Which store rents the most?", "Which rating sells best?", "What is the average length?"];
const scriptedFollowUps: typeof realFollowUps = async (req) => {
  followUpCalls.push({ thread: req.thread, asked: req.asked });
  return {
    questions: CHIPS,
    step: { step: "followups", ms: 12, prompt: req.thread, text: CHIPS.join("\n"), questions: CHIPS },
  };
};

/** a provider that never reaches the model: the exchange takes a provider
 * error and persist() never runs, so it owns no appdb rows */
const failingRun: typeof realRunAsk = async () => {
  throw new Error("the provider is not configured");
};

// ---- seed -----------------------------------------------------------------------

const PID = "p";
const TID = "t";

function exchange(n: number): Exchange {
  return {
    id: `ex-${n}`,
    turnId: 10 + n,
    userTurnId: 40 + n,
    // the slot its question's row holds; its answer's is one above
    idx: n * 2,
    question: `question ${n}`,
    text: `answer ${n}. A second sentence nobody replays.`,
    thinking: "",
    chips: [],
    answer: {
      verdict: { status: "answered", sql: `SELECT ${n}`, rowCount: 1 },
      sql: `SELECT ${n}`,
      run: null,
      assumptions: [],
      sanity: [],
      trace: [],
      text: `answer ${n}. A second sentence nobody replays.`,
      turns: 1,
      ms: 10,
      usage: { input: 1, output: 1 },
      promptVersion: "v2",
      candidates: [],
      recall: null,
      risky: false,
    },
    error: null,
    streaming: false,
    provider: "claude-code",
    model: "claude-sonnet-5",
  };
}

/** a question whose provider failed before persist() ran: on screen, and in
 * appdb not at all */
function unpersisted(n: number): Exchange {
  return {
    ...exchange(n),
    turnId: null,
    userTurnId: null,
    idx: null,
    answer: null,
    text: "",
    error: { kind: "provider", message: "the provider is not configured" },
  };
}

function seed(exchanges: Exchange[] = [exchange(0), exchange(1), exchange(2)]) {
  installIpc();
  calls = [];
  seen = [];
  nextTurnId = 100;
  stored = { turns: [], answers: [] };
  followUpCalls = [];
  runner.runAsk = answeredRun;
  runner.suggestFollowUps = scriptedFollowUps;
  useSettings.setState(baseAgentSettings());
  useSchema.setState({ snapshots: { [PID]: minimalSnapshot() } });
  useAgent.setState({
    activeProfileId: PID,
    threads: { [PID]: [{ id: TID, profileId: PID, title: "Jump back", createdAt: "2026-09-06" }] },
    activeThread: { [PID]: TID },
    exchanges: { [TID]: exchanges },
    sessions: { [TID]: "session-1" },
    busy: { [TID]: false },
    phase: { [TID]: null },
    pending: {},
    followUps: {},
  });
}

/** a thread the store has never run: closeThread is how the app forgets that
 * a provider session was resumed, and `resumed` outlives one test */
const fresh = async () => {
  await useAgent.getState().closeThread(TID);
  seed();
};

const thread = () => (useAgent.getState().threads[PID] ?? [])[0];
const ids = () => (useAgent.getState().exchanges[TID] ?? []).map((e) => e.id);

/** what a relaunch does: the thread is read back out of appdb instead of out
 * of what this session already had on screen */
async function reload(threadId: string) {
  useAgent.setState((s) => {
    const exchanges = { ...s.exchanges };
    delete exchanges[threadId];
    return { exchanges };
  });
  await useAgent.getState().openThread(PID, threadId);
}

// ---- tests ------------------------------------------------------------------------

describe("truncateThread", () => {
  beforeEach(fresh);

  test("an inclusive cut drops the exchange and everything after it, in appdb too", async () => {
    useAgent.setState((s) => ({
      pending: { ...s.pending, "ex-2": { c: true }, "ex-1": { c: true }, "ex-0": { c: true } },
    }));
    await useAgent.getState().truncateThread(TID, "ex-1", true);

    expect(ids()).toEqual(["ex-0"]);
    // the cut exchanges' pending sets go with them; the kept one's stays
    expect(Object.keys(useAgent.getState().pending)).toEqual(["ex-0"]);
    expect(cmds()).toEqual(["agent_thread_truncate", "agent_thread_session_set"]);
    // the cut names the four rows the two dropped exchanges own
    expect(argsOf("agent_thread_truncate")[0]).toEqual({ threadId: TID, turnIds: [41, 11, 42, 12] });
    const key = thread().sessionKey;
    expect(key).toBeString();
    expect(key).not.toBe(TID);
    expect(argsOf("agent_thread_session_set")[0]).toEqual({ threadId: TID, sessionKey: key });
  });

  test("an exclusive cut keeps the exchange it names", async () => {
    await useAgent.getState().truncateThread(TID, "ex-1", false);
    expect(ids()).toEqual(["ex-0", "ex-1"]);
    expect(argsOf("agent_thread_truncate")[0]).toEqual({ threadId: TID, turnIds: [42, 12] });
  });

  test("a busy thread, an unknown exchange and a cut that removes nothing are no-ops", async () => {
    useAgent.setState((s) => ({ busy: { ...s.busy, [TID]: true } }));
    await useAgent.getState().truncateThread(TID, "ex-1", true);
    useAgent.setState((s) => ({ busy: { ...s.busy, [TID]: false } }));
    await useAgent.getState().truncateThread(TID, "nope", true);
    // the newest exchange has nothing after it: its session still remembers
    // exactly what is on screen
    await useAgent.getState().truncateThread(TID, "ex-2", false);
    expect(ids()).toEqual(["ex-0", "ex-1", "ex-2"]);
    expect(calls).toEqual([]);
    expect(thread().sessionKey).toBeUndefined();
  });

  test("an exchange that never reached appdb names no rows", async () => {
    seed([exchange(0), unpersisted(1), exchange(2)]);
    await useAgent.getState().truncateThread(TID, "ex-1", true);

    expect(ids()).toEqual(["ex-0"]);
    // ex-1 owns nothing, so only ex-2's pair is named
    expect(argsOf("agent_thread_truncate")[0]).toEqual({ threadId: TID, turnIds: [42, 12] });
  });

  test("a cut with nothing on record still mints the session and asks appdb for nothing", async () => {
    seed([exchange(0), unpersisted(1)]);
    await useAgent.getState().truncateThread(TID, "ex-1", true);

    expect(ids()).toEqual(["ex-0"]);
    expect(cmds()).toEqual(["agent_thread_session_set"]);
  });

  test("a Retry on an older exchange stays out of the next cut's way", async () => {
    // the S1 route: the second question fails, the third lands, and the Retry
    // on the second writes its rows LAST. A cut that read a boundary out of
    // the row count or the id order would keep the third and delete the second
    seed([]);
    await useAgent.getState().ask("question 0");
    runner.runAsk = failingRun;
    await useAgent.getState().ask("question 1");
    runner.runAsk = answeredRun;
    await useAgent.getState().ask("question 2");
    const [, failed, latest] = useAgent.getState().exchanges[TID];
    await useAgent.getState().retry(failed.id);

    // the third question took the slots after the first (the failed one owns
    // none), and the Retry shifted it up to take them for itself
    expect(written()).toEqual([
      ["user", 0],
      ["assistant", 1],
      ["user", 2],
      ["assistant", 3],
      ["user", 2],
      ["assistant", 3],
    ]);
    expect(argsOf("agent_turns_shift")[0]).toEqual({ threadId: TID, fromIdx: 2, by: 2 });
    expect(failed.turnId).toBeNull();
    expect(useAgent.getState().exchanges[TID][1].turnId).toBe(105);

    calls = [];
    await useAgent.getState().truncateThread(TID, latest.id, true);
    expect(argsOf("agent_thread_truncate")[0]).toEqual({ threadId: TID, turnIds: [102, 103] });
    expect(useAgent.getState().exchanges[TID].map((e) => e.question)).toEqual([
      "question 0",
      "question 1",
    ]);
  });

  test("a failed appdb write costs the record of the cut, never the thread on screen", async () => {
    mockIPC((cmd) => {
      if (cmd === "agent_thread_truncate") throw new Error("appdb is gone");
      return undefined;
    });
    await useAgent.getState().truncateThread(TID, "ex-1", true);
    expect(ids()).toEqual(["ex-0"]);
  });
});

describe("askFrom", () => {
  beforeEach(fresh);

  test("the new question lands where the edited one stood, turn rows included", async () => {
    await useAgent.getState().askFrom("ex-1", "  a better question 1  ");

    expect(ids()[0]).toBe("ex-0");
    const landed = (useAgent.getState().exchanges[TID] ?? [])[1];
    expect(ids()).toHaveLength(2);
    expect(landed.question).toBe("a better question 1");
    expect(landed.answer?.verdict.status).toBe("answered");
    // the new pair takes the slots after the exchange the cut kept, which are
    // the ones the cut freed
    expect(written()).toEqual([
      ["user", 2],
      ["assistant", 3],
    ]);
    expect(cmds()).not.toContain("agent_turns_shift");
    // both ids come back onto the exchange, so the next cut can count its rows
    expect(landed.userTurnId).toBe(100);
    expect(landed.turnId).toBe(101);
    expect(useAgent.getState().busy[TID]).toBe(false);
  });

  test("the first run after a cut carries the kept exchanges, the next carries none", async () => {
    await useAgent.getState().askFrom("ex-1", "a better question 1");
    const replay = seen[0].req.thread?.replay ?? "";
    expect(replay).toStartWith("Earlier in this thread:");
    expect(replay).toContain("Q: question 0");
    expect(replay).toContain("SQL: SELECT 0");
    expect(replay).toContain("A: answer 0.");
    // the exchange being asked is not in its own replay, and neither is the
    // one the cut deleted
    expect(replay).not.toContain("question 1");
    expect(replay).not.toContain("question 2");
    // the cut minted the session, so this is a first call again
    expect(seen[0].req.thread?.session).toBe(thread().sessionKey);
    expect(seen[0].req.thread?.firstCall).toBe(true);

    await useAgent.getState().ask("and one more");
    expect(seen[1].req.thread?.replay).toBeUndefined();
    expect(seen[1].req.thread?.firstCall).toBe(false);
    expect(seen[1].req.thread?.session).toBe(thread().sessionKey);
  });

  test("an empty question and a busy thread ask nothing", async () => {
    await useAgent.getState().askFrom("ex-1", "   ");
    useAgent.setState((s) => ({ busy: { ...s.busy, [TID]: true } }));
    await useAgent.getState().askFrom("ex-1", "a better question");
    expect(ids()).toEqual(["ex-0", "ex-1", "ex-2"]);
    expect(seen).toEqual([]);
  });
});

describe("restartFrom", () => {
  beforeEach(fresh);

  // W7: a Restart used to be a Retry on the newest exchange, which resumed
  // the session; the model answered from memory in five seconds with no tool
  // call. Every Restart now re-mints, and the newest one has nothing to cut
  test("the latest exchange cuts nothing and still re-mints the session", async () => {
    await useAgent.getState().restartFrom("ex-2");
    expect(ids()).toEqual(["ex-0", "ex-1", "ex-2"]);
    expect(cmds()).not.toContain("agent_thread_truncate");
    expect(cmds()).toContain("agent_thread_session_set");
    const key = thread().sessionKey;
    expect(key).not.toBe(TID);
    expect(seen[0].req.thread?.session).toBe(key);
    expect(seen[0].req.thread?.firstCall).toBe(true);
    // the session has never heard the thread, so the run carries what stands
    // BEFORE this exchange, and never its own question
    expect(seen[0].req.thread?.replay).toContain("Q: question 1");
    expect(seen[0].req.thread?.replay).not.toContain("Q: question 2");
    // mid-flight the exchange wore its landed shape as `prior`, and nothing
    // of it was on screen: the strip has to be what the user watches
    expect(seen[0].priorAt[2]?.prior?.answer?.sql).toBe("SELECT 2");
    expect(seen[0].priorAt[2]?.answer).toBeNull();
    expect(seen[0].priorAt[2]?.text).toBe("");
    expect(useAgent.getState().exchanges[TID][2].prior).toBeUndefined();
    expect(useAgent.getState().exchanges[TID][2].forgot).toBeUndefined();
  });

  test("a Stop puts the forgotten answer back exactly", async () => {
    runner.runAsk = async (req) => {
      seen.push({ req, priorAt: [] });
      req.onEvent?.({ type: "text", delta: "half an answer" });
      useAgent.getState().cancel();
      return {
        verdict: { status: "cancelled", sql: null },
        sql: null,
        run: null,
        assumptions: [],
        sanity: [],
        trace: [],
        text: "",
        turns: 1,
        ms: 3,
        usage: { input: 0, output: 0 },
        promptVersion: "v2",
        candidates: [],
        recall: null,
        risky: false,
      };
    };
    await useAgent.getState().restartFrom("ex-1");
    const back = useAgent.getState().exchanges[TID][1];
    expect(back.answer?.sql).toBe("SELECT 1");
    expect(back.text).toBe("answer 1. A second sentence nobody replays.");
    expect(back.forgot).toBeUndefined();
    expect(back.prior).toBeUndefined();
    expect(back.streaming).toBe(false);
  });

  test("an older exchange cuts everything after it and re-runs its own question", async () => {
    await useAgent.getState().restartFrom("ex-1");
    expect(ids()).toEqual(["ex-0", "ex-1"]);
    expect(argsOf("agent_thread_truncate")[0]).toEqual({ threadId: TID, turnIds: [42, 12] });
    expect(seen[0].req.question).toBe("question 1");
    expect(seen[0].priorAt[1]?.prior?.answer?.sql).toBe("SELECT 1");
    // a persisted exchange keeps its rows: they are rewritten, not appended
    expect(cmds()).not.toContain("agent_turn_add");
    expect(argsOf("agent_answer_put")[0].answer).toMatchObject({ turn_id: 11, sql: "SELECT 3" });
    // its replay is the exchange before it, never itself
    expect(seen[0].req.thread?.replay).toContain("Q: question 0");
    expect(seen[0].req.thread?.replay).not.toContain("Q: question 1");
  });

  test("the re-answered turn is rewritten, so a reload reads what is on screen", async () => {
    await useAgent.getState().restartFrom("ex-1");

    const patch = argsOf("agent_turn_update")[0].turn as Record<string, unknown>;
    expect(patch).toMatchObject({ id: 11, content: "answered.", prompt_version: "v2", ms: 7 });
    // what the row says and what the bubble says are the same sentence: the
    // old prose beside the new SQL is an answer nobody was given
    expect(useAgent.getState().exchanges[TID][1].answer?.text).toBe("answered.");
  });

  test("a cut forgets that the provider was resumed", async () => {
    await useAgent.getState().ask("a first question");
    expect(seen[0].req.thread?.firstCall).toBe(true);
    await useAgent.getState().ask("a second question");
    expect(seen[1].req.thread?.firstCall).toBe(false);
    await useAgent.getState().restartFrom("ex-1");
    expect(seen[2].req.thread?.firstCall).toBe(true);
  });
});

// W7 item 5: the maintainer's run stopped at the cap, and the only way on was
// to ask again from scratch. Continue resumes the SAME session, which still
// holds the inspection, and writes no second question into the thread
describe("continueFrom", () => {
  beforeEach(fresh);

  /** the newest exchange as a capped run leaves it: a verdict, no rows lost */
  function capped(n = 2): Exchange {
    const e = exchange(n);
    return {
      ...e,
      answer: { ...e.answer!, verdict: { status: "turn_cap", sql: null, turns: 24 }, sql: null },
      error: { kind: "turncap", message: "stopped after 24 turns" },
    };
  }

  test("the same session, a fresh budget, and no re-inspection asked for", async () => {
    seed([exchange(0), exchange(1), capped()]);
    await useAgent.getState().continueFrom("ex-2");

    expect(seen[0].req.question).toContain("Continue");
    expect(seen[0].req.question).toContain("finish the answer from where you stopped");
    // the session is NOT re-minted: that is the whole point, it remembers the
    // describe and peek the capped run already paid for
    expect(cmds()).not.toContain("agent_thread_session_set");
    expect(cmds()).not.toContain("agent_thread_truncate");
    expect(seen[0].req.thread?.replay).toBeUndefined();
    expect(useAgent.getState().exchanges[TID][2].answer?.verdict.status).toBe("answered");
  });

  test("it writes no second question: the rows the capped run left are rewritten", async () => {
    seed([exchange(0), exchange(1), capped()]);
    await useAgent.getState().continueFrom("ex-2");

    expect(cmds()).not.toContain("agent_turn_add");
    expect(argsOf("agent_turn_update")[0].turn).toMatchObject({ id: 12, content: "answered." });
    // the question row still says what the user typed, never "Continue:"
    expect(useAgent.getState().exchanges[TID][2].question).toBe("question 2");
  });

  test("a capped exchange that never reached appdb leaves history as it found it", async () => {
    seed([exchange(0), { ...capped(1), turnId: null, userTurnId: null, idx: null }]);
    await useAgent.getState().continueFrom("ex-1");

    expect(seen).toHaveLength(1);
    expect(cmds()).not.toContain("agent_turn_add");
    expect(cmds()).not.toContain("agent_answer_put");
    expect(useAgent.getState().exchanges[TID][1].answer?.verdict.status).toBe("answered");
  });

  test("an answered exchange and a plain failure have nowhere to continue from", async () => {
    seed([exchange(0), exchange(1)]);
    await useAgent.getState().continueFrom("ex-1");
    useAgent.setState((s) => ({
      exchanges: {
        ...s.exchanges,
        [TID]: (s.exchanges[TID] ?? []).map((e) =>
          e.id === "ex-1" ? { ...e, error: { kind: "provider" as const, message: "no" } } : e,
        ),
      },
    }));
    await useAgent.getState().continueFrom("ex-1");
    expect(seen).toEqual([]);
  });
});

// W7 item 3: n rows of chips became one, under the last answer, read from the
// whole thread. What a thread is suggesting is the thread's, not an answer's
describe("the thread's follow-ups", () => {
  beforeEach(fresh);

  test("one call per landed answer, carrying the whole thread", async () => {
    seed([]);
    await useAgent.getState().ask("question 0");
    await useAgent.getState().ask("question 1");

    expect(followUpCalls).toHaveLength(2);
    const last = followUpCalls[1];
    expect(last.thread).toContain("Q: question 0");
    expect(last.thread).toContain("Q: question 1");
    expect(last.thread).toContain("SQL: SELECT 3");
    // no heading: the store's transcript, not a cut's replay
    expect(last.thread).not.toContain("Earlier in this thread");
    expect(last.asked).toEqual(["question 0", "question 1"]);
    expect(useAgent.getState().followUps[TID]).toEqual(CHIPS);
  });

  test("the row leaves the instant a question is sent", async () => {
    seed([]);
    await useAgent.getState().ask("question 0");
    expect(useAgent.getState().followUps[TID]).toEqual(CHIPS);

    let duringRun: string[] | undefined = CHIPS;
    runner.runAsk = async (req) => {
      duringRun = useAgent.getState().followUps[TID];
      return answeredRun(req);
    };
    await useAgent.getState().ask("question 1");
    expect(duringRun).toBeUndefined();
  });

  test("a Stop costs nothing, the row included", async () => {
    seed([]);
    await useAgent.getState().ask("question 0");
    const exchangeId = useAgent.getState().exchanges[TID][0].id;

    runner.runAsk = async () => {
      useAgent.getState().cancel();
      return {
        verdict: { status: "cancelled", sql: null },
        sql: null,
        run: null,
        assumptions: [],
        sanity: [],
        trace: [],
        text: "",
        turns: 1,
        ms: 1,
        usage: { input: 0, output: 0 },
        promptVersion: "v2",
        candidates: [],
        recall: null,
        risky: false,
      };
    };
    await useAgent.getState().retry(exchangeId);
    expect(useAgent.getState().followUps[TID]).toEqual(CHIPS);
  });

  test("a deleted thread takes its row with it", async () => {
    seed([]);
    await useAgent.getState().ask("question 0");
    await useAgent.getState().deleteThread(PID, TID);
    expect(useAgent.getState().followUps[TID]).toBeUndefined();
  });

  test("a reloaded thread recomputes them from what appdb kept", async () => {
    seed();
    const RTID = "t-followups";
    stored = {
      turns: [row(RTID, 1, 0, "Q1"), row(RTID, 2, 1, "A1.")],
      answers: [answerRow(2, "SELECT 1")],
    };
    useAgent.setState((s) => ({
      threads: {
        [PID]: [...(s.threads[PID] ?? []), { id: RTID, profileId: PID, title: "Reloaded", createdAt: "2026-09-06" }],
      },
    }));
    await useAgent.getState().openThread(PID, RTID);
    // the follow-up call is fired and not awaited: let its microtask land
    await Promise.resolve();
    await Promise.resolve();
    expect(useAgent.getState().followUps[RTID]).toEqual(CHIPS);
    expect(followUpCalls[followUpCalls.length - 1].thread).toContain("Q: Q1");
  });
});

describe("the replay", () => {
  test("one block per exchange: the question, the SQL it settled on, the first sentence", () => {
    const e = exchange(0);
    expect(replayOf([e])).toBe(
      "Earlier in this thread:\n\nQ: question 0\nSQL: SELECT 0\nA: answer 0.",
    );
  });

  test("an exchange with no answer says so rather than inventing one", () => {
    const e = { ...exchange(0), answer: null, text: "" };
    expect(replayOf([e])).toContain("SQL: none\nA: none");
  });

  test("the anatomy's own rows never reach it twice", () => {
    // the fence and the Assumptions line belong to the SQL row and the chips
    const e = {
      ...exchange(0),
      answer: {
        ...exchange(0).answer!,
        text: "Nine films.\n\n```sql\nSELECT 1\n```\nAssumptions: none",
      },
    };
    expect(replayOf([e])).toBe("Earlier in this thread:\n\nQ: question 0\nSQL: SELECT 0\nA: Nine films.");
  });

  test("a long thread drops its oldest exchanges first and stays under the cap", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      ...exchange(i),
      question: `question ${i} ${"x".repeat(120)}`,
    }));
    const out = replayOf(long);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("Q: question 39");
    expect(out).not.toContain("Q: question 0 ");
    expect(replayOf([])).toBe("");
  });
});

describe("a thread rebuilt from appdb", () => {
  const RTID = "t-reload";

  test("the cut names the rows the thread kept, not twice its position", async () => {
    seed();
    // a thread whose second question failed before persist() ran: idx 2 and 3
    // were never written, so every later row carries an idx two ahead of the
    // position its exchange holds on screen
    stored = {
      turns: [
        row(RTID, 1, 0, "Q1"),
        row(RTID, 2, 1, "A1"),
        row(RTID, 3, 4, "Q3"),
        row(RTID, 4, 5, "A3"),
        row(RTID, 5, 6, "Q4"),
        row(RTID, 6, 7, "A4"),
      ],
      // a failed verdict on the newest answer, so the reload asks no provider
      // for follow-up chips
      answers: [answerRow(6, null, "failed")],
    };
    useAgent.setState((s) => ({
      threads: { [PID]: [...(s.threads[PID] ?? []), { id: RTID, profileId: PID, title: "Reloaded", createdAt: "2026-09-06" }] },
    }));

    await useAgent.getState().openThread(PID, RTID);
    const rebuilt = useAgent.getState().exchanges[RTID] ?? [];
    expect(rebuilt.map((e) => e.question)).toEqual(["Q1", "Q3", "Q4"]);
    // each exchange carries the slot its own row holds, not its position
    expect(rebuilt.map((e) => e.idx)).toEqual([0, 4, 6]);

    // jumping back to the third question names the two rows that question owns
    // and nothing else: a rebuilt exchange carries both of its row ids, so the
    // cut is exact even where idx (0, 1, 4, 5, 6, 7) counts something else
    await useAgent.getState().truncateThread(RTID, "turn-5", true);
    expect(argsOf("agent_thread_truncate")[0]).toEqual({ threadId: RTID, turnIds: [5, 6] });
  });
});

// The S1 the W4 gate blocked the commit on: `idx` written from the exchange's
// POSITION collided with the rows a reloaded thread was still showing, and the
// reload after that hung two answers on one question and left another with
// none. `idx` is now allocated between the pair's neighbours (LESSONS 1).
describe("the slot a new pair takes", () => {
  beforeEach(fresh);

  test("the first exchange of a thread takes 0 and 1", async () => {
    seed([]);
    await useAgent.getState().ask("the first question");
    expect(written()).toEqual([
      ["user", 0],
      ["assistant", 1],
    ]);
    expect(cmds()).not.toContain("agent_turns_shift");
  });

  test("a reloaded thread with a gap places the next pair after its neighbour, never on it", async () => {
    seed([]);
    // appdb as the S1 left it: Q1 at 0,1 and Q3 at 4,5, because the second
    // question's provider failed before persist() ran and it was never retried
    stored = {
      turns: [row(TID, 1, 0, "Q1"), row(TID, 2, 1, "A1"), row(TID, 3, 4, "Q3"), row(TID, 4, 5, "A3")],
      answers: [answerRow(2, "SELECT 1"), answerRow(4, "SELECT 3")],
    };
    await reload(TID);
    expect((useAgent.getState().exchanges[TID] ?? []).map((e) => e.question)).toEqual(["Q1", "Q3"]);

    calls = [];
    await useAgent.getState().ask("Q4");
    // the position of the new exchange is 2 and its slots are 6 and 7: the
    // reload compacted the gap, the rows did not renumber, and 4 and 5 are
    // Q3's for as long as Q3 is on screen
    expect(written()).toEqual([
      ["user", 6],
      ["assistant", 7],
    ]);
    expect(cmds()).not.toContain("agent_turns_shift");

    // the relaunch the S1 was found on: every answer still hangs on the
    // question it answered, and nothing is left without one
    await reload(TID);
    const rebuilt = useAgent.getState().exchanges[TID] ?? [];
    expect(rebuilt.map((e) => e.question)).toEqual(["Q1", "Q3", "Q4"]);
    expect(rebuilt.map((e) => e.text)).toEqual(["A1", "A3", "answered."]);
    expect(rebuilt.map((e) => [e.userTurnId, e.turnId])).toEqual([
      [1, 2],
      [3, 4],
      [100, 101],
    ]);
    expect(rebuilt.map((e) => e.idx)).toEqual([0, 4, 6]);
  });

  test("a Retry between two persisted exchanges shifts the tail out of its way", async () => {
    seed([]);
    await useAgent.getState().ask("question 0");
    runner.runAsk = failingRun;
    await useAgent.getState().ask("question 1");
    runner.runAsk = answeredRun;
    await useAgent.getState().ask("question 2");
    // the failed question owns no rows, so the third took the slots after the
    // first: there is no room left between them
    expect(written()).toEqual([
      ["user", 0],
      ["assistant", 1],
      ["user", 2],
      ["assistant", 3],
    ]);

    calls = [];
    const failed = useAgent.getState().exchanges[TID][1];
    await useAgent.getState().retry(failed.id);

    // the tail moves up first, then the pair is written into the room it made
    expect(argsOf("agent_turns_shift")[0]).toEqual({ threadId: TID, fromIdx: 2, by: 2 });
    expect(cmds().indexOf("agent_turns_shift")).toBeLessThan(cmds().indexOf("agent_turn_add"));
    expect(written()).toEqual([
      ["user", 2],
      ["assistant", 3],
    ]);
    // the exchange holding the moved rows moves with them, or the next
    // allocation would place a pair on top of them
    expect(useAgent.getState().exchanges[TID].map((e) => e.idx)).toEqual([0, 2, 4]);

    await reload(TID);
    expect((useAgent.getState().exchanges[TID] ?? []).map((e) => e.question)).toEqual([
      "question 0",
      "question 1",
      "question 2",
    ]);
  });
});
