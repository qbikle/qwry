// D2's four store doors and the one face that grew a control (items 2, 3, 4
// and 5). Each of them is a rule the eye cannot check in a frame:
//
//   growTo    a note follows its words until a HAND takes the corner, and then
//             never again; it grows by whole rows, caps at six, and refuses to
//             shrink unless the commit asks it to (the page must not jump
//             under the caret)
//   fitChart  `+ N more` gives a squeezed chart the height its bars need, and
//             that height is `defaultSpanFor`'s, the same arithmetic that
//             chose the opening one; the WIDTH the hand chose is untouched
//   rename    the header's one door, which the tab's label follows
//   clear     the compared chip's `×`, which puts the table face back
//
// and the chips themselves, which stand inside the diff face only where the
// face is standing in a widget: in the pane there is nothing to clear.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

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
mockIPC(() => undefined);

const { DiffFace } = await import("../DiffFace");
const { Widget } = await import("../widget");
const { cancelCanvasSaves, defaultSpanFor, NOTE_ROWS_MAX, useCanvas } = await import("../../stores/canvas");
const { cancelTabSaves, useTabs } = await import("../../stores/tabs");
type Block = import("../../stores/canvas").Block;
type CanvasDoc = import("../../stores/canvas").CanvasDoc;
type Diff = import("../../stores/canvas").Diff;

