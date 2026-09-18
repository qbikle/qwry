// What a refresh promises and what it refuses (E2 R1-R6, amended by E3 1-3).
//
// The promise is a FRAME: every surface that will refetch wears its skeleton
// in the one synchronous write the keypress itself causes, before a single
// await stands between the chord and the pixel (LESSONS 16). The refusals are
// the other half — a tab holding staged edits, a query whose last run wrote, a
// connection that did not come back — and each of them is decided in that same
// write, so a gesture never answers twice.
//
// heal is stood in through its module, because what is under test is what a
// verdict DOES here, not how connections.healProfile reaches one; it answers
// on a delay, because a probe that answers in 0 ms is exactly the harness that
// let E2 ship the lag (LESSONS 16). Everything else is the real store.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// the stores paint the theme and read localStorage as they evaluate; bun has
// neither (the same shim as live-session.test.ts)
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

for (const k of ["window", "localStorage", "document"].filter((n) => !(n in globalThis))) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });
}

mock.module("../../design/springs", () => ({
  prefersReducedMotion: () => false,
}));

let healHolds = true;
/** the bastion's own cost: nothing may wait for this, and everything that was
 * already up has to survive whatever it answers (E3 rules 1 and 3) */
let healDelay = 40;
let retryAt: number | null = null;
const healCalls: { profileId: string; manual: boolean }[] = [];
/** the loaders as they stood when the probe was ASKED: the chord's write has
 * to be behind it, never the other way round (E3 rule 1) */
