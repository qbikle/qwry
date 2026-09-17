// E2 R5: what a refresh RUN is allowed to do to the result a reader is
// looking at. The rule is one store write: the old statements stay exactly
// where they are while the fresh set streams into a shadow buffer, and either
// the whole fresh set lands at once or nothing does and the old rows keep the
// screen with a strip over them. Everything here is about that seam, because
// every way of getting it wrong (a half-streamed set painted mid-flight, a
// blank pane after a dead connection, a scroll offset dropped on the way) is
// invisible in a screenshot and obvious to the person reading the rows.
//
// The transport is Tauri's own mock, scripted per test: `execute_stream` hands
// the run whatever QueryEvents the test wants through the real Channel, so the
// store's own event folding is what is under test rather than a stand-in.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// the stores paint the theme and read localStorage as they evaluate; bun has
// neither (the same shim as live-session.test.ts, kept identical so one fix
// serves every store test)
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

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

const { mockIPC } = await import("@tauri-apps/api/mocks");

type QueryEvent = import("../../ipc/types").QueryEvent;

/** the events the next execute_stream replays, then how it ends */
let script: QueryEvent[] = [];
let failWith: string | null = null;
/** the sql every run was handed, in order */
const ran: string[] = [];

/** every count(*) the footer asked for */
const counted: string[] = [];
/** statement indexes the backend was asked to map the editability of */
const mapped: number[] = [];
/** the session id each run was executed on */
const sessions: string[] = [];

/** re-armed per test: a sibling file's `clearMocks` drops a handler installed
 * at module level, and the run would then reach the real (absent) backend */
function arm() {
  mockIPC((cmd, payload) => {
    const a = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "connect":
        return "s1";
      case "session_probe":
        return true;
      case "execute": {
        counted.push(String(a.sql));
        return { statements: [{ rows: [["842113"]] }] };
      }
      case "editability":
        mapped.push(Number(a.statementIndex));
        return usersMap();
      case "execute_stream": {
        ran.push(String(a.sql));
        sessions.push(String(a.sessionId));
        const ch = a.onEvent as { onmessage: (ev: QueryEvent) => void };
        for (const ev of script) ch.onmessage(ev);
        if (failWith) throw new Error(failWith);
        return undefined;
      }
      default:
        return undefined;
    }
  });
}

const { useConnections } = await import("../connections");
const { useResults } = await import("../results");
const { useBrowser } = await import("../browser");
const { useEdits } = await import("../edits");
const { useTabs } = await import("../tabs");
const { readQueryScroll, saveQueryScroll } = await import("../../grid/scrollMemory");
type TableInfo = import("../schema").TableInfo;
type ColumnMeta = import("../../ipc/types").ColumnMeta;
type EditabilityMap = import("../../ipc/types").EditabilityMap;
type StatementState = import("../results").StatementState;
// the stores' own shapes, read back off the stores: a hand-written fixture
// cast to `never` compiles forever while the state it stands for moves under
// it, which is how a filter this suite thought it was setting never reached
// the SQL at all
type TabResult = ReturnType<typeof useResults.getState>["byTab"][string];
type BrowseTab = ReturnType<typeof useBrowser.getState>["byTab"][string];
type TabEdits = ReturnType<typeof useEdits.getState>["byTab"][string];

const col = (name: string, attnum: number): ColumnMeta => ({
  name,
  type_oid: 25,
  table_oid: 1,
  attnum,
});

/** the result the reader is looking at when the refresh starts */
const seededStatement = (): StatementState => ({
  index: 0,
  sql: "SELECT id, email FROM users",
  columns: [col("id", 1), col("email", 2)],
  rows: [
    ["1", "ada@example.com"],
    ["2", "grace@example.com"],
  ] as (string | null)[][],
  truncated: new Set<string>(),
  affected: null,
  ms: 41,
  rowCount: 2,
  capped: false,
  done: true,
  error: null,
});

/** the editability map the grid fetched for the result on screen: the header's
 * type glyphs, the inspector's type badge and every editable cell are read off
 * this one object, so a tab that loses it is a tab that quietly went read-only */
const usersMap = (): EditabilityMap => ({
  statement_index: 0,
  columns: [
    {
      col: 0,
      table_oid: 1,
      attnum: 1,
      editable: false,
      reason: "primary key",
      type_name: "int4",
      cast: "int4",
      is_ctid: false,
      warn: null,
    },
    {
      col: 1,
      table_oid: 1,
      attnum: 2,
      editable: true,
      reason: null,
      type_name: "text",
      cast: "text",
      is_ctid: false,
      warn: null,
    },
  ],
  pk_cols: { 1: [0] },
  tables: { 1: "public.users" },
  table_refs: { 1: { schema: "public", name: "users" } },
});

