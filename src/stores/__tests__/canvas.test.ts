// The canvas document (A3). What is pinned here is the store's half of the
// wave: which canvas an answer lands on, what one exchange becomes, the faces
// a block can actually wear, and the diff, which is the only thing on the
// canvas that can quietly lie (a pairing that guesses which row answers which
// is worse than no comparison at all).
//
// The backend is Tauri's own mock transport, so every `invoke` the store makes
// is recorded in order and the appdb writes can be read back exactly as the
// database would hold them.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

// canvas.ts pulls in tabs.ts and settings.ts, which paint the theme onto the
// document at import and read localStorage; bun has neither (the agent store
// tests' own shim, kept identical so one fix serves both)
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
const canvas = await import("../canvas");
const {
  buildDiff,
  cancelCanvasSaves,
  chartOf,
  compareTargets,
  columnKinds,
  DIFF_ROW_CAP,
  facesOf,
  statusOf,
  useCanvas,
} = canvas;
type Block = import("../canvas").Block;
type DiffSide = import("../canvas").DiffSide;
type ResultBlock = import("../canvas").ResultBlock;
const { cancelTabSaves, useTabs } = await import("../tabs");
const { useConnections } = await import("../connections");
const { useAgent } = await import("../agent");
// importing ../canvas above is what registers the port, so it stands already
const { useCanvasPort } = await import("../../canvas/port");
const canvasPort = () => useCanvasPort.getState().port;

type Exchange = import("../agent").Exchange;
type AgentRun = import("../../agent/types").AgentRun;
type Profile = import("../../ipc/types").Profile;

/** one row over the chart's and the diff's shared cap */
const OVER_CAP = 201;

// a block landed in the last assertion leaves a 400ms write behind it; the
// suite that runs after this one has torn the mock transport down by then, so
// the pending write is dropped here rather than left to land on nothing
afterEach(() => {
  cancelCanvasSaves();
  cancelTabSaves();
});

afterAll(() => {
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- the backend seam -----------------------------------------------------

interface Invoked {
  cmd: string;
  args: Record<string, unknown>;
}
interface CanvasRow {
  id: string;
  profile_id: string;
  title: string;
  doc_json: string;
  created_at: string;
  updated_at: string;
}
interface TabRow {
  id: string;
  name: string;
  sql: string;
  position: number;
  saved_id: string | null;
  profile_id: string | null;
  canvas_id: string | null;
}
let calls: Invoked[] = [];
/** what appdb holds: a write here is what the next canvas_list reads */
let stored: CanvasRow[] = [];
/** the tabs table, same contract: a replace-all write is what a restart reads */
let tabRows: TabRow[] = [];
/** the rows agent_run_readonly hands back, per session */
let runResult: AgentRun & { row_count: number } = {
  columns: [],
  rows: [],
  rowCount: 0,
  row_count: 0,
  capped: false,
  ms: 0,
};
let runFails: string | null = null;

function installIpc() {
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    if (cmd === "canvas_upsert") {
      const row = args.row as Omit<CanvasRow, "created_at" | "updated_at">;
      const at = stored.findIndex((c) => c.id === row.id);
      const next = { ...row, created_at: "2026-09-06", updated_at: "2026-09-06" };
      if (at >= 0) stored[at] = next;
      else stored.push(next);
      return undefined;
    }
    if (cmd === "canvas_list") return stored.filter((c) => c.profile_id === args.profileId);
    if (cmd === "canvas_delete") {
      stored = stored.filter((c) => c.id !== args.id);
      return undefined;
    }
    if (cmd === "tabs_save") {
      tabRows = args.tabs as TabRow[];
      return undefined;
    }
    if (cmd === "tabs_list") return tabRows;
    if (cmd === "agent_connect") return "session-b";
    if (cmd === "agent_run_readonly") {
      if (runFails) throw new Error(runFails);
      return runResult;
    }
    return undefined;
  });
}

