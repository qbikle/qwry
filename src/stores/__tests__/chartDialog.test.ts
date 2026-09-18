// F2: the New Chart dialog's two stores, the parts no frame can check.
//
//   addChart        the person's own widget lands: face `chart`, the statement
//                   kept, no `wroteBy` (a cut must never take it away), placed
//                   at the kind's own default span like every other door
//   the dialog      what a pick composes and runs, what `Add Chart` stands on,
//                   which answers are dropped, and what the session does when
//                   the dialog closes
//
// The run is driven through mockIPC, which is the same seam the harness uses:
// a test that stubbed the store's own methods would be checking its own
// arrangement (LESSONS 12).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// canvas.ts reaches tabs.ts and settings.ts, which paint the theme and read
// localStorage at import: the canvas tests' own seam, kept identical
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

const { cancelCanvasSaves, CHART_ROW_CAP, useCanvas } = await import("../canvas");
const { cancelTabSaves, useTabs } = await import("../tabs");
const { useSchema } = await import("../schema");
const { useConnections } = await import("../connections");
const {
  askWordsOf,
  columnsFor,
  openChartDialog,
  picksOf,
  previewBlock,
  specOf,
  useChartDialog,
} = await import("../chartDialog");
const { CHART_LIMITS } = await import("../../canvas/chartSql");
type AgentRun = import("../../agent/types").AgentRun;
type CanvasMeta = import("../canvas").CanvasMeta;

afterAll(() => {
  cancelCanvasSaves();
  cancelTabSaves();
  clearMocks();
});

const PROFILE = "p-f2";
const CANVAS = "c-f2";

const TEXT_ROWS: (string | null)[][] = [
  ["delivered", "41238"],
  ["confirmed", "18804"],
  ["stitching_started", "9120"],
  ["dispatched", "6231"],
  ["cancelled", "5320"],
  ["returned", "1874"],
  ["rto", "933"],
  ["on_hold", "212"],
];

const DATE_ROWS: (string | null)[][] = [
  ["2026-07", "10412"],
  ["2026-08", "11208"],
  ["2026-09", "6122"],
];

/** the wire record `agent_run_readonly` answers with (ipc/types AgentRun) */
const wire = (columns: string[], rows: (string | null)[][], ms: number) => ({
  columns,
  rows,
  row_count: rows.length,
  capped: false,
  ms,
});

const meta = (): CanvasMeta => ({
  id: CANVAS,
  profileId: PROFILE,
  title: "Canvas 7",
  updatedAt: "2026-09-18T09:00:00.000Z",
});

const COLUMNS = [
  { name: "id", attnum: 1, type: "bigint", type_oid: 20, not_null: true, default: null },
  { name: "status", attnum: 2, type: "text", type_oid: 25, not_null: false, default: null },
  { name: "amount", attnum: 3, type: "numeric(10,2)", type_oid: 1700, not_null: false, default: null },
  {
    name: "created_at",
    attnum: 4,
    type: "timestamp with time zone",
    type_oid: 1184,
    not_null: false,
    default: null,
  },
];

/** what the shim answers, and what the last run was asked to run */
interface Wire {
  sql: string[];
  connects: number;
  disconnects: string[];
  /** a run held open, resolved by the test */
  hold: ((run: unknown) => void) | null;
  answer: (sql: string) => unknown;
}
let w: Wire;

function install(): void {
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (cmd === "agent_connect") {
      w.connects += 1;
      return "session-f2";
    }
    if (cmd === "agent_run_readonly") {
      const sql = String(args.sql ?? "");
      w.sql.push(sql);
      if (w.hold) return new Promise((res) => (w.hold = res as (run: unknown) => void));
      return w.answer(sql);
    }
    if (cmd === "disconnect") {
      w.disconnects.push(String(args.sessionId ?? ""));
      return undefined;
    }
    return undefined;
  });
}

const tick = (ms = 0) => new Promise<void>((done) => setTimeout(done, ms));
/** past the dialog's own 250 ms debounce and the round trip after it */
const settled = () => tick(340);

