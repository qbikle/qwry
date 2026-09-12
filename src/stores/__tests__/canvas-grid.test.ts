// The document as a LAYOUT (C2). Four things are under test and only four:
// the pair (a document we emit is a document we parse, LESSONS 1), the
// migration (A3's ordered list opens as rows of cells and the old document is
// not written over until the user's own first change), the spans (what a kind
// opens at, read from its content), and the commit path (every geometry answer
// comes from the engine, and appdb hears about it once per gesture end).
//
// The engine's own invariants are tested next door without a store
// (src/canvas/__tests__/grid.test.ts); what is tested here is the document's
// half: which slot a block occupies, what its content measures, and when a
// layout is allowed to reach appdb at all.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

// canvas.ts pulls in tabs.ts and settings.ts, which paint the theme onto the
// document at import and read localStorage; bun has neither (the canvas store
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
const {
  cancelCanvasSaves,
  defaultSpanFor,
  drawingName,
  flushCanvases,
  laidOut,
  migrateV1,
  minSpanFor,
  parseDoc,
  readDoc,
  useCanvas,
  writeDoc,
} = await import("../canvas");
const { cancelTabSaves, useTabs } = await import("../tabs");
const { useConnections } = await import("../connections");
const { useAgent } = await import("../agent");
const { COLUMNS_FALLBACK } = await import("../../agent/tools");
const { COLUMNS_MAX, MIGRATE_W_MAX, overlaps, place, SPAN_MAX } = await import("../../canvas/grid");

type Block = import("../canvas").Block;
type CanvasDoc = import("../canvas").CanvasDoc;
type Cell = import("../../canvas/grid").Cell;
type AgentRun = import("../../agent/types").AgentRun;
type Profile = import("../../ipc/types").Profile;

afterEach(() => {
  cancelCanvasSaves();
  cancelTabSaves();
});

