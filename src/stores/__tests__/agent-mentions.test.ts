// The store's half of the `@` tags (ROADMAP W6): every path that asks
// resolves the question's tags against the connection as it stands BEFORE its
// first await (LESSONS 3), a tagged thread's replay is read out of appdb
// through the same helper a cut uses, and a tag that no longer resolves costs
// the question nothing (LESSONS 5). The loop is stood in through the store's
// `runner` seam, so the assertion is on the AskRequest the store built; the
// backend is Tauri's own mock transport (@tauri-apps/api/mocks), the seam the
// W4 store tests already use, with three commands answered.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentAnswer, AgentTurn } from "../../ipc/types";

// agent.ts pulls in settings.ts, which paints the theme onto the document at
// import, and saved.ts, which persists through localStorage; bun has neither
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

/** every appdb call the run made. Four commands answer: a tagged thread's
 * turns and its verdicts (the point of the file) and the two writes an
 * answered run makes, so the log stays readable. Everything else rejects
 * like a dead backend. */
const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
let rowId = 100;
const turn = (id: number, role: string, content: string, threadId = "t-old"): AgentTurn => ({
  id,
  thread_id: threadId,
  idx: id - 1,
  role,
  content,
  tool_calls_json: null,
  tool_results_json: null,
  usage_json: null,
  model: "claude-sonnet-5",
  provider: "claude-code",
  prompt_version: "v3",
  ms: 10,
  created_at: "2026-09-06T00:00:00Z",
});
const answer = (turnId: number, sql: string | null): AgentAnswer => ({
  turn_id: turnId,
  sql,
  row_count: 1,
  assumptions_json: null,
  sanity_json: null,
  status: "answered",
});
const TURNS: AgentTurn[] = [
  turn(1, "user", "how many films"),
  turn(2, "assistant", "One thousand films. The catalogue has not grown.\n\n```sql\nSELECT count(*) FROM film\n```"),
];
const ANSWERS: AgentAnswer[] = [answer(2, "SELECT count(*) FROM film")];
/** the thread whose answer never fenced its SQL: the model dropped the fence
 * the prompt asks for and the verdict row is the only place the query
 * survives. Replaying the prose under `SQL:` would tell the next model that a
 * paragraph is a query (LESSONS 9). */
const RAW_SQL = "SELECT date_trunc('month', placed_at) AS m, count(*) FROM orders GROUP BY 1";
const RAW_TURNS: AgentTurn[] = [
  turn(11, "user", "orders by month last year", "t-raw"),
  turn(
    12,
    "assistant",
    "Twelve months, the busiest being March. The orders table carries placed_at, not created_at, so the month comes off that.",
    "t-raw",
  ),
];
const RAW_ANSWERS: AgentAnswer[] = [answer(12, RAW_SQL)];
const TURNS_BY: Record<string, AgentTurn[]> = { "t-old": TURNS, "t-raw": RAW_TURNS };
const ANSWERS_BY: Record<string, AgentAnswer[]> = { "t-old": ANSWERS, "t-raw": RAW_ANSWERS };
// bun shares one global scope across files and every file that shims it also
// tears its own shims down, so a file that ran earlier can take `window` out
// from under this one: install what is missing at import AND before each test,
// and take back exactly what this file put there
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
const agent = await import("../agent");
const { useAgent, replayPairs, replayOf, runner } = agent;
type Exchange = import("../agent").Exchange;
const { useSchema } = await import("../schema");
const { useSaved } = await import("../saved");
const { useSettings } = await import("../settings");
const { mentionContext } = await import("../../agent/mentions");

type AskRequest = Parameters<typeof runner.runAsk>[0];

const realRunAsk = runner.runAsk;
afterAll(() => {
  runner.runAsk = realRunAsk;
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

/** the backend: a tagged thread's turns and verdicts (the point of the file)
 * and the two writes an answered run makes, so the log carries no failed
 * history write. Everything else rejects the way a dead backend does. */
function mockBackend() {
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    invoked.push({ cmd, args });
    if (cmd === "agent_turns_list") return TURNS_BY[String(args.threadId)] ?? [];
    if (cmd === "agent_answers_list") return ANSWERS_BY[String(args.threadId)] ?? [];
    if (cmd === "agent_turn_add") return rowId++;
    if (cmd === "agent_answer_put") return undefined;
    throw new Error(`no backend in this test: ${cmd}`);
  });
}

// ---- the loop seam ---------------------------------------------------------