function seed() {
  calls = [];
  stored = [];
  tabRows = [];
  runFails = null;
  installIpc();
  // the canvas store reads a profile's id and its name and nothing else
  useConnections.setState({
    profiles: [
      { id: "staging", name: "staging" },
      { id: "prod", name: "prod" },
      { id: "analytics", name: "analytics" },
    ] as unknown as Profile[],
    activeProfileId: "staging",
  });
  useTabs.setState({ tabs: [], activeId: null, loaded: true, closedStack: [] });
  useAgent.setState({ threads: {}, exchanges: {} });
  useCanvas.setState({
    canvases: {},
    docs: {},
    loaded: {},
    recent: {},
    comparing: {},
    saveError: false,
    askedFrom: {},
  });
}

beforeEach(seed);

// ---- fixtures -------------------------------------------------------------

const run = (columns: string[], rows: (string | null)[][], ms = 311.8): AgentRun => ({
  columns,
  rows,
  rowCount: rows.length,
  capped: false,
  ms,
});

function exchange(over: Partial<Exchange> = {}): Exchange {
  const r = over.answer?.run ?? run(["payment_status", "orders"], [["paid", "482"]]);
  return {
    id: over.id ?? crypto.randomUUID(),
    turnId: null,
    question: "can you check the revenue in last month",
    text: "Nearly all of last month's paid revenue is INR.",
    thinking: "",
    chips: [],
    streaming: false,
    provider: "claude-code",
    model: "claude-haiku-4-5",
    error: null,
    answer: {
      verdict: { status: "answered", sql: "select 1", rowCount: r.rowCount },
      sql: "select payment_status, count(*) from orders group by 1",
      run: r,
      assumptions: [
        { id: "a1", label: "Last Month = August 2026", source: "model", active: true },
        { id: "a2", label: "Revenue = Paid Orders", source: "model", active: true },
        { id: "a3", label: "Excluded Test Orders", source: "detected", active: false },
      ],
      sanity: [],
      trace: [],
      text: "Nearly all of last month's paid revenue is INR.",
      turns: 1,
      ms: 20400,
      usage: { input: 1, output: 1 },
      promptVersion: "v4",
      candidates: [],
      recall: null,
      risky: false,
    },
    ...over,
  } as Exchange;
}

const blocksOf = (id: string): Block[] => useCanvas.getState().docs[id]?.blocks ?? [];
const resultAt = (id: string, i: number): ResultBlock => {
  const b = blocksOf(id)[i];
  if (b.kind !== "result") throw new Error("expected a result block");
  return b;
};

// ---- where an answer lands ------------------------------------------------

