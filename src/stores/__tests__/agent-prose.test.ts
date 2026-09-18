// The failure KIND (E4 R4), the store's half. One question is under test:
// when does an exchange come back from appdb carrying a statement, and so
// wearing the `sql` kind and the Fix It that rides it?
//
// The answer has to be "when a statement failed" and nothing else, because
// the loop that shipped before this wave wrote the model's own prose into
// `agent_answers.sql`. A thread reopened on such a row came back with a
// paragraph in the result block's SQL face and Fix It offered over it: Fix It
// re-sent the paragraph, and the exchange spiralled. The store cannot ask the
// gate about a row it reads out of a database, so it asks the gate's own
// question itself (`opens_like_sql`, src-tauri agent.rs).
//
// Everything here goes through `openThread`, which is the path that reads
// those two tables; the backend is Tauri's own mock transport, the seam the
// other store tests use.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { CLOSING_FENCE } from "../../agent/loop";
import type { AgentAnswer, AgentTurn } from "../../ipc/types";
import { baseAgentSettings, minimalSnapshot } from "./fixtures";

// agent.ts pulls in settings.ts, which paints the theme onto the document at
// import, and sidePane.ts, which reads localStorage; bun has neither
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
// bun shares one global scope across files and every file that shims it also
// tears its own shims down, so a file that ran earlier can take `window` out
// from under this one (the agent-mentions precedent)
const STANDINS: Record<string, unknown> = {
  window: globalThis,
  localStorage: storage,
  document: inert,
};
const shimmed = new Set<string>();
function shim() {
  for (const [k, value] of Object.entries(STANDINS)) {
    if (k in globalThis) continue;
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
    shimmed.add(k);
  }
}
shim();

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { useAgent, runner } = await import("../agent");
const { useSchema } = await import("../schema");
const { useSettings } = await import("../settings");
const realRunAsk = runner.runAsk;
const realFollowUps = runner.suggestFollowUps;

afterAll(() => {
  runner.runAsk = realRunAsk;
  runner.suggestFollowUps = realFollowUps;
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

const PID = "p-prose";
const TID = "t-prose";

/** what the thread holds, rewritten by each case before it reopens */
const stored: { turns: AgentTurn[]; answers: AgentAnswer[] } = { turns: [], answers: [] };

const turn = (id: number, role: string, content: string): AgentTurn => ({
  id,
  thread_id: TID,
  idx: id - 1,
  role,
  content,
  tool_calls_json: null,
  tool_results_json: null,
  usage_json: null,
  model: "claude-haiku-4-5",
  provider: "claude-code",
  prompt_version: "v4",
  ms: 58_600,
  created_at: "2026-09-14T00:00:00Z",
});

/** the maintainer's own exchange: the question he typed and what Haiku 4.5
 * replied, which the old loop then ran as a query */
const QUESTION = '@"Canvas" what what can you create on canvas';
const PROSE =
  'The question "what can you create on canvas" is informational and requires a text answer per your instruction to "reply in text and call no tool." No SQL applies.';

const SQL = "SELECT count(*) FROM film";

const row = (sql: string | null, status: string): AgentAnswer => ({
  turn_id: 2,
  sql,
  row_count: null,
  assumptions_json: "[]",
  sanity_json: "[]",
  status,
});

beforeEach(() => {
  shim();
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (cmd === "agent_turns_list") return String(args.threadId) === TID ? stored.turns : [];
    if (cmd === "agent_answers_list") return String(args.threadId) === TID ? stored.answers : [];
    throw new Error(`no backend in this test: ${cmd}`);
  });
  // no model configured, so the reload asks for no follow-up chips: this file
  // is about what came back out of the two tables and nothing else
  useSettings.setState({ agentProvider: "", agentModel: "", agentByConn: {}, agentBaseUrls: {} });
  useAgent.setState({ exchanges: {}, activeThread: {}, threads: {} });
});

/** reopen the thread on one recorded pair and hand back the exchange */
async function reopen(text: string, answer: AgentAnswer) {
  stored.turns = [turn(1, "user", QUESTION), turn(2, "assistant", text)];
  stored.answers = [answer];
  await useAgent.getState().openThread(PID, TID);
  const list = useAgent.getState().exchanges[TID] ?? [];
  expect(list).toHaveLength(1);
  return list[0];
}

describe("a failed exchange reopened from appdb", () => {
  test("a statement that failed keeps the sql kind, and Fix It with it", async () => {
    const e = await reopen(`Here it is.\n\n\`\`\`sql\n${SQL}\n\`\`\``, row(SQL, "failed"));
    expect(e.error?.kind).toBe("sql");
    expect(e.answer?.sql).toBe(SQL);
    expect(e.answer?.verdict).toEqual({
      status: "failed",
      sql: SQL,
      message: e.error?.message ?? "",
    });
  });

  test("the model's own prose in the sql column is not a statement", async () => {
    // the row the maintainer's thread left behind. What comes back is a
    // failure of the RUN, which offers Retry and never Fix It: a paragraph
    // has nothing to fix, and re-sending it is the spiral this wave ends
    const e = await reopen(PROSE, row(PROSE, "failed"));
    expect(e.error?.kind).toBe("provider");
    expect(e.answer?.sql).toBe(null);
    expect(e.answer?.verdict.sql).toBe(null);
  });

  test("a failure that recorded no statement at all stays the run's", async () => {
    const e = await reopen("It stopped.", row(null, "failed"));
    expect(e.error?.kind).toBe("provider");
    expect(e.answer?.sql).toBe(null);
  });
});