/** a tab's empty edit state; the store's own blank is module-private */
const blankEdits = (): TabEdits => ({
  maps: {},
  pending: {},
  flash: new Set(),
  undoStack: [],
  redoStack: [],
});

/** a fresh two-row answer to the same query */
const freshScript = (rows: (string | null)[][]): QueryEvent[] => [
  { type: "statement_start", index: 0, sql: "SELECT id, email FROM users" },
  { type: "columns", index: 0, columns: [col("id", 1), col("email", 2)] },
  { type: "rows", index: 0, rows, truncated: [] },
  { type: "statement_done", index: 0, affected: null, ms: 38, row_count: rows.length, capped: false },
  { type: "finished", total_ms: 38 },
];

const users: TableInfo = {
  table_oid: 1,
  schema: "public",
  name: "users",
  kind: "r",
  columns: [
    { name: "id", attnum: 1, type: "int4", type_oid: 23, not_null: true, default: null },
    { name: "email", attnum: 2, type: "text", type_oid: 25, not_null: false, default: null },
  ],
  pk: ["id"],
};

/** let the fire-and-forget chains (dynamic imports, edits reset) settle */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

function seed() {
  useConnections.setState({
    profiles: [],
    sessions: { p1: "primary" },
    tabSessions: { "p1::t1": "A" },
    txTabs: {},
    writeTabs: {},
    connState: { p1: "connected" },
    activeProfileId: "p1",
    error: null,
    errorProfileId: null,
    closedToast: null,
    sql: "SELECT id, email FROM users",
  });
  useTabs.setState({ activeId: "t1", tabs: [] });
  const t1: TabResult = {
    statements: [seededStatement()],
    activeStatement: 0,
    running: false,
    cancelling: false,
    connecting: false,
    refreshing: false,
    refreshedAt: null,
    totalMs: 41,
    executedSql: "SELECT id, email FROM users",
    executedOffset: 0,
    notices: [],
    executedSessionId: "A",
    executedProfileId: "p1",
    globalError: null,
  };
  useResults.setState({ byTab: { t1 }, active: "t1", ...t1 });
  useEdits.setState({ byTab: {}, active: "t1", lastError: null, preview: null });
}

beforeEach(() => {
  arm();
  script = freshScript([
    ["1", "ada.lovelace@example.com"],
    ["2", "grace@example.com"],
  ]);
  failWith = null;
  ran.length = 0;
  sessions.length = 0;
  counted.length = 0;
  mapped.length = 0;
  mem.clear();
  seed();
});

// ---- (a) the old result holds the screen until the fresh one is whole -----

describe("a refresh run", () => {
  test("never paints a half-streamed set, and swaps in exactly one write", async () => {
    const seen: number[] = [];
    const unsub = useResults.subscribe((s) =>
      seen.push(s.statements[0]?.rows[0]?.[1] === "ada.lovelace@example.com" ? 1 : 0),
    );
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    unsub();
    // every write before the last one still carried the OLD rows
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((v) => v === 1).length).toBe(1);
    expect(seen[seen.length - 1]).toBe(1);
  });

  test("swaps the fresh rows in and stamps when it landed", async () => {
    const before = useResults.getState().refreshedAt;
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    const t = useResults.getState().byTab.t1;
    expect(t.statements[0].rows[0][1]).toBe("ada.lovelace@example.com");
    expect(t.statements[0].ms).toBe(38);
    expect(t.totalMs).toBe(38);
    expect(t.refreshing).toBe(false);
    expect(t.running).toBe(false);
    expect(before).toBeNull();
    expect(typeof t.refreshedAt).toBe("number");
  });

  test("holds the tab refreshing while the fresh set streams, old rows still up", async () => {
    const seen: { refreshing: boolean; first: string | null }[] = [];
    const unsub = useResults.subscribe((s) =>
      seen.push({ refreshing: s.refreshing, first: s.statements[0]?.rows[0]?.[1] ?? null }),
    );
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    unsub();
    const mid = seen.filter((v) => v.refreshing);
    expect(mid.length).toBeGreaterThan(0);
    // every write made while the flag was up still carried the old address
    expect(mid.every((v) => v.first === "ada@example.com")).toBe(true);
  });

  test("runs on the tab's own session, so an open transaction survives it", async () => {
    // R4: a refetch inside a tx is a SELECT on that same session; a rebuilt
    // one would roll the transaction back without anyone saying so
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    expect(sessions).toEqual(["A"]);
    expect(useConnections.getState().tabSessions["p1::t1"]).toBe("A");
  });

  test("keeps the sql and buffer offset the result came from", async () => {
    await useResults.getState().run("SELECT id, email FROM users", 7, { refresh: true });
    const t = useResults.getState().byTab.t1;
    expect(t.executedSql).toBe("SELECT id, email FROM users");
    expect(t.executedOffset).toBe(7);
  });

  test("keeps the editability map over the swap: same columns, same map", async () => {
    // R4: a map describes columns and table identity, never rows. Dropping it
    // downgrades the tab in silence — no type glyphs, no type badge, no
    // editable cell — and nothing on the tab would ever fetch it again
    useEdits.setState({ byTab: { t1: { ...blankEdits(), maps: { 0: usersMap() } } } });
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    await settle();
    expect(useEdits.getState().byTab.t1?.maps[0]).toEqual(usersMap());
    expect(mapped).toEqual([]); // it already described these columns
  });

  test("refetches the map when the fresh result is not the shape it described", async () => {
    useEdits.setState({ byTab: { t1: { ...blankEdits(), maps: { 0: "unavailable" } } } });
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    await settle();
    expect(mapped).toEqual([0]);
    expect(useEdits.getState().byTab.t1?.maps[0]).toEqual(usersMap());
  });

  test("drops the tab's staged-edit bookkeeping at the swap, not before", async () => {
    useEdits.setState({
      byTab: { t1: { ...blankEdits(), undoStack: [{}], flash: new Set(["0:0:1"]) } },
    });
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    await settle();
    const t = useEdits.getState().byTab.t1;
    expect(t?.undoStack).toEqual([]);
    expect(t?.flash.size).toBe(0);
  });

  test("declines while edits are staged: the rows those edits sit on must not move", async () => {
    useEdits.setState({
      byTab: {
        t1: {
          ...blankEdits(),
          pending: {
            "0:0:1": { stmtIndex: 0, row: 0, col: 1, value: "x", original: "ada@example.com" },
          },
        },
      },
    });
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    expect(ran).toEqual([]);
    expect(useResults.getState().byTab.t1.statements[0].rows[0][1]).toBe("ada@example.com");
  });
});

