// The canvas the model writes into (B3): the four things about a block that
// are law rather than layout, and the one thing about the note in edit.
//
// 1. The TITLE line. The exchange's question stands ONCE, on the answer's
//    first block; the model's own six-word title stands on its other results,
//    in the same slot and the same face; a model's note carries neither,
//    because the question above it is the section's heading (rule 14).
// 2. The VALUES face. A one-row result renders its columns as pairs in the
//    big data register, the values exactly as the database printed them (the
//    model formats in SQL, so the currency glyph and the per cents are the
//    statement's), and never as a grid of one row.
// 3. Its REVISION. A replace keeps the block's id and its place, so the id
//    alone cannot tell a rewrite from a re-render and the entrance has to
//    read the content's own signature to know a replacement from an arrival.
// 4. The note in EDIT wears one box and one ring: no composer fill under the
//    words (no `.ask-box`) and no ring at all while the box is empty, since
//    the ring arrives with the first glyph.

import { afterAll, describe, expect, test } from "bun:test";

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
for (const [k, value] of Object.entries({ window: globalThis, localStorage: storage, document: inert })) {
  if (k in globalThis) continue;
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}

// the canvas store subscribes to Tauri events at import; the mock transport is
// what puts `__TAURI_INTERNALS__` on the window (the store tests' own seam)
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { renderToStaticMarkup } = await import("react-dom/server");
const { NoteBlock } = await import("../NoteBlock");
const { ScalarResult } = await import("../../ask/ScalarResult");
const { titleOf, revOf } = await import("../CanvasTab");
const { facesOf, statusOf } = await import("../../stores/canvas");
const b3 = await import("../../harness/fixtures.b3canvas");
type Block = import("../../stores/canvas").Block;
type NoteData = import("../../stores/canvas").NoteBlock;
type ResultData = import("../../stores/canvas").ResultBlock;
type Written = Block & { title?: string; wroteBy?: string };

const result = (over: Partial<ResultData> & { title?: string } = {}): Written =>
  ({
    id: "r1",
    kind: "result",
    question: "",
    prose: "",
    sql: "SELECT 1",
    columns: ["orders"],
    rows: [["2,763"]],
    chips: [],
    status: "1 row · 96.4 ms",
    ms: 96.4,
    face: "table",
    ...over,
  }) as Written;

const figures = {
  columns: ["orders", "collected", "cod_share", "failed_share"],
  rows: [["2,763", "₹4,266,056", "43%", "22%"]],
  rowCount: 1,
  capped: false,
  ms: 96.4,
};

afterAll(clearMocks);

describe("the title line", () => {
  test("the exchange's question, on the answer's first block", () => {
    expect(titleOf(result({ question: "what stood out in orders last month" }))).toBe(
      "what stood out in orders last month",
    );
  });

  test("the model's own title on its other results", () => {
    expect(titleOf(result({ question: "", title: "Orders by channel" }))).toBe("Orders by channel");
  });

  test("the question wins where a block carries both", () => {
    expect(titleOf(result({ question: "the user asked this", title: "Orders by channel" }))).toBe(
      "the user asked this",
    );
  });

  test("a model's note carries none, and draws no line", () => {
    const note: NoteData = { id: "n1", kind: "note", text: "**Against July:**" };
    expect(titleOf(note)).toBe("");
  });
});

describe("the values face", () => {
  test("every column a pair, the values as the database printed them", () => {
    const out = renderToStaticMarkup(<ScalarResult run={figures} row />);
    expect(out.match(/class="ans-scalar"/g)?.length).toBe(4);
    for (const v of ["2,763", "₹4,266,056", "43%", "22%"]) expect(out).toContain(v);
    for (const k of figures.columns) expect(out).toContain(`ans-scalar-k">${k}`);
    // the pairs read in the statement's own column order
    expect(out.indexOf("2,763")).toBeLessThan(out.indexOf("₹4,266,056"));
  });

  test("never a grid of one row, and never the pane's stacked pairs", () => {
    const out = renderToStaticMarkup(<ScalarResult run={figures} row />);
    expect(out).not.toContain("ans-kv");
    expect(out).not.toContain("vgrid");
  });

  test("one column is the shape it already was: the row form adds nothing", () => {
    const one = { ...figures, columns: ["orders"], rows: [["2,763"]] };
    expect(renderToStaticMarkup(<ScalarResult run={one} row />)).toBe(
      renderToStaticMarkup(<ScalarResult run={one} />),
    );
  });

  test("the pane keeps its stacked pairs past one column", () => {
    const out = renderToStaticMarkup(<ScalarResult run={figures} />);
    expect(out).toContain("ans-kv");
    expect(out.match(/class="ans-scalar"/g)).toBeNull();
  });
});