describe("an exchange answered in prose", () => {
  test("comes back as its words, with no statement and no failure", async () => {
    // R1's own row: the model stopped with no tool call, so the loop wrote
    // `answered` with no SQL. Nothing here reads as a query or as an error
    const e = await reopen(PROSE, row(null, "answered"));
    expect(e.error).toBe(null);
    expect(e.answer?.sql).toBe(null);
    expect(e.answer?.verdict).toEqual({ status: "answered", sql: null, rowCount: null });
    expect(e.text).toBe(PROSE);
  });

  test("the prose is never re-read as this exchange's SQL", async () => {
    // extractSql's `raw` branch hands back the whole paragraph, so a turn
    // with no answer row at all is the same trap one table over (E4 R2)
    stored.turns = [turn(1, "user", QUESTION), turn(2, "assistant", PROSE)];
    stored.answers = [];
    await useAgent.getState().openThread(PID, TID);
    const e = (useAgent.getState().exchanges[TID] ?? [])[0];
    expect(e.answer?.sql).toBe(null);
    expect(e.error).toBe(null);
  });
});

// ---- R5: the call log a landed answer leaves behind -------------------------
// The trace the loop hands back can hold a run the LOOP made: a closing fence
// the model stated and never called (R2), fetched once under its own id. What
// persists is the MODEL's record, so that row is not in it: a thread reopened
// on the app's own provider must not come back wearing a second `run_sql` for
// the one statement the model wrote.

const FILMS = "SELECT count(*) FROM film";
const MODEL_CALL = "toolu_01";

/** an answered exchange whose trace holds both runs: the model's own call, and
 * the loop's fetch of the fence that closed the answer */
const bothRuns: typeof realRunAsk = async () => ({
  verdict: { status: "answered", sql: FILMS, rowCount: 1 },
  sql: FILMS,
  run: { columns: ["count"], rows: [["1000"]], rowCount: 1, capped: false, ms: 2 },
  assumptions: [],
  sanity: [],
  trace: [
    { step: "turn", ms: 9, index: 0, text: "One thousand.", usage: { input: 1, output: 1 } },
    {
      step: "tool",
      ms: 3,
      id: MODEL_CALL,
      name: "run_sql",
      args: JSON.stringify({ sql: FILMS }),
      result: "count\n1000",
      isError: false,
    },
    {
      step: "tool",
      ms: 2,
      id: CLOSING_FENCE,
      name: "run_sql",
      args: JSON.stringify({ sql: FILMS }),
      result: "count\n1000",
      isError: false,
    },
  ],
  text: "One thousand.",
  turns: 1,
  ms: 11,
  usage: { input: 1, output: 1 },
  promptVersion: "v4",
  candidates: [],
  recall: null,
  risky: false,
});

describe("the call log a landed answer writes", () => {
  let added: Record<string, unknown>[] = [];

  beforeEach(() => {
    added = [];
    mockIPC((cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      if (cmd === "agent_turn_add") {
        added.push(args.turn as Record<string, unknown>);
        return added.length;
      }
      if (cmd === "agent_turns_list" || cmd === "agent_answers_list") return [];
      return undefined;
    });
    runner.runAsk = bothRuns;
    runner.suggestFollowUps = async (req) => ({
      questions: [],
      step: { step: "followups", ms: 1, prompt: req.thread, text: "", questions: [] },
    });
    useSettings.setState(baseAgentSettings());
    useSchema.setState({ snapshots: { [PID]: minimalSnapshot() } });
    useAgent.setState({
      activeProfileId: PID,
      threads: { [PID]: [{ id: TID, profileId: PID, title: "Films", createdAt: "2026-09-14" }] },
      activeThread: { [PID]: TID },
      exchanges: { [TID]: [] },
      sessions: { [TID]: "session-1" },
      busy: { [TID]: false },
      phase: { [TID]: null },
      pending: {},
      followUps: {},
    });
  });

  test("holds the model's own call and not the loop's closing-fence fetch", async () => {
    await useAgent.getState().ask("how many films are there");

    const assistant = added.find((t) => t.role === "assistant");
    expect(assistant).toBeDefined();
    const calls = JSON.parse(String(assistant?.tool_calls_json)) as { id: string }[];
    const results = JSON.parse(String(assistant?.tool_results_json)) as { id: string }[];
    expect(calls.map((c) => c.id)).toEqual([MODEL_CALL]);
    expect(results.map((r) => r.id)).toEqual([MODEL_CALL]);
  });
});
