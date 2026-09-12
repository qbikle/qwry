// The canvas layout engine. Pure: no React, no DOM, no store, no Tauri, so the
// rules live once and are tested without any of them (canvas.ts:9-13's shape).
//
// Two contracts carry everything else. First, a cell's WIDTH stretches with the
// container and its HEIGHT never does: every pixel a block holds is typed in
// unscaled CSS px (a bar pitch 24, a grid row 26, a text line 20), and width is
// the one axis all of it already reflows against. Second, collision is push
// down then float up, never swap: it is the one rule that yields a valid layout
// for arbitrary spans, so the gesture has one outcome instead of two.
//
// The total order is (y, x, id). Ids are uuids, so that is a total order and
// every pass is fully determined by its input. No Math.random, no Date, no
// iteration over an object's own key order.

/** an element's rect in CELLS. x,y >= 0; w,h >= 1. Never pixels. */
export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** what the engine needs of an element: its identity and its rect. */
export interface GridItem {
  id: string;
  cell: Cell;
}

/** a size in cells, with no place yet. */
export interface Span {
  w: number;
  h: number;
}

/** the pixel truth for one container width, computed once per measure. */
export interface Metrics {
  /** how many columns this width affords */
  columns: number;
  /** one cell's width in CSS px; stretches with the container, capped */
  cellW: number;
  /** the gap between cells, both axes; grows only past the stretch cap */
  gutter: number;
}

/** one cell at the base, 27 x 4. The floor (640) holds five of them exactly. */
export const CELL_W_BASE = 108;
/** one cell's height. A CONSTANT: content heights do not scale with a window. */
export const CELL_H = 108;
/** --sp-3, both axes. The 16 that stood between blocks becomes this 12. */
export const GUTTER = 12;
/** the page's own inset, both sides (canvas.css's 20 becomes this 16). */
export const PAGE_INSET = 16;
/** a cell never exceeds this many times its base width */
export const STRETCH_MAX = 1.25;
/** occupancy is one u32 per row; past this the count clamps */
export const COLUMNS_MAX = 32;
/** the largest span any element may take: the full width, twelve rows tall */
export const SPAN_MAX: Span = { w: COLUMNS_MAX, h: 12 };
/** the last row anything may claim. Not a design limit: 4096 rows is 491,520px
 *  of page, past any document a person can make. It is what keeps a corrupt
 *  doc_json (a y of 1e9) from walking a float-up loop a billion rows or asking
 *  for a billion rows of occupancy. A clamped y compacts to its real place.
 *  A height does the same damage and is held by SPAN_MAX.h at the same doors:
 *  every rect the engine takes in goes through `rows` and `tall`. */
const ROW_MAX = 4096;
/** a v1 block's width at first open, capped just past the note's 680 measure */
export const MIGRATE_W_MAX = 6;

/** every span the tables are keyed by: a note, a result's five faces, the sheet
 *  C2b fills. The store maps a block to one of these; the engine never sees a
 *  block. */
export type SpanKey = "note" | "values" | "chart" | "table" | "sql" | "diff" | "drawing";

/** the cap each kind opens at, before its content is read (see defaultSpan). */
export const DEFAULT_SPAN: Record<SpanKey, Span> = {
  note: { w: 3, h: 2 },
  values: { w: 2, h: 1 },
  chart: { w: 4, h: 3 },
  table: { w: 6, h: 4 },
  sql: { w: 6, h: 4 },
  diff: { w: 6, h: 4 },
  drawing: { w: 3, h: 3 },
};

/** the floor each kind stands on, measured against the BASE cell so a minimum
 *  does not move when the window does. A result's 2 is its cluster's 148px. */
export const MIN_SPAN: Record<SpanKey, Span> = {
  note: { w: 1, h: 1 },
  values: { w: 2, h: 1 },
  chart: { w: 2, h: 2 },
  table: { w: 2, h: 2 },
  sql: { w: 2, h: 1 },
  diff: { w: 2, h: 2 },
  drawing: { w: 2, h: 2 },
};

/** what a kind knows about its own content when it asks for a default size. */
export interface ContentSize {
  /** table, diff: the rows the result holds */
  rows?: number;
  /** chart: the bar count. Absent reads as a line plot, which has no rows. */
  bars?: number;
  /** values: the pairs' cells, one per pair and two past a figure of 8 glyphs */
  cells?: number;
  /** note: the lines the markdown renders to at the span's width. table, diff,
   *  sql: the lines of PROSE standing above the face, which the block draws
   *  and its height therefore has to hold */
  lines?: number;
}

