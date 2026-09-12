// Where a model-written block STANDS (C2a, canvas-grid-spec section 2.6 and
// the wave's maintainer call 8). The canvas is a grid now, so `canvas_write`
// and `canvas_replace` take an optional `at` and `span` in cells; absent, the
// document places the block at its kind's own size; impossible, the tool
// clamps it to the grid and the reply says so in the voice `faceFor` already
// uses for a face the rows cannot wear. Nothing here is ever a refusal.
//
// The three halves under test: the schema (what the model may write), the pure
// clamp and the outline's renderer (tools.ts), and the tool over a document
// that composes real cells through the real engine (canvas.tauri.ts). The
// no-target surface is pinned here too, because a placement field that leaked
// into the five would re-baseline every row in EVAL.md section 4.

import { beforeEach, describe, expect, test } from "bun:test";
import schema from "../tools.schema.json";
import {
  COLUMNS_FALLBACK,
  TOOL_SCHEMAS,
  cellPart,
  clampPlace,
  columnsSaid,
  outlineLine,
  outlineText,
  parseCanvasBlock,
  toolsFor,
  type CanvasOutlineEntry,
  type ModelCell,
} from "../tools";
import { DEFAULT_SPAN, move, place, type Cell, type GridItem, type Span } from "../../canvas/grid";
import { canvasMessage } from "../prompt";

// settings.ts paints the theme onto the document at import and the canvas
// store reaches the window; bun has neither (canvasTools.test.ts's precedent)
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
function shim() {
  for (const [k, value] of Object.entries(STANDINS)) {
    if (k in globalThis) continue;
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  }
}
shim();
beforeEach(shim);

const { createCanvasTools } = await import("../canvas.tauri");
type CanvasStore = import("../canvas.tauri").CanvasStore;
type ModelBlockInput = import("../canvas.tauri").ModelBlockInput;
type AgentRun = import("../types").AgentRun;

// ---- the shape the agent composes is the shape the engine holds ------------
// tools.ts declares `at` and `span` itself rather than importing the engine,
// because the pure half of the agent imports nothing from the canvas. That is
// two declarations of one fact unless something pins them equal (DESIGN rule
// 14), so this is the pin: assignment both ways, checked by the compiler.

const asEngine: Cell = { x: 1, y: 2, w: 3, h: 4 } satisfies ModelCell;
const asAgent: ModelCell = asEngine;

test("the engine's Cell and the tool's at-plus-span are one shape", () => {
  expect(asAgent).toEqual({ x: 1, y: 2, w: 3, h: 4 });
});

// ---- the schema ------------------------------------------------------------

interface Json {
  [k: string]: unknown;
}
const wire = JSON.parse(JSON.stringify(schema)) as {
  tools: Json[];
  canvasTools: { name: string; parameters: { properties: Record<string, Json> } }[];
};
/** the two arms of the union, note first, of canvas_write and canvas_replace */
const armsOf = (tool: number, prop: string): Json[] => {
  const p = wire.canvasTools[tool].parameters.properties[prop];
  const union = (p.items as Json) ?? p;
  return union.anyOf as Json[];
};

describe("what the model may write", () => {
  test("both kinds of both tools carry `at` and `span`, and neither is required", () => {
    for (const arms of [armsOf(0, "blocks"), armsOf(1, "block")]) {
      expect(arms).toHaveLength(2);
      for (const arm of arms) {
        const props = arm.properties as Json;
        expect(Object.keys(props)).toContain("at");
        expect(Object.keys(props)).toContain("span");
        expect(arm.required).not.toContain("at");
        expect(arm.required).not.toContain("span");
        for (const [field, keys, floor] of [
          ["at", ["x", "y"], 0],
          ["span", ["w", "h"], 1],
        ] as const) {
          const f = props[field] as Json;
          expect(f.type).toBe("object");
          expect(f.required).toEqual([...keys]);
          expect(f.additionalProperties).toBe(false);
          for (const k of keys) {
            expect((f.properties as Json)[k]).toEqual({ type: "integer", minimum: floor });
          }
        }
      }
    }
  });

  test("the placement never reaches the five: a no-target run is what it was", () => {
    const five = JSON.stringify(schema.tools);
    expect(five).not.toContain('"at"');
    expect(five).not.toContain('"span"');
    expect(toolsFor(false)).toEqual([...TOOL_SCHEMAS]);
  });

  test("canvas_read says it prints the grid, because `at` is written against it", () => {
    const read = wire.canvasTools[2] as unknown as { description: string };
    expect(read.description).toContain("how many columns wide");
  });
});

