// The store's half of A2: what the connection knows reaches the loop with the
// question (item 4), and the two code entry points compose one ordinary
// question each (items 5 and 6b).
//
// The knowledge rows are read from the store the connection loaded them into,
// the history from appdb, and a history read that fails costs the question
// nothing, the rule a tagged thread's replay already follows (LESSONS 5). The
// loop is stood in through the store's `runner` seam, so every assertion is on
// the AskRequest the store built; the backend is Tauri's own mock transport.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { baseAgentSettings, minimalSnapshot } from "./fixtures";

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
const { useAgent, runner } = agent;
const { useSchema } = await import("../schema");
const { useSaved } = await import("../saved");
const { useSettings } = await import("../settings");
const { useKnowledge } = await import("../knowledge");

type AskRequest = Parameters<typeof runner.runAsk>[0];

const realRunAsk = runner.runAsk;
afterAll(() => {
  runner.runAsk = realRunAsk;
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

const PID = "p";
const TID = "t-open";

const PAIRS = [
  { question: "how many films are rated G", sql: "SELECT count(*) FROM film", created_at: "2026-09-05" },
];

/** every appdb call the run made; the two writes an answered run makes are
 * answered so the log carries no failed history write */
const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
let rowId = 100;
let historyFails = false;

function mockBackend() {
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    invoked.push({ cmd, args });
    if (cmd === "agent_history_pairs") {
      if (historyFails) throw new Error("appdb is gone");
      return PAIRS;
    }
    if (cmd === "agent_turn_add") return rowId++;
    if (cmd === "agent_turn_update") return undefined;
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
    promptVersion: "v4",
    candidates: [],
    recall: null,
    risky: false,
  };
};

// ---- seed ------------------------------------------------------------------

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

const SNAPSHOT = minimalSnapshot([table("film", ["film_id", "title"])]);

const ROWS = [
  { id: "k1", profile_id: PID, kind: "hint" as const, target: "film", text: "one row per title" },
  { id: "k2", profile_id: PID, kind: "synonym" as const, target: "film", text: "catalogue" },
];

/** a saved query that failed its check: 12 rows where none were expected */
const CHECK = {
  id: "s2",
  name: "Unpaid orders older than a week",
  sql: "SELECT 1 AS unpaid",
  profile_id: PID,
  expect_json: '{"kind":"rows","op":"eq","n":0}',
  last_check_json: '{"ok":false,"rows":12,"at":"2026-09-06T00:00:00Z"}',
};

function seed() {
  shim();
  mockBackend();
  runner.runAsk = answering;
  seen.length = 0;
  invoked.length = 0;
  historyFails = false;
  useSettings.setState(baseAgentSettings());
  useSchema.setState({ snapshots: { [PID]: SNAPSHOT } });
  useSaved.setState({ queries: [CHECK] });
  useKnowledge.setState({ rows: { [PID]: ROWS } });
  useAgent.setState({
    activeProfileId: PID,
    threads: { [PID]: [{ id: TID, profileId: PID, title: "the open thread", createdAt: "2026-09-06" }] },
    activeThread: { [PID]: TID },
    exchanges: { [TID]: [] },
    sessions: { [TID]: "session-1" },
    busy: {},
    phase: {},
    pending: {},
    followUps: {},
  });
}

const lastAsk = () => seen[seen.length - 1];
const exchanges = () => useAgent.getState().exchanges[TID] ?? [];

beforeEach(seed);

describe("what the connection knows travels with the question", () => {
  test("the rows the connection loaded, and its earlier answers", async () => {
    await useAgent.getState().ask("how big is the film catalogue?");
    expect(lastAsk().knowledge).toEqual(ROWS);
    expect(lastAsk().history).toEqual(PAIRS);
    expect(invoked.some((c) => c.cmd === "agent_history_pairs")).toBe(true);
  });

  test("no synonyms of its own: the loop reads the map off the rows themselves", async () => {
    await useAgent.getState().ask("how big is the film catalogue?");
    expect(lastAsk().synonyms).toBeUndefined();
  });

  test("a history read that fails costs the question nothing", async () => {
    historyFails = true;
    await useAgent.getState().ask("how many films?");
    expect(lastAsk().history).toEqual([]);
    expect(exchanges()[0].answer?.verdict.status).toBe("answered");
  });

  test("a re-run carries it too: the knowledge is the connection's, not the question's", async () => {
    await useAgent.getState().ask("how many films?");
    const first = exchanges()[0];
    await useAgent.getState().retry(first.id);
    expect(seen).toHaveLength(2);
    expect(lastAsk().knowledge).toEqual(ROWS);
  });
});

describe("Explain with Ask", () => {
  test("one question, the tab as a pill, the statement under the tags", async () => {
    await useAgent.getState().explainWithAsk("SELECT 1\n", "cohort retention");
    expect(lastAsk().question).toBe('Explain this query @"cohort retention"');
    expect(lastAsk().context).toBe('tab "cohort retention":\nSELECT 1');
    // the pill is a fact about the exchange: a closed tab must not un-pill it
    expect(exchanges()[0].tabName).toBe("cohort retention");
  });

  test("a saved query of the same name does not answer for the tab", async () => {
    useSaved.setState({ queries: [{ ...CHECK, name: "cohort retention" }] });
    await useAgent.getState().explainWithAsk("SELECT 1", "cohort retention");
    expect(lastAsk().mentions).toBeUndefined();
    expect(lastAsk().context).toBe('tab "cohort retention":\nSELECT 1');
  });

  test("a re-run asks with the statement again, never about a query nobody sent", async () => {
    await useAgent.getState().explainWithAsk("SELECT 1", "cohort retention");
    await useAgent.getState().retry(exchanges()[0].id);
    expect(seen).toHaveLength(2);
    expect(lastAsk().context).toBe('tab "cohort retention":\nSELECT 1');
  });

  test("an empty statement asks nothing at all", async () => {
    await useAgent.getState().explainWithAsk("   ", "cohort retention");
    expect(seen).toHaveLength(0);
    expect(exchanges()).toHaveLength(0);
  });

  test("a long statement says that it was cut, and never sends half a query", async () => {
    const long = `SELECT ${"a".repeat(3000)}`;
    await useAgent.getState().explainWithAsk(long, "wide");
    expect(lastAsk().context).toEndWith("\n… (truncated)");
    expect((lastAsk().context ?? "").length).toBeLessThan(long.length);
  });
});

describe("Ask Why", () => {
  test("the check as a tag, its drift as the line under it", async () => {
    await useAgent.getState().askWhy(CHECK);
    expect(lastAsk().question).toBe('Why did @"Unpaid orders older than a week" fail its check?');
    // the drift the failed row prints, read once and sent as it stands
    expect(lastAsk().context).toBe('check "Unpaid orders older than a week": 12 rows · expected 0');
    // the check is a saved query, so the tag resolves the way any other does
    expect(lastAsk().mentions?.map((m) => m.kind)).toEqual(["saved"]);
  });

  test("a check that has not run yet says only what it is", async () => {
    await useAgent.getState().askWhy({ ...CHECK, last_check_json: null });
    expect(lastAsk().context).toBe('check "Unpaid orders older than a week"');
  });
});