describe("addExchange", () => {
  test("with no canvas open it makes one, gives it a tab, and does not switch to it", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toBe(true);

    const tabs = useTabs.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("canvas");
    expect(tabs[0].canvas_id).toBe(out.canvasId);
    expect(tabs[0].name).toBe("Canvas");
    // the block lands, the pane keeps the conversation (A3 item 3)
    expect(useTabs.getState().activeId).toBeNull();
    expect(blocksOf(out.canvasId)).toHaveLength(1);
  });

  test("a second answer joins the canvas the first one made", async () => {
    const first = useCanvas.getState().addExchange("staging", exchange());
    const second = useCanvas.getState().addExchange("staging", exchange());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.canvasId).toBe(first.canvasId);
    expect(second.created).toBe(false);
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(blocksOf(first.canvasId)).toHaveLength(2);
  });

  test("with two canvases open it takes the one last looked at, not the last opened", async () => {
    const older = useCanvas.getState().create("staging");
    const newer = useCanvas.getState().create("staging");
    useTabs.getState().openCanvasTab(older, "Canvas");
    useTabs.getState().openCanvasTab(newer, "Canvas 2");
    // the strip's last tab is `newer`; the tab the user came back to is `older`
    const olderTab = useTabs.getState().tabs.find((t) => t.canvas_id === older)!;
    useTabs.getState().select(olderTab.id);

    const out = useCanvas.getState().addExchange("staging", exchange());
    expect(out.ok && out.canvasId).toBe(older);
  });

  test("another connection's canvas is never the one an answer lands on", async () => {
    const mine = useCanvas.getState().create("staging");
    useTabs.getState().openCanvasTab(mine, "Canvas");
    const out = useCanvas.getState().addExchange("prod", exchange());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.canvasId).not.toBe(mine);
    expect(out.created).toBe(true);
  });

  test("prose with no run becomes a note that keeps its question", async () => {
    const ex = exchange();
    const out = await useCanvas
      .getState()
      .addExchange("staging", { ...ex, answer: { ...ex.answer!, run: null, sql: null } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const b = blocksOf(out.canvasId)[0];
    expect(b.kind).toBe("note");
    if (b.kind !== "note") return;
    expect(b.question).toBe(ex.question);
    expect(b.text).toContain("INR");
  });

  test("an exchange with neither rows nor prose adds nothing", async () => {
    const ex = exchange();
    const out = await useCanvas
      .getState()
      .addExchange("staging", { ...ex, text: "", answer: { ...ex.answer!, run: null, text: "" } });
    expect(out.ok).toBe(false);
    expect(useTabs.getState().tabs).toHaveLength(0);
  });

  test("a reply asked FROM a block lands directly under that block", async () => {
    const first = useCanvas.getState().addExchange("staging", exchange());
    if (!first.ok) throw new Error("seed failed");
    const under = useCanvas.getState().addExchange("staging", exchange());
    if (!under.ok) throw new Error("seed failed");

    const reply = exchange({ id: "ex-reply" });
    useCanvas.getState().noteAskedFrom("ex-reply", first.blockId);
    const out = useCanvas.getState().addExchange("staging", reply);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // a block no canvas holds records nothing rather than a stale link
    useCanvas.getState().noteAskedFrom("ex-nowhere", "not-a-block");
    expect(useCanvas.getState().askedFrom["ex-nowhere"]).toBeUndefined();

    const ids = blocksOf(first.canvasId).map((b) => b.id);
    expect(ids).toEqual([first.blockId, out.blockId, under.blockId]);
    expect(blocksOf(first.canvasId)[1].askedFrom).toBe(first.blockId);
  });

  test("the block carries the run whole, the active assumptions, and W7's status", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    const b = resultAt(out.canvasId, 0);
    expect(b.question).toBe("can you check the revenue in last month");
    expect(b.prose).toContain("INR");
    expect(b.columns).toEqual(["payment_status", "orders"]);
    expect(b.status).toBe("1 row · 311.8 ms");
    expect(b.ms).toBe(311.8);
    // an assumption the user switched off is not one the answer made
    expect(b.chips).toEqual(["Last Month = August 2026", "Revenue = Paid Orders"]);
    // B3: a press keeps the face the reader was looking at, which for ONE row
    // is its figures (the values face) and for more is the grid
    expect(b.face).toBe("values");
  });

  test("a run of more than one row opens on the grid, as the pane showed it", () => {
    const ex = exchange();
    const wide = run(["payment_status", "orders"], [["paid", "482"], ["failed", "61"]]);
    const out = useCanvas
      .getState()
      .addExchange("staging", { ...ex, answer: { ...ex.answer!, run: wide } });
    if (!out.ok) throw new Error("add failed");
    const b = resultAt(out.canvasId, 0);
    expect(b.face).toBe("table");
    expect(b.status).toBe("2 rows · 311.8 ms");
  });

  test("a run that left no rows opens on the SQL face (W7's own rule)", async () => {
    const ex = exchange();
    const out = await useCanvas
      .getState()
      .addExchange("staging", { ...ex, answer: { ...ex.answer!, run: run(["n"], []) } });
    if (!out.ok) throw new Error("add failed");
    expect(resultAt(out.canvasId, 0).face).toBe("sql");
  });
});

// ---- notes ----------------------------------------------------------------

describe("notes", () => {
  test("a note emptied in edit deletes itself on commit", async () => {
    const id = useCanvas.getState().create("staging");
    const blockId = useCanvas.getState().addNote(id, "for Friday's call");
    useCanvas.getState().updateNote(id, blockId, "for Friday's finance call");
    expect((blocksOf(id)[0] as { text: string }).text).toBe("for Friday's finance call");
    useCanvas.getState().updateNote(id, blockId, "   ");
    expect(blocksOf(id)).toHaveLength(0);
  });

  test("move is a no-op at either end and never loses a block", async () => {
    const id = useCanvas.getState().create("staging");
    const a = useCanvas.getState().addNote(id, "a");
    const b = useCanvas.getState().addNote(id, "b");
    useCanvas.getState().move(id, a, -1);
    expect(blocksOf(id).map((x) => x.id)).toEqual([a, b]);
    useCanvas.getState().move(id, a, 1);
    expect(blocksOf(id).map((x) => x.id)).toEqual([b, a]);
    useCanvas.getState().move(id, a, 1);
    expect(blocksOf(id).map((x) => x.id)).toEqual([b, a]);
  });
});