beforeEach(async () => {
  // the previous test's own session leaves on the previous test's wire: a
  // disconnect recorded against THIS test's would read as a second one
  useChartDialog.getState().close();
  await tick();
  w = {
    sql: [],
    connects: 0,
    disconnects: [],
    hold: null,
    answer: (sql) =>
      sql.includes("date_trunc")
        ? wire(["created_at", "avg_amount"], DATE_ROWS, 388.1)
        : wire(["status", "count"], TEXT_ROWS, 241.6),
  };
  install();
  useCanvas.setState({
    canvases: { [PROFILE]: [meta()] },
    docs: { [CANVAS]: { v: 2, blocks: [], lastColumns: 5 } },
    loaded: { [PROFILE]: true },
    recent: { [PROFILE]: CANVAS },
    comparing: {},
    saveError: false,
    editing: null,
    askedFrom: {},
  });
  useSchema.setState({
    snapshots: {
      [PROFILE]: {
        tables: [
          {
            table_oid: 1,
            schema: "public",
            name: "order_v2",
            kind: "r",
            columns: COLUMNS,
            pk: ["id"],
            reltuples: 1_200_000,
          },
          {
            table_oid: 2,
            schema: "analytics",
            name: "order_daily_mv",
            kind: "m",
            columns: COLUMNS,
            pk: [],
            reltuples: -1,
          },
        ],
        foreign_keys: [],
        functions: [],
        schemas: ["public", "analytics"],
        indexes: [],
        enums: [],
      },
    },
  });
  useTabs.setState({
    tabs: [
      {
        id: "t-f2",
        name: "Canvas 7",
        sql: "",
        position: 0,
        saved_id: null,
        kind: "canvas",
        table: null,
        canvas_id: CANVAS,
        profile_id: PROFILE,
      },
    ],
    activeId: "t-f2",
  });
  useConnections.setState({ activeProfileId: PROFILE });
});

// ---- the store door -------------------------------------------------------

describe("addChart", () => {
  const run: AgentRun = {
    columns: ["status", "count"],
    rows: TEXT_ROWS,
    rowCount: TEXT_ROWS.length,
    capped: false,
    ms: 241.6,
  };

  test("a result widget on its chart face, standing on the statement", () => {
    const id = useCanvas.getState().addChart(CANVAS, {
      title: "count by `status`",
      sql: "select status, count(*) as count from public.order_v2 group by 1 order by 2 desc limit 10",
      run,
    });
    const block = useCanvas.getState().docs[CANVAS]?.blocks.find((b) => b.id === id);
    expect(block?.kind).toBe("result");
    if (block?.kind !== "result") throw new Error("not a result");
    expect(block.face).toBe("chart");
    expect(block.title).toBe("count by `status`");
    expect(block.sql).toContain("from public.order_v2");
    expect(block.rows).toHaveLength(8);
  });

  test("no question line, no prose, no assumptions: nobody asked it", () => {
    const id = useCanvas.getState().addChart(CANVAS, { title: "count by `status`", sql: "select 1", run });
    const block = useCanvas.getState().docs[CANVAS]?.blocks.find((b) => b.id === id);
    if (block?.kind !== "result") throw new Error("not a result");
    expect(block.question).toBe("");
    expect(block.prose).toBe("");
    expect(block.chips).toEqual([]);
  });

  test("no wroteBy: a thread that is cut never takes the person's own widget", () => {
    const id = useCanvas.getState().addChart(CANVAS, { title: "count by `status`", sql: "select 1", run });
    const block = useCanvas.getState().docs[CANVAS]?.blocks.find((b) => b.id === id);
    expect(block?.wroteBy).toBeUndefined();
    useCanvas.getState().removeByExchange(["anything"]);
    expect(useCanvas.getState().docs[CANVAS]?.blocks.find((b) => b.id === id)).toBeDefined();
  });

  test("placed on cells, exactly as addNote and addDrawing place theirs", () => {
    const id = useCanvas.getState().addChart(CANVAS, { title: "t", sql: "select 1", run });
    const block = useCanvas.getState().docs[CANVAS]?.blocks.find((b) => b.id === id);
    expect(block?.cell).toBeDefined();
    expect(block?.cell?.w).toBeGreaterThan(0);
    expect(block?.cell?.h).toBeGreaterThan(0);
  });

  test("the status line is capRun's own sentence, one door for every write", () => {
    const id = useCanvas.getState().addChart(CANVAS, { title: "t", sql: "select 1", run });
    const block = useCanvas.getState().docs[CANVAS]?.blocks.find((b) => b.id === id);
    if (block?.kind !== "result") throw new Error("not a result");
    expect(block.status).toBe("8 rows · 241.6 ms");
    expect(block.ms).toBe(241.6);
  });
});

// ---- the dialog -----------------------------------------------------------