/** a figure past this many glyphs takes two cells in a values row. */
export const FIGURE_WIDE_GLYPHS = 8;

/** the px a span of n cells covers at the base, on either axis. Pairs with
 *  cellsForPx: one turns cells into pixels, the other pixels back into cells. */
export function basePx(cells: number): number {
  const n = Math.max(1, Math.floor(cells));
  return n * CELL_W_BASE + (n - 1) * GUTTER;
}

/** the cells a measured height needs. The autoH rule, and every h below. */
export function cellsForPx(px: number): number {
  if (!Number.isFinite(px)) return 1;
  return Math.max(1, Math.ceil((px + GUTTER) / (CELL_H + GUTTER)));
}

/** a values row's width: one cell a pair, two for a figure past 8 glyphs. */
export function valueCells(figures: readonly string[]): number {
  let c = 0;
  for (const f of figures) c += f.length > FIGURE_WIDE_GLYPHS ? 2 : 1;
  return Math.max(MIN_SPAN.values.w, c);
}

function clampSpan(span: Span, min: Span, max: Span): Span {
  return {
    w: Math.min(Math.max(span.w, min.w), max.w),
    h: Math.min(Math.max(span.h, min.h), max.h),
  };
}

/** the size a kind opens at, read from its content and capped by DEFAULT_SPAN.
 *  The heights are the product doc's formulas against this grid's 120 pitch. */
export function defaultSpan(key: SpanKey, content?: ContentSize): Span {
  const cap = DEFAULT_SPAN[key];
  if (!content) return { ...cap };
  const min = MIN_SPAN[key];
  switch (key) {
    case "table":
    case "diff":
    case "sql": {
      if (content.rows === undefined) return { ...cap };
      // the prose the model wrote stands ABOVE the grid and is the block's
      // content too: left out of the height, every result that carries a
      // sentence opens one line short and cuts its last row
      const h = cellsForPx(30 + 26 * Math.max(0, content.rows) + 56 + 20 * Math.max(0, content.lines ?? 0));
      return clampSpan({ w: cap.w, h }, min, cap);
    }
    case "chart": {
      if (content.bars === undefined) return { ...cap };
      const h = cellsForPx(24 * Math.max(0, content.bars) + 64);
      return clampSpan({ w: cap.w, h }, min, cap);
    }
    case "values": {
      const w = Math.max(min.w, content.cells ?? cap.w);
      const rows = Math.max(1, Math.ceil((content.cells ?? w) / w));
      return { w, h: rows };
    }
    case "note": {
      if (content.lines === undefined) return { ...cap };
      const h = cellsForPx(Math.max(0, content.lines) * 20 + 8);
      return clampSpan({ w: cap.w, h }, min, { w: cap.w, h: 6 });
    }
    default:
      return { ...cap };
  }
}

/** the floor a kind stands on with its content in hand: a bar chart squeezed
 *  under 16px a bar drops to this rather than overlapping its labels. */
export function minSpan(key: SpanKey, content?: ContentSize): Span {
  const min = MIN_SPAN[key];
  if (key === "chart" && content?.bars !== undefined) {
    const h = cellsForPx(16 * Math.max(0, content.bars) + 64);
    return { w: min.w, h: Math.min(Math.max(min.h, h), DEFAULT_SPAN.chart.h) };
  }
  return { ...min };
}

/** the grid's container is the scroller's content box, not the card: a card of
 *  640 lays out 606 (the card's hairline both sides, then the page's inset). */
export function contentWidthFor(cardWidth: number): number {
  return Math.max(0, cardWidth - 2 - 2 * PAGE_INSET);
}

/** how many columns a content width affords. */
export function columnsFor(width: number, base = CELL_W_BASE, gutter = GUTTER): number {
  const w = Number.isFinite(width) ? Math.max(0, width) : 0;
  const pitch = base + gutter;
  return Math.min(COLUMNS_MAX, Math.max(1, Math.floor((w + gutter) / pitch)));
}

/** the stretch, capped. Past the cap the leftover goes to the GUTTER, never to
 *  a dead right margin: the grid closes flush on both edges at every width. */