// ---- the union reads them --------------------------------------------------

const ok = <T,>(v: { ok: boolean } & Record<string, unknown>): T => {
  if (!v.ok) throw new Error(String(v.error));
  return v.value as T;
};
const err = (v: { ok: boolean } & Record<string, unknown>): string =>
  v.ok ? "(no error)" : String(v.error);

describe("at and span, as the union parses them", () => {
  test("absent stays absent: a block that names no place has none", () => {
    expect(parseCanvasBlock({ kind: "note", text: "a" })).toEqual({
      ok: true,
      value: { kind: "note", text: "a" },
    });
  });

  test("both kinds carry them through", () => {
    expect(
      parseCanvasBlock({ kind: "note", text: "a", at: { x: 2, y: 1 }, span: { w: 3, h: 2 } }),
    ).toEqual({
      ok: true,
      value: { kind: "note", text: "a", at: { x: 2, y: 1 }, span: { w: 3, h: 2 } },
    });
    expect(
      parseCanvasBlock({ kind: "result", sql: "SELECT 1", at: { x: 0, y: 4 } }),
    ).toEqual({ ok: true, value: { kind: "result", sql: "SELECT 1", at: { x: 0, y: 4 } } });
  });

  test("half a cell is not a place, and a negative one is not a narrower canvas", () => {
    expect(
      ok<{ at: { x: number; y: number }; span: { w: number; h: number } }>(
        parseCanvasBlock({
          kind: "note",
          text: "a",
          at: { x: 2.7, y: -3 },
          span: { w: 3.9, h: 0 },
        }),
      ),
    ).toMatchObject({ at: { x: 2, y: 0 }, span: { w: 3, h: 1 } });
  });

  test("a place that is not two numbers names the way out, and nothing lands", () => {
    expect(err(parseCanvasBlock({ kind: "note", text: "a", at: { x: 1 } }))).toBe(
      "ERROR: `at` is `x` and `y`, whole cells of the grid. Read the grid off canvas_read, or leave it off and the canvas places the block",
    );
    expect(err(parseCanvasBlock({ kind: "note", text: "a", at: "top left" }))).toStartWith(
      "ERROR: `at` is `x` and `y`",
    );
    expect(err(parseCanvasBlock({ kind: "result", sql: "SELECT 1", span: { w: "6", h: 4 } }))).toBe(
      "ERROR: `span` is `w` and `h`, whole cells of the grid. Read the grid off canvas_read, or leave it off and the canvas places the block",
    );
  });
});

// ---- the clamp -------------------------------------------------------------