// ---- (b) a refresh that failed leaves the reader everything they had ------

describe("a refresh that died mid-flight", () => {
  test("keeps the old rows and says so in the strip", async () => {
    script = script.slice(0, 2); // columns arrived, then the connection went
    failWith = "connection closed";
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    const t = useResults.getState().byTab.t1;
    expect(t.statements).toHaveLength(1);
    expect(t.statements[0].rows[0][1]).toBe("ada@example.com");
    expect(t.globalError?.message).toBeTruthy();
    expect(t.refreshing).toBe(false);
    expect(t.refreshedAt).toBeNull();
  });

  test("a plain run's own strip still yields to a statement error", async () => {
    script = [
      { type: "statement_start", index: 0, sql: "SELECT boom" },
      {
        type: "error",
        index: 0,
        message: "column boom does not exist",
        position: 8,
        code: "42703",
        detail: null,
        hint: null,
      },
    ];
    failWith = "column boom does not exist";
    await useResults.getState().run("SELECT boom", 0);
    const t = useResults.getState().byTab.t1;
    expect(t.globalError).toBeNull();
    expect(t.statements[0].error?.code).toBe("42703");
  });
});

// ---- (c) the scroll offset is the reader's, not the run's -----------------

describe("scroll memory", () => {
  test("a refresh keeps the tab's scroll key; a plain run drops it", async () => {
    saveQueryScroll("t1:0", 120, 0);
    await useResults.getState().run("SELECT id, email FROM users", 0, { refresh: true });
    expect(readQueryScroll("t1:0")?.top).toBe(120);

    await useResults.getState().run("SELECT id, email FROM users", 0);
    expect(readQueryScroll("t1:0")).toBeUndefined();
  });
});

// ---- (d) a browse refresh is the same query, not a fresh one -------------

describe("a browse refresh", () => {
  test("re-runs with the same filters, sort and limit, and keeps the count", async () => {
    const t: BrowseTab = {
      tab: "data",
      filters: [
        { col: "email", op: "=", value: "ada@example.com", enabled: true, conj: "AND" },
      ],
      whereMode: "builder",
      rawWhere: "",
      sortChain: [{ column: "id", dir: "desc" }],
      sort: { col: "id", dir: "DESC" },
      limit: 2000,
      jumpOffset: 0,
      draftRow: null,
      draftError: null,
      pinnedKeys: null,
      pageStale: true,
      paginationBroken: "seek failed",
      exactCount: 842113,
      counting: false,
      countError: null,
    };
    useBrowser.setState({ byTab: { t1: t }, active: "t1", table: users, ...t });

    await useBrowser.getState().refresh();

    const sql = ran[ran.length - 1];
    expect(sql).toContain("ada@example.com");
    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("2000");
    const b = useBrowser.getState().byTab.t1;
    // the count on screen was never blanked: R4 keeps it and re-runs it
    expect(b.exactCount).toBe(842113);
    expect(counted).toHaveLength(1);
    expect(counted[0]).toContain("ada@example.com");
    // a fresh result set clears both pagination latches
    expect(b.pageStale).toBe(false);
    expect(b.paginationBroken).toBeNull();
  });
});
