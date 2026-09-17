// What a refresh promises and what it refuses (E2 R1-R6).
//
// The sweep is the ACK and the surfaces are the verdict, so the two things
// worth pinning are TIME and RESTRAINT: when each surface's cycle starts
// (the band's own front, projected exactly as the sketch projects it), and
// which gestures decline to touch anything at all — a tab holding staged
// edits, a query whose last run wrote, a connection that did not come back.
//
// heal is stood in through its module, because what is under test is what a
// verdict DOES here, not how connections.healProfile reaches one; everything
// else is the real store.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// the stores paint the theme and read localStorage as they evaluate; bun has
// neither (the same shim as live-session.test.ts, with one addition: this
// module measures elements, so `document` answers querySelector for real)
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

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
const box = (r: Rect) => ({ getBoundingClientRect: () => r }) as unknown as HTMLElement;
/** the sketch's own frame: 1280 × 640 (docs/refresh-sketch-e2.html) */
const SHELL: Rect = { left: 0, top: 0, width: 1280, height: 640 };
const docStub: Record<string, unknown> = {
  querySelector: (sel: string) => (sel === ".v2-shell" ? box(SHELL) : null),
};
const doc: unknown = new Proxy(docStub, {
  get: (t, k) => (k in t ? t[k as string] : inert),
});

for (const k of ["window", "localStorage"].filter((n) => !(n in globalThis))) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : storage,
    configurable: true,
    writable: true,
  });
}
/** `document` is REPLACED, not filled in: a sibling suite loaded first leaves a
 * wholly inert one behind, and this suite is the one that measures elements.
 * The proxy answers querySelector and stays inert for everything else, so a
 * suite that runs after this one sees exactly what it saw before. */
function installDocument() {
  Object.defineProperty(globalThis, "document", {
    value: doc,
    configurable: true,
    writable: true,
  });
}
installDocument();

let reducedMotion = false;
mock.module("../../design/springs", () => ({
  prefersReducedMotion: () => reducedMotion,
}));

let healHolds = true;
let retryAt: number | null = null;
const healCalls: { profileId: string; manual: boolean }[] = [];
mock.module("../heal", () => ({
  requestHeal: async (profileId: string, manual = false) => {
    healCalls.push({ profileId, manual });
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
const { useEdits } = await import("../edits");
const { useResults } = await import("../results");
const { useTabs } = await import("../tabs");

type PendingEdit = import("../edits").PendingEdit;
type Tab = import("../tabs").Tab;
type ResultsTab = (typeof useResults)["getState"] extends () => { byTab: Record<string, infer T> }
  ? T
  : never;

const TAB = "t1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** the surfaces as the sketch lays them out at 1280 × 640, measured off its
 * own frames (docs/research/e2-sketch-frames/ok-1280-dark-460.png) */
const TREE = box({ left: 8, top: 121, width: 246, height: 510 });
const MAIN = box({ left: 265, top: 111, width: 695, height: 498 });
const INSPECTOR = box({ left: 972, top: 71, width: 298, height: 255 });

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

/** refreshActiveTab reads the COUNT of staged edits; their shape is edits.ts's
 * own business and nothing here depends on it */
const staged = (n: number): Record<string, PendingEdit> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, {} as PendingEdit]));

beforeEach(() => {
  installDocument();
  reducedMotion = false;
  healHolds = true;
  retryAt = null;
  healCalls.length = 0;
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
});

describe("frontReachMs: the band's front is the clock", () => {
  test("a surface's start is where the diagonal crosses its centre", () => {
    useRefresh.setState({ tier: "hard" });
    const reach = useRefresh.getState().frontReachMs;
    const tree = reach(TREE);
    const main = reach(MAIN);
    const inspector = reach(INSPECTOR);
    // top-left to bottom-right, so the sidebar goes first and the inspector last
    expect(tree).toBeLessThan(main);
    expect(main).toBeLessThan(inspector);
    // as fractions of the 720ms sweep: the sketch's own numbers
    expect(tree).toBeGreaterThanOrEqual(0.1 * 720);
    expect(tree).toBeLessThanOrEqual(0.2 * 720);
    expect(main).toBeLessThanOrEqual(0.45 * 720);
    expect(inspector).toBeGreaterThan(0.45 * 720);
    expect(inspector).toBeLessThanOrEqual(0.7 * 720);
  });

  test("the soft tier has no band, so nothing waits for one", () => {
    useRefresh.setState({ tier: "soft" });
    const reach = useRefresh.getState().frontReachMs;
    expect(reach(TREE)).toBe(0);
    expect(reach(MAIN)).toBe(0);
    expect(reach(INSPECTOR)).toBe(0);
  });

  test("reduced motion removes the band, and the wait with it", () => {
    reducedMotion = true;
    useRefresh.setState({ tier: "hard" });
    const reach = useRefresh.getState().frontReachMs;
    expect(reach(TREE)).toBe(0);
    expect(reach(INSPECTOR)).toBe(0);
  });

  test("an unmounted surface is not a position", () => {
    useRefresh.setState({ tier: "hard" });
    expect(useRefresh.getState().frontReachMs(null)).toBe(0);
    expect(useRefresh.getState().frontReachMs(box({ left: 0, top: 0, width: 0, height: 0 }))).toBe(
      0,
    );
  });
});

describe("track: a surface blanks only while it is truly refetching", () => {
  test("a refetch that lands inside the grace never blanks", async () => {
    useRefresh.setState({ tier: "soft", startedAt: Date.now() });
    useRefresh.getState().track("main", sleep(100));
    await sleep(250);
    expect(useRefresh.getState().cycling.main).toBeUndefined();
  });

  test("a slow refetch holds its skeleton for at least --dur-slow", async () => {
    useRefresh.setState({ tier: "soft", startedAt: Date.now() });
    const started = Date.now();
    useRefresh.getState().track("main", sleep(500));
    await sleep(250);
    expect(useRefresh.getState().cycling.main).toBe(true);
    await sleep(200); // 450ms in: still refetching, so still cycling
    expect(useRefresh.getState().cycling.main).toBe(true);
    while (useRefresh.getState().cycling.main) await sleep(25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150 + 240);
  });

  test("a failed refetch ends its cycle too: nothing stays blank", async () => {
    useRefresh.setState({ tier: "soft", startedAt: Date.now() });
    const work = sleep(300).then(() => {
      throw new Error("connection closed");
    });
    useRefresh.getState().track("main", work.catch(() => Promise.reject(new Error("again"))));
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
      byTab: { [TAB]: { maps: {}, pending: staged(3), flash: new Set(), undoStack: [], redoStack: [] } },
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
      byTab: { [TAB]: { maps: {}, pending: staged(1), flash: new Set(), undoStack: [], redoStack: [] } },
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
    expect(useResults.getState().byTab[TAB]?.running).toBe(false);
  });

  test("a tab that never ran has nothing to reload, and says nothing", async () => {
    useTabs.setState({ tabs: [queryTab()], activeId: TAB });
    useResults.setState({ byTab: { [TAB]: resultsTab({ executedSql: null }) } });
    await refreshActiveTab();
    expect(useRefresh.getState().note).toBeNull();
  });
});

describe("the dead connection (R6)", () => {
  test("the sweep plays once and no surface cycles", async () => {
    healHolds = false;
    retryAt = Date.now() + 2_000;
    await useRefresh.getState().hardRefresh("p1");
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

  test("a background heal on a live connection cycles nothing", async () => {
    await healSettled("p2", true);
    expect(useRefresh.getState().sweepSeq).toBe(0);
    expect(useRefresh.getState().cycling).toEqual({});
  });
});