const seen: AskRequest[] = [];
const answering: typeof realRunAsk = async (req) => {
  seen.push(req);
  return {
    verdict: { status: "answered", sql: "SELECT 1", rowCount: 1 },
    sql: "SELECT 1",
    run: { columns: ["n"], rows: [["1"]], rowCount: 1, capped: false, ms: 3 },
    assumptions: [],
    sanity: [],
    trace: [],
    text: "One.",
    turns: 1,
    ms: 12,
    usage: { input: 1, output: 1 },
    promptVersion: "v3",
    candidates: [],
    recall: null,
    risky: false,
  };
};

// ---- seed ------------------------------------------------------------------

const PID = "p";
const TID = "t-open";

const table = (name: string, cols: string[]) => ({
  table_oid: name.length,
  schema: "public",
  name,
  kind: "r" as const,
  columns: cols.map((c, i) => ({
    name: c,
    attnum: i + 1,
    type: "text",
    type_oid: 25,
    not_null: false,
    default: null,
  })),
  pk: [],
});

const SNAPSHOT = {
  tables: [table("film", ["film_id", "title"]), table("customer", ["customer_id", "email"])],
  foreign_keys: [],
  functions: [],
  schemas: ["public"],
  indexes: [],
  enums: [],
  sequences: [],
  extensions: [],
  server_version_num: 160004,
};

function seed() {
  shim();
  mockBackend();
  runner.runAsk = answering;
  seen.length = 0;
  invoked.length = 0;
  useSettings.setState({
    agentProvider: "claude-code",
    agentModel: "claude-sonnet-5",
    agentByConn: {},
    agentBaseUrls: {},
  });
  useSchema.setState({ snapshots: { [PID]: SNAPSHOT } });
  useSaved.setState({
    queries: [{ id: "s1", name: "Monthly revenue", sql: "SELECT 1 AS revenue;", profile_id: PID }],
  });
  useAgent.setState({
    activeProfileId: PID,
    threads: {
      [PID]: [
        { id: TID, profileId: PID, title: "the open thread", createdAt: "2026-09-06" },
        { id: "t-old", profileId: PID, title: "how many films", createdAt: "2026-09-05" },
        { id: "t-raw", profileId: PID, title: "orders by month", createdAt: "2026-09-04" },
      ],
    },
    activeThread: { [PID]: TID },
    exchanges: { [TID]: [] },
    sessions: { [TID]: "session-1" },
    busy: { [TID]: false },
    phase: { [TID]: null },
    pending: {},
  });
}

const kindsOf = (req: AskRequest) => (req.mentions ?? []).map((m) => m.kind);

// ---- tests -----------------------------------------------------------------