let cyclingAtHeal: Record<string, boolean> = {};
mock.module("../heal", () => ({
  requestHeal: async (profileId: string, manual = false) => {
    healCalls.push({ profileId, manual });
    cyclingAtHeal = { ...useRefresh.getState().cycling };
    await new Promise((r) => setTimeout(r, healDelay));
    return healHolds;
  },
  nextRetryAt: () => retryAt,
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

const { mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { healSettled, refreshActiveTab, useRefresh } = await import("../refresh");
const { readOnlyHeads } = await import("../../lib/sqlHeads");
const { useConnections } = await import("../connections");
const { useEdits } = await import("../edits");
const { useResults } = await import("../results");
const { useSidePane } = await import("../sidePane");
const { useTabs } = await import("../tabs");

type PendingEdit = import("../edits").PendingEdit;
type Tab = import("../tabs").Tab;
type ResultsTab = (typeof useResults)["getState"] extends () => { byTab: Record<string, infer T> }
  ? T
  : never;

const TAB = "t1";
/** stores/refresh.ts's own floor: a skeleton that was shown reads as a state */
const MIN_SHOW_MS = 240;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const queryTab = (over: Partial<Tab> = {}): Tab => ({
  id: TAB,
  name: "new qwry",
  sql: "SELECT 1",
  position: 0,
  saved_id: null,
  kind: "query",
  table: null,
  canvas_id: null,
  profile_id: "p1",
  ...over,
});

const resultsTab = (over: Partial<ResultsTab> = {}): ResultsTab =>
  ({
    statements: [],
    activeStatement: 0,
    running: false,
    cancelling: false,
    connecting: false,
    totalMs: null,
    executedSql: "SELECT * FROM users",
    executedOffset: 0,
    notices: [],
    executedSessionId: "A",
    executedProfileId: "p1",
    globalError: null,
    ...over,
  }) as ResultsTab;

/** the plan reads the COUNT of staged edits; their shape is edits.ts's own
 * business and nothing here depends on it */
const staged = (n: number): Record<string, PendingEdit> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, {} as PendingEdit]));

/** a query tab sitting on a read-only result: the window a refresh lands in */
function onAQueryTab() {
  useTabs.setState({ tabs: [queryTab()], activeId: TAB });
  useResults.setState({ byTab: { [TAB]: resultsTab() } });
}

beforeEach(() => {
  healHolds = true;
  healDelay = 40;
  retryAt = null;
  healCalls.length = 0;
  cyclingAtHeal = {};
  useRefresh.setState({
    tier: null,
    profileId: null,
    sweepSeq: 0,
    startedAt: null,
    cycling: {},
    note: null,
    dead: null,
  });
  useTabs.setState({ tabs: [], activeId: null });
  useResults.setState({ byTab: {}, active: TAB });
  useEdits.setState({ byTab: {} });
  // the inspector shows a row of the result the main body refetches, so the
  // pane has to be open on it for that surface to be in any plan
  useSidePane.setState({ mode: "inspector", open: true, width: 300 });
  // the world a hard refresh normally lands in: a heal that held left a
  // session behind, which is what the surfaces then send on
  useConnections.setState({ sessions: { p1: "A" }, tabSessions: {} });
});

describe("the gesture's own frame (E3 rule 1)", () => {
  test("⇧⌘R shows every loader in one write, before any await", async () => {
    onAQueryTab();
    const act = useRefresh.getState().hardRefresh("p1");
    // read with not one microtask run: the act's promise is still untouched
    const s = useRefresh.getState();
    expect(s.sweepSeq).toBe(1);
    expect(s.tier).toBe("hard");
    expect(s.startedAt).not.toBeNull();
    expect(s.cycling.tree).toBe(true);
    expect(s.cycling.main).toBe(true);
    expect(s.cycling.inspector).toBe(true);
    // the probe went out beside them, never ahead of them
    expect(healCalls).toEqual([{ profileId: "p1", manual: true }]);
    expect(cyclingAtHeal).toEqual({ tree: true, main: true, inspector: true });
    await act;
  });

  test("⌘R answers in the same frame, with no band and no schema", async () => {
    onAQueryTab();
    const act = useRefresh.getState().softRefresh();
    const s = useRefresh.getState();
    expect(s.sweepSeq).toBe(0);
    expect(s.tier).toBe("soft");
    expect(s.cycling.main).toBe(true);
    expect(s.cycling.inspector).toBe(true);
    expect(s.cycling.tree).toBeUndefined();
    expect(healCalls).toEqual([]);
    await act;
  });

  test("a pane showing something else has nothing to refetch", async () => {
    onAQueryTab();
    useSidePane.setState({ mode: "ask", open: true });
    const act = useRefresh.getState().softRefresh();
    expect(useRefresh.getState().cycling.main).toBe(true);
    expect(useRefresh.getState().cycling.inspector).toBeUndefined();
    await act;
  });

  test("the staged guard writes its note in that same write, and cycles nothing", async () => {
    useTabs.setState({ tabs: [queryTab({ kind: "table" })], activeId: TAB });
    useResults.setState({ byTab: { [TAB]: resultsTab() } });
    useEdits.setState({
      byTab: {
        [TAB]: { maps: {}, pending: staged(3), flash: new Set(), undoStack: [], redoStack: [] },
      },
    });
    const act = useRefresh.getState().hardRefresh("p1");
    const s = useRefresh.getState();
    expect(s.note).toEqual({
      tabId: TAB,
      text: "3 staged edits kept. Commit ⌘S or discard to refresh",
    });
    expect(s.cycling.main).toBeUndefined();
    expect(s.cycling.inspector).toBeUndefined();
    // the schema is not the tab, and it refetches either way
    expect(s.cycling.tree).toBe(true);
    await act;
    expect(useResults.getState().byTab[TAB]?.running).toBe(false);
  });
});

describe("track: a skeleton that was shown reads as a state (E3 rule 2)", () => {
  test("a refetch that lands in a blink still holds for --dur-slow", async () => {
    const started = Date.now();
    useRefresh.setState({ startedAt: started, cycling: { main: true } });
    useRefresh.getState().track("main", sleep(50));
    await sleep(120);
    expect(useRefresh.getState().cycling.main).toBe(true);
    while (useRefresh.getState().cycling.main) await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(MIN_SHOW_MS);
  });

  test("a slow refetch holds its skeleton until it lands", async () => {
    useRefresh.setState({ startedAt: Date.now(), cycling: { main: true } });
    useRefresh.getState().track("main", sleep(500));
    await sleep(300);
    expect(useRefresh.getState().cycling.main).toBe(true);
    while (useRefresh.getState().cycling.main) await sleep(25);
    expect(useRefresh.getState().cycling.main).toBeUndefined();
  });

  test("a failed refetch ends its cycle too: nothing stays blank", async () => {
    useRefresh.setState({ startedAt: Date.now(), cycling: { main: true } });
    const work = sleep(300).then(() => {
      throw new Error("connection closed");
    });
    useRefresh.getState().track("main", work);
    await sleep(250);
    expect(useRefresh.getState().cycling.main).toBe(true);
    while (useRefresh.getState().cycling.main) await sleep(25);
    expect(useRefresh.getState().cycling.main).toBeUndefined();
  });
});

describe("readOnlyHeads: what may run a second time", () => {
  test("the read-only heads", () => {
    expect(readOnlyHeads("select * from users")).toBe(true);
    expect(readOnlyHeads("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(true);
    expect(readOnlyHeads("explain select 1")).toBe(true);
    expect(readOnlyHeads("show search_path")).toBe(true);
    expect(readOnlyHeads("values (1), (2)")).toBe(true);
    expect(readOnlyHeads("table users")).toBe(true);
    expect(readOnlyHeads("-- a comment\nselect 1")).toBe(true);
    expect(readOnlyHeads("select 1; select 2")).toBe(true);
  });

  test("everything that writes", () => {
    expect(readOnlyHeads("update users set name = 'x'")).toBe(false);
    expect(readOnlyHeads("insert into users (id) values (1)")).toBe(false);
    expect(readOnlyHeads("delete from users where id = 1")).toBe(false);
    expect(readOnlyHeads("create table t (id int)")).toBe(false);
    // one write among reads still writes
    expect(readOnlyHeads("select 1; delete from users")).toBe(false);
    expect(readOnlyHeads("")).toBe(false);
  });

  test("the two heads that lie about themselves", () => {
    // EXPLAIN ANALYZE runs the statement it explains
    expect(readOnlyHeads("explain analyze delete from users")).toBe(false);
    expect(readOnlyHeads("EXPLAIN (ANALYZE, BUFFERS) UPDATE users SET id = 1")).toBe(false);
    expect(readOnlyHeads("explain (costs off) select 1")).toBe(true);
    // a data-modifying CTE writes whatever the outer statement does
    expect(readOnlyHeads("with d as (delete from users returning id) select * from d")).toBe(false);
    expect(readOnlyHeads("with t as (select 1) insert into users select * from t")).toBe(false);
  });
});

describe("refreshActiveTab: what a refresh declines to do (R4)", () => {
  test("staged edits keep their rows, and the strip says so", async () => {
    useTabs.setState({ tabs: [queryTab({ kind: "table" })], activeId: TAB });
    useResults.setState({ byTab: { [TAB]: resultsTab() } });
    useEdits.setState({
      byTab: {
        [TAB]: { maps: {}, pending: staged(3), flash: new Set(), undoStack: [], redoStack: [] },
      },
    });
    await refreshActiveTab();
    expect(useRefresh.getState().note).toEqual({
      tabId: TAB,
      text: "3 staged edits kept. Commit ⌘S or discard to refresh",
    });
    // the rows never moved: no run was started for this tab
    expect(useResults.getState().byTab[TAB]?.running).toBe(false);
  });

  test("one staged edit is one edit", async () => {
    useTabs.setState({ tabs: [queryTab({ kind: "table" })], activeId: TAB });
    useResults.setState({ byTab: { [TAB]: resultsTab() } });
    useEdits.setState({
      byTab: {
        [TAB]: { maps: {}, pending: staged(1), flash: new Set(), undoStack: [], redoStack: [] },
      },
    });
    await refreshActiveTab();
    expect(useRefresh.getState().note?.text).toBe(
      "1 staged edit kept. Commit ⌘S or discard to refresh",
    );
  });

  test("after a write the rows stay and the strip offers the rerun", async () => {
    useTabs.setState({ tabs: [queryTab()], activeId: TAB });
    useResults.setState({
      byTab: { [TAB]: resultsTab({ executedSql: "update users set name = 'x' where id = 1" }) },
    });
    await refreshActiveTab();
    expect(useRefresh.getState().note).toEqual({
      tabId: TAB,
      text: "last run wrote. ⌘↩ runs again",
    });
    expect(useRefresh.getState().cycling).toEqual({});
    expect(useResults.getState().byTab[TAB]?.running).toBe(false);
  });

  test("a tab that never ran has nothing to reload, and says nothing", async () => {
    useTabs.setState({ tabs: [queryTab()], activeId: TAB });
    useResults.setState({ byTab: { [TAB]: resultsTab({ executedSql: null }) } });
    await refreshActiveTab();
    expect(useRefresh.getState().note).toBeNull();
    expect(useRefresh.getState().cycling).toEqual({});
  });
});

describe("the dead connection (R6, amended by E3 rule 3)", () => {
  test("the loaders are up from t0, and the dead answer returns them", async () => {
    healHolds = false;
    healDelay = 60;
    retryAt = Date.now() + 2_000;
    onAQueryTab();
    const act = useRefresh.getState().hardRefresh("p1");
    // the app tried: the skeletons stood while the probe was still out
    expect(useRefresh.getState().cycling.main).toBe(true);
    expect(useRefresh.getState().cycling.tree).toBe(true);
    await act;
    const s = useRefresh.getState();
    expect(s.sweepSeq).toBe(1);
    expect(healCalls).toEqual([{ profileId: "p1", manual: true }]);
    expect(s.cycling).toEqual({});
    expect(s.dead?.profileId).toBe("p1");
    expect(s.dead?.retryAt).toBe(retryAt);
  });

  test("a retry that lands is not a gesture: it plays no second sweep", async () => {
    healHolds = false;
    await useRefresh.getState().hardRefresh("p1");
    expect(useRefresh.getState().sweepSeq).toBe(1);
    await healSettled("p1", true);
    expect(useRefresh.getState().sweepSeq).toBe(1);
    expect(useRefresh.getState().dead).toBeNull();
  });

  test("a failed retry keeps the countdown going", async () => {
    healHolds = false;
    await useRefresh.getState().hardRefresh("p1");
    retryAt = Date.now() + 5_000;
    await healSettled("p1", false);
    expect(useRefresh.getState().dead?.retryAt).toBe(retryAt);
  });

  test("a heal that held but left no session cycles nothing either", async () => {
    // the verdict said ok and the map is empty: there is no address to send
    // on, so no surface may blank as though something were on the wire, and
    // the strip carries the connection instead of a skeleton (R3, R6)
    useConnections.setState({ sessions: {}, tabSessions: {} });
    retryAt = Date.now() + 2_000;
    await useRefresh.getState().hardRefresh("p1");
    const s = useRefresh.getState();
    expect(s.sweepSeq).toBe(1);
    expect(s.cycling).toEqual({});
    expect(s.dead).toEqual({ profileId: "p1", retryAt });
  });

  test("a live tab session is an address too", async () => {
    useConnections.setState({ sessions: {}, tabSessions: { "p1::t9": "B" } });
    await useRefresh.getState().hardRefresh("p1");
    expect(useRefresh.getState().dead).toBeNull();
  });

  test("a background heal on a live connection cycles nothing", async () => {
    await healSettled("p2", true);
    expect(useRefresh.getState().sweepSeq).toBe(0);
    expect(useRefresh.getState().cycling).toEqual({});
  });
});
