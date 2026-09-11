// The layout engine (grid.ts). Two things are under test: the arithmetic that
// turns a container width into columns, which the whole wave's pixel evidence
// rests on, and the four invariants the engine promises for any document a user
// or a model can produce. The second set is properties over random layouts
// rather than examples, because an overlap that only appears at 9 columns with
// a 6-wide element is exactly the bug an example suite does not have.
//
// The PRNG is seeded (fuzzy.test.ts:21-23's shape): a property failure has to
// reproduce.

import { describe, expect, test } from "bun:test";
import {
  CELL_H,
  CELL_W_BASE,
  COLUMNS_MAX,
  DEFAULT_SPAN,
  GUTTER,
  MIN_SPAN,
  SPAN_MAX,
  STRETCH_MAX,
  basePx,
  bounds,
  cellMetrics,
  cellsForPx,
  columnsFor,
  compact,
  contentWidthFor,
  defaultSpan,
  minSpan,
  move,
  overlaps,
  place,
  reflow,
  resize,
  valueCells,
  type Cell,
  type GridItem,
  type Span,
} from "../grid";

/** a deterministic PRNG: a property failure has to reproduce */
let seed = 0x51a7c3d;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)] as T;

/** the contract in one line, so the properties can state it */
function noOverlap(items: readonly GridItem[]): boolean {
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (overlaps(items[i]!.cell, items[j]!.cell)) return false;
  return true;
}

function inside(items: readonly GridItem[], columns: number): boolean {
  return items.every(
    ({ cell: c }) => c.x >= 0 && c.w >= 1 && c.h >= 1 && c.x + c.w <= columns && c.y >= 0,
  );
}

/** the ids in (y, x, id) order: what a reader reads, and what reflow keeps */
function readingOrder(items: readonly GridItem[]): string[] {
  return [...items]
    .sort((a, b) =>
      a.cell.y !== b.cell.y
        ? a.cell.y - b.cell.y
        : a.cell.x !== b.cell.x
          ? a.cell.x - b.cell.x
          : a.id < b.id
            ? -1
            : 1,
    )
    .map((i) => i.id);
}

const cellsOf = (items: readonly GridItem[]) =>
  new Map(items.map((i) => [i.id, `${i.cell.x},${i.cell.y},${i.cell.w},${i.cell.h}`]));

/** spans drawn from the kind ladder, plus the shapes a hand resize can reach */
const LADDER: readonly Span[] = [
  DEFAULT_SPAN.note,
  DEFAULT_SPAN.values,
  DEFAULT_SPAN.chart,
  DEFAULT_SPAN.table,
  DEFAULT_SPAN.drawing,
  { w: 1, h: 1 },
  { w: 2, h: 1 },
  { w: 5, h: 1 },
  { w: 2, h: 4 },
  { w: 10, h: 2 },
];

function randomDoc(n: number, columns: number): GridItem[] {
  const items: GridItem[] = [];
  for (let i = 0; i < n; i++) {
    const span = pick(LADDER);
    const cell = place(items, { w: Math.min(span.w, columns), h: span.h }, columns);
    items.push({ id: `e${String(i).padStart(3, "0")}`, cell });
  }
  return items;
}

describe("the cell, measured", () => {
  test("the three harness widths give 5 / 7 / 10 columns", () => {
    expect(contentWidthFor(640)).toBe(606);
    expect(contentWidthFor(960)).toBe(926);
    expect(contentWidthFor(1280)).toBe(1246);
    expect(columnsFor(606)).toBe(5);
    expect(columnsFor(926)).toBe(7);
    expect(columnsFor(1246)).toBe(10);
  });

  test("the floor holds five cells, stretched 3 percent and well under the cap", () => {
    const m = cellMetrics(606);
    expect(m.columns).toBe(5);
    expect(m.gutter).toBeCloseTo(GUTTER, 6);
    expect(m.cellW).toBeCloseTo(111.6, 6);
    // 5 cells at the base plus 4 gutters is 588, and the 640 card lays out 606:
    // the 18 left over is the stretch, 3.3 percent against a 25 percent ceiling
    expect(5 * CELL_W_BASE + 4 * GUTTER).toBe(588);
    expect(m.cellW / CELL_W_BASE).toBeLessThan(STRETCH_MAX);
  });

  test("the grid closes flush on both edges at every width", () => {
    for (const w of [606, 926, 1246, 640, 960, 1280, 300, 722, 987, 1819]) {
      const m = cellMetrics(w);
      if (m.columns === 1) continue;
      expect(m.columns * m.cellW + (m.columns - 1) * m.gutter).toBeCloseTo(w, 6);
    }
  });

  test("past the stretch cap the leftover goes to the gutter, never to a margin", () => {
    const m = cellMetrics(300);
    expect(m.columns).toBe(2);
    expect(m.cellW).toBeCloseTo(CELL_W_BASE * STRETCH_MAX, 6);
    expect(m.gutter).toBeCloseTo(30, 6);
    expect(cellMetrics(926).cellW).toBeLessThan(CELL_W_BASE * STRETCH_MAX);
  });

  test("the count clamps, and a degenerate width still lays out", () => {
    expect(columnsFor(99999)).toBe(COLUMNS_MAX);
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(Number.NaN)).toBe(1);
    expect(cellMetrics(-40).columns).toBe(1);
  });

  test("cells and pixels are a pair, on both axes", () => {
    expect(basePx(1)).toBe(CELL_W_BASE);
    expect(basePx(5)).toBe(588);
    expect(CELL_H).toBe(CELL_W_BASE);
    for (const n of [1, 2, 3, 4, 6, 10]) expect(cellsForPx(basePx(n))).toBe(n);
  });
});