describe("what the canvas can give of what was asked", () => {
  test("in range is untouched, and says nothing", () => {
    expect(clampPlace({ at: { x: 2, y: 1 }, span: { w: 3, h: 2 } }, 5)).toEqual({
      at: { x: 2, y: 1 },
      span: { w: 3, h: 2 },
      said: [],
    });
  });

  test("wider than the canvas is narrowed, never refused", () => {
    const out = clampPlace({ span: { w: 9, h: 3 } }, 5);
    expect(out.span).toEqual({ w: 5, h: 3 });
    expect(out.said).toEqual(["asked for 9 wide, the canvas is 5 columns, placed 5 wide"]);
  });

  test("a column past the right edge is pulled back to the last one that fits", () => {
    const out = clampPlace({ at: { x: 4, y: 0 }, span: { w: 3, h: 2 } }, 5);
    expect(out.at).toEqual({ x: 2, y: 0 });
    expect(out.said).toEqual([
      "asked for column 4, the canvas is 5 columns, placed at column 2",
    ]);
  });

  test("with no span the tool knows no width, so it says only that the column is not there", () => {
    const out = clampPlace({ at: { x: 9, y: 2 } }, 7);
    expect(out.at).toEqual({ x: 6, y: 2 });
    expect(out.said).toEqual([
      "asked for column 9, the canvas is 7 columns, placed at column 6",
    ]);
  });

  test("both at once, in the order they were asked for", () => {
    const out = clampPlace({ at: { x: 6, y: 3 }, span: { w: 8, h: 4 } }, 5);
    expect(out).toEqual({
      at: { x: 0, y: 3 },
      span: { w: 5, h: 4 },
      said: [
        "asked for 8 wide, the canvas is 5 columns, placed 5 wide",
        "asked for column 6, the canvas is 5 columns, placed at column 0",
      ],
    });
  });

  test("one column is one column, not one columns", () => {
    expect(columnsSaid(1)).toBe("1 column");
    expect(clampPlace({ span: { w: 4, h: 1 } }, 1).said).toEqual([
      "asked for 4 wide, the canvas is 1 column, placed 1 wide",
    ]);
  });

  test("y is never clamped: the canvas grows down as far as its last element", () => {
    expect(clampPlace({ at: { x: 0, y: 400 } }, 5).at).toEqual({ x: 0, y: 400 });
  });
});

// ---- the outline -----------------------------------------------------------

describe("the outline prints the grid and every block's place", () => {
  const entry = (over: Partial<CanvasOutlineEntry> = {}): CanvasOutlineEntry => ({
    id: "b3f2c1a0-0000-4000-8000-000000000001",
    kind: "result",
    line: "Revenue by month",
    rows: 12,
    columns: ["month", "revenue"],
    face: "chart",
    modelWritten: true,
    cell: { x: 0, y: 0, w: 6, h: 4 },
    ...over,
  });

  test("the cell rides last on the line, in one renderer", () => {
    expect(outlineLine(entry())).toBe(
      "b3f2  result  Revenue by month · 12 rows: month, revenue · chart face · at 0,0 6×4",
    );
    expect(cellPart({ x: 6, y: 0, w: 4, h: 4 })).toBe("at 6,0 4×4");
    expect(cellPart(undefined)).toBeNull();
  });

  test("a document the grid has not reached says nothing about geometry", () => {
    expect(outlineLine(entry({ cell: undefined }))).toBe(
      "b3f2  result  Revenue by month · 12 rows: month, revenue · chart face",
    );
  });

  test("the head carries the width, so `at` is a place and not a guess", () => {
    expect(
      outlineText(
        "Q3 revenue",
        [
          entry(),
          entry({
            id: "7c020000-0000-4000-8000-000000000002",
            kind: "note",
            line: "**Revenue concentrated in two channels:**",
            rows: undefined,
            columns: undefined,
            face: undefined,
            cell: { x: 6, y: 0, w: 4, h: 4 },
          }),
        ],
        10,
      ),
    ).toBe(
      [
        'Canvas "Q3 revenue", 2 blocks, 10 columns wide.',
        "b3f2  result  Revenue by month · 12 rows: month, revenue · chart face · at 0,0 6×4",
        "7c02  note    **Revenue concentrated in two channels:** · at 6,0 4×4",
      ].join("\n"),
    );
  });

  test("an empty canvas still says how wide it is, because a block may go anywhere on it", () => {
    expect(outlineText("Sales", [], 5)).toBe('Canvas "Sales" is empty, 5 columns wide.');
    expect(outlineText("Sales", [], 1)).toBe('Canvas "Sales" is empty, 1 column wide.');
  });

  test("a caller with no grid to read states no number rather than the wrong one", () => {
    expect(outlineText("Sales", [])).toBe('Canvas "Sales" is empty.');
    expect(outlineText("Sales", [entry({ cell: undefined })])).toStartWith(
      'Canvas "Sales", 1 block.',
    );
  });
});