export function cellMetrics(width: number): Metrics {
  const w = Number.isFinite(width) ? Math.max(0, width) : 0;
  const columns = columnsFor(w);
  const raw = (w - (columns - 1) * GUTTER) / columns;
  const cellW = Math.max(0, Math.min(raw, CELL_W_BASE * STRETCH_MAX));
  const gutter = columns > 1 ? (w - columns * cellW) / (columns - 1) : GUTTER;
  return { columns, cellW, gutter };
}

/** do two rects share a cell? */
export function overlaps(a: Cell, b: Cell): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** what the page is. Empty is 0 rows, so the empty state is a real empty. */
export function bounds(items: readonly GridItem[], columns: number): { columns: number; rows: number } {
  let rows = 0;
  for (const it of items) rows = Math.max(rows, row(it.cell.y) + tall(it.cell.h));
  return { columns: clampColumns(columns), rows };
}

/** row-major first fit: for y = 0.., for x = 0..columns-w. Deterministic. */
export function place(items: readonly GridItem[], span: Span, columns: number): Cell {
  const cols = clampColumns(columns);
  const w = Math.min(Math.max(1, int(span.w, 1)), cols);
  const h = tall(span.h);
  return firstFit(occupancyOf(items, cols), w, h, cols, 0, 0);
}

/** the moved element is PINNED where it was dropped; everything it now overlaps
 *  is pushed DOWN just enough to clear, in (y, x, id) order, and the whole
 *  layout then floats up with the moved element still pinned. One rule. */
export function move(
  items: readonly GridItem[],
  id: string,
  to: { x: number; y: number },
  columns: number,
): GridItem[] {
  const cols = clampColumns(columns);
  const target = items.find((i) => i.id === id);
  if (!target) return copyAll(items);
  const w = Math.min(Math.max(1, int(target.cell.w, 1)), cols);
  const h = tall(target.cell.h);
  const cell: Cell = { x: clamp(int(to.x, 0), 0, cols - w), y: row(to.y), w, h };
  return compact(withCell(items, id, cell), cols, id);
}

/** identical, with the new span: w clamps into the columns and into SPAN_MAX,
 *  h clamps to SPAN_MAX.h, x pulls back so x + w <= columns. */
export function resize(items: readonly GridItem[], id: string, span: Span, columns: number): GridItem[] {
  const cols = clampColumns(columns);
  const target = items.find((i) => i.id === id);
  if (!target) return copyAll(items);
  const w = clamp(int(span.w, 1), 1, Math.min(cols, SPAN_MAX.w));
  const h = clamp(int(span.h, 1), 1, SPAN_MAX.h);
  const cell: Cell = { x: clamp(int(target.cell.x, 0), 0, cols - w), y: row(target.cell.y), w, h };
  return compact(withCell(items, id, cell), cols, id);
}

/** the column count changed. Cap every w to `columns`, then re-place every
 *  element into an EMPTY layout in the reading order it had, each one landing
 *  at or after the one before it: the derived layout keeps the reading order
 *  exactly, which is the one thing a narrowing cannot afford to lose (the width
 *  it genuinely loses, and the store keeps the stored layout to return to). */
export function reflow(items: readonly GridItem[], columns: number): GridItem[] {
  const cols = clampColumns(columns);
  const occ = new Occupancy();
  const placed = new Map<string, Cell>();
  let fromY = 0;
  let fromX = 0;
  for (const it of ordered(items)) {
    const w = Math.min(Math.max(1, int(it.cell.w, 1)), cols);
    const h = tall(it.cell.h);
    const cell = firstFit(occ, w, h, cols, fromY, fromX);
    occ.add(cell);
    placed.set(it.id, cell);
    fromY = cell.y;
    fromX = cell.x;
  }
  return items.map((i) => ({ id: i.id, cell: placed.get(i.id) ?? { ...i.cell } }));
}

/** float every element up in (y, x, id) order until it hits something or y = 0.
 *  A pinned element is seeded first and never moves: that is what makes a drop
 *  mean something. An element that starts on top of another is pushed down
 *  first, so compact is total and its output is always a valid layout. */