describe("the spans", () => {
  test("a default is read from the content and capped", () => {
    expect(defaultSpan("table", { rows: 4 })).toEqual({ w: 6, h: 2 });
    // the prose a result carries stands above its grid and is its content too
    expect(defaultSpan("table", { rows: 4, lines: 2 })).toEqual({ w: 6, h: 3 });
    expect(defaultSpan("table", { rows: 10 })).toEqual({ w: 6, h: 3 });
    expect(defaultSpan("table", { rows: 200 })).toEqual({ w: 6, h: 4 });
    expect(defaultSpan("chart", { bars: 6 })).toEqual({ w: 4, h: 2 });
    expect(defaultSpan("chart", { bars: 8 })).toEqual({ w: 4, h: 3 });
    expect(defaultSpan("chart")).toEqual({ w: 4, h: 3 });
    expect(defaultSpan("note")).toEqual({ w: 3, h: 2 });
  });

  test("a values row stands on cells, two for a figure past eight glyphs", () => {
    expect(valueCells(["2,763", "43%", "96.4 ms"])).toBe(3);
    expect(valueCells(["2,763", "Rs 4,266,056", "43%", "22%"])).toBe(5);
    expect(defaultSpan("values", { cells: 5 })).toEqual({ w: 5, h: 1 });
  });

  test("a result's floor is two cells, a note's is one", () => {
    expect(MIN_SPAN.values).toEqual({ w: 2, h: 1 });
    expect(MIN_SPAN.note).toEqual({ w: 1, h: 1 });
    expect(minSpan("chart", { bars: 12 })).toEqual({ w: 2, h: 3 });
  });
});