// ---- the faces ------------------------------------------------------------

describe("faces", () => {
  const block = (columns: string[], rows: (string | null)[][]): ResultBlock => ({
    id: "b1",
    kind: "result",
    question: "q",
    prose: "",
    sql: "select 1",
    columns,
    rows,
    chips: [],
    status: "",
    ms: 1,
    face: "table",
  });

  test("a label column and a numeric column make a chart; the cycle is three", () => {
    const b = block(["channel", "orders"], [["app", "1602"], ["web", "486"]]);
    expect(facesOf(b)).toEqual(["table", "chart", "sql"]);
    const spec = chartOf(b)!;
    expect(spec.kind).toBe("bars");
    expect(spec.label).toBe("channel");
    expect(spec.series).toEqual([{ name: "orders", values: [1602, 486] }]);
  });

  test("a date label draws a line instead of bars", () => {
    const spec = chartOf(block(["month", "usd"], [["2026-07-01", "4"], ["2026-08-01", "7"]]))!;
    expect(spec.kind).toBe("line");
  });

  test("no chart face over the row cap, over three series, or with two labels", () => {
    const many = Array.from({ length: OVER_CAP }, (_, i) => [`c${i}`, "1"]);
    expect(chartOf(block(["channel", "orders"], many))).toBeNull();
    expect(
      chartOf(block(["c", "a", "b", "d", "e"], [["x", "1", "2", "3", "4"]])),
    ).toBeNull();
    expect(chartOf(block(["city", "state", "orders"], [["Pune", "MH", "187"]]))).toBeNull();
    // no numbers at all is no chart either
    expect(chartOf(block(["city", "state"], [["Pune", "MH"]]))).toBeNull();
    // and the cycle simply loses the face rather than landing on nothing. One
    // row stands on its figures, which is the table face's own place (B3)
    expect(facesOf(block(["city", "state"], [["Pune", "MH"]]))).toEqual(["values", "sql"]);
    expect(
      facesOf(block(["city", "state"], [["Pune", "MH"], ["Nashik", "MH"]])),
    ).toEqual(["table", "sql"]);
  });

  test("flip walks the cycle the block actually has and comes back round", async () => {
    const id = useCanvas.getState().create("staging");
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    const cid = out.canvasId;
    const bid = out.blockId;
    // the fixture's run is one row, so the values face holds the table's place
    expect(resultAt(cid, 0).face).toBe("values");
    useCanvas.getState().flip(cid, bid);
    expect(resultAt(cid, 0).face).toBe("chart");
    useCanvas.getState().flip(cid, bid);
    expect(resultAt(cid, 0).face).toBe("sql");
    useCanvas.getState().flip(cid, bid);
    expect(resultAt(cid, 0).face).toBe("values");
    // a face the block does not have is refused, not stored
    useCanvas.getState().setFace(cid, bid, "diff");
    expect(resultAt(cid, 0).face).toBe("values");
    useCanvas.getState().setFace(cid, bid, "table");
    expect(resultAt(cid, 0).face).toBe("values");
    expect(id).toBeTruthy();
  });

  test("the face is a fact of the document, so it rides doc_json", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    useCanvas.getState().flip(out.canvasId, out.blockId);
    await Bun.sleep(500);
    const row = stored.find((c) => c.id === out.canvasId)!;
    expect(JSON.parse(row.doc_json).blocks[0].face).toBe("chart");
  });
});


// ---- the diff -------------------------------------------------------------