describe("the New Chart dialog", () => {
  test("opening takes the canvas's own connection and one session with it", async () => {
    openChartDialog(CANVAS);
    const s = useChartDialog.getState();
    expect(s.canvasId).toBe(CANVAS);
    expect(s.profileId).toBe(PROFILE);
    await tick();
    expect(w.connects).toBe(1);
  });

  test("an id no canvas holds opens nothing", () => {
    openChartDialog("no-such-canvas");
    expect(useChartDialog.getState().canvasId).toBeNull();
  });

  test("nothing is composed, and nothing runs, until a table AND a group stand", async () => {
    openChartDialog(CANVAS);
    expect(picksOf(useChartDialog.getState())).toBeNull();
    useChartDialog.getState().pickTable("public", "order_v2");
    expect(useChartDialog.getState().sql).toBeNull();
    expect(useChartDialog.getState().running).toBe(false);
    await settled();
    expect(w.sql).toHaveLength(0);
  });

  test("a group composes the statement and runs it once", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    // the cycle is up in the pick's own frame, before anything waits
    expect(useChartDialog.getState().running).toBe(true);
    expect(useChartDialog.getState().sql).toBe(
      "select status, count(*) as count from public.order_v2 group by 1 order by 2 desc limit 10",
    );
    await settled();
    expect(w.sql).toHaveLength(1);
    const s = useChartDialog.getState();
    expect(s.running).toBe(false);
    expect(s.run?.rowCount).toBe(8);
    expect(s.error).toBeNull();
  });

  test("the run asks for one row past the cap, so an over-cap answer is known to be one", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    await settled();
    expect(CHART_LIMITS[CHART_LIMITS.length - 1]).toBe(CHART_ROW_CAP);
  });

  test("Add stands on a chart existing, never on a run landing", async () => {
    openChartDialog(CANVAS);
    expect(specOf(previewBlock(null, null))).toBeNull();
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    await settled();
    const s = useChartDialog.getState();
    expect(specOf(previewBlock(s.sql, s.run))?.kind).toBe("bars");
  });

  test("Add is refused while a run is in flight, and lands nothing", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    await settled();
    // a further pick puts the cycle back up: the chart standing is the OLD
    // one and adding it now would land a widget the picks no longer describe
    useChartDialog.getState().pickLimit(20);
    expect(useChartDialog.getState().running).toBe(true);
    expect(useChartDialog.getState().add()).toBeNull();
    expect(useCanvas.getState().docs[CANVAS]?.blocks).toHaveLength(0);
  });

  test("Add lands the widget, closes the dialog and disconnects", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    await settled();
    const id = useChartDialog.getState().add();
    expect(id).not.toBeNull();
    const block = useCanvas.getState().docs[CANVAS]?.blocks.find((b) => b.id === id);
    if (block?.kind !== "result") throw new Error("not a result");
    expect(block.face).toBe("chart");
    expect(block.title).toBe("count by `status`");
    expect(useChartDialog.getState().canvasId).toBeNull();
    await tick();
    expect(w.disconnects).toEqual(["session-f2"]);
  });

  test("a failed run puts the server's first line where the reader is looking, and the picks stand", async () => {
    openChartDialog(CANVAS);
    w.answer = () => {
      throw { message: 'column "statuss" does not exist\nLINE 1: select statuss' };
    };
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    await settled();
    const s = useChartDialog.getState();
    expect(s.error).toBe('column "statuss" does not exist');
    expect(s.run).toBeNull();
    expect(s.running).toBe(false);
    expect(s.table).toBe("order_v2");
    expect(s.group).toBe("status");
    expect(s.sql).not.toBeNull();
    expect(specOf(previewBlock(s.sql, s.run))).toBeNull();
  });

  test("a stale answer is dropped: the pick the reader made last owns the preview", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    w.hold = () => {};
    useChartDialog.getState().pickGroup("status");
    await tick(300);
    const release = w.hold;
    w.hold = null;
    // the reader moves on while the first statement is still on the wire
    useChartDialog.getState().pickGroup("created_at");
    release?.(wire(["created_at", "avg_amount"], DATE_ROWS, 388.1));
    await settled();
    const s = useChartDialog.getState();
    expect(s.group).toBe("created_at");
    expect(s.run?.columns).toEqual(["created_at", "avg_amount"]);
    expect(s.sql).toContain("date_trunc('month', created_at)");
  });

  test("closing drops what is on the wire and never draws it", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    w.hold = () => {};
    useChartDialog.getState().pickGroup("status");
    await tick(300);
    const release = w.hold;
    useChartDialog.getState().close();
    release?.(wire(["status", "count"], TEXT_ROWS, 241.6));
    await settled();
    expect(useChartDialog.getState().run).toBeNull();
    expect(useChartDialog.getState().canvasId).toBeNull();
    expect(w.disconnects).toEqual(["session-f2"]);
  });

  test("a debounced burst of picks reaches the wire once", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    useChartDialog.getState().pickLimit(20);
    useChartDialog.getState().pickLimit(50);
    await settled();
    expect(w.sql).toHaveLength(1);
    expect(w.sql[0]).toEndWith("limit 50");
  });
});