export function compact(items: readonly GridItem[], columns: number, pinned?: string): GridItem[] {
  const cols = clampColumns(columns);
  const occ = new Occupancy();
  const placed = new Map<string, Cell>();
  const order = ordered(items);
  const pin = pinned === undefined ? undefined : order.find((i) => i.id === pinned);
  if (pin) {
    const cell = fit(pin.cell, cols);
    occ.add(cell);
    placed.set(pin.id, cell);
  }
  for (const it of order) {
    if (pin && it.id === pin.id) continue;
    const { x, y: from, w, h } = fit(it.cell, cols);
    let y = from;
    while (!occ.free(x, y, w, h)) y++;
    while (y > 0 && occ.free(x, y - 1, w, 1)) y--;
    const cell: Cell = { x, y, w, h };
    occ.add(cell);
    placed.set(it.id, cell);
  }
  return items.map((i) => ({ id: i.id, cell: placed.get(i.id) ?? { ...i.cell } }));
}

// one u32 a row: a collision test is a mask AND, and 200 elements compact in
// tens of microseconds, which is why nothing incremental is built here.
const ROW_FULL = 0xffffffff;

function maskOf(x: number, w: number): number {
  const span = w >= 32 ? ROW_FULL : ((1 << w) - 1) >>> 0;
  return (span << x) >>> 0;
}

class Occupancy {
  private rows: number[] = [];

  get height(): number {
    return this.rows.length;
  }

  add(c: Cell): void {
    const mask = maskOf(c.x, c.w);
    const end = c.y + c.h;
    while (this.rows.length < end) this.rows.push(0);
    for (let y = c.y; y < end; y++) this.rows[y] = (this.rows[y] | mask) >>> 0;
  }

  free(x: number, y: number, w: number, h: number): boolean {
    const mask = maskOf(x, w);
    const end = Math.min(y + h, this.rows.length);
    for (let r = y; r < end; r++) if ((this.rows[r] & mask) !== 0) return false;
    return true;
  }
}

function occupancyOf(items: readonly GridItem[], cols: number): Occupancy {
  const occ = new Occupancy();
  for (const it of items) occ.add(fit(it.cell, cols));
  return occ;
}

/** the first free w x h rect at or after (fromY, fromX), scanning rows top down
 *  and columns left to right. place() starts at the origin and fills holes;
 *  reflow() starts at its predecessor and cannot. */
function firstFit(occ: Occupancy, w: number, h: number, cols: number, fromY: number, fromX: number): Cell {
  const last = Math.max(fromY, occ.height);
  let x0 = Math.max(0, fromX);
  for (let y = fromY; y <= last; y++) {
    for (let x = x0; x + w <= cols; x++) if (occ.free(x, y, w, h)) return { x, y, w, h };
    x0 = 0;
  }
  return { x: 0, y: last, w, h };
}

function ordered(items: readonly GridItem[]): GridItem[] {
  return [...items].sort((a, b) => {
    const ay = int(a.cell.y, 0);
    const by = int(b.cell.y, 0);
    if (ay !== by) return ay - by;
    const ax = int(a.cell.x, 0);
    const bx = int(b.cell.x, 0);
    if (ax !== bx) return ax - bx;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function fit(cell: Cell, cols: number): Cell {
  const w = Math.min(Math.max(1, int(cell.w, 1)), cols);
  return {
    x: clamp(int(cell.x, 0), 0, cols - w),
    y: row(cell.y),
    w,
    h: tall(cell.h),
  };
}

function withCell(items: readonly GridItem[], id: string, cell: Cell): GridItem[] {
  return items.map((i) => (i.id === id ? { id, cell } : { id: i.id, cell: { ...i.cell } }));
}

function copyAll(items: readonly GridItem[]): GridItem[] {
  return items.map((i) => ({ id: i.id, cell: { ...i.cell } }));
}

function clampColumns(columns: number): number {
  return clamp(int(columns, 1), 1, COLUMNS_MAX);
}

function row(v: number): number {
  return clamp(int(v, 0), 0, ROW_MAX);
}

/** a height, held to the span table's own ceiling. `resize` clamped it and no
 *  other door did, so a corrupt h of 1e9 walked `Occupancy.add` a row at a
 *  time and pushed every neighbour a billion rows down */
function tall(v: number): number {
  return clamp(int(v, 1), 1, SPAN_MAX.h);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function int(v: number, fallback: number): number {
  return Number.isFinite(v) ? Math.trunc(v) : fallback;
}