// ---- the tool, over a document that lays its blocks out ---------------------
//
// The fake document is the real engine: `place` for a block that named no
// cell, `move` for one that did, which is what makes "the model's x is
// honoured and what stood there is pushed down" a fact this file can assert
// rather than a sentence it repeats.

const RUN = (over: Partial<AgentRun> = {}): AgentRun => ({
  columns: ["month", "revenue"],
  rows: [
    ["2026-04", "41220"],
    ["2026-05", "44905"],
  ],
  rowCount: 2,
  capped: false,
  ms: 12,
  ...over,
});

const spanKeyOf = (b: ModelBlockInput): "note" | "chart" | "table" | "values" | "sql" =>
  b.kind === "note" ? "note" : b.face === "diff" ? "table" : b.face;

interface Fake {
  doc: CanvasOutlineEntry[];
  applied: ModelBlockInput[];
  tools: ReturnType<typeof createCanvasTools>;
}

function fake(columns = 5, seed: readonly CanvasOutlineEntry[] = []): Fake {
  const doc: CanvasOutlineEntry[] = seed.map((e) => ({ ...e }));
  const applied: ModelBlockInput[] = [];
  const itemsOf = (): GridItem[] =>
    doc.flatMap((e) => (e.cell ? [{ id: e.id, cell: { ...e.cell } }] : []));

  /** one block onto the grid: its own cell when it named one, the first free
   * rectangle when it did not, then the engine's own push-down and float-up */
  const land = (b: ModelBlockInput): void => {
    applied.push(b);
    const items = itemsOf();
    const span: Span = b.span ?? DEFAULT_SPAN[spanKeyOf(b)];
    const cell: Cell = b.at ? { ...b.at, ...span } : place(items, span, columns);
    doc.push({
      id: b.id,
      kind: b.kind,
      line: b.kind === "note" ? b.text : (b.title ?? b.question ?? ""),
      modelWritten: true,
      cell,
    });
    const settled = new Map(
      move([...items, { id: b.id, cell }], b.id, cell, columns).map((i) => [i.id, i.cell]),
    );
    for (const e of doc) e.cell = settled.get(e.id) ?? e.cell;
  };

  const store: CanvasStore = {
    applyModelBlocks(_canvasId, blocks) {
      for (const b of blocks) land(b);
      return blocks.map((b) => b.id);
    },
    replaceBlock(_canvasId, blockId, block) {
      const at = doc.findIndex((b) => b.id === blockId);
      if (at === -1) return null;
      const old = doc[at].cell;
      doc.splice(at, 1);
      // a replace keeps the block's place unless the new one names its own
      land({ ...block, ...(block.at ?? block.span ? {} : { at: old, span: old }) });
      return block.id;
    },
    outline: () => doc,
    columns: () => columns,
  };

  return {
    doc,
    applied,
    tools: createCanvasTools({
      sessionId: "s1",
      canvasId: "cv-1",
      title: "Sales",
      exchangeId: "ex-1",
      question: "what stood out in orders last month",
      timeoutMs: 4000,
      store,
      run: async () => RUN(),
    }),
  };
}