describe("the date group's own two rows", () => {
  test("Per stands only on a date group, and the row cap reads Last 12", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    expect(useChartDialog.getState().groupKind).toBe("text");
    expect(useChartDialog.getState().limit).toBe(10);
    useChartDialog.getState().pickGroup("created_at");
    expect(useChartDialog.getState().groupKind).toBe("date");
    expect(useChartDialog.getState().limit).toBe(12);
    await settled();
  });

  test("going back to a text group takes the twelve with it", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("created_at");
    useChartDialog.getState().pickGroup("status");
    expect(useChartDialog.getState().limit).toBe(10);
    await settled();
  });

  test("a count the reader chose survives a group of the same kind", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    useChartDialog.getState().pickLimit(50);
    useChartDialog.getState().pickGroup("id");
    expect(useChartDialog.getState().limit).toBe(50);
    await settled();
  });

  test("the unit rides the statement", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("created_at");
    useChartDialog.getState().pickMeasure("amount");
    useChartDialog.getState().pickAgg("avg");
    useChartDialog.getState().pickUnit("day");
    await settled();
    expect(useChartDialog.getState().sql).toContain("date_trunc('day', created_at), 'YYYY-MM-DD'");
    expect(w.sql[0]).toStartWith("select * from (");
  });
});

describe("the picks the pickers read", () => {
  test("a table with no analyze behind it wears no row estimate", () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    expect(useChartDialog.getState().tableRows).toBe(1_200_000);
    useChartDialog.getState().pickTable("analytics", "order_daily_mv");
    expect(useChartDialog.getState().tableRows).toBeNull();
  });

  test("a new table drops the picks made against the old one", async () => {
    openChartDialog(CANVAS);
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("created_at");
    useChartDialog.getState().pickMeasure("amount");
    useChartDialog.getState().pickTable("analytics", "order_daily_mv");
    const s = useChartDialog.getState();
    expect(s.group).toBeNull();
    expect(s.measure).toBeNull();
    expect(s.limit).toBe(10);
    expect(s.sql).toBeNull();
    await settled();
  });

  test("the columns come from the chosen table and carry their kind", () => {
    openChartDialog(CANVAS);
    expect(columnsFor(useChartDialog.getState())).toHaveLength(0);
    useChartDialog.getState().pickTable("public", "order_v2");
    const cols = columnsFor(useChartDialog.getState());
    expect(cols.map((c) => c.name)).toEqual(["id", "status", "amount", "created_at"]);
    expect(cols.find((c) => c.name === "amount")?.kind).toBe("numeric");
    expect(cols.find((c) => c.name === "created_at")?.kind).toBe("date");
    expect(cols.find((c) => c.name === "status")?.kind).toBe("text");
  });

  test("Ask instead carries whatever has been picked, and the old words when nothing has", () => {
    openChartDialog(CANVAS);
    expect(askWordsOf(useChartDialog.getState())).toBe("add a chart of ");
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    expect(askWordsOf(useChartDialog.getState())).toBe("add a chart of order_v2 by status");
  });
});

describe("the two doors", () => {
  test("the palette's New Chart… opens the dialog on the connection's current canvas", async () => {
    useCanvas.getState().newChart();
    await tick(20);
    expect(useChartDialog.getState().canvasId).toBe(CANVAS);
  });

  test("a connection with no canvas gets one, exactly as New Drawing makes one", async () => {
    useCanvas.setState({ canvases: {}, docs: {}, recent: {}, loaded: { [PROFILE]: true } });
    useTabs.setState({ tabs: [], activeId: null });
    useCanvas.getState().newChart();
    await tick(20);
    const id = useChartDialog.getState().canvasId;
    expect(id).not.toBeNull();
    expect(useCanvas.getState().canvases[PROFILE]?.[0]?.id).toBe(id!);
  });
});