describe("buildDiff", () => {
  const A: DiffSide = { profileId: "staging", name: "staging", ms: 412.6 };
  const B: DiffSide = { profileId: "prod", name: "prod", ms: 388.1 };
  const columns = ["payment_status", "orders", "amount"];
  const aRows = [
    ["cod_delivered", "731", "1988640.00"],
    ["failed", "611", "1402315.00"],
    ["paid", "482", "2277416.00"],
  ];
  const bRows = [
    ["cod_delivered", "748", "2011200.00"],
    ["failed", "640", "1466980.00"],
    ["partial_refund", "21", "61420.00"],
  ];
  const build = (over: Partial<Parameters<typeof buildDiff>[0]> = {}) =>
    buildDiff({
      columns,
      aRows,
      bColumns: columns,
      bRows,
      aTotal: aRows.length,
      bTotal: bRows.length,
      a: A,
      b: B,
      ...over,
    });

  test("the label columns key the rows and the numbers pair up", () => {
    const out = build();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diff.labelColumns).toEqual(["payment_status"]);
    expect(out.diff.numericColumns).toEqual(["orders", "amount"]);
    const first = out.diff.rows[0];
    expect(first.labels).toEqual(["cod_delivered"]);
    // both sides exactly as the database printed them
    expect(first.cells[0].a).toBe("731");
    expect(first.cells[0].b).toBe("748");
    expect(first.cells[0].delta).toBeCloseTo(2.3, 1);
    expect(first.only).toBeNull();
  });

  test("a row on one side only carries no delta and says which side it lacks", () => {
    const out = build();
    if (!out.ok) throw new Error("diff refused");
    const onlyA = out.diff.rows.find((r) => r.labels[0] === "paid")!;
    expect(onlyA.only).toBe("a");
    expect(onlyA.cells[0].b).toBeNull();
    expect(onlyA.cells[0].delta).toBeNull();
    const onlyB = out.diff.rows.find((r) => r.labels[0] === "partial_refund")!;
    expect(onlyB.only).toBe("b");
    expect(onlyB.cells[0].a).toBeNull();
    // A's order first, then the rows only B has
    expect(out.diff.rows.map((r) => r.labels[0])).toEqual([
      "cod_delivered",
      "failed",
      "paid",
      "partial_refund",
    ]);
  });

  test("the delta is signed and relative, and undefined from a zero", () => {
    const out = buildDiff({
      columns: ["k", "n"],
      aRows: [["a", "100"], ["b", "0"], ["c", "50"]],
      bColumns: ["k", "n"],
      bRows: [["a", "75"], ["b", "9"], ["c", "50"]],
      aTotal: 3,
      bTotal: 3,
      a: A,
      b: B,
    });
    if (!out.ok) throw new Error("diff refused");
    expect(out.diff.rows[0].cells[0].delta).toBeCloseTo(-25, 6);
    // a relative change from nothing is not a number; the cell still shows both
    expect(out.diff.rows[1].cells[0].delta).toBeNull();
    expect(out.diff.rows[1].cells[0].b).toBe("9");
    expect(out.diff.rows[2].cells[0].delta).toBe(0);
  });

  test("over the cap on either side the diff is its status line and no rows", () => {
    const over = build({ bTotal: DIFF_ROW_CAP + 1 });
    if (!over.ok) throw new Error("diff refused");
    expect(over.diff.capped).toBe(true);
    expect(over.diff.rows).toHaveLength(0);
    // the two connections are still named: the comparison happened
    expect(over.diff.a.name).toBe("staging");
    expect(over.diff.b.name).toBe("prod");
    const aOver = build({ aTotal: DIFF_ROW_CAP + 1 });
    expect(aOver.ok && aOver.diff.capped).toBe(true);
    const atCap = build({ bTotal: DIFF_ROW_CAP });
    expect(atCap.ok && atCap.diff.capped).toBe(false);
  });

  test("it refuses rather than guess: different columns, repeated labels, no numbers", () => {
    const shape = build({ bColumns: ["payment_status", "orders"] });
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.message).toContain("different columns");

    const dupe = build({ aRows: [["paid", "1", "2"], ["paid", "3", "4"]], aTotal: 2 });
    expect(dupe.ok).toBe(false);
    if (!dupe.ok) expect(dupe.message).toContain("staging");

    const noNumbers = buildDiff({
      columns: ["a", "b"],
      aRows: [["x", "y"]],
      bColumns: ["a", "b"],
      bRows: [["x", "z"]],
      aTotal: 1,
      bTotal: 1,
      a: A,
      b: B,
    });
    expect(noNumbers.ok).toBe(false);

    const noLabels = buildDiff({
      columns: ["n"],
      aRows: [["1"]],
      bColumns: ["n"],
      bRows: [["2"]],
      aTotal: 1,
      bTotal: 1,
      a: A,
      b: B,
    });
    expect(noLabels.ok).toBe(false);
  });

  test("a column that is numeric on one side only is a label on both", () => {
    const { labels, numbers } = columnKinds(
      ["k", "n"],
      [["a", "1"], ["b", "n/a"]],
    );
    expect(labels).toEqual([0, 1]);
    expect(numbers).toEqual([]);
  });
});