describe("canvas_write, placed", () => {
  test("a block that names no place is placed, and the reply says where it stands", async () => {
    const f = fake(5);
    const out = await f.tools.write({ blocks: [{ kind: "note", text: "a finding" }] });
    expect(f.applied[0].at).toBeUndefined();
    expect(f.applied[0].span).toBeUndefined();
    expect(f.doc[0].cell).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    expect(out.textForModel.split("\n")[1]).toEndWith("note    a finding · at 0,0 3×2");
  });

  test("a block that names one takes it, and the tool says nothing extra", async () => {
    const f = fake(7);
    const out = await f.tools.write({
      blocks: [{ kind: "note", text: "a finding", at: { x: 2, y: 1 }, span: { w: 3, h: 2 } }],
    });
    expect(f.applied[0]).toMatchObject({ at: { x: 2, y: 1 }, span: { w: 3, h: 2 } });
    expect(out.textForModel).toContain("at 2,1 3×2");
    expect(out.textForModel).not.toContain("asked for");
    expect(out.error).toBeUndefined();
  });

  test("wider than the canvas is placed as wide as the canvas is, and the reply says so", async () => {
    const f = fake(5);
    const out = await f.tools.write({
      blocks: [{ kind: "result", sql: "SELECT 1", span: { w: 9, h: 3 } }],
    });
    expect(f.applied[0].span).toEqual({ w: 5, h: 3 });
    expect(out.error).toBeUndefined();
    expect(out.textForModel).toContain(
      "asked for 9 wide, the canvas is 5 columns, placed 5 wide",
    );
    expect(out.textForModel).toContain("at 0,0 5×3");
  });

  test("a column off the right edge is pulled back, and the block still lands", async () => {
    const f = fake(5);
    const out = await f.tools.write({
      blocks: [{ kind: "note", text: "a", at: { x: 4, y: 0 }, span: { w: 3, h: 1 } }],
    });
    expect(f.doc[0].cell).toEqual({ x: 2, y: 0, w: 3, h: 1 });
    expect(out.textForModel).toContain(
      "asked for column 4, the canvas is 5 columns, placed at column 2",
    );
  });

  test("a cell that is taken is not an error: the engine pushes what stood there down", async () => {
    const f = fake(5, [
      {
        id: "77de0000-0000-4000-8000-000000000009",
        kind: "result",
        line: "Top customers",
        modelWritten: true,
        cell: { x: 0, y: 0, w: 5, h: 2 },
      },
    ]);
    const out = await f.tools.write({
      blocks: [{ kind: "note", text: "over it", at: { x: 0, y: 0 }, span: { w: 2, h: 1 } }],
    });
    expect(out.error).toBeUndefined();
    expect(out.textForModel).not.toContain("asked for");
    // the model's x is honoured; the block that stood there moves down
    expect(f.doc[1].cell).toEqual({ x: 0, y: 0, w: 2, h: 1 });
    expect(f.doc[0].cell).toEqual({ x: 0, y: 1, w: 5, h: 2 });
    expect(out.textForModel).toContain("at 0,0 2×1");
  });

  test("the reply names where each block IS, not where it was aimed", async () => {
    const f = fake(5);
    const out = await f.tools.write({
      blocks: [
        { kind: "note", text: "first", at: { x: 0, y: 3 }, span: { w: 2, h: 1 } },
        { kind: "note", text: "second", at: { x: 0, y: 3 }, span: { w: 2, h: 1 } },
      ],
    });
    // both asked for row 3; compaction floats the first to the top and the
    // second stands where the engine put it, which is what the reply prints
    const lines = out.textForModel.split("\n");
    expect(lines[1]).toEndWith(`note    first · ${cellPart(f.doc[0].cell)}`);
    expect(lines[2]).toEndWith(`note    second · ${cellPart(f.doc[1].cell)}`);
    expect(f.doc[0].cell).not.toEqual(f.doc[1].cell);
  });

  test("a place of the wrong shape lands NO block and runs no statement", async () => {
    const f = fake(5);
    const out = await f.tools.write({
      blocks: [{ kind: "result", sql: "SELECT 1", span: { w: 3 } }],
    });
    expect(out.error).toBeTruthy();
    expect(out.textForModel).toStartWith("ERROR: `span` is `w` and `h`");
    expect(f.applied).toEqual([]);
  });
});