afterAll(() => {
  cancelCanvasSaves();
  cancelTabSaves();
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

const CANVAS = "d2-canvas";
const PROFILE = "d2-staging";
const COLUMNS = 7;

/** twelve bars of one series: more than a 4x2 widget can hold and fewer than
 * the document's own cap, so the fit rule has somewhere to travel */
const CITIES: [string, string][] = [
  ["Mumbai", "412"],
  ["Delhi", "388"],
  ["Bengaluru", "301"],
  ["Hyderabad", "266"],
  ["Chennai", "241"],
  ["Pune", "198"],
  ["Kolkata", "181"],
  ["Ahmedabad", "164"],
  ["Jaipur", "142"],
  ["Surat", "121"],
  ["Lucknow", "108"],
  ["Indore", "96"],
];

const chart = (cell: { x: number; y: number; w: number; h: number }): Block => ({
  id: "d2-chart",
  kind: "result",
  question: "",
  title: "Orders by city",
  prose: "",
  sql: "SELECT city, orders FROM order_city",
  columns: ["city", "orders"],
  rows: CITIES.map((r) => [...r]),
  chips: [],
  status: "12 rows · 241.6 ms",
  ms: 241.6,
  face: "chart",
  cell,
});

const note = (text: string, over: Partial<Block> = {}): Block =>
  ({
    id: "d2-note",
    kind: "note",
    text,
    autoH: true,
    cell: { x: 0, y: 3, w: 3, h: 1 },
    ...over,
  }) as Block;

function seed(blocks: Block[]): void {
  const doc: CanvasDoc = { v: 2, blocks, lastColumns: COLUMNS };
  useCanvas.setState({
    canvases: {
      [PROFILE]: [{ id: CANVAS, profileId: PROFILE, title: "Canvas 4", updatedAt: "2026-09-14T09:00:00.000Z" }],
    },
    docs: { [CANVAS]: doc },
    loaded: { [PROFILE]: true },
    comparing: {},
    editing: null,
    askedFrom: {},
  });
}

const blockAt = (id: string): Block => {
  const b = useCanvas.getState().docs[CANVAS]?.blocks.find((x) => x.id === id);
  if (!b) throw new Error(`no block ${id}`);
  return b;
};

beforeEach(() => {
  cancelCanvasSaves();
});

// ---- item 3: the note grows until a hand sizes it --------------------------

describe("growTo", () => {
  test("a note follows its words by whole rows while nothing has sized it", () => {
    seed([note("two lines of words")]);
    useCanvas.getState().growTo(CANVAS, "d2-note", 3, COLUMNS);
    expect(blockAt("d2-note").cell).toMatchObject({ w: 3, h: 3 });
    expect(blockAt("d2-note").autoH).toBe(true);
  });

  test("the first hand resize ends it, and nothing the words do brings it back", () => {
    seed([note("two lines of words")]);
    // a hand on the corner is `resizeTo` with no `auto`: it clears the flag
    useCanvas.getState().resizeTo(CANVAS, "d2-note", { w: 3, h: 2 }, COLUMNS);
    expect(blockAt("d2-note").autoH).toBeUndefined();
    useCanvas.getState().growTo(CANVAS, "d2-note", 5, COLUMNS);
    expect(blockAt("d2-note").cell).toMatchObject({ h: 2 });
  });

  test("it never shrinks unless the commit asks, and never grows past the cap", () => {
    seed([note("a page of words", { cell: { x: 0, y: 0, w: 3, h: 3 } })]);
    useCanvas.getState().growTo(CANVAS, "d2-note", 1, COLUMNS);
    expect(blockAt("d2-note").cell).toMatchObject({ h: 3 });
    useCanvas.getState().growTo(CANVAS, "d2-note", 1, COLUMNS, { shrink: true });
    expect(blockAt("d2-note").cell).toMatchObject({ h: 1 });
    useCanvas.getState().growTo(CANVAS, "d2-note", NOTE_ROWS_MAX + 4, COLUMNS);
    expect(blockAt("d2-note").cell).toMatchObject({ h: NOTE_ROWS_MAX });
  });
});

// ---- item 4: the chart's fit toggle ----------------------------------------

describe("fitChart", () => {
  test("a squeezed chart takes the height its bars need, at the width the hand chose", () => {
    seed([chart({ x: 0, y: 0, w: 4, h: 2 })]);
    const want = defaultSpanFor(blockAt("d2-chart"), 4).h;
    expect(want).toBeGreaterThan(2);
    useCanvas.getState().fitChart(CANVAS, "d2-chart", COLUMNS);
    expect(blockAt("d2-chart").cell).toMatchObject({ w: 4, h: want });
  });

  test("a chart that already fits is left exactly where it stands", () => {
    seed([chart({ x: 0, y: 0, w: 4, h: 6 })]);
    useCanvas.getState().fitChart(CANVAS, "d2-chart", COLUMNS);
    expect(blockAt("d2-chart").cell).toMatchObject({ w: 4, h: 6 });
  });

  test("a note has no bars and no fit", () => {
    seed([note("words", { cell: { x: 0, y: 0, w: 3, h: 1 } })]);
    useCanvas.getState().fitChart(CANVAS, "d2-note", COLUMNS);
    expect(blockAt("d2-note").cell).toMatchObject({ h: 1 });
  });
});

// ---- item 2: the header's rename -------------------------------------------

describe("rename", () => {
  test("the canvas takes the name and the tab's label follows it", () => {
    seed([note("words")]);
    useTabs.setState({
      tabs: [
        {
          id: "t-1",
          name: "Canvas 4",
          sql: "",
          position: 0,
          saved_id: null,
          kind: "canvas",
          table: null,
          profile_id: PROFILE,
          canvas_id: CANVAS,
        },
      ],
      activeId: "t-1",
    });
    useCanvas.getState().rename(CANVAS, "August finance");
    expect(useCanvas.getState().canvases[PROFILE][0].title).toBe("August finance");
    expect(useTabs.getState().tabs[0].name).toBe("August finance");
  });
});

// ---- the fixtures the frames are shot through ------------------------------

describe("the D2 harness states", () => {
  test("every one seeds a document the store itself would hold", async () => {
    const { D2_CANVAS_STATES, d2CanvasSeed, d2CanvasCardH } = await import("../../harness/fixtures.d2canvas");
    for (const state of D2_CANVAS_STATES) {
      const s = d2CanvasSeed(state);
      const blocks = s.docs[s.canvasId].blocks;
      expect(blocks.length).toBeGreaterThan(0);
      // a fixture that drew a widget with no cells would be a picture of the
      // engine's placement and not of the document (the canvas fixtures' rule)
      for (const b of blocks) expect(b.cell).toBeDefined();
      expect(d2CanvasCardH(state)).toBeGreaterThan(0);
    }
  });
});

// ---- item 5: the chips, and the × that clears the comparison ---------------

const diff = (): Diff => ({
  a: { profileId: "p-a", name: "staging", ms: 412.6 },
  b: { profileId: "p-b", name: "prod", ms: 388.1 },
  labelColumns: ["payment_status"],
  numericColumns: ["orders"],
  rows: [{ labels: ["cod_delivered"], cells: [{ a: "731", b: "748", delta: 2.3 }], only: null }],
  capped: false,
});

const widget = { canvasId: CANVAS, blockId: "d2-chart", columns: () => COLUMNS };

describe("the compare chips", () => {
  test("both sides stand in the face, each with its own time, the compared one alone clearable", () => {
    const out = renderToStaticMarkup(
      <Widget.Provider value={widget}>
        <DiffFace diff={diff()} />
      </Widget.Provider>,
    );
    expect(out).toContain("staging");
    expect(out).toContain("412.6 ms");
    expect(out).toContain("prod");
    expect(out).toContain("388.1 ms");
    // one × and one only: the origin chip answers no click
    expect(out.split("Clear Comparison").length - 1).toBe(2); // title + aria-label
    expect(out.split("cchip-x").length - 1).toBe(1);
  });

  test("in the pane, where a face stands on no cells, no chip is drawn", () => {
    const out = renderToStaticMarkup(<DiffFace diff={diff()} />);
    expect(out).not.toContain("cchips");
    expect(out).not.toContain("Clear Comparison");
    // the grid is unchanged: the chips are the only thing the widget adds
    expect(out).toContain("731");
  });

  test("the × puts the table face back and the diff leaves with it", () => {
    seed([{ ...(chart({ x: 0, y: 0, w: 6, h: 3 }) as Block), face: "diff", diff: diff() } as Block]);
    useCanvas.getState().clearCompare(CANVAS, "d2-chart");
    const b = blockAt("d2-chart");
    if (b.kind !== "result") throw new Error("not a result");
    expect(b.diff).toBeUndefined();
    expect(b.face).toBe("table");
  });
});