// ---- compare, end to end --------------------------------------------------

describe("compare", () => {
  test("runs read-only on the sibling, keeps the diff, and turns the block to it", async () => {
    const out = useCanvas.getState().addExchange(
      "staging",
      exchange({
        answer: {
          ...exchange().answer!,
          run: run(["payment_status", "orders"], [["paid", "482"], ["failed", "611"]]),
        },
      }),
    );
    if (!out.ok) throw new Error("add failed");
    runResult = {
      columns: ["payment_status", "orders"],
      rows: [["paid", "479"], ["failed", "640"]],
      rowCount: 2,
      row_count: 2,
      capped: false,
      ms: 388.1,
    };
    calls = [];

    const verdict = await useCanvas.getState().compare(out.canvasId, out.blockId, "prod");
    expect(verdict.ok).toBe(true);
    const names = calls.map((c) => c.cmd);
    expect(names).toEqual(["agent_connect", "agent_run_readonly", "disconnect"]);
    expect(calls[0].args.profileId).toBe("prod");
    // both sides capped at the same number, one row over so the cap is visible
    expect(calls[1].args.maxRows).toBe(DIFF_ROW_CAP + 1);

    const b = resultAt(out.canvasId, 0);
    expect(b.face).toBe("diff");
    expect(b.diff!.a.name).toBe("staging");
    expect(b.diff!.b.name).toBe("prod");
    expect(b.diff!.b.ms).toBe(388.1);
    expect(b.diff!.rows).toHaveLength(2);
    // the diff stands in the table face's place, so the cycle stays three
    expect(facesOf(b)).toEqual(["diff", "chart", "sql"]);
    expect(useCanvas.getState().comparing[out.blockId]).toBeUndefined();

    useCanvas.getState().clearCompare(out.canvasId, out.blockId);
    expect(resultAt(out.canvasId, 0).diff).toBeUndefined();
    expect(resultAt(out.canvasId, 0).face).toBe("table");
  });

  test("a failure says why, keeps the block as it was, and closes the session", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    runFails = "ERROR: relation \"orders\" does not exist";
    calls = [];
    const verdict = await useCanvas.getState().compare(out.canvasId, out.blockId, "prod");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("does not exist");
    expect(calls.map((c) => c.cmd)).toContain("disconnect");
    expect(resultAt(out.canvasId, 0).diff).toBeUndefined();
    expect(useCanvas.getState().comparing[out.blockId]).toBeUndefined();
  });

  test("a block deleted while the query ran is not written back (LESSONS 3)", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    runResult = {
      columns: ["payment_status", "orders"],
      rows: [["paid", "479"]],
      rowCount: 1,
      row_count: 1,
      capped: false,
      ms: 12,
    };
    const running = useCanvas.getState().compare(out.canvasId, out.blockId, "prod");
    useCanvas.getState().remove(out.canvasId, out.blockId);
    await running;
    expect(blocksOf(out.canvasId)).toHaveLength(0);
  });

  test("the siblings offered are every other connection", () => {
    expect(compareTargets("staging").map((p) => p.id)).toEqual(["prod", "analytics"]);
  });
});

// ---- the status line ------------------------------------------------------