afterAll(() => {
  // every pending write dropped BEFORE the transport goes: a timer that lands
  // on a torn-down mock reads as a failed save and starts retrying against it
  cancelCanvasSaves();
  cancelTabSaves();
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- the backend seam -----------------------------------------------------

interface CanvasRow {
  id: string;
  profile_id: string;
  title: string;
  doc_json: string;
  created_at: string;
  updated_at: string;
}
let stored: CanvasRow[] = [];
/** every canvas_upsert since the last `writes.length = 0`: the only honest
 * answer to "did that gesture write?" */
let writes: CanvasRow[] = [];

function seed() {
  stored = [];
  writes = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (cmd === "canvas_upsert") {
      const row = args.row as Omit<CanvasRow, "created_at" | "updated_at">;
      const next = { ...row, created_at: "2026-09-11", updated_at: "2026-09-11" };
      writes.push(next);
      const at = stored.findIndex((c) => c.id === row.id);
      if (at >= 0) stored[at] = next;
      else stored.push(next);
      return undefined;
    }
    if (cmd === "canvas_list") return stored.filter((c) => c.profile_id === args.profileId);
    if (cmd === "canvas_delete") {
      stored = stored.filter((c) => c.id !== args.id);
      return undefined;
    }
    return undefined;
  });
  useConnections.setState({
    profiles: [{ id: "staging", name: "staging" }] as unknown as Profile[],
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

/** fire every write the document has scheduled, now. The debounce itself is
 * A3's and tested there; what is tested here is WHETHER a gesture scheduled
 * one at all, and a flush answers that exactly instead of by sleeping */
const saved = () => flushCanvases();

const run = (columns: string[], rows: (string | null)[][]): AgentRun => ({
  columns,
  rows,
  rowCount: rows.length,
  capped: false,
  ms: 311.8,
});

/** one v1 block, exactly the shape A3 shipped: no cell, no autoH, no version */
const v1Result = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
  id,
  kind: "result",
  question: "can you check the revenue in last month",
  prose: "Nearly all of last month's paid revenue is INR.",
  sql: "select payment_status, count(*) from orders group by 1",
  columns: ["payment_status", "orders"],
  rows: [
    ["paid", "482"],
    ["failed", "611"],
  ],
  chips: ["Last Month = August 2026"],
  status: "2 rows · 311.8 ms",
  ms: 311.8,
  face: "chart",
  ...over,
});

const v1Note = (id: string, text = "**Against July:**\n- COD is 43% of the month.") => ({
  id,
  kind: "note",
  text,
});

/** a real pre-C2 `doc_json`: an ordered list and nothing else */
const V1_JSON = JSON.stringify({
  blocks: [v1Result("b-1"), v1Note("b-2"), v1Result("b-3", { face: "table" })],
});

const docOf = (id: string): CanvasDoc => useCanvas.getState().docs[id];
const blocksOf = (id: string): Block[] => docOf(id)?.blocks ?? [];
const cellOf = (canvasId: string, blockId: string): Cell =>
  blocksOf(canvasId).find((b) => b.id === blockId)!.cell!;

const noOverlap = (blocks: readonly Block[]): boolean =>
  blocks.every((a, i) =>
    blocks.every((b, j) => i === j || !a.cell || !b.cell || !overlaps(a.cell, b.cell)),
  );

/** a canvas of this connection with a tab, so `addExchange` and the model's
 * door both land on it */
function canvas(): string {
  const id = useCanvas.getState().create("staging");
  useTabs.getState().openCanvasTab(id, "Canvas", false);
  writes.length = 0;
  return id;
}

// ---- the pair (LESSONS 1) -------------------------------------------------

/** a deterministic PRNG: a property failure has to reproduce */
let rndSeed = 0x51f2c33;
const rnd = () => ((rndSeed = (rndSeed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const SPANS = [
  { w: 1, h: 1 },
  { w: 2, h: 1 },
  { w: 3, h: 2 },
  { w: 4, h: 3 },
  { w: 6, h: 4 },
];

/** a random document that the grid could actually have produced: every block
 * placed by the engine, so nothing overlaps and nothing hangs off the page */
function randomDoc(): CanvasDoc {
  const columns = int(1, 12);
  const blocks: Block[] = [];
  const items: { id: string; cell: Cell }[] = [];
  for (let i = 0; i < int(0, 9); i++) {
    const id = `b-${i}-${int(1000, 9999)}`;
    const cell = place(items, pick(SPANS), columns);
    items.push({ id, cell });
    blocks.push(
      rnd() < 0.4
        ? {
            id,
            kind: "note",
            text: pick(["", "one line", "**Against July:**\n- COD is 43%\n- app is 61%"]),
            cell,
            ...(rnd() < 0.5 ? { autoH: true } : null),
          }
        : {
            id,
            kind: "result",
            question: pick(["", "what stood out last month"]),
            prose: "",
            sql: rnd() < 0.8 ? "select 1" : null,
            columns: ["channel", "orders"],
            rows: [["app", "1602"]],
            chips: [],
            status: "1 row · 311.8 ms",
            ms: 311.8,
            face: pick(["table", "chart", "values", "sql"] as const),
            cell,
            ...(rnd() < 0.3 ? { wroteBy: "ex-1" } : null),
          },
    );
  }
  return { v: 2, blocks, ...(rnd() < 0.5 ? { lastColumns: columns } : null) };
}

describe("writeDoc and parseDoc", () => {
  test("parseDoc(writeDoc(d)) is d, over 2,000 documents", () => {
    for (let i = 0; i < 2000; i++) {
      const d = randomDoc();
      expect(parseDoc(writeDoc(d))).toEqual(d);
    }
  });

  test("what we emit is always a whole v2 document, whatever it was given", () => {
    // a document with no geometry at all is A3's list wherever it came from,
    // so what goes out is the migration's own row
    const doc = JSON.parse(writeDoc({ blocks: [v1Note("n1") as unknown as Block] })) as CanvasDoc;
    expect(doc.v).toBe(2);
    expect(doc.blocks[0].cell).toEqual({ x: 0, y: 0, w: MIGRATE_W_MAX, h: 1 });
  });

  test("broken is unreadable JSON and a missing blocks array, and nothing else", () => {
    expect(parseDoc("{not json")).toBeNull();
    expect(parseDoc("null")).toBeNull();
    expect(parseDoc(JSON.stringify({ v: 2 }))).toBeNull();
    expect(parseDoc(JSON.stringify({ blocks: [] }))).toEqual({ v: 2, blocks: [] });
  });

  test("a drawing appdb holds with no strokes at all reads as a drawing with none", () => {
    // the shape a v1-era row or a half-written blob can genuinely hold: the
    // kind arrived, the ink did not. It reads as an EMPTY sheet, never as a
    // throw and never as a broken document, because a document that did not
    // parse is one the store refuses to write over for ever (LESSONS 1)
    const doc = parseDoc(JSON.stringify({ v: 2, blocks: [{ id: "d", kind: "drawing" }] }))!;
    expect(doc).not.toBeNull();
    expect(doc.blocks).toHaveLength(1);
    const one = doc.blocks[0] as Block & { strokes: unknown[] };
    expect(one.kind).toBe("drawing");
    expect(one.strokes).toEqual([]);
    // and it round-trips from there, which is what makes the repair a parse
    // and not a patch
    expect(parseDoc(writeDoc(doc))).toEqual(doc);
  });

  test("a rect appdb could not have come by honestly is placed, not kept", () => {
    const bad = JSON.stringify({
      v: 2,
      lastColumns: 7,
      blocks: [
        { ...v1Note("ok"), cell: { x: 0, y: 0, w: 3, h: 2 } },
        { ...v1Note("half"), cell: { x: 0, y: 0, w: 2.5, h: 1 } },
        { ...v1Note("over"), cell: { x: 6, y: 0, w: 3, h: 1 } },
        { ...v1Note("under"), cell: { x: -1, y: 0, w: 2, h: 1 } },
        { ...v1Note("on top"), cell: { x: 1, y: 1, w: 2, h: 1 } },
      ],
    });
    const doc = parseDoc(bad)!;
    expect(doc.blocks[0].cell).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(noOverlap(doc.blocks)).toBe(true);
    expect(doc.blocks.every((b) => b.cell && b.cell.x >= 0 && b.cell.x + b.cell.w <= 7)).toBe(true);
    expect(doc.blocks.map((b) => b.id)).toEqual(["ok", "half", "over", "under", "on top"]);
  });

  test("a rect no grid can hold loses its cell: the width AND the height", () => {
    // the column test is only a test if the width it tests against is bounded;
    // `columnsOfDoc` derives one from max(x + w), so an unbounded w answered
    // its own question and rode into the document (and into the model's
    // outline, and into --rows) until the first engine call clamped it
    const wild = JSON.stringify({
      v: 2,
      blocks: [
        { ...v1Note("wide"), cell: { x: 0, y: 0, w: 1_000_000_000, h: 1 } },
        { ...v1Note("tall"), cell: { x: 0, y: 1, w: 1, h: 1_000_000_000 } },
      ],
    });
    const doc = parseDoc(wild)!;
    expect(doc.blocks.every((b) => b.cell!.w <= COLUMNS_MAX && b.cell!.h <= SPAN_MAX.h)).toBe(true);
    expect(noOverlap(doc.blocks)).toBe(true);
  });

  test("two blocks under one id is one block: the engine keys by id", () => {
    // compact() answers a Map<id, Cell>, so a duplicate takes the other's cell
    // and both stand in the same rect - the one thing the engine promises
    // never to produce - and the surface draws two children on one React key
    const twice = JSON.stringify({
      v: 2,
      lastColumns: 5,
      blocks: [
        { ...v1Note("dup"), cell: { x: 0, y: 0, w: 2, h: 1 } },
        { ...v1Note("dup", "the second one"), cell: { x: 2, y: 0, w: 2, h: 1 } },
        { ...v1Note("own"), cell: { x: 0, y: 1, w: 2, h: 1 } },
      ],
    });
    const doc = parseDoc(twice)!;
    expect(doc.blocks.map((b) => b.id)).toEqual(["dup", "own"]);
    expect(noOverlap(doc.blocks)).toBe(true);
  });

  test("a block missing what its kind carries reads, and is never a throw", () => {
    // `doc_json` is opaque and a hand edit, a truncated write or a block a
    // LATER version writes (C2b's drawing has no rows at all) all arrive here.
    // A throw took the whole connection's canvas list with it (load below)
    const odd = JSON.stringify({
      v: 2,
      blocks: [
        { id: "n", kind: "note" },
        { id: "r", kind: "result", face: "table" },
        { id: "d", kind: "drawing" },
        null,
      ],
    });
    const doc = parseDoc(odd)!;
    expect(doc.blocks.map((b) => b.id)).toEqual(["n", "r", "d"]);
    expect(doc.blocks.every((b) => b.cell!.w >= 1 && b.cell!.h >= 1)).toBe(true);
  });
});

// ---- the migration (canvas-grid 7) ----------------------------------------

describe("migrateV1", () => {
  test("A3's list opens as full-width rows, in order, at its kinds' heights", () => {
    const read = readDoc(V1_JSON, 5)!;
    expect(read.migrated).toBe(true);
    expect(read.doc.v).toBe(2);
    expect(read.doc.blocks.map((b) => b.id)).toEqual(["b-1", "b-2", "b-3"]);
    const cells = read.doc.blocks.map((b) => b.cell!);
    expect(cells.every((c) => c.x === 0 && c.w === 5)).toBe(true);
    // stacked: every y is the one before it plus its height
    expect(cells.map((c) => c.y)).toEqual([0, cells[0].h, cells[0].h + cells[1].h]);
    expect(noOverlap(read.doc.blocks)).toBe(true);
    // a note comes back measuring itself
    expect(read.doc.blocks[1].autoH).toBe(true);
    expect(read.doc.blocks[0].autoH).toBeUndefined();
  });

  test("the width at first open is capped at six cells", () => {
    const wide = readDoc(V1_JSON, 12)!.doc;
    expect(wide.blocks.every((b) => b.cell!.w === MIGRATE_W_MAX)).toBe(true);
    const narrow = readDoc(V1_JSON, 3)!.doc;
    expect(narrow.blocks.every((b) => b.cell!.w === 3)).toBe(true);
  });

  test("running it twice is a no-op", () => {
    const once = readDoc(V1_JSON)!.doc;
    const twice = parseDoc(writeDoc(once))!;
    expect(twice).toEqual(once);
    expect(migrateV1(once.blocks, COLUMNS_FALLBACK)).toEqual(once.blocks);
  });

  test("a v1 document is never broken, and is not written over until a change", async () => {
    stored = [
      {
        id: "c-old",
        profile_id: "staging",
        title: "Canvas",
        doc_json: V1_JSON,
        created_at: "",
        updated_at: "",
      },
    ];
    await useCanvas.getState().load("staging");
    expect(useCanvas.getState().canvases.staging[0].broken).toBeUndefined();
    expect(blocksOf("c-old")).toHaveLength(3);

    // the migration stands in memory; nothing reaches appdb, and the document
    // in the database is still A3's own
    await saved();
    expect(writes).toHaveLength(0);
    expect(stored[0].doc_json).toBe(V1_JSON);

    // the surface measuring a note is not a change either
    useCanvas.getState().resizeTo("c-old", "b-2", { w: 3, h: 3 }, 5, { auto: true });
    await saved();
    expect(writes).toHaveLength(0);

    // the user's own first change is, and it writes the whole v2 document
    useCanvas.getState().moveTo("c-old", "b-1", { x: 0, y: 4 }, 5);
    await saved();
    expect(writes).toHaveLength(1);
    const doc = JSON.parse(stored[0].doc_json) as CanvasDoc;
    expect(doc.v).toBe(2);
    expect(doc.blocks.map((b) => b.id)).toEqual(["b-1", "b-2", "b-3"]);
    expect(noOverlap(doc.blocks)).toBe(true);
  });

  test("one canvas the reader cannot make sense of is ONE broken canvas", async () => {
    // `readDoc` promises null for a broken document and nothing else, and the
    // per-row `broken` flag is written for exactly this. A throw out of the
    // read went past both, into load's own try/catch, and the connection lost
    // every canvas it had: no list, no flag, `loaded` never set, and a retry
    // for ever against the same row
    stored = [
      { id: "c-ok", profile_id: "staging", title: "Canvas", doc_json: V1_JSON, created_at: "", updated_at: "" },
      {
        id: "c-odd",
        profile_id: "staging",
        title: "Canvas 2",
        doc_json: JSON.stringify({ blocks: [{ id: "b", kind: "note" }, null, 7] }),
        created_at: "",
        updated_at: "",
      },
    ];
    await useCanvas.getState().load("staging");
    expect(useCanvas.getState().canvases.staging.map((c) => c.id)).toEqual(["c-ok", "c-odd"]);
    expect(useCanvas.getState().loaded.staging).toBe(true);
    expect(useCanvas.getState().saveError).toBe(false);
    expect(blocksOf("c-ok")).toHaveLength(3);
    // the odd one reads: a note with no words is a note with no words
    expect(blocksOf("c-odd").map((b) => b.id)).toEqual(["b"]);
  });

  test("laidOut answers for a block with no rect and leaves the rest alone", () => {
    const laid = laidOut(
      [
        { ...(v1Note("a") as unknown as Block), cell: { x: 0, y: 0, w: 4, h: 2 } },
        v1Note("b") as unknown as Block,
      ],
      7,
    );
    expect(laid[0].cell).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect(laid[1].cell).toEqual({ x: 4, y: 0, w: 3, h: 1 });
    expect(noOverlap(laid)).toBe(true);
  });
});

// ---- the spans (canvas-grid 3, the maintainer's table) --------------------

describe("the span a kind opens at", () => {
  const note = (text: string): Block => ({ id: "n", kind: "note", text, autoH: true });
  const result = (over: Partial<Block> & { columns: string[]; rows: (string | null)[][] }): Block =>
    ({
      id: "r",
      kind: "result",
      question: "q",
      prose: "",
      sql: "select 1",
      chips: [],
      status: "",
      ms: 1,
      face: "table",
      ...over,
    }) as Block;

  test("a note is three wide and as tall as its own words, capped at six", () => {
    expect(defaultSpanFor(note("one line"))).toEqual({ w: 3, h: 1 });
    expect(defaultSpanFor(note("x".repeat(600)))).toEqual({ w: 3, h: 3 });
    expect(defaultSpanFor(note("line\n".repeat(80)))).toEqual({ w: 3, h: 6 });
    expect(minSpanFor(note("one line"))).toEqual({ w: 1, h: 1 });
  });

  const drawing = (strokes: unknown[]): Block =>
    ({ id: "d", kind: "drawing", strokes }) as unknown as Block;

  test("a sheet stands on two cells, and grows with the ink that is on it", () => {
    // the kind's own floor, which is its cluster's width and not its content's
    expect(minSpanFor(drawing([]))).toEqual({ w: 2, h: 2 });
    // ink out to 400px on both axes: ceil((400 + 12) / 120) cells, and the
    // floor is what a smaller drawing gets rather than what this one gets
    const wide = drawing([{ k: "rect", c: 0, t: 2, b: [20, 20, 400, 400] }]);
    expect(minSpanFor(wide)).toEqual({ w: 4, h: 4 });
  });

  test("a drawing is named by its first label, and nothing else is named at all", () => {
    const labelled = drawing([
      { k: "pen", c: 0, t: 2, p: [0, 0, 10, 10] },
      { k: "text", c: 0, s: 13, at: [4, 40], v: "Gateway change, 12th" },
      { k: "text", c: 0, s: 13, at: [4, 80], v: "the second one" },
    ]);
    expect(drawingName(labelled)).toBe("Gateway change, 12th");
    // ink with no words has no name, and the ordinal the surface falls back to
    // is the SURFACE's, since only the page knows which drawing this is
    expect(drawingName(drawing([{ k: "pen", c: 0, t: 2, p: [0, 0, 10, 10] }]))).toBe("");
    expect(drawingName(drawing([]))).toBe("");
    // and a note is not a drawing, which is the guard the outline leans on
    expect(drawingName(note("one line"))).toBe("");
  });

  test("a figure row takes one cell a pair, two past eight glyphs", () => {
    const figures = result({
      columns: ["orders", "revenue", "cod", "app"],
      rows: [["2763", "4266056", "43", "22"]],
      face: "values",
    });
    // `4,266,056` is nine glyphs once the grid has grouped it
    expect(defaultSpanFor(figures)).toEqual({ w: 5, h: 1 });
    expect(minSpanFor(figures)).toEqual({ w: 2, h: 1 });
    const one = result({ columns: ["orders"], rows: [["482"]], face: "values" });
    // a result's floor is two cells whatever its content: its cluster is 148px
    expect(defaultSpanFor(one)).toEqual({ w: 2, h: 1 });
  });

  test("a chart is four wide and as tall as its bars, a table six and as tall as its rows", () => {
    const bars = (n: number) =>
      result({
        columns: ["channel", "orders"],
        rows: Array.from({ length: n }, (_, i) => [`c${i}`, `${i + 1}`]),
        face: "chart",
      });
    expect(defaultSpanFor(bars(6))).toEqual({ w: 4, h: 2 });
    expect(defaultSpanFor(bars(9))).toEqual({ w: 4, h: 3 });
    expect(minSpanFor(bars(6))).toEqual({ w: 2, h: 2 });

    const table = (n: number) =>
      result({
        columns: ["city", "state"],
        rows: Array.from({ length: n }, (_, i) => [`c${i}`, "MH"]),
      });
    expect(defaultSpanFor(table(4))).toEqual({ w: 6, h: 2 });
    expect(defaultSpanFor(table(10))).toEqual({ w: 6, h: 3 });
    expect(defaultSpanFor(table(200))).toEqual({ w: 6, h: 4 });
    expect(minSpanFor(table(10))).toEqual({ w: 2, h: 2 });
  });

  test("a result opens at the size of the face it STANDS on, not the one it stores", () => {
    // a one-row result cannot wear the table face at all (`facesOf`), so a
    // document that files it under `table` still opens on its figures and must
    // not be given the table's four rows of box to hold one line of pairs
    const filed = result({ columns: ["orders"], rows: [["482"]], face: "table" });
    expect(defaultSpanFor(filed)).toEqual({ w: 2, h: 1 });
  });

  test("a table's height holds the prose standing above it", () => {
    const rows = Array.from({ length: 4 }, (_, i) => [`c${i}`, "MH"]);
    const bare = result({ columns: ["city", "state"], rows });
    const wordy = result({
      columns: ["city", "state"],
      rows,
      prose: "Nearly all of last month's paid revenue is INR; the USD, AUD and EUR rows are ten orders between them, kept in their own currency rather than converted.",
    });
    // the same four rows, one cell taller: without the sentence counted the
    // block opens short and the grid cuts its last row (a3-canvas at 640)
    expect(defaultSpanFor(bare, 5)).toEqual({ w: 6, h: 2 });
    expect(defaultSpanFor(wordy, 5)).toEqual({ w: 6, h: 3 });
  });

  test("a block added from Ask opens at its kind's own span", () => {
    const cv = canvas();
    const id = useCanvas.getState().addNote(cv, "for Friday's finance call");
    expect(cellOf(cv, id)).toEqual({ x: 0, y: 0, w: 3, h: 1 });
    expect(blocksOf(cv)[0].autoH).toBe(true);
  });
});

// ---- the commit path ------------------------------------------------------

describe("moveTo, resizeTo and the engine", () => {
  /** three notes: two on the first row, one under them */
  function three(): { cv: string; ids: string[] } {
    const cv = canvas();
    const ids = ["a", "b", "c"].map((t) => useCanvas.getState().addNote(cv, t));
    return { cv, ids };
  }

  test("a drop pins the element and pushes what it lands on down", () => {
    const { cv, ids } = three();
    expect(cellOf(cv, ids[2]).y).toBe(1);
    useCanvas.getState().moveTo(cv, ids[2], { x: 0, y: 0 }, 7);
    expect(cellOf(cv, ids[2])).toEqual({ x: 0, y: 0, w: 3, h: 1 });
    // the one that stood there is pushed down and floats up to the next row
    expect(cellOf(cv, ids[0]).y).toBe(1);
    expect(noOverlap(blocksOf(cv))).toBe(true);
  });

  test("a resize holds the kind's floor and takes the height off autoH", () => {
    const { cv, ids } = three();
    useCanvas.getState().resizeTo(cv, ids[0], { w: 0, h: 0 }, 7);
    expect(cellOf(cv, ids[0])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(blocksOf(cv)[0].autoH).toBeUndefined();

    // the surface's own measure is not a hand, and keeps it
    const note = blocksOf(cv).find((b) => b.id === ids[1])!;
    expect(note.autoH).toBe(true);
    useCanvas.getState().resizeTo(cv, ids[1], { w: 3, h: 2 }, 7, { auto: true });
    expect(cellOf(cv, ids[1]).h).toBe(2);
    expect(blocksOf(cv).find((b) => b.id === ids[1])!.autoH).toBe(true);
  });

  test("a width past the page is capped, and nothing ever leaves the columns", () => {
    const { cv, ids } = three();
    useCanvas.getState().resizeTo(cv, ids[0], { w: 99, h: 2 }, 7);
    expect(cellOf(cv, ids[0]).w).toBe(7);
    expect(blocksOf(cv).every((b) => b.cell!.x + b.cell!.w <= 7)).toBe(true);
    expect(noOverlap(blocksOf(cv))).toBe(true);
  });

  test("a delete closes the hole it leaves above what stood under it", async () => {
    const { cv, ids } = three();
    useCanvas.getState().resizeTo(cv, ids[0], { w: 7, h: 2 }, 7);
    expect(cellOf(cv, ids[1]).y).toBe(2);
    expect(cellOf(cv, ids[2]).y).toBe(2);
    await saved();
    writes.length = 0;

    useCanvas.getState().remove(cv, ids[0]);
    expect(blocksOf(cv).map((b) => b.id)).toEqual([ids[1], ids[2]]);
    expect(blocksOf(cv).every((b) => b.cell!.y === 0)).toBe(true);
    expect(noOverlap(blocksOf(cv))).toBe(true);
    await saved();
    expect(writes).toHaveLength(1);
  });

  test("a block that is gone, a canvas that is gone, a column count that is not one", () => {
    const { cv, ids } = three();
    const before = blocksOf(cv).map((b) => b.cell);
    useCanvas.getState().moveTo(cv, "not-a-block", { x: 0, y: 0 }, 7);
    useCanvas.getState().moveTo("not-a-canvas", ids[0], { x: 0, y: 0 }, 7);
    useCanvas.getState().moveTo(cv, ids[0], { x: 0, y: 2 }, 0);
    useCanvas.getState().resizeTo(cv, "not-a-block", { w: 2, h: 2 }, 7);
    expect(blocksOf(cv).map((b) => b.cell)).toEqual(before);
  });
});

describe("reflowTo and setColumns", () => {
  test("a narrower window flows in reading order and never writes", async () => {
    const cv = canvas();
    const ids = ["a", "b", "c"].map((t) => useCanvas.getState().addNote(cv, t));
    await saved();
    const stored0 = stored.find((c) => c.id === cv)!.doc_json;
    writes.length = 0;

    useCanvas.getState().reflowTo(cv, 3);
    expect(blocksOf(cv).map((b) => b.cell!.y)).toEqual([0, 1, 2]);
    expect(blocksOf(cv).every((b) => b.cell!.x === 0)).toBe(true);
    expect(docOf(cv).lastColumns).toBe(3);
    await saved();
    // a derived layout is never the stored one
    expect(writes).toHaveLength(0);
    expect(stored.find((c) => c.id === cv)!.doc_json).toBe(stored0);

    // and the stored layout comes back whole when the window does
    useCanvas.getState().reflowTo(cv, 7);
    expect(cellOf(cv, ids[1])).toEqual({ x: 3, y: 0, w: 3, h: 1 });
    await saved();
    expect(writes).toHaveLength(0);
  });

  test("a change at a derived count commits it: the user touched it", async () => {
    const cv = canvas();
    const ids = ["a", "b", "c"].map((t) => useCanvas.getState().addNote(cv, t));
    await saved();
    writes.length = 0;

    useCanvas.getState().reflowTo(cv, 3);
    useCanvas.getState().moveTo(cv, ids[0], { x: 0, y: 1 }, 3);
    await saved();
    expect(writes).toHaveLength(1);
    // the document is the flow now, so a wider window does not undo it
    useCanvas.getState().reflowTo(cv, 7);
    expect(blocksOf(cv).every((b) => b.cell!.x === 0)).toBe(true);
  });

  test("a layout stands at its OWN count, whatever width has since opened it", () => {
    // the stored layout is 7 wide (a note at the right with air to its left);
    // a window that merely OPENS it at 10 raises `lastColumns` to 10, and a
    // count read from there re-flowed the layout at the count it was made
    // under: the honoured x was lost on the way back (AGENT-UX 16q)
    const cv = canvas();
    useCanvas.setState((st: { docs: Record<string, CanvasDoc> }) => ({
      docs: {
        ...st.docs,
        [cv]: {
          v: 2,
          lastColumns: 7,
          blocks: [
            { ...(v1Note("note") as unknown as Block), cell: { x: 5, y: 0, w: 2, h: 1 } },
            { ...(v1Note("chart") as unknown as Block), cell: { x: 0, y: 1, w: 4, h: 3 } },
            { ...(v1Note("table") as unknown as Block), cell: { x: 0, y: 4, w: 6, h: 4 } },
          ],
        },
      },
    }));
    const authored = blocksOf(cv).map((b) => b.cell!);
    useCanvas.getState().reflowTo(cv, 7);
    expect(blocksOf(cv).map((b) => b.cell!)).toEqual(authored);
    useCanvas.getState().reflowTo(cv, 10);
    expect(blocksOf(cv).map((b) => b.cell!)).toEqual(authored);
    expect(docOf(cv).lastColumns).toBe(10);
    useCanvas.getState().reflowTo(cv, 7);
    expect(blocksOf(cv).map((b) => b.cell!)).toEqual(authored);
    // and a window narrower than the layout still derives one
    useCanvas.getState().reflowTo(cv, 5);
    expect(cellOf(cv, "note")).toEqual({ x: 0, y: 0, w: 2, h: 1 });
  });

  test("a window drag inside one column band changes nothing at all", () => {
    // at a DERIVED width every measure ran reflowTo, which always setDoc'd new
    // block objects for everything it had displaced, so a window drag that
    // held the count committed a React render per frame (AGENT-UX 16r)
    const cv = canvas();
    ["a", "b", "c", "d"].forEach((t) => useCanvas.getState().addNote(cv, t));
    useCanvas.getState().reflowTo(cv, 3);
    const doc = docOf(cv);
    const blocks = blocksOf(cv);
    for (let i = 0; i < 6; i++) useCanvas.getState().reflowTo(cv, 3);
    // the same document object, block for block: nothing for React to commit
    expect(docOf(cv)).toBe(doc);
    expect(blocksOf(cv).every((b, i) => b === blocks[i])).toBe(true);
  });

  test("setColumns records the count for the model and writes nothing", async () => {
    const cv = canvas();
    useCanvas.getState().addNote(cv, "a");
    await saved();
    writes.length = 0;

    useCanvas.getState().setColumns(cv, 10);
    expect(docOf(cv).lastColumns).toBe(10);
    expect(useCanvas.getState().columnsOf(cv)).toBe(10);
    useCanvas.getState().setColumns(cv, 10);
    await saved();
    expect(writes).toHaveLength(0);
    // a canvas nothing has measured answers the fallback, and refuses nothing
    expect(useCanvas.getState().columnsOf("not-a-canvas")).toBe(COLUMNS_FALLBACK);
  });
});

// ---- one write per gesture end --------------------------------------------

describe("the debounce", () => {
  test("a gesture writes once, and only when it has ended", async () => {
    const cv = canvas();
    const id = useCanvas.getState().addNote(cv, "a");
    await saved();
    writes.length = 0;

    useCanvas.getState().moveTo(cv, id, { x: 2, y: 3 }, 7);
    // the store has the cell at once; appdb does not hear about it yet
    expect(cellOf(cv, id)).toEqual({ x: 2, y: 3, w: 3, h: 1 });
    expect(writes).toHaveLength(0);
    await saved();
    expect(writes).toHaveLength(1);
  });

  test("a held arrow key is one write, not one a keystroke", async () => {
    const cv = canvas();
    const id = useCanvas.getState().addNote(cv, "a");
    await saved();
    writes.length = 0;

    for (let y = 1; y <= 10; y++) useCanvas.getState().moveTo(cv, id, { x: 0, y }, 7);
    expect(writes).toHaveLength(0);
    await saved();
    expect(writes).toHaveLength(1);
    // and the element is where the last keystroke put it: a drop is pinned,
    // holes above it and all, because the row is the user's own answer
    expect(cellOf(cv, id).y).toBe(10);
  });

  test("a move to the cells it already stands on writes nothing at all", async () => {
    const cv = canvas();
    const id = useCanvas.getState().addNote(cv, "a");
    await saved();
    writes.length = 0;

    useCanvas.getState().moveTo(cv, id, { x: 0, y: 0 }, 7);
    useCanvas.getState().resizeTo(cv, id, { w: 3, h: 1 }, 7, { auto: true });
    await saved();
    expect(writes).toHaveLength(0);
  });
});

// ---- the picture the bridge asks the document for --------------------------

describe("drawingImage", () => {
  // only the two REFUSALS are pinned here: rendering needs a browser (an
  // Image, a canvas and a FileReader), and the round trip through the product's
  // own renderer is measured instead, in the wave's probe. What a test can own
  // is the contract the bridge leans on — `canvas_read({ block_id })` answers
  // the line ALONE, and never a broken picture, for a block that has none
  test("a block that is not a drawing has no picture", async () => {
    const cv = canvas();
    const id = useCanvas.getState().addNote(cv, "not ink");
    expect(await useCanvas.getState().drawingImage(cv, id)).toBeNull();
  });

  test("a sheet nobody has drawn on has no picture", async () => {
    const cv = canvas();
    const id = useCanvas.getState().addDrawing(cv);
    expect(await useCanvas.getState().drawingImage(cv, id)).toBeNull();
  });

  test("a block that is not there at all has no picture", async () => {
    const cv = canvas();
    expect(await useCanvas.getState().drawingImage(cv, "nothing")).toBeNull();
    expect(await useCanvas.getState().drawingImage("no-canvas", "nothing")).toBeNull();
  });
});

// ---- the model's own place (canvas-grid-spec 2.6) -------------------------

describe("the model's at and span", () => {
  /** the input union is the document's own; the cast is the test's shorthand */
  const blockInput = (over: Record<string, unknown> = {}) =>
    ({
      id: crypto.randomUUID(),
      kind: "result",
      sql: "select channel, orders from o",
      run: run(["channel", "orders"], [["app", "1602"], ["web", "486"]]),
      face: "chart",
      wroteBy: "ex-1",
      ...over,
    }) as unknown as Parameters<ReturnType<typeof useCanvas.getState>["applyModelBlocks"]>[1][number];

  test("absent means the canvas places it, in the first free rectangle", () => {
    const cv = canvas();
    useCanvas.getState().applyModelBlocks(cv, [blockInput(), blockInput()]);
    const cells = blocksOf(cv).map((b) => b.cell!);
    expect(cells[0]).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect(cells[1]).toEqual({ x: 0, y: 2, w: 4, h: 2 });
    expect(noOverlap(blocksOf(cv))).toBe(true);
  });

  test("a place it named is honoured, and what stood there is pushed down", () => {
    const cv = canvas();
    const first = useCanvas.getState().applyModelBlocks(cv, [blockInput()])[0];
    useCanvas
      .getState()
      .applyModelBlocks(cv, [blockInput({ at: { x: 0, y: 0 }, span: { w: 3, h: 2 } })]);
    const placed = blocksOf(cv).find((b) => b.id !== first)!;
    expect(placed.cell).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(cellOf(cv, first).y).toBe(2);
    expect(noOverlap(blocksOf(cv))).toBe(true);
  });

  test("a span the canvas cannot give is clamped, never refused", () => {
    const cv = canvas();
    useCanvas.getState().setColumns(cv, 5);
    const ids = useCanvas
      .getState()
      .applyModelBlocks(cv, [
        blockInput({ span: { w: 9, h: 3 } }),
        blockInput({ at: { x: 9, y: 0 }, span: { w: 2, h: 1 } }),
        blockInput({ kind: "note", text: "a reading", sql: undefined, run: undefined, span: { w: 0, h: 0 } }),
      ]);
    expect(ids).toHaveLength(3);
    const cells = ids.map((id) => cellOf(cv, id));
    // asked for 9 wide, the canvas is 5 columns
    expect(cells[0].w).toBe(5);
    // asked for column 9, the last one a 2-wide block can stand in is 3
    expect(cells[1].x).toBe(3);
    // under a note's own floor
    expect(cells[2]).toMatchObject({ w: 1, h: 1 });
    expect(blocksOf(cv).every((b) => b.cell!.x + b.cell!.w <= 5)).toBe(true);
    expect(noOverlap(blocksOf(cv))).toBe(true);
  });

  test("a replacement keeps the place, unless it asks for another", () => {
    const cv = canvas();
    const first = useCanvas.getState().applyModelBlocks(cv, [blockInput()])[0];
    const kept = useCanvas.getState().replaceBlock(cv, first, blockInput())!;
    expect(cellOf(cv, kept)).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    const moved = useCanvas
      .getState()
      .replaceBlock(cv, kept, blockInput({ at: { x: 1, y: 1 }, span: { w: 2, h: 2 } }))!;
    expect(cellOf(cv, moved)).toEqual({ x: 1, y: 1, w: 2, h: 2 });
  });

  test("one call is one write, however many blocks it lands", async () => {
    const cv = canvas();
    await saved();
    writes.length = 0;
    useCanvas.getState().applyModelBlocks(cv, [blockInput(), blockInput(), blockInput()]);
    await saved();
    expect(writes).toHaveLength(1);
  });
});