describe("the operations", () => {
  const doc = (...cells: Cell[]): GridItem[] =>
    cells.map((cell, i) => ({ id: `e${String(i).padStart(3, "0")}`, cell }));

  test("place is a row-major first fit, so it fills a hole", () => {
    const items = doc({ x: 0, y: 0, w: 3, h: 2 });
    expect(place(items, { w: 2, h: 1 }, 5)).toEqual({ x: 3, y: 0, w: 2, h: 1 });
    expect(place(items, { w: 4, h: 1 }, 5)).toEqual({ x: 0, y: 2, w: 4, h: 1 });
    expect(place([], { w: 9, h: 2 }, 5)).toEqual({ x: 0, y: 0, w: 5, h: 2 });
  });

  test("a move pins the drop and pushes what it lands on down", () => {
    const items = doc({ x: 0, y: 0, w: 2, h: 1 }, { x: 2, y: 0, w: 2, h: 1 });
    const out = move(items, "e001", { x: 0, y: 0 }, 5);
    expect(out.find((i) => i.id === "e001")!.cell).toEqual({ x: 0, y: 0, w: 2, h: 1 });
    expect(out.find((i) => i.id === "e000")!.cell).toEqual({ x: 0, y: 1, w: 2, h: 1 });
  });

  test("a drop into empty space stands where it was dropped", () => {
    const items = doc({ x: 0, y: 0, w: 2, h: 1 }, { x: 0, y: 1, w: 2, h: 1 });
    const out = move(items, "e000", { x: 3, y: 4 }, 5);
    expect(out[0]!.cell).toEqual({ x: 3, y: 4, w: 2, h: 1 });
    expect(out[1]!.cell).toEqual({ x: 0, y: 0, w: 2, h: 1 });
  });

  test("a move clamps into the columns instead of refusing", () => {
    const items = doc({ x: 0, y: 0, w: 4, h: 1 });
    expect(move(items, "e000", { x: 9, y: -3 }, 5)[0]!.cell).toEqual({ x: 1, y: 0, w: 4, h: 1 });
  });

  test("a resize clamps the span and pulls x back", () => {
    const items = doc({ x: 3, y: 0, w: 2, h: 1 });
    expect(resize(items, "e000", { w: 4, h: 2 }, 5)[0]!.cell).toEqual({ x: 1, y: 0, w: 4, h: 2 });
    expect(resize(items, "e000", { w: 99, h: 99 }, 5)[0]!.cell.w).toBe(5);
    expect(resize(items, "e000", { w: 99, h: 99 }, 5)[0]!.cell.h).toBe(SPAN_MAX.h);
    expect(resize(items, "e000", { w: 0, h: 0 }, 5)[0]!.cell).toEqual({ x: 3, y: 0, w: 1, h: 1 });
  });

  test("compaction floats up and leaves a hole beside a wide element standing", () => {
    const items = doc({ x: 0, y: 0, w: 3, h: 1 }, { x: 3, y: 4, w: 2, h: 1 });
    const out = compact(items, 5);
    expect(out[1]!.cell).toEqual({ x: 3, y: 0, w: 2, h: 1 });
    const wide = compact(doc({ x: 0, y: 0, w: 5, h: 1 }, { x: 3, y: 9, w: 2, h: 1 }), 5);
    expect(wide[1]!.cell.y).toBe(1);
    expect(wide[1]!.cell.x).toBe(3);
  });

  test("a pinned element never moves, and an overlapping input is resolved", () => {
    const items = doc({ x: 0, y: 3, w: 2, h: 1 }, { x: 0, y: 3, w: 2, h: 1 });
    const out = compact(items, 5, "e001");
    expect(out[1]!.cell.y).toBe(3);
    expect(noOverlap(out)).toBe(true);
  });

  test("bounds is what the page is, and an empty page has no height", () => {
    expect(bounds([], 7)).toEqual({ columns: 7, rows: 0 });
    expect(bounds(doc({ x: 0, y: 2, w: 1, h: 3 }), 7).rows).toBe(5);
  });

  test("reflow caps widths, wraps, and keeps every id in its reading order", () => {
    const items = doc(
      { x: 0, y: 0, w: 5, h: 1 },
      { x: 0, y: 1, w: 4, h: 3 },
      { x: 4, y: 1, w: 3, h: 3 },
      { x: 0, y: 4, w: 6, h: 4 },
    );
    const out = reflow(items, 5);
    expect(inside(out, 5)).toBe(true);
    expect(noOverlap(out)).toBe(true);
    expect(out[3]!.cell.w).toBe(5);
    expect(readingOrder(out)).toEqual(["e000", "e001", "e002", "e003"]);
  });

  test("a corrupt cell is clamped into the grid, never walked", () => {
    const wild = doc({ x: 1e9, y: 1e9, w: 1e9, h: Number.NaN }, { x: -5, y: -5, w: 2, h: 2 });
    const out = compact(wild, 5);
    expect(out[1]!.cell).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(out[0]!.cell).toEqual({ x: 0, y: 2, w: 5, h: 1 });
    expect(bounds(wild, 5).rows).toBeLessThan(9999);
    expect(move(wild, "e001", { x: 0, y: 1e9 }, 5)[1]!.cell.y).toBeLessThan(9999);
  });

  test("a corrupt HEIGHT is clamped too, at every door", () => {
    // the y clamp was the only one: fit() left h alone, so one rect asking for
    // four million rows allocated one occupancy row per cell of it and pushed
    // its neighbour four million rows down (38 ms and 157 MB; at 1e9 it is the
    // window). Every door that takes an h agrees on the ceiling
    const tall = doc({ x: 0, y: 0, w: 1, h: 4_000_000 }, { x: 0, y: 1, w: 1, h: 1 });
    const out = compact(tall, 5);
    expect(out[0]!.cell.h).toBe(SPAN_MAX.h);
    expect(out[1]!.cell.y).toBe(SPAN_MAX.h);
    expect(bounds(tall, 5).rows).toBe(SPAN_MAX.h);
    expect(place(tall, { w: 1, h: 1e9 }, 5).h).toBe(SPAN_MAX.h);
    expect(move(tall, "e000", { x: 2, y: 0 }, 5)[0]!.cell.h).toBe(SPAN_MAX.h);
    expect(reflow(tall, 5).every((i) => i.cell.h <= SPAN_MAX.h)).toBe(true);
  });

  test("an unknown id changes nothing", () => {
    const items = doc({ x: 1, y: 1, w: 2, h: 2 });
    expect(move(items, "nobody", { x: 0, y: 0 }, 5)).toEqual(items);
    expect(resize(items, "nobody", { w: 1, h: 1 }, 5)).toEqual(items);
  });
});