describe("statusOf", () => {
  test("a run states its own facts and folds the assumptions in", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    const s = statusOf(resultAt(out.canvasId, 0))!;
    expect(s.facts).toBe("1 row · 311.8 ms");
    expect(s.sides).toEqual([]);
    expect(s.assumed).toEqual(["Last Month = August 2026", "Revenue = Paid Orders"]);
  });

  test("a comparison names both connections once, and says so over the cap", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    runResult = {
      columns: ["payment_status", "orders"],
      rows: [["paid", "479"]],
      rowCount: 1,
      row_count: 1,
      capped: false,
      ms: 388.1,
    };
    await useCanvas.getState().compare(out.canvasId, out.blockId, "prod");
    const s = statusOf(resultAt(out.canvasId, 0))!;
    expect(s.facts).toBe("1 row");
    expect(s.sides).toEqual([
      { name: "staging", ms: 311.8 },
      { name: "prod", ms: 388.1 },
    ]);
    expect(s.assumed).toEqual(["Last Month = August 2026", "Revenue = Paid Orders"]);

    runResult = { ...runResult, row_count: DIFF_ROW_CAP + 1 };
    await useCanvas.getState().compare(out.canvasId, out.blockId, "prod");
    expect(statusOf(resultAt(out.canvasId, 0))!.facts).toBe(`over ${DIFF_ROW_CAP} rows`);
  });

  test("a note has no status line", async () => {
    const id = useCanvas.getState().create("staging");
    const b = useCanvas.getState().addNote(id, "note");
    expect(statusOf(blocksOf(id).find((x) => x.id === b)!)).toBeNull();
  });
});

// ---- persistence ----------------------------------------------------------

describe("persistence", () => {
  test("the document is written debounced and read back whole", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    useCanvas.getState().addNote(out.canvasId, "for Friday's finance call");
    await Bun.sleep(500);

    const row = stored.find((c) => c.id === out.canvasId)!;
    expect(row.title).toBe("Canvas");
    expect(row.profile_id).toBe("staging");
    const doc = JSON.parse(row.doc_json) as { blocks: Block[] };
    expect(doc.blocks.map((b) => b.kind)).toEqual(["result", "note"]);

    // a fresh window reads the same document back
    useCanvas.setState({ canvases: {}, docs: {}, loaded: {}, recent: {} });
    await useCanvas.getState().load("staging");
    expect(blocksOf(out.canvasId).map((b) => b.kind)).toEqual(["result", "note"]);
    expect(useCanvas.getState().canvases.staging[0].title).toBe("Canvas");
  });

  test("a document that did not parse is listed and never written over", async () => {
    stored = [
      {
        id: "c-broken",
        profile_id: "staging",
        title: "Canvas",
        doc_json: "{not json",
        created_at: "",
        updated_at: "",
      },
    ];
    await useCanvas.getState().load("staging");
    expect(useCanvas.getState().canvases.staging[0].broken).toBe(true);
    useCanvas.getState().rename("c-broken", "Renamed");
    await Bun.sleep(500);
    expect(stored[0].doc_json).toBe("{not json");
  });

  test("deleting a canvas takes its tab with it", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    expect(useTabs.getState().tabs).toHaveLength(1);
    await useCanvas.getState().deleteCanvas(out.canvasId);
    expect(useTabs.getState().tabs).toHaveLength(0);
    expect(stored.find((c) => c.id === out.canvasId)).toBeUndefined();
    expect(useCanvas.getState().docs[out.canvasId]).toBeUndefined();
  });

  test("renaming a canvas renames its tab, and deleting it leaves nothing to reopen", () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    useCanvas.getState().rename(out.canvasId, "Finance");
    expect(useTabs.getState().tabs[0].name).toBe("Finance");

    void useCanvas.getState().deleteCanvas(out.canvasId);
    expect(useTabs.getState().closedStack).toHaveLength(0);
    useTabs.getState().restoreClosed();
    expect(useTabs.getState().tabs).toHaveLength(0);
  });

  test("a canvas tab survives a restart, its canvas id standing in for the kind", async () => {
    const out = useCanvas.getState().addExchange("staging", exchange());
    if (!out.ok) throw new Error("add failed");
    await Bun.sleep(700); // the tabs store's own debounce is 600ms
    expect(tabRows).toHaveLength(1);
    expect(tabRows[0].canvas_id).toBe(out.canvasId);
    expect(tabRows[0].profile_id).toBe("staging");

    // relaunch: the appdb row is all the strip has to go on
    useTabs.setState({ tabs: [], activeId: null, loaded: false });
    await useTabs.getState().load();
    const t = useTabs.getState().tabs[0];
    expect(t.kind).toBe("canvas");
    expect(t.canvas_id).toBe(out.canvasId);
    expect(t.name).toBe("Canvas");
  });

  test("a second canvas on one connection gets a numbered name", async () => {
    useCanvas.getState().create("staging");
    const second = useCanvas.getState().create("staging");
    const titles = useCanvas.getState().canvases.staging.map((c) => c.title);
    expect(titles).toContain("Canvas");
    expect(titles).toContain("Canvas 2");
    expect(second).toBeTruthy();
  });
});