describe("a block's revision", () => {
  test("a replaced result reads as different content in the same slot", () => {
    const before = result({ sql: "SELECT 1", rows: [["2,763"]] });
    const after = result({ sql: "SELECT 2", rows: [["2,763"]] });
    expect(revOf(before)).not.toBe(revOf(after));
  });

  test("a re-render of the same block is the same revision", () => {
    expect(revOf(result())).toBe(revOf(result()));
  });

  test("a face flip is not a replacement: the block's own faces crossfade", () => {
    expect(revOf(result({ face: "table" }))).toBe(revOf(result({ face: "chart" })));
  });

  test("an edited note is new content", () => {
    const note = (text: string): NoteData => ({ id: "n1", kind: "note", text });
    expect(revOf(note("one"))).not.toBe(revOf(note("two")));
  });
});

describe("the note in edit", () => {
  const note = (text: string): NoteData => ({ id: "n1", kind: "note", text });
  const html = (text: string) =>
    renderToStaticMarkup(
      <NoteBlock
        block={note(text)}
        editing
        canMoveUp={false}
        canMoveDown
        onEdit={() => {}}
        onCommit={() => {}}
        onCancel={() => {}}
        onDelete={() => {}}
        onMove={() => {}}
      />,
    );

  test("one box and no composer fill under the words", () => {
    const out = html("**Against July:**");
    expect(out).toContain("note-box");
    expect(out).not.toContain("ask-box");
  });

  test("an empty box is a caret and no ring", () => {
    expect(html("")).not.toContain("note-box ring");
  });

  test("the source is the textarea's, and it is the only thing in the box", () => {
    const out = html("**Against July:**");
    expect(out).toContain('aria-label="Note"');
    expect(out).toContain("**Against July:**");
    expect(out).not.toContain("acts-float");
  });
});

describe("the analysis fixture is one answer the product could have written", () => {
  const doc = () => b3.b3CanvasSeed("b3-canvas-analysis").docs["b3-canvas"].blocks;

  test("four blocks, one exchange", () => {
    const blocks = doc();
    expect(blocks.length).toBe(4);
    const by = new Set(blocks.map((b) => (b as Written).wroteBy));
    expect(by.size).toBe(1);
  });

  test("the question stands once, the model's titles carry the rest", () => {
    const titles = doc().map(titleOf);
    expect(titles).toEqual([
      "what stood out in orders last month",
      "Orders by channel",
      "",
      "Failed payments by gateway",
    ]);
  });

  test("the assumptions ride the FIRST result and nowhere else", () => {
    const assumed = doc().map((b) => statusOf(b)?.assumed ?? null);
    expect(assumed).toEqual([
      ["Last Month = August 2026", "Collected = Paid and Delivered COD"],
      [],
      null,
      [],
    ]);
  });

  test("the figure row is a one-row result the document puts on its values face", () => {
    const [figures, chart, , table] = doc();
    expect(facesOf(figures)).toEqual(["values", "sql"]);
    expect(facesOf(chart)).toEqual(["table", "chart", "sql"]);
    // two label columns and one number: no chart to be had, so the table
    // keeps the one frame the page still draws
    expect(facesOf(table)).toEqual(["table", "sql"]);
  });

  test("the empty state is empty, and the note-edit state seeds the caret", () => {
    expect(b3.b3CanvasSeed("b3-canvas-empty").docs["b3-canvas"].blocks).toEqual([]);
    expect(b3.b3CanvasSeed("b3-canvas-empty").editing).toBeNull();
    expect(b3.b3CanvasSeed("b3-note-edit").editing).toBe("b3-blk-note");
    // the third block is the one arriving, so the fourth is not written yet
    expect(b3.b3CanvasSeed("b3-canvas-streaming").docs["b3-canvas"].blocks.length).toBe(3);
  });
});