describe("the store resolves what the question tagged", () => {
  beforeEach(seed);

  test("the tags reach the loop and the question is persisted exactly as typed", async () => {
    const text = 'compare @film with @"Monthly revenue" for August';
    await useAgent.getState().ask(text);
    expect(seen).toHaveLength(1);
    expect(kindsOf(seen[0])).toEqual(["table", "saved"]);
    expect(seen[0].mentions?.[0].ref).toEqual({ schema: "public", table: "film" });
    // the `@` tokens travel in the question itself; nothing rewrites them
    expect(seen[0].question).toBe(text);
    const exchanges = useAgent.getState().exchanges[TID] as Exchange[];
    expect(exchanges[0].question).toBe(text);
  });

  test("a column tag names its table, and a tag nothing owns is never sent", async () => {
    await useAgent.getState().ask("@customer.email and @nope and @not_a_table.col");
    expect(kindsOf(seen[0])).toEqual(["column"]);
    expect(seen[0].mentions?.[0].ref).toEqual({
      schema: "public",
      table: "customer",
      column: "email",
    });
  });

  test("nothing tagged sends no tags at all: the eval path's shape", async () => {
    await useAgent.getState().ask("how many films are there?");
    expect("mentions" in seen[0]).toBe(false);
  });

  test("a tagged thread carries its replay, read from appdb through the cut's helper", async () => {
    await useAgent.getState().ask('does @"how many films" still hold?');
    expect(kindsOf(seen[0])).toEqual(["thread"]);
    const tag = seen[0].mentions?.[0];
    expect(invoked.filter((c) => c.cmd === "agent_turns_list")).toEqual([
      { cmd: "agent_turns_list", args: { threadId: "t-old" } },
    ]);
    // what was said and what was concluded: both tables, one round trip
    expect(invoked.filter((c) => c.cmd === "agent_answers_list")).toEqual([
      { cmd: "agent_answers_list", args: { threadId: "t-old" } },
    ]);
    // the same helper, headless and under the tag's own cap
    expect(tag?.kind === "thread" && tag.ref.replay).toBe(
      replayOf(replayPairs(TURNS, ANSWERS), { head: "", cap: 1500 }),
    );
    expect(mentionContext(seen[0].mentions ?? [])).toBe(
      'thread "how many films":\nQ: how many films\nSQL: SELECT count(*) FROM film\nA: One thousand films.',
    );
  });

  test("a tagged thread replays the SQL its verdict recorded, never its prose", async () => {
    await useAgent.getState().ask('like @"orders by month" but for July');
    expect(kindsOf(seen[0])).toEqual(["thread"]);
    expect(mentionContext(seen[0].mentions ?? [])).toBe(
      `thread "orders by month":\nQ: orders by month last year\nSQL: ${RAW_SQL}\n` +
        "A: Twelve months, the busiest being March.",
    );
  });

  test("the thread being asked in is never its own context", async () => {
    await useAgent.getState().ask('what about @"the open thread"?');
    expect("mentions" in seen[0]).toBe(false);
    expect(invoked.some((c) => c.cmd === "agent_turns_list")).toBe(false);
  });

  test("resolution happens before the first await: a snapshot that leaves mid-run is too late", async () => {
    const run = useAgent.getState().ask('compare @film with @"Monthly revenue"');
    // the connection's schema and bookmarks go while the run is in the air
    useSchema.setState({ snapshots: {} });
    useSaved.setState({ queries: [] });
    await run;
    expect(kindsOf(seen[0])).toEqual(["table", "saved"]);
  });

  test("a re-run re-resolves, and a tag that stopped resolving never refuses the question", async () => {
    await useAgent.getState().ask("count @film rows");
    expect(kindsOf(seen[0])).toEqual(["table"]);
    const exchangeId = (useAgent.getState().exchanges[TID] as Exchange[])[0].id;
    // the table is dropped from the connection between the two runs
    useSchema.setState({
      snapshots: { [PID]: { ...SNAPSHOT, tables: [SNAPSHOT.tables[1]] } },
    });
    await useAgent.getState().retry(exchangeId);
    expect(seen).toHaveLength(2);
    expect("mentions" in seen[1]).toBe(false);
    expect(seen[1].question).toBe("count @film rows");
  });
});

describe("the replay a tagged thread sends", () => {
  test("each user turn pairs with the assistant turn that answered it", () => {
    expect(replayPairs(TURNS, ANSWERS)).toEqual([
      {
        question: "how many films",
        text: TURNS[1].content,
        answer: { sql: "SELECT count(*) FROM film", text: TURNS[1].content },
      },
    ]);
  });

  test("the verdict's SQL wins over the fence the answer printed", () => {
    const rewritten = [answer(2, "SELECT count(*) FROM film WHERE 1 = 1")];
    expect(replayPairs(TURNS, rewritten)[0].answer?.sql).toBe(
      "SELECT count(*) FROM film WHERE 1 = 1",
    );
  });

  test("an answer that fenced nothing and recorded nothing replays as none", () => {
    // extractSql falls back to how: "raw" and hands back the whole paragraph;
    // a paragraph under `SQL:` is a lie the next model reads as a query
    expect(replayPairs(RAW_TURNS)[0].answer?.sql).toBe(null);
    expect(replayOf(replayPairs(RAW_TURNS), { head: "", cap: 1500 })).toContain("SQL: none");
    expect(replayPairs(RAW_TURNS, RAW_ANSWERS)[0].answer?.sql).toBe(RAW_SQL);
  });

  test("an unanswered question and a stray assistant turn are both survivable", () => {
    const stray = [turn(9, "assistant", "orphan"), turn(10, "user", "asked, never answered")];
    expect(replayPairs(stray)).toEqual([
      { question: "asked, never answered", text: "", answer: null },
    ]);
    expect(replayOf(replayPairs(stray), { head: "", cap: 1500 })).toBe(
      "Q: asked, never answered\nSQL: none\nA: none",
    );
  });

  test("the oldest exchanges are dropped until the rest fits the tag's cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => [
      turn(i * 2 + 1, "user", `question ${i} ${"x".repeat(60)}`),
      turn(i * 2 + 2, "assistant", `answer ${i}.`),
    ]).flat();
    const out = replayOf(replayPairs(many), { head: "", cap: 1500 });
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("question 39");
    expect(out).not.toContain("question 0 ");
    // headless: the tag block writes its own header line above it
    expect(out.startsWith("Q: ")).toBe(true);
  });
});