// ---- the palette's two doors ---------------------------------------------

describe("New Canvas and New Note", () => {
  test("New Canvas goes there; Add to Canvas is the one that does not", () => {
    useCanvas.getState().newCanvas();
    const tab = useTabs.getState().tabs[0];
    expect(tab.kind).toBe("canvas");
    expect(tab.name).toBe("Canvas");
    expect(useTabs.getState().activeId).toBe(tab.id);
  });

  test("New Note opens a canvas when there is none and lands in edit", () => {
    useCanvas.getState().newNote();
    const tab = useTabs.getState().tabs[0];
    expect(tab.kind).toBe("canvas");
    const cid = tab.canvas_id!;
    expect(blocksOf(cid)).toHaveLength(1);
    expect(useCanvas.getState().editing).toBe(blocksOf(cid)[0].id);
    // committing it empty takes it away again (the fold precedent)
    useCanvas.getState().updateNote(cid, blocksOf(cid)[0].id, "");
    expect(blocksOf(cid)).toHaveLength(0);
  });

  test("New Note writes into the canvas already open, never a second one", () => {
    const id = useCanvas.getState().create("staging");
    useTabs.getState().openCanvasTab(id, "Canvas");
    useCanvas.getState().newNote();
    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(blocksOf(id)).toHaveLength(1);
  });

  test("with no connection active neither door does anything", () => {
    useConnections.setState({ activeProfileId: null });
    useCanvas.getState().newCanvas();
    useCanvas.getState().newNote();
    expect(useTabs.getState().tabs).toHaveLength(0);
  });
});

// ---- the door from Ask (canvas/port.ts) -----------------------------------

describe("the canvas port", () => {
  /** the pane's own state: a thread of one connection holding one exchange */
  function thread(ex: Exchange, profileId = "staging") {
    useAgent.setState({
      threads: {
        [profileId]: [{ id: "th1", profileId, title: "t", createdAt: "2026-09-06" }],
      },
      exchanges: { th1: [ex] },
    });
  }

  test("Add to Canvas names an exchange by id and reports which cue to show", () => {
    thread(exchange({ id: "ex-1" }));
    const port = canvasPort()!;
    expect(port).toBeTruthy();
    expect(port.addExchange("ex-1")).toEqual({ ok: true, created: true });
    expect(port.addExchange("ex-1")).toEqual({ ok: true, created: false });
    expect(blocksOf(useCanvas.getState().currentFor("staging")!)).toHaveLength(2);
  });

  test("an exchange the pane no longer holds adds nothing and says why", () => {
    const out = canvasPort()!.addExchange("ex-gone");
    expect(out.ok).toBe(false);
    expect(out.message).toBe("that answer is gone");
    expect(useTabs.getState().tabs).toHaveLength(0);
  });

  test("the block lands on the EXCHANGE's connection, not the active one", () => {
    thread(exchange({ id: "ex-prod" }), "prod");
    useConnections.setState({ activeProfileId: "staging" });
    canvasPort()!.addExchange("ex-prod");
    expect(useCanvas.getState().canvases.prod).toHaveLength(1);
    expect(useCanvas.getState().canvases.staging).toBeUndefined();
  });
});