describe("canvas_replace, placed", () => {
  const own = (): CanvasOutlineEntry[] => [
    {
      id: "9c110000-0000-4000-8000-000000000002",
      kind: "result",
      line: "Revenue by month",
      modelWritten: true,
      cell: { x: 0, y: 0, w: 4, h: 3 },
    },
  ];

  test("no place named keeps the block's own", async () => {
    const f = fake(7, own());
    const out = await f.tools.replace({
      block_id: "9c11",
      block: { kind: "note", text: "a better reading" },
    });
    expect(out.error).toBeUndefined();
    expect(f.doc[0].cell).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(out.textForModel).toContain("at 0,0 4×3");
  });

  test("a place named on a replace moves it, clamped like any other", async () => {
    const f = fake(5, own());
    const out = await f.tools.replace({
      block_id: "9c11",
      block: { kind: "note", text: "moved", at: { x: 3, y: 1 }, span: { w: 6, h: 2 } },
    });
    expect(f.applied[0]).toMatchObject({ at: { x: 0, y: 1 }, span: { w: 5, h: 2 } });
    expect(out.textForModel).toContain(
      "asked for 6 wide, the canvas is 5 columns, placed 5 wide",
    );
    expect(out.textForModel).toContain(
      "asked for column 3, the canvas is 5 columns, placed at column 0",
    );
  });
});

describe("canvas_read, on a grid", () => {
  test("the head names the width and every line names its cell", async () => {
    const f = fake(5);
    await f.tools.write({
      blocks: [
        { kind: "result", sql: "SELECT 1", title: "Revenue by month" },
        { kind: "note", text: "a reading" },
      ],
    });
    const out = await f.tools.read();
    expect(out.result?.columns).toBe(5);
    const lines = out.textForModel.split("\n");
    expect(lines[0]).toBe('Canvas "Sales", 2 blocks, 5 columns wide.');
    expect(lines[1]).toContain(" · at 0,0 4×3");
    expect(lines[2]).toContain(" · at 0,3 3×2");
  });

  test("the column count is the one the tool clamps against", async () => {
    const f = fake(10);
    expect((await f.tools.read()).result?.columns).toBe(10);
    expect(f.tools.columns?.()).toBe(10);
  });
});

// ---- the CANVAS block ------------------------------------------------------
// It rides the USER message of a canvas-targeted run and nothing else, so
// PROMPT_VERSION does not move and no baseline row is owed (EVAL.md section 4).

describe("the CANVAS block says a block may place itself", () => {
  test("one sentence, naming both fields and what happens when they do not fit", () => {
    const block = canvasMessage("Sales");
    expect(block).toContain(
      "The canvas is a grid of cells, and a block\nmay name its own place on it: `at` is the cell its top left takes and `span` is how many cells wide and tall it is, both clamped to the grid rather than\nrefused, and a block that names neither lands in the first free place at its kind's own size.",
    );
  });

  test("the outline's head carries the width when the caller measured one", () => {
    const entry: CanvasOutlineEntry = {
      id: "9c110000-0000-4000-8000-000000000002",
      kind: "note",
      line: "a reading",
      modelWritten: true,
      cell: { x: 0, y: 2, w: 3, h: 2 },
    };
    expect(canvasMessage("Sales", [entry], 7)).toContain(
      '\nOUTLINE OF "Sales" (1 block, 7 columns wide):\n9c11  note    a reading · at 0,2 3×2',
    );
    // and states no number when nothing measured the canvas
    expect(canvasMessage("Sales", [entry])).toContain('\nOUTLINE OF "Sales" (1 block):\n');
  });

  test("the fallback is a number, not a refusal: no tab measuring is not an error", () => {
    expect(COLUMNS_FALLBACK).toBe(7);
    expect(clampPlace({ span: { w: 9, h: 2 } }, COLUMNS_FALLBACK).span).toEqual({ w: 7, h: 2 });
  });
});