describe("the invariants, over random documents", () => {
  const DOCS = 220;

  test("no overlap, inside the columns, through a random walk of every op", () => {
    for (let d = 0; d < DOCS; d++) {
      let columns = between(1, 14);
      let items = randomDoc(between(1, 24), columns);
      expect(noOverlap(items)).toBe(true);
      expect(inside(items, columns)).toBe(true);
      for (let step = 0; step < 12; step++) {
        const victim = pick(items).id;
        const op = between(0, 4);
        if (op === 0) items = move(items, victim, { x: between(-2, 16), y: between(-2, 20) }, columns);
        else if (op === 1) items = resize(items, victim, pick(LADDER), columns);
        else if (op === 2) items = compact(items, columns);
        else if (op === 3) {
          columns = between(1, 14);
          items = reflow(items, columns);
        } else {
          const span = pick(LADDER);
          items = [...items, { id: `n${d}_${step}`, cell: place(items, span, columns) }];
        }
        expect(noOverlap(items)).toBe(true);
        expect(inside(items, columns)).toBe(true);
        expect(bounds(items, columns).rows).toBe(
          items.reduce((r, i) => Math.max(r, i.cell.y + i.cell.h), 0),
        );
      }
    }
  });

  test("compaction is idempotent", () => {
    for (let d = 0; d < DOCS; d++) {
      const columns = between(1, 14);
      const items = randomDoc(between(1, 40), columns).map((i) => ({
        id: i.id,
        cell: { ...i.cell, y: i.cell.y + between(0, 6) },
      }));
      const once = compact(items, columns);
      expect(cellsOf(compact(once, columns))).toEqual(cellsOf(once));
      const pinned = once[between(0, once.length - 1)]!.id;
      const p1 = compact(items, columns, pinned);
      expect(cellsOf(compact(p1, columns, pinned))).toEqual(cellsOf(p1));
    }
  });

  test("the result depends on the (y, x, id) order and never on the array's", () => {
    for (let d = 0; d < DOCS; d++) {
      const columns = between(1, 14);
      const items = randomDoc(between(2, 30), columns);
      const shuffled = [...items].sort(() => rnd() - 0.5);
      expect(cellsOf(compact(shuffled, columns))).toEqual(cellsOf(compact(items, columns)));
      const victim = items[0]!.id;
      expect(cellsOf(move(shuffled, victim, { x: 1, y: 2 }, columns))).toEqual(
        cellsOf(move(items, victim, { x: 1, y: 2 }, columns)),
      );
      expect(cellsOf(reflow(shuffled, 4))).toEqual(cellsOf(reflow(items, 4)));
    }
  });

  test("reflow keeps the reading order, and reflow then widen keeps it too", () => {
    for (let d = 0; d < DOCS; d++) {
      const columns = between(2, 14);
      const items = randomDoc(between(1, 40), columns);
      const order = readingOrder(items);
      for (const c of [1, 4, 5, 7, 10, 14]) expect(readingOrder(reflow(items, c))).toEqual(order);
      expect(readingOrder(reflow(reflow(items, 4), 10))).toEqual(readingOrder(reflow(items, 10)));
      expect(cellsOf(reflow(reflow(items, 7), 7))).toEqual(cellsOf(reflow(items, 7)));
    }
  });

  test("the canvas grows down only: nothing ever sits past the last column", () => {
    for (let d = 0; d < DOCS; d++) {
      const wide = between(8, 14);
      const items = randomDoc(between(1, 40), wide);
      for (const c of [1, 2, 3, 5, 7]) {
        const out = reflow(items, c);
        expect(bounds(out, c).columns).toBe(c);
        expect(out.every((i) => i.cell.x + i.cell.w <= c)).toBe(true);
      }
    }
  });
});

test("compact over 200 elements is under 2 ms", () => {
  const columns = 10;
  const items = randomDoc(200, columns).map((i) => ({
    id: i.id,
    cell: { ...i.cell, y: i.cell.y + between(0, 12) },
  }));
  for (let i = 0; i < 5; i++) compact(items, columns);
  const runs: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t = performance.now();
    compact(items, columns);
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  expect(runs[12]!).toBeLessThan(2);
});
