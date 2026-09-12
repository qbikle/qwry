// Canvas documents (A3). A canvas is a tab of the main card holding an
// ordered list of blocks of TWO kinds, not five (DESIGN rule 15): a `result`
// is the W7 result block reused whole, wearing the exchange's question as its
// first line, the model's sentence above the faces and the assumptions folded
// into the status line; a `note` is prose, the user's or the model's. "query",
// "table", "assumption" and "chart" are not blocks: the first three are parts
// of the result block and the chart is a third FACE of it.
//
// This file is the document and nothing else: it owns the blocks, the face a
// block wears, the comparison a block carries, and the debounced write to
// appdb. It draws nothing. What the UI needs to draw truthfully it asks for
// here (`statusOf`, `chartOf`, `facesOf`), so the rules that decide whether a
// chart face exists at all live in one place and are testable without a DOM.
//
// B3 gives the MODEL a door into the document: `applyModelBlocks` applies one
// tool call's blocks in ONE setDoc, so two calls of a turn interleave at call
// granularity and never at block granularity, and every block it lands wears
// `wroteBy: exchangeId`. That field is the document's own record of whose a
// block is, and it is what makes the three cut rules possible without the
// pane owning a list: a cut removes the blocks of the exchanges it removes
// (`removeByExchange`), a re-run's first write clears the previous attempt's,
// and a block the user deleted by hand is simply not there any more. A block
// with no `wroteBy` is the document's own and no thread may take it away.
//
// LESSONS 3 is the rule this file is written around, the same as agent.ts:
// the canvas id, the block and the connection are captured at entry and never
// re-read from the store after an await. `compare` runs a query on another
// connection while the user is free to delete the block it ran for.
//
// LESSONS 4: a comparison names both connections inside the document, not
// from the navigation state, so a diff read a week later still says which two
// databases produced it.
//
// C2 gives the document a LAYOUT. Every block carries a `cell` (x, y, w, h in
// the grid's own units, `src/canvas/grid.ts`), the document carries `v: 2` and
// an advisory `lastColumns`, and the engine next door decides every geometry
// question; this file is where a cell becomes a FACT of the document. It
// places what lands (`place`), it commits one layout per gesture end and never
// per pointer move, and it reads A3's ordered list back as rows of cells
// (`migrateV1`) without writing over that document until the user's own first
// change: a read must not look like an edit.

import { create } from "zustand";
import {
  agentConnect,
  agentRunReadonly,
  canvasDelete,
  canvasList,
  canvasUpsert,
  disconnect,
} from "../ipc/commands";
import {
  CANVAS_BLOCK_ROWS,
  COLUMNS_FALLBACK,
  RUN_SQL_TIMEOUT_MS,
  type CanvasOutlineEntry,
  type ModelPlace,
} from "../agent/tools";
import type { AgentRun, CanvasFace } from "../agent/types";
import { figureText, SCALAR_MAX_COLS } from "../ask/ScalarResult";
import { msText } from "../lib/duration";
import {
  basePx,
  cellsForPx,
  COLUMNS_MAX,
  compact,
  DEFAULT_SPAN,
  defaultSpan,
  minSpan,
  MIGRATE_W_MAX,
  move as moveCells,
  overlaps,
  place,
  reflow as reflowCells,
  resize as resizeCells,
  SPAN_MAX,
  valueCells,
  type Cell,
  type ContentSize,
  type GridItem,
  type Span,
  type SpanKey,
} from "../canvas/grid";
import {
  bboxOf,
  inkPalette,
  paperColour,
  parseStrokes,
  toPng,
  writeStrokes,
  type Stroke,
} from "../canvas/strokes";
import type { DrawTool } from "../canvas/blockTools";
import { setCanvasPort } from "../canvas/port";
import { useAgent } from "./agent";
import { useAsk } from "./ask";
import { useConnections } from "./connections";
import { useRecents } from "./recents";
import { useSettings } from "./settings";
import { useTabs } from "./tabs";
import type { Exchange } from "./agent";

/** which face of a result block is up. `values` stands in the TABLE face's
 * place when the statement returned exactly one row (the headline figures
 * over their column names: a figure row is a result, not a third kind, B3),
 * and `diff` stands there while a comparison stands (the table's cells are
 * the diff's A cells, DESIGN rule 14), so the flip cycle is three faces
 * whichever of the three holds that place. */
export type BlockFace = "table" | "chart" | "values" | "sql" | "diff";

/** the default title of a connection's first canvas */
export const DEFAULT_CANVAS_TITLE = "Canvas";

/** a chart face exists only for an aggregate: over this many rows there is no
 * chart to read, and the face is ABSENT rather than a message in its place.
 * The document's own row cap (`CANVAS_BLOCK_ROWS`, beside the other row caps
 * in agent/tools) is that number, because a block cannot hold more than it
 * either: ONE number for the canvas, both doors, B3's own call */
export const CHART_ROW_CAP = CANVAS_BLOCK_ROWS;
/** the accent ladder is three steps of one hue; a fourth series has no colour */
export const CHART_MAX_SERIES = 3;
/** both sides of a comparison, same reason: a diff of thousands of rows is
 * not a reading, and over the cap the face is its status line and nothing else */
export const DIFF_ROW_CAP = CANVAS_BLOCK_ROWS;

/** appdb write debounce; the tabs store's own 600 is for text typed a
 * character at a time, a block lands whole */
const SAVE_DEBOUNCE_MS = 400;

/** one numeric cell of a diff row: both sides as the database printed them,
 * and the change between them */
export interface DiffCell {
  a: string | null;
  b: string | null;
  /** the signed RELATIVE change in per cent (an absolute difference restates
   * two numbers already in the cell). Null when it cannot be stated: a
   * one-sided row, or an A of zero, where a relative change is not a number */
  delta: number | null;
}

export interface DiffRow {
  labels: (string | null)[];
  cells: DiffCell[];
  /** the row stands on one side only: the warn tier, `∅` for the side it lacks */
  only: "a" | "b" | null;
}

/** one side of a comparison, as it stood when the comparison ran */
export interface DiffSide {
  profileId: string;
  name: string;
  ms: number;
}

export interface Diff {
  a: DiffSide;
  b: DiffSide;
  labelColumns: string[];
  numericColumns: string[];
  rows: DiffRow[];
  /** a side came back over DIFF_ROW_CAP: `rows` is empty and the face is one
   * status line */
  capped: boolean;
}

interface BlockBase {
  id: string;
  /** C2: where the element stands, in CELLS (grid.ts's units). Every block of
   * every document the store has laid out carries one: `parseDoc` fills what a
   * v1 document never had and every door into the document places what it
   * lands. Optional in the TYPE and not in the fact, because a hand-built
   * fixture and an A3 document are both written without one and neither is
   * broken; `laidOut` is the single place that answers for a block that has
   * none, so no caller invents a second fallback (DESIGN rule 14) */
  cell?: Cell;
  /** C2: the height follows the content and no hand has overridden it. A note
   * is born with it (its own words set its height); the first hand resize
   * clears it and the element keeps the size it was given */
  autoH?: boolean;
  /** the canvas block this exchange was asked from (A3 item 4), so the reply
   * lands under the block it answered. Session memory made durable: the id
   * rides the document, and a block that is gone simply resolves to nothing */
  askedFrom?: string;
  /** B3: the exchange whose answer wrote this block. The document's own
   * record of whose a block is, and the only one there is: a cut deletes the
   * blocks of every exchange it removes, a re-run's first write clears the
   * previous attempt's, and the pane's status line counts what still stands
   * (LESSONS 13, the number read from whatever did the counting). ABSENT on a
   * block the user made, by hand or by pressing Add to Canvas: those are the
   * document's own and no thread ever takes them away (LESSONS 4) */
  wroteBy?: string;
}

/** one exchange, whole: the question, the model's sentence, the run and the
 * assumptions. Never two blocks (a note plus a result carries the question
 * line twice, DESIGN rule 14, and two clusters). */
export interface ResultBlock extends BlockBase {
  kind: "result";
  question: string;
  /** B3: the model's own title line, at most six words, Sentence case,
   * identifiers in backticks. The exchange's question stands on the answer's
   * FIRST block and this on its others (rule 14: the question once), so the
   * two facts keep their own fields and share one slot: `titleOf` renders
   * whichever the block has, and a model's six words are never mistaken for
   * words the user typed (LESSONS 4) */
  title?: string;
  /** the model's own words, read-only here; provenance, not decoration */
  prose: string;
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
  /** the assumption labels, folded into the status line after one lowercase
   * `assumed`. Labels, not chips: a chip on the canvas toggles nothing, and a
   * control costume on a non-control is DESIGN rule 8's inverse */
  chips: string[];
  /** the run's facts as they landed, `4 rows · 311.8 ms` */
  status: string;
  /** that run's own milliseconds, kept as a number so a comparison can name
   * both sides' timings in one status line */
  ms: number;
  /** on the canvas the chosen face is a FACT of the document and persists; in
   * Ask it stays a way of looking (W7, never persisted) */
  face: BlockFace;
  diff?: Diff;
}

export interface NoteBlock extends BlockBase {
  kind: "note";
  text: string;
  /** the question that produced it, when a model's answer wrote the note */
  question?: string;
}

/** C2b: ink on paper, the canvas's third species. Not a face of a note: a
 * face is a view of one content, and ink is not a view of prose (a note
 * wearing a text face and an ink face would hide the words behind the
 * strokes, one content in two slots with one always hidden). The strokes are
 * in the element's own CSS pixels at 1:1, never normalized, so a cell that
 * stretches wider than it is tall cannot turn a circle into an ellipse
 * (`src/canvas/strokes.ts`). */
export interface DrawingBlock extends BlockBase {
  kind: "drawing";
  strokes: Stroke[];
  /** the accent-ladder step, the weight and the tool the NEXT stroke takes:
   * the element's own memory, so a drawing reopened is the pen it was put
   * down as. Optional, because a drawing the model or a fixture writes has
   * none and the picker's own defaults answer for it */
  ink?: number;
  weight?: number;
  tool?: DrawTool;
}

export type Block = ResultBlock | NoteBlock | DrawingBlock;

export interface CanvasDoc {
  /** absent = v1, the ordered list A3 shipped and `migrateV1` reads as rows of
   * cells. 2 = the grid. A v1 document is never BROKEN: it parses, it migrates,
   * and it is not written back until the user's own first change */
  v?: 2;
  blocks: Block[];
  /** ADVISORY: the column count this layout was last laid out at, so `outline`
   * can tell the model how wide the page is when no tab is measuring and a
   * block that lands headless still lands somewhere sensible. Nothing reads it
   * to refuse anything (LESSONS 5: cached metadata informs, never refuses) */
  lastColumns?: number;
}

/** a canvas in the list: everything but its document */
export interface CanvasMeta {
  id: string;
  profileId: string;
  title: string;
  updatedAt: string;
  /** the stored document did not parse. It is listed (it exists) and never
   * written to: overwriting what we could not read would delete it for good */
  broken?: boolean;
}

/** what the status line under a block's faces says. The store hands over the
 * parts; the tiers are the UI's (the labels tier 1, the lead and the numbers
 * tier 2). A note has no status line, hence null. */
export interface StatusLine {
  /** the run's own facts, or a diff's row count */
  facts: string;
  /** a comparison names both connections and both timings ONCE (LESSONS 4) */
  sides: { name: string; ms: number }[];
  /** the assumptions, rendered after one lowercase `assumed` lead */
  assumed: string[];
}

/** what a chart face draws. Bars unless the label parses as a date. */
export interface ChartSpec {
  kind: "bars" | "line";
  label: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}

// ---- reading a result -----------------------------------------------------

/** `4 rows`, `1 row` */
const rowsText = (n: number) => `${n.toLocaleString()} ${n === 1 ? "row" : "rows"}`;

/** What a result block keeps of a run, and the status line that tells the
 * truth about it. BOTH doors into the document go through here (the model's
 * `canvas_write` and the user's `Add to Canvas` press), so the row cap and
 * the sentence that reports it stand in one place: over the cap the block
 * keeps the first `CANVAS_BLOCK_ROWS` rows and says `200 of 1,842 rows`, because
 * a silently halved table reads as the whole table and is read as one
 * (LESSONS 9). `rowCount` is what the statement produced, which is already
 * more than `rows` holds when the run itself was capped. */
export function capRun(run: {
  rows: readonly (string | null)[][];
  rowCount: number;
  ms: number;
}): { rows: (string | null)[][]; status: string } {
  const rows = run.rows.slice(0, CANVAS_BLOCK_ROWS).map((r) => [...r]);
  const facts =
    rows.length < run.rowCount
      ? `${rows.length.toLocaleString()} of ${rowsText(run.rowCount)}`
      : rowsText(run.rowCount);
  return { rows, status: `${facts} · ${msText(run.ms)}` };
}

/** a column is numeric when every value it actually has is a finite number.
 * All-null and all-empty columns are labels: nothing in them can be summed,
 * compared or drawn. */
function numericAt(rows: (string | null)[][], i: number): boolean {
  let seen = false;
  for (const r of rows) {
    const v = r[i];
    if (v === null || v === undefined || v === "") continue;
    if (!Number.isFinite(Number(v))) return false;
    seen = true;
  }
  return seen;
}

/** the column indices that name a row and the ones that measure it */
export function columnKinds(
  columns: string[],
  rows: (string | null)[][],
): { labels: number[]; numbers: number[] } {
  const labels: number[] = [];
  const numbers: number[] = [];
  columns.forEach((_, i) => (numericAt(rows, i) ? numbers : labels).push(i));
  return { labels, numbers };
}

/** a label draws a line instead of bars when EVERY one of them is a date */
const DATE_LABEL = /^\d{4}-\d{2}(-\d{2})?([T ]|$)/;

/** what a result CARRIES, on a document that may not carry it: `doc_json` is
 * opaque, a hand edit or a truncated write can drop an array, and a block a
 * later version writes (C2b's drawing) has neither. Empty is the honest
 * reading and it gives the block a face and a size; a throw here took the
 * whole connection's canvas list down with it (LESSONS 5) */
const rowsOf = (block: Block): (string | null)[][] =>
  block.kind === "result" && Array.isArray(block.rows) ? block.rows : [];
const columnsOfBlock = (block: Block): string[] =>
  block.kind === "result" && Array.isArray(block.columns) ? block.columns : [];

/** the chart the block's rows can carry, or null when there is none: over the
 * row cap, over three numeric columns, with no label column or with two, the
 * face does not exist. Never a message in its place. */
export function chartOf(block: Block): ChartSpec | null {
  if (block.kind !== "result") return null;
  const rows = rowsOf(block);
  const cols = columnsOfBlock(block);
  if (rows.length === 0 || rows.length > CHART_ROW_CAP) return null;
  const { labels, numbers } = columnKinds(cols, rows);
  if (labels.length !== 1) return null;
  if (numbers.length < 1 || numbers.length > CHART_MAX_SERIES) return null;
  const li = labels[0];
  const text = rows.map((r) => r[li] ?? "");
  return {
    kind: text.every((t) => DATE_LABEL.test(t)) ? "line" : "bars",
    label: cols[li],
    labels: text,
    series: numbers.map((ci) => ({
      name: cols[ci],
      values: rows.map((r) => Number(r[ci] ?? 0)),
    })),
  };
}

/** the faces this block can wear, in the cycle order the one flip glyph walks:
 * table (or the diff standing in its place) → chart → SQL. A face that does
 * not exist is not in the cycle, so Flip never lands on an empty one. */
export function facesOf(block: Block): BlockFace[] {
  if (block.kind !== "result") return [];
  const faces: BlockFace[] = [];
  // one place, three tenants: a comparison holds it while it stands, a
  // one-row statement holds it as its figures, and a grid holds it otherwise
  const rows = rowsOf(block);
  if (block.diff) faces.push("diff");
  // one row of five or more columns is a grid, not a figure row: ScalarResult
  // draws at most SCALAR_MAX_COLS pairs, so offering `values` past that would
  // name a face the run cannot stand on (DESIGN rule 11)
  else if (rows.length === 1 && columnsOfBlock(block).length <= SCALAR_MAX_COLS) faces.push("values");
  else if (rows.length > 0) faces.push("table");
  if (chartOf(block)) faces.push("chart");
  if (block.sql) faces.push("sql");
  return faces.length > 0 ? faces : ["table"];
}

/** the face a result OPENS on, given no instruction: its chart when the rows
 * make one, its figures when there is one row, its grid when there are more,
 * its statement when there are none. The model's write composes a reading and
 * takes this (canvas-agent 3.3, chart before table); `Add to Canvas` does not,
 * because a press keeps the face the reader was already looking at. */
export function defaultFace(block: Block): BlockFace {
  if (block.kind !== "result") return "table";
  if (chartOf(block)) return "chart";
  return facesOf(block)[0];
}

/** the status line's parts. A comparison replaces the run's facts with the
 * diff's own, because the two sides are what the block now states. */
export function statusOf(block: Block): StatusLine | null {
  if (block.kind !== "result") return null;
  const assumed = block.chips;
  const d = block.diff;
  if (!d) return { facts: block.status, sides: [], assumed };
  return {
    facts: d.capped ? `over ${DIFF_ROW_CAP} rows` : rowsText(d.rows.length),
    sides: [
      { name: d.a.name, ms: d.a.ms },
      { name: d.b.name, ms: d.b.ms },
    ],
    assumed,
  };
}

/** what a drawing answers to: its first text label, which is the one thing on
 * it a person wrote in words. Empty when it carries none, and the surface then
 * names it by its ordinal (`Drawing 2`) exactly as it names an untitled note:
 * one derivation, read by the outline, the live region and the `@` pill alike
 * (LESSONS 4) */
export function drawingName(block: Block): string {
  if (block.kind !== "drawing") return "";
  for (const s of block.strokes) if (s.k === "text") return s.v;
  return "";
}

/** a span's pixel box at the BASE cell, the measure a drawing's own floor is
 * read against. The two axes share `basePx` because the base cell is square
 * (grid.ts CELL_W_BASE === CELL_H); only the RENDERED width stretches, and a
 * box computed here is for a sheet no window is stretching */
const boxOf = (span: { w: number; h: number }): { w: number; h: number } => ({
  w: basePx(span.w),
  h: basePx(span.h),
});

/** the line the outline ellipsizes, one form per kind: a result's own title
 * line, a note's first words, a drawing's first label. The model wrote at most
 * one of the three and reads back what the DOCUMENT holds, never what it sent
 * (LESSONS 13) */
function outlineLineOf(block: Block): string {
  if (block.kind === "result") return block.question || block.title || "";
  if (block.kind === "drawing") return drawingName(block);
  return block.text.split("\n")[0];
}

// ---- the layout (C2) ------------------------------------------------------
//
// The engine holds the geometry and the tables (grid.ts: the spans, the
// minimums, the formulas); this half holds the READING of a block, which is
// the store's own and nowhere else's: which slot a block occupies and what its
// content measures. So a default span is one fact in one place, asked for by
// the model's door and by the surface alike.

/** the average advance of `--text-md`, the one number a line count needs. The
 * estimate is the DOCUMENT's and not the DOM's: the store knows the markdown,
 * the harness pins the number, and a height computed on one machine is the
 * height on every other (the engine turns the lines into cells) */
const NOTE_ADVANCE = 6.8;

/** the slot a block occupies in the span tables: a note is a note, a result is
 * the face it STANDS on, and `drawing` is the key C2b fills. The face it
 * stands on and the face it stores are not always the same name: a one-row
 * result filed under `table` renders its figures, and a span read from the
 * stored name would open it four rows tall with its pairs alone in the box.
 * `facesOf` is the same list the surface picks from, so the size a block opens
 * at and the face it opens on are read from one fact (LESSONS 13) */
export function spanKeyOf(block: Block): SpanKey {
  if (block.kind === "note") return "note";
  // C2b's sheet, and the door a kind a LATER version writes comes through
  // too: it gets a row in the tables rather than falling out of them
  // (`facesOf` answers [] for it, and the undefined key that followed read
  // `DEFAULT_SPAN[undefined].w`)
  if (block.kind !== "result") return "drawing";
  const faces = facesOf(block);
  return faces.includes(block.face) ? block.face : faces[0];
}

/** how many lines a note's markdown renders to at `w` cells of the BASE cell */
function noteLines(text: string, w: number): number {
  const per = Math.max(1, Math.floor(basePx(w) / NOTE_ADVANCE));
  let lines = 0;
  for (const p of text.split("\n")) lines += Math.max(1, Math.ceil(p.length / per));
  return Math.max(1, lines);
}

/** what a block knows about its own content when it asks for a size: the rows
 * a table holds, the bars a chart draws, the cells a figure row takes (one a
 * pair, two past eight glyphs), the lines a note renders to. `width` is the
 * span the note is being measured AT, since the same words are fewer lines
 * across six cells than across three; it defaults to the one it stands on */
export function contentSizeOf(block: Block, width?: number): ContentSize {
  if (block.kind === "note")
    return { lines: noteLines(block.text ?? "", width ?? block.cell?.w ?? DEFAULT_SPAN.note.w) };
  // a drawing is a SHEET: its size is not read from a row count, it is read
  // from the ink already on it, which is `minSpanFor`'s half of the job
  if (block.kind === "drawing") return {};
  const key = spanKeyOf(block);
  if (key === "values") {
    const row = rowsOf(block)[0] ?? [];
    return { cells: valueCells(row.map(figureText)) };
  }
  if (key === "chart") {
    const spec = chartOf(block);
    return spec?.kind === "bars" ? { bars: spec.labels.length } : {};
  }
  const w = width ?? block.cell?.w ?? DEFAULT_SPAN[key].w;
  const diffRows = block.diff && Array.isArray(block.diff.rows) ? block.diff.rows.length : null;
  return {
    rows: diffRows ?? rowsOf(block).length,
    // the sentence the model wrote above the grid wraps at the block's own
    // width, the same measure a note's words take
    lines: block.prose ? noteLines(block.prose, w) : 0,
  };
}

/** the size this block opens at, its content read at the width it will stand at */
export const defaultSpanFor = (block: Block, width?: number): Span =>
  defaultSpan(spanKeyOf(block), contentSizeOf(block, width));

/** the floor this block stands on: no resize, by hand or by key, goes under it.
 * A drawing's floor GROWS with its ink, so a shrink stops at the strokes'
 * bounds and no stroke is ever cut off by a corner or an arrow key: the cells
 * are counted against the BASE cell, so the floor does not move when the
 * window does (canvas-grid 3.2, 3.5) */
export function minSpanFor(block: Block): Span {
  const min = minSpan(spanKeyOf(block), contentSizeOf(block));
  if (block.kind !== "drawing") return min;
  const ink = bboxOf(block.strokes);
  if (!ink) return min;
  return {
    w: Math.max(min.w, cellsForPx(ink.x + ink.w)),
    h: Math.max(min.h, cellsForPx(ink.y + ink.h)),
  };
}

/** the span a block opens at on a page this wide: never wider than the canvas
 * is, and never under its own floor. The engine clamps too; doing it here is
 * what lets the document say what it asked for (the model's reply) */
function openingSpan(block: Block, columns: number, width?: number): Span {
  const span = defaultSpanFor(block, width);
  const min = minSpanFor(block);
  return {
    w: Math.min(Math.max(span.w, min.w), Math.max(1, columns)),
    h: Math.max(span.h, min.h),
  };
}

const itemsOf = (blocks: readonly Block[]): GridItem[] =>
  blocks.filter((b) => b.cell).map((b) => ({ id: b.id, cell: b.cell as Cell }));

const sameCell = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** a rect the document can stand on: whole cells, on the page, at least 1 × 1
 * and never past the span table's own ceiling. A rect that fails any of these
 * loses its cell and is placed like any other block; carrying it instead put a
 * height of 1e9 into the engine, which walks its occupancy a row at a time */
function validCell(cell: Cell | undefined, columns: number): Cell | null {
  if (!cell) return null;
  const { x, y, w, h } = cell;
  if (![x, y, w, h].every((n) => Number.isInteger(n))) return null;
  if (x < 0 || y < 0 || w < 1 || h < 1 || h > SPAN_MAX.h || x + w > columns) return null;
  return { x, y, w, h };
}

/** A3's ordered list as rows of cells: every block full width at first open
 * (capped at six cells, just past the note's own 680 measure), in its stored
 * order, with its kind's height. Nothing is lost, because the reading order is
 * the order and reading order is what compaction preserves. Not persisted: a
 * document opened and not touched is a document unchanged */
export function migrateV1(blocks: readonly Block[], columns: number): Block[] {
  const w = Math.max(1, Math.min(columns, MIGRATE_W_MAX));
  let y = 0;
  return blocks
    .filter((b) => b && typeof b === "object")
    .map((b) => {
      // the WIDTH is the page's, not the kind's: every block had the whole
      // column in A3 and keeps it here. Only the height is read from the block
      const cell = { x: 0, y, w, h: openingSpan(b, w, w).h };
      y += cell.h;
      return { ...b, cell, ...(b.kind === "note" ? { autoH: true } : null) };
    });
}

/** the page with its holes closed: what stood under a block that is gone
 * floats up. A hole BESIDE an element is the user's own placement and stands;
 * a hole ABOVE one is a gap nothing put there (canvas-grid 4.5) */
function compacted(blocks: readonly Block[], columns: number): Block[] {
  const cells = new Map(compact(itemsOf(blocks), columns).map((i) => [i.id, i.cell]));
  return blocks.map((b) => {
    const cell = cells.get(b.id);
    return cell && b.cell && !sameCell(cell, b.cell) ? { ...b, cell } : b;
  });
}

/** every block with a rect it can be drawn at, and the ONE place that answers
 * for a block without one: a whole document with no geometry is A3's list and
 * migrates; a straggler beside blocks that have theirs is placed where it
 * fits. A document already laid out comes back untouched, so this is free to
 * stand at every door */
export function laidOut(blocks: readonly Block[], columns: number): Block[] {
  if (blocks.every((b) => b.cell)) return blocks.slice();
  if (blocks.every((b) => !b.cell)) return migrateV1(blocks, columns);
  const items = itemsOf(blocks);
  return blocks.map((b) => {
    if (b.cell) return b;
    const cell = place(items, openingSpan(b, columns), columns);
    items.push({ id: b.id, cell });
    return { ...b, cell };
  });
}

/** how wide the page this document was laid out for is: its own record first
 * (`lastColumns`, written by whatever laid it out), then the layout it
 * actually holds, then the fallback. Advisory all the way down: it decides
 * where a headless write lands and what the outline says, never whether an
 * operation is allowed (LESSONS 5) */
function columnsOfDoc(doc: CanvasDoc | undefined): number {
  if (!doc) return COLUMNS_FALLBACK;
  if (doc.lastColumns && doc.lastColumns > 0) return Math.min(COLUMNS_MAX, doc.lastColumns);
  // capped at the widest grid there is, because `validCell`'s own page test is
  // read from this number: uncapped, the widest block in a document decides
  // what fits on the page and can never fail (a w of 1e9 answering 1e9 columns)
  return Math.min(COLUMNS_MAX, Math.max(rightEdgeOf(doc.blocks), COLUMNS_FALLBACK));
}

/** how wide the layout a document HOLDS is: the furthest right edge any block
 * claims. What a narrowing is measured against, since the count a document
 * last RENDERED at is whatever window was open and re-flowing a layout against
 * a width it never stood at loses the placement the user made (AGENT-UX 16q) */
function rightEdgeOf(blocks: readonly Block[]): number {
  let right = 0;
  for (const b of blocks) {
    // `doc_json` is opaque: this runs before anything has vetted the array
    const edge = b?.cell ? b.cell.x + b.cell.w : 0;
    if (Number.isFinite(edge)) right = Math.max(right, edge);
  }
  return right;
}

// ---- the document on the wire (LESSONS 1: one pair, one test) --------------

/** the document as appdb holds it. Always v2, and always complete: a block
 * that never met a surface is laid out on the way out, so what we emit is what
 * we parse */
export function writeDoc(doc: CanvasDoc): string {
  const columns = columnsOfDoc(doc);
  const out: CanvasDoc = {
    ...doc,
    v: 2,
    blocks: laidOut(doc.blocks, columns),
  };
  return JSON.stringify(out);
}

/** the document, read. `null` is BROKEN and nothing else: unparseable JSON or
 * no blocks array, exactly the two conditions A3 refused to write over. A v1
 * document is not one of them — it migrates (§7), and a migration mistaken for
 * a break would freeze every pre-C2 canvas for good */
export function readDoc(
  json: string,
  columns = COLUMNS_FALLBACK,
): { doc: CanvasDoc; migrated: boolean } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const doc = raw as CanvasDoc | null;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.blocks)) return null;
  if (doc.v !== 2) return { doc: { ...doc, v: 2, blocks: migrateV1(doc.blocks, columns) }, migrated: true };
  // a rect appdb could not have come by honestly (a hand edit, a truncated
  // write, an overlap) loses its cell and is placed; the rest stand as stored
  const wide = columnsOfDoc(doc);
  const items: GridItem[] = [];
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const b of doc.blocks) {
    // two blocks under one id collapse onto one cell in the engine (it keys
    // its answer by id) and onto one React key on the surface, so the second
    // one never stands at all: the duplicate is dropped at the door instead
    if (!b || typeof b !== "object" || seen.has(b.id)) continue;
    seen.add(b.id);
    // `doc_json` is opaque and a hand edit or a truncated write can leave a
    // NaN in a stroke, or no stroke array at all: the ink is read back through
    // its own parser at the same door the cell is, and BEFORE the rect is
    // judged, so one bad stroke costs that stroke and never the canvas
    // (LESSONS 5)
    const block = b.kind === "drawing" ? { ...b, strokes: parseStrokes(b.strokes) } : b;
    const cell = validCell(b.cell, wide);
    if (!cell || items.some((i) => overlaps(i.cell, cell))) {
      blocks.push({ ...block, cell: undefined });
      continue;
    }
    items.push({ id: b.id, cell });
    blocks.push(block);
  }
  return { doc: { ...doc, blocks: laidOut(blocks, wide) }, migrated: false };
}

export const parseDoc = (json: string, columns = COLUMNS_FALLBACK): CanvasDoc | null =>
  readDoc(json, columns)?.doc ?? null;

// ---- the diff -------------------------------------------------------------

export type DiffOutcome = { ok: true; diff: Diff } | { ok: false; message: string };

/** the key separator: a value the database cannot have put inside a label,
 * so two label columns can never collide into one key by accident */
const KEY_SEP = "\u0000";

/** Pair two runs of the same SQL by their label columns. Refusals are truthful
 * and specific: a diff that guesses which row answers which is worse than no
 * diff at all (the columns came back different, the labels do not identify a
 * row, there is nothing numeric to compare). */
export function buildDiff(args: {
  columns: string[];
  aRows: (string | null)[][];
  bColumns: string[];
  bRows: (string | null)[][];
  /** what each side's statement actually produced, which may exceed the rows
   * carried: over the cap the face is one status line */
  aTotal: number;
  bTotal: number;
  a: DiffSide;
  b: DiffSide;
}): DiffOutcome {
  const { columns, aRows, bColumns, bRows } = args;
  if (bColumns.length !== columns.length || bColumns.some((c, i) => c !== columns[i]))
    return { ok: false, message: "the other connection returned different columns" };

  const { labels, numbers } = columnKinds(columns, [...aRows, ...bRows]);
  if (numbers.length === 0)
    return { ok: false, message: "these rows carry no numbers to compare" };
  if (labels.length === 0)
    return { ok: false, message: "these rows carry no labels to pair them by" };

  const shape = {
    labelColumns: labels.map((i) => columns[i]),
    numericColumns: numbers.map((i) => columns[i]),
  };
  if (args.aTotal > DIFF_ROW_CAP || args.bTotal > DIFF_ROW_CAP)
    return { ok: true, diff: { a: args.a, b: args.b, ...shape, rows: [], capped: true } };

  const keyOf = (r: (string | null)[]) => labels.map((i) => r[i] ?? "").join(KEY_SEP);
  const index = (rows: (string | null)[][], side: string) => {
    const m = new Map<string, (string | null)[]>();
    for (const r of rows) {
      const k = keyOf(r);
      if (m.has(k))
        return `the same labels appear on two rows of ${side}, so they can’t be paired`;
      m.set(k, r);
    }
    return m;
  };
  const ai = index(aRows, args.a.name);
  if (typeof ai === "string") return { ok: false, message: ai };
  const bi = index(bRows, args.b.name);
  if (typeof bi === "string") return { ok: false, message: bi };

  const cellsOf = (av: (string | null)[] | null, bv: (string | null)[] | null): DiffCell[] =>
    numbers.map((i) => {
      const a = av ? av[i] ?? null : null;
      const b = bv ? bv[i] ?? null : null;
      if (a === null || b === null) return { a, b, delta: null };
      const an = Number(a);
      const bn = Number(b);
      const delta =
        Number.isFinite(an) && Number.isFinite(bn) && an !== 0 ? ((bn - an) / an) * 100 : null;
      return { a, b, delta };
    });

  // A's order first, then the rows only B has, in B's own order
  const rows: DiffRow[] = aRows.map((r) => {
    const bv = bi.get(keyOf(r)) ?? null;
    return {
      labels: labels.map((i) => r[i] ?? null),
      cells: cellsOf(r, bv),
      only: bv ? null : "a",
    };
  });
  for (const r of bRows) {
    if (ai.has(keyOf(r))) continue;
    rows.push({
      labels: labels.map((i) => r[i] ?? null),
      cells: cellsOf(null, r),
      only: "b",
    });
  }
  return { ok: true, diff: { a: args.a, b: args.b, ...shape, rows, capped: false } };
}

// ---- the store ------------------------------------------------------------

export type AddOutcome =
  | { ok: true; canvasId: string; blockId: string; created: boolean }
  | { ok: false; message: string };

/** One block on its way in from the model, as `src/agent/canvas.tauri.ts`
 * hands it over: the model's INTENT (a statement, a title, a face) with the
 * run it produced beside it. The document turns it into a `Block`, because
 * the status line and the row cap are the document's own (`capRun`) and a
 * second formatter on the tool's side would be one string in two places
 * (DESIGN rule 14). The id and `wroteBy` are the tool's: it minted the id and
 * it knows which exchange it is running for. */
export type ModelBlockInput = (
  | { id: string; kind: "note"; text: string; question?: string; wroteBy: string }
  | {
      id: string;
      kind: "result";
      sql: string;
      run: AgentRun;
      face: BlockFace;
      title?: string;
      note?: string;
      question?: string;
      wroteBy: string;
    }
) &
  // C2: where the model asked for it, already clamped to the column count by
  // the tool (`clampPlace`). Absent is the common case and means `place()`:
  // the canvas finds the first free rectangle in reading order
  ModelPlace;

export type CompareOutcome = { ok: true } | { ok: false; message: string };

interface CanvasState {
  /** by connection, most recently written first */
  canvases: Record<string, CanvasMeta[]>;
  /** by canvas id */
  docs: Record<string, CanvasDoc>;
  loaded: Record<string, boolean>;
  /** by connection: the canvas its tabs were last in. `currentFor` reads it */
  recent: Record<string, string>;
  /** by block id, while its comparison runs */
  comparing: Record<string, boolean>;
  /** the last canvas_upsert failed; persistence never lies (tabs precedent) */
  saveError: boolean;

  load: (profileId: string) => Promise<void>;
  /** the canvas a new block belongs to: the most recent canvas tab of this
   * connection, or null when it has none */
  currentFor: (profileId: string) => string | null;
  /** a new canvas of this connection; the write is debounced like every other */
  create: (profileId: string, title?: string) => string;
  /** append an Ask exchange as one block, opening a canvas when there is none.
   * Synchronous on purpose: the block is the document's the moment it lands,
   * and nothing between the click and the block can be read from a store that
   * has moved on (LESSONS 3) */
  addExchange: (profileId: string, exchange: Exchange) => AddOutcome;
  /** B3, the model's one door in: one canvas tool call's blocks appended in
   * ONE setDoc, at the end or after a named block, so two calls of a turn
   * interleave at CALL granularity and never at block granularity. Returns
   * the ids in order, which is what the tool reports and what the exchange
   * records (LESSONS 13: the count comes from whatever did the applying).
   * Synchronous like `addExchange`: the blocks are the document's the moment
   * they land, and nothing between the call and them can be re-read from a
   * store that has moved on (LESSONS 3) */
  applyModelBlocks: (canvasId: string, blocks: readonly ModelBlockInput[], after?: string) => string[];
  /** B3: one block replaced in place, keeping its position and the `askedFrom`
   * link the old one carried, on the flip's own crossfade. Null when no block
   * of that id stands (the user deleted it meanwhile), which the tool answers
   * with the id it could not find. The new block carries a new id, so the
   * exchange that wrote the old one stops counting it */
  replaceBlock: (canvasId: string, blockId: string, block: ModelBlockInput) => string | null;
  /** B3: the document as it stands, in reading order, for `canvas_read` and
   * for the `CANVAS:` message's outline. The store hands over the facts; the
   * lines the model reads are the tool's own (agent/tools `outlineText`) */
  outline: (canvasId: string) => CanvasOutlineEntry[];
  /** B3: forget everything these exchanges wrote, one setDoc per canvas that
   * changed. The cut's own act (a Restart from an older exchange, a send from
   * edit mode): the blocks belong to the exchanges that are going, and a
   * block with no `wroteBy` is the document's own and is never touched */
  removeByExchange: (exchangeIds: readonly string[]) => void;
  /** B3: the exchange's assumptions, once the verdict has parsed them, onto
   * the FIRST result block it wrote and no other. An assumption belongs to
   * the EXCHANGE, so the same labels under four blocks would be one fact in
   * four slots (DESIGN rule 14), and a note has no status line to carry them.
   * Not a field the model writes: one more thing it could get wrong, for a
   * fact the loop already extracts (canvas-agent-spec 2.7) */
  assumeOn: (exchangeId: string, labels: readonly string[]) => void;
  /** B3: this exchange is about to be asked again, so its FIRST write clears
   * what its previous attempt wrote. Marked rather than deleted, and consumed
   * by that write: a re-run that fails, is refused or is cancelled before
   * writing anything leaves the blocks that stand exactly where they are
   * (canvas-agent-spec 2.4 rule 2) */
  clearOnNextWrite: (exchangeId: string) => void;
  addNote: (canvasId: string, text: string, at?: number) => string;
  /** C2b: a sheet, at the end of the document. The palette's `New Drawing` and
   * a click on the empty grid are its two doors; the MODEL has neither, because
   * a drawing is a person's hand and `tools.schema.json`'s union does not move
   * (canvas-grid 3.1) */
  addDrawing: (canvasId: string, at?: number) => string;
  /** C2b: one stroke lands, or the picker's memory moves. ONE setDoc per
   * stroke and never one per pointer move, the rule every gesture on this page
   * follows: a stroke lands whole and the 400 ms debounce is written for it */
  updateDrawing: (
    canvasId: string,
    blockId: string,
    patch: { strokes?: Stroke[]; ink?: number; weight?: number; tool?: DrawTool },
  ) => void;
  /** C2b: one drawing's ink as a PNG, or null when that block is not a
   * drawing or holds none. ONE renderer for both doors: the `Ask` button
   * beside the element and `canvas_read({ block_id })` from a model read the
   * same picture, so what a person attaches and what the bridge sends can
   * never be two different drawings (LESSONS 13). The document owns the
   * strokes, which is why this stands here and not on the surface. */
  drawingImage: (
    canvasId: string,
    blockId: string,
  ) => Promise<{ mime: "image/png"; b64: string } | null>;
  /** commit an edited note; empty text deletes it (the fold precedent: the
   * preview is the commit) */
  updateNote: (canvasId: string, blockId: string, text: string) => void;
  remove: (canvasId: string, blockId: string) => void;
  /** move a block one ROW up (-1) or down (+1), the menu's own act on a grid:
   * the same `moveTo` a drag ends in, so the two routes share one algorithm
   * (the rows below make way and the layout floats up) */
  move: (canvasId: string, blockId: string, delta: 1 | -1) => void;
  /** C2, a gesture's END: the element is pinned where it was dropped, what it
   * overlaps is pushed down, the layout floats up. ONE setDoc, never one per
   * pointer move: a block lands whole, and the 400 ms debounce is written for
   * exactly that */
  moveTo: (canvasId: string, blockId: string, to: { x: number; y: number }, columns: number) => void;
  /** C2: the same commit with a new span, held at the kind's own floor. A hand
   * resize clears `autoH` (the height is the user's now); `auto` is the
   * surface's own measure of a note and keeps it */
  resizeTo: (
    canvasId: string,
    blockId: string,
    span: Span,
    columns: number,
    opts?: { auto?: boolean },
  ) => void;
  /** C2: the page is this many columns wide now. Wider than the layout was
   * stored at, the stored layout stands (empty columns at the right until
   * something is moved there); NARROWER, a derived layout is computed in
   * reading order, is never written to appdb, and the stored one comes back
   * whole when the window does. The user's first change at a derived count
   * commits it, which is the only way it ever becomes the document */
  reflowTo: (canvasId: string, columns: number) => void;
  /** C2: record the count the page stands at, for the model's outline. In
   * memory: a read is not an edit */
  setColumns: (canvasId: string, columns: number) => void;
  /** C2: how wide this canvas is laid out, for a door with no surface to ask
   * (the model's write, a block added from Ask while the tab is closed). Its
   * own record first, then the layout it actually holds, then the fallback:
   * advisory all the way down, and a refusal nowhere (LESSONS 5) */
  columnsOf: (canvasId: string) => number;
  setFace: (canvasId: string, blockId: string, face: BlockFace) => void;
  /** the one flip glyph: the next face in the cycle this block actually has */
  flip: (canvasId: string, blockId: string) => void;
  /** run this block's SQL read-only on a sibling connection and keep the diff */
  compare: (canvasId: string, blockId: string, profileB: string) => Promise<CompareOutcome>;
  clearCompare: (canvasId: string, blockId: string) => void;
  /** the note being edited in place, if any. The edit itself is the UI's; the
   * id lives here because the palette's `New Note` is a keyboard route into
   * edit mode from outside the canvas component (A3 item 6) */
  editing: string | null;
  beginEdit: (blockId: string) => void;
  endEdit: () => void;
  /** an Ask turn was opened from a block: its reply lands under that block.
   * Session memory, by exchange id */
  askedFrom: Record<string, { canvasId: string; blockId: string }>;
  /** the pane's own call once the exchange exists: the block is named by its
   * id alone and the canvas holding it is resolved here, so the Ask side never
   * has to carry a canvas id it does not otherwise need. An id no canvas holds
   * records nothing (a stale link is worse than none) */
  noteAskedFrom: (exchangeId: string, blockId: string) => void;
  rename: (canvasId: string, title: string) => void;
  deleteCanvas: (canvasId: string) => Promise<void>;
  /** the palette's `New Canvas`: a canvas of the active connection, and you go
   * there (unlike Add to Canvas, which leaves the pane where it is) */
  newCanvas: () => void;
  /** B3: the one canvas a QUESTION can cause. A question carrying the word
   * "canvas" on a connection that has none gets one: the document is created
   * and its tab opens BESIDE the user's without taking focus, so the reader
   * stays where they are while the answer lands where it was sent, and the
   * caller prefixes the question's own pill and cues `New canvas`. The MODEL
   * never creates a canvas: it has no tool for one and no canvas id to name
   * (canvas-agent-spec 1.1, 3.2). A Send is the press, the same consent Add
   * to Canvas has always asked for */
  openForQuestion: (profileId: string) => { canvasId: string; title: string };
  /** the palette's `New Note`: the keyboard route onto an empty canvas, whose
   * only other door is a click on the card (A3 item 6) */
  newNote: () => void;
  /** C2b: the palette's `New Drawing`, the same route for a sheet. A drawing
   * has no words to begin with, so it lands armed and empty rather than in an
   * edit: the sheet IS the edit */
  newDrawing: () => void;
}

const metaOf = (s: CanvasState, canvasId: string): CanvasMeta | null => {
  for (const list of Object.values(s.canvases)) {
    const hit = list.find((c) => c.id === canvasId);
    if (hit) return hit;
  }
  return null;
};

/** the canvas holding a block, resolved from the block id alone. The pairing
 * a reply lands under is recorded on the EXCHANGE (`askedFrom`, a block id and
 * nothing more: `Ask` on a block presses before any exchange exists, so a map
 * keyed by exchange id cannot be filled at that moment), and the Ask side has
 * no canvas id to carry, so the document that holds it is found here. An id no
 * canvas holds records nothing: a stale link is worse than none */
function holderOf(s: CanvasState, blockId: string | undefined): { canvasId: string; blockId: string } | null {
  if (!blockId) return null;
  const hit = Object.entries(s.docs).find(([, d]) => d.blocks.some((b) => b.id === blockId));
  return hit ? { canvasId: hit[0], blockId } : null;
}

/** the connection's siblings, the ones a comparison can run on: every other
 * saved connection, in the rail's own order. The picker is the UI's; the list
 * is the store's so both halves agree on what a sibling is. */
export function compareTargets(profileId: string): { id: string; name: string }[] {
  return useConnections
    .getState()
    .profiles.filter((p) => p.id !== profileId)
    .map((p) => ({ id: p.id, name: p.name }));
}

const titleOf = (canvasId: string): string =>
  metaOf(useCanvas.getState(), canvasId)?.title ?? DEFAULT_CANVAS_TITLE;

const nameOf = (profileId: string): string =>
  useConnections.getState().profiles.find((p) => p.id === profileId)?.name ?? profileId;

/** `readDoc`, with the one promise its own doc comment makes: null is broken
 * and nothing else, a throw included */
function readSafely(json: string, canvasId: string): { doc: CanvasDoc; migrated: boolean } | null {
  try {
    return readDoc(json);
  } catch (e) {
    console.error("canvas doc did not read", canvasId, e);
    return null;
  }
}

function firstLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.split("\n")[0].trim() || "the comparison failed";
}

export const useCanvas = create<CanvasState>((set, get) => ({
  canvases: {},
  docs: {},
  loaded: {},
  recent: {},
  comparing: {},
  saveError: false,
  editing: null,
  askedFrom: {},

  beginEdit: (blockId) => set({ editing: blockId }),
  endEdit: () => set({ editing: null }),

  load: async (profileId) => {
    if (get().loaded[profileId]) return;
    try {
      const rows = await canvasList(profileId);
      const metas: CanvasMeta[] = [];
      const docs: Record<string, CanvasDoc> = {};
      for (const r of rows) {
        // the read is the one thing here that touches a stranger's JSON, so it
        // is the one thing wrapped: a block the reader cannot make sense of
        // marks ITS canvas broken (the mechanism two lines down), where a
        // throw took the profile's whole list, the `broken` flag and the
        // `loaded` mark with it and left load retrying for ever
        const read = readSafely(r.doc_json, r.id);
        // a canvas we could not read is listed and never written to: an
        // overwrite would turn an unreadable document into a deleted one. A v1
        // document is NOT one of those: it read perfectly, it is A3's list, and
        // it migrates (a migration mistaken for a break freezes every pre-C2
        // canvas for good)
        metas.push({
          id: r.id,
          profileId: r.profile_id,
          title: r.title,
          updatedAt: r.updated_at,
          ...(read ? null : { broken: true }),
        });
        if (!read) {
          console.error("canvas doc did not parse", r.id);
          continue;
        }
        // the migration stands in memory until the user's own first change:
        // nothing here schedules a write, and `save` only ever writes what a
        // change has scheduled
        docs[r.id] = read.doc;
        native.delete(r.id);
      }
      set((s) => ({
        canvases: { ...s.canvases, [profileId]: metas },
        docs: { ...s.docs, ...docs },
        loaded: { ...s.loaded, [profileId]: true },
      }));
    } catch (e) {
      console.error("canvas_list failed", e);
      set({ saveError: true });
    }
  },

  currentFor: (profileId) => {
    // whose canvas a tab shows is the DOCUMENT's fact, read from the canvas
    // list, never from the tab's own `profile_id`: a tab is stamped with
    // whatever connection was active when it opened, and Add to Canvas lands
    // on the EXCHANGE's connection, which is not always that one (LESSONS 4).
    // Reading the tab's copy made every add open a second canvas whenever the
    // two differed, and cue `Added to a new canvas` every time
    const mine = new Set((get().canvases[profileId] ?? []).map((c) => c.id));
    const own = useTabs
      .getState()
      .tabs.filter((t) => t.kind === "canvas" && t.canvas_id && mine.has(t.canvas_id));
    if (own.length === 0) return null;
    const recent = get().recent[profileId];
    const hit = recent ? own.find((t) => t.canvas_id === recent) : undefined;
    return (hit ?? own[own.length - 1]).canvas_id;
  },

  create: (profileId, title) => {
    const taken = new Set((get().canvases[profileId] ?? []).map((c) => c.title));
    let name = title ?? DEFAULT_CANVAS_TITLE;
    if (!title) for (let n = 2; taken.has(name); n++) name = `${DEFAULT_CANVAS_TITLE} ${n}`;
    const id = crypto.randomUUID();
    const doc: CanvasDoc = { v: 2, blocks: [] };
    set((s) => ({
      canvases: {
        ...s.canvases,
        [profileId]: [
          { id, profileId, title: name, updatedAt: "" },
          ...(s.canvases[profileId] ?? []),
        ],
      },
      docs: { ...s.docs, [id]: doc },
      recent: { ...s.recent, [profileId]: id },
    }));
    persist(id);
    return id;
  },

  addExchange: (profileId, ex) => {
    const block = blockOf(ex);
    if (!block) return { ok: false, message: "there is nothing to add yet" };
    // an Ask opened from a block lands its reply under that block, on that
    // block's own canvas: the provenance is the document's, not the strip's
    const from = get().askedFrom[ex.id] ?? holderOf(get(), ex.askedFrom);
    const fromDoc = from ? get().docs[from.canvasId] : undefined;
    const at = fromDoc?.blocks.findIndex((b) => b.id === from!.blockId) ?? -1;
    if (from && fromDoc && at >= 0) {
      block.askedFrom = from.blockId;
      insert(from.canvasId, block, at + 1, fromDoc.blocks[at].cell);
      // the canvas the question came from may have been closed since; the
      // reply still belongs under its block, so the tab comes back with it
      useTabs.getState().openCanvasTab(from.canvasId, titleOf(from.canvasId), false);
      set((s) => ({ recent: { ...s.recent, [profileId]: from.canvasId } }));
      return { ok: true, canvasId: from.canvasId, blockId: block.id, created: false };
    }
    let canvasId = get().currentFor(profileId);
    let created = false;
    if (!canvasId) {
      canvasId = get().create(profileId);
      // the canvas gets its tab so it is reachable, but the pane keeps the
      // conversation: Add to Canvas never switches tabs (A3 item 3)
      useTabs.getState().openCanvasTab(canvasId, titleOf(canvasId), false);
      created = true;
    }
    insert(canvasId, block, get().docs[canvasId]?.blocks.length ?? 0);
    set((s) => ({ recent: { ...s.recent, [profileId]: canvasId } }));
    return { ok: true, canvasId, blockId: block.id, created };
  },

  applyModelBlocks: (canvasId, blocks, after) => {
    // the document is read ONCE here and every block lands in that one array
    // (LESSONS 3): a call's blocks are contiguous or absent, never woven
    // through another call's
    const doc = get().docs[canvasId];
    if (!doc || blocks.length === 0) return [];
    const columns = columnsOfDoc(doc);
    const kept = laidOut(cleared(doc.blocks, blocks[0].wroteBy), columns);
    const at = after ? kept.findIndex((b) => b.id === after) : -1;
    const made = blocks.map(blockFromModel);
    // the model's OWN places go down first, in the order it asked for them, so
    // a block it placed never loses its cells to one it left to the canvas
    const asked = made.map((_, i) => i).filter((i) => blocks[i].at);
    const free = made.map((_, i) => i).filter((i) => !blocks[i].at);
    let items = itemsOf(kept);
    for (const i of [...asked, ...free]) {
      const id = made[i].id;
      const span = askedSpan(made[i], blocks[i].span, columns);
      const ask = blocks[i].at;
      if (!ask) {
        items = [...items, { id, cell: place(items, span, columns) }];
        continue;
      }
      // a cell it named is honoured whether or not something stands there: what
      // does is pushed down, so a taken place is a layout and never a refusal
      const cell = cornerAt(ask, span, columns);
      items = pinAt([...items, { id, cell }], id, cell, columns);
    }
    const cells = new Map(items.map((i) => [i.id, i.cell]));
    const landed = made.map((b) => ({ ...b, cell: cells.get(b.id) }));
    const held = kept.map((b) => {
      const cell = cells.get(b.id);
      return cell && b.cell && !sameCell(cell, b.cell) ? { ...b, cell } : b;
    });
    const put = at >= 0 ? at + 1 : held.length;
    setDoc(canvasId, {
      blocks: [...held.slice(0, put), ...landed, ...held.slice(put)],
      lastColumns: columns,
    });
    return landed.map((b) => b.id);
  },

  replaceBlock: (canvasId, blockId, block) => {
    const doc = get().docs[canvasId];
    if (!doc) return null;
    const kept = cleared(doc.blocks, block.wroteBy);
    const at = kept.findIndex((b) => b.id === blockId);
    if (at < 0) {
      // the clear still stands: a re-run whose first act is a replace of a
      // block the user deleted has still started over
      if (kept.length !== doc.blocks.length) setDoc(canvasId, { blocks: kept });
      return null;
    }
    const old = kept[at];
    // the new block takes the old one's PLACE and its provenance link, so a
    // reply still stands under the block it answered (A3 item 4). A face never
    // changes a span and neither does a replacement: only an `at` or a `span`
    // the model wrote moves it, and the engine resolves what it lands on
    const made = blockFromModel(block);
    const columns = columnsOfDoc(doc);
    const blocks = [...kept];
    blocks[at] = {
      ...made,
      cell: old.cell,
      ...(old.askedFrom ? { askedFrom: old.askedFrom } : null),
    };
    const laid = laidOut(blocks, columns);
    const held = laid[at].cell as Cell;
    const span = block.span ? askedSpan(made, block.span, columns) : { w: held.w, h: held.h };
    const to = block.at ? cornerAt(block.at, span, columns) : { ...held, ...span };
    const cells = new Map(pinAt(itemsOf(laid), made.id, to, columns).map((i) => [i.id, i.cell]));
    setDoc(canvasId, {
      blocks: laid.map((b) => {
        const cell = cells.get(b.id);
        return cell && b.cell && !sameCell(cell, b.cell) ? { ...b, cell } : b;
      }),
      lastColumns: columns,
    });
    // the block that stood here is gone: its name goes back to plain text and
    // the exchange that wrote it stops counting it
    useAsk.getState().forgetBlock(old.id);
    useAgent.getState().forgetCanvasBlocks([old.id]);
    return made.id;
  },

  outline: (canvasId) =>
    (get().docs[canvasId]?.blocks ?? []).map((b) => ({
      id: b.id,
      kind: b.kind,
      // the line the outline ellipsizes: a result's own title line, a note's
      // first words. The model wrote one of the two and reads back what the
      // document holds, never what it sent (LESSONS 13)
      line: outlineLineOf(b),
      modelWritten: b.wroteBy !== undefined,
      // C2: the cell the block actually stands on, read straight off the
      // document. A canvas no surface has laid out yet has none, and the
      // outline then says nothing about geometry rather than guessing
      ...(b.cell ? { cell: b.cell } : null),
      ...(b.kind === "result"
        ? { rows: b.rows.length, columns: b.columns, face: faceForModel(b) }
        : null),
    })),

  removeByExchange: (exchangeIds) => {
    const doomed = new Set(exchangeIds);
    if (doomed.size === 0) return;
    for (const id of doomed) pendingClear.delete(id);
    // one setDoc per canvas that changed, never one per block: the whole
    // document is one write (DECISIONS, A3), so a cut of four blocks across
    // two canvases is two writes and not four
    for (const [canvasId, doc] of Object.entries(get().docs)) {
      const gone = doc.blocks.filter((b) => b.wroteBy !== undefined && doomed.has(b.wroteBy));
      if (gone.length === 0) continue;
      // by ID, never by reference: laying the page out first hands back blocks
      // that are new objects, and a cut that compared them would remove nothing
      const cut = new Set(gone.map((b) => b.id));
      const columns = columnsOfDoc(doc);
      setDoc(canvasId, {
        blocks: compacted(laidOut(doc.blocks, columns).filter((b) => !cut.has(b.id)), columns),
        lastColumns: columns,
      });
      for (const b of gone) useAsk.getState().forgetBlock(b.id);
    }
  },

  assumeOn: (exchangeId, labels) => {
    for (const [canvasId, doc] of Object.entries(get().docs)) {
      const first = doc.blocks.find((b) => b.kind === "result" && b.wroteBy === exchangeId);
      if (!first) continue;
      patch(canvasId, first.id, (b) =>
        b.kind === "result" ? { ...b, chips: [...labels] } : b,
      );
      return;
    }
  },

  clearOnNextWrite: (exchangeId) => void pendingClear.add(exchangeId),

  addNote: (canvasId, text, at) => {
    // `autoH`: a note's height is its own words' until a hand says otherwise
    const block: NoteBlock = { id: crypto.randomUUID(), kind: "note", text, autoH: true };
    insert(canvasId, block, at ?? get().docs[canvasId]?.blocks.length ?? 0);
    return block.id;
  },

  addDrawing: (canvasId, at) => {
    const block: DrawingBlock = { id: crypto.randomUUID(), kind: "drawing", strokes: [] };
    insert(canvasId, block, at ?? get().docs[canvasId]?.blocks.length ?? 0);
    return block.id;
  },

  updateDrawing: (canvasId, blockId, next) => {
    patch(canvasId, blockId, (b) =>
      b.kind !== "drawing"
        ? b
        : {
            ...b,
            // the canonical form goes in, so what the element holds and what
            // appdb holds are the same array and a reload draws the same ink
            // (LESSONS 1)
            ...(next.strokes ? { strokes: writeStrokes(next.strokes) } : null),
            ...(next.ink !== undefined ? { ink: next.ink } : null),
            ...(next.weight !== undefined ? { weight: next.weight } : null),
            ...(next.tool !== undefined ? { tool: next.tool } : null),
          },
    );
  },

  drawingImage: async (canvasId, blockId) => {
    const block = get().docs[canvasId]?.blocks.find((b) => b.id === blockId);
    // not a drawing, or a sheet nobody has written on: the block's own line
    // already says it is empty and a picture of nothing says it again
    if (!block || block.kind !== "drawing" || block.strokes.length === 0) return null;
    if (typeof document === "undefined") return null;
    // the element as it STANDS is the truth when it stands: the sheet knows
    // the paper it was given. A canvas in a tab nobody opened has no element,
    // and then the box is the span the document holds, measured against the
    // BASE cell — the same measure `minSpanFor` reads the ink against, so a
    // picture made with no tab open frames exactly what a tab would open on
    const sheet = document.querySelector<SVGSVGElement>(
      `[data-block="${CSS.escape(blockId)}"] .dw-sheet`,
    );
    const host: Element = sheet ?? document.documentElement;
    // a sheet that measures ZERO on either axis is a sheet whose box has not
    // resolved (the bug this wave's frames caught: an element wrapper with no
    // height collapsed `flex: 1 1 0` and clipped every stroke away). It falls
    // back to the span rather than sending the model an empty picture, which
    // is the one failure of this door that would look like an answer
    const live = sheet && sheet.clientWidth > 0 && sheet.clientHeight > 0 ? sheet : null;
    const box = live
      ? { w: live.clientWidth, h: live.clientHeight }
      : boxOf(block.cell ?? DEFAULT_SPAN.drawing);
    const blob = await toPng(block.strokes, box, inkPalette(host), paperColour(host));
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("the drawing could not be read"));
      reader.readAsDataURL(blob);
    });
    return { mime: "image/png", b64: url.slice(url.indexOf(",") + 1) };
  },

  updateNote: (canvasId, blockId, text) => {
    // a note emptied in edit deletes itself on commit
    if (text.trim() === "") return get().remove(canvasId, blockId);
    patch(canvasId, blockId, (b) => (b.kind === "note" ? { ...b, text } : b));
  },

  remove: (canvasId, blockId) => {
    const doc = get().docs[canvasId];
    if (!doc || !doc.blocks.some((b) => b.id === blockId)) return;
    const columns = columnsOfDoc(doc);
    setDoc(canvasId, {
      blocks: compacted(laidOut(doc.blocks, columns).filter((b) => b.id !== blockId), columns),
      lastColumns: columns,
    });
    // a block that is gone stops resolving: its name in an older bubble goes
    // back to plain text and the question still runs (LESSONS 5)
    useAsk.getState().forgetBlock(blockId);
    // deleting by hand is the document's act and leaves the exchange standing
    // (canvas-agent 3.5); its status line then reads the number that REMAINS,
    // because the count is the blocks the store still holds and never the
    // model's own tally of what it meant to write (LESSONS 13)
    useAgent.getState().forgetCanvasBlocks([blockId]);
  },

  move: (canvasId, blockId, delta) => {
    const doc = get().docs[canvasId];
    const columns = columnsOfDoc(doc);
    const block = laidOut(doc?.blocks ?? [], columns).find((b) => b.id === blockId);
    const cell = block?.cell;
    if (!cell) return;
    const y = cell.y + delta;
    if (y < 0) return;
    get().moveTo(canvasId, blockId, { x: cell.x, y }, columns);
  },

  moveTo: (canvasId, blockId, to, columns) => {
    commitLayout(canvasId, columns, (items) => moveCells(items, blockId, to, columns), { user: true });
  },

  resizeTo: (canvasId, blockId, span, columns, opts) => {
    const doc = get().docs[canvasId];
    const block = doc?.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const min = minSpanFor(block);
    const want: Span = {
      w: Math.min(Math.max(span.w, Math.min(min.w, columns)), Math.max(1, columns)),
      h: Math.max(span.h, min.h),
    };
    commitLayout(canvasId, columns, (items) => resizeCells(items, blockId, want, columns), {
      // the surface measuring a note is the DOCUMENT following its own content,
      // not a hand on the corner: it keeps `autoH` and it does not commit a
      // migration or a derived layout on its own (§2.3, §4.6)
      user: !opts?.auto,
      clearAutoH: opts?.auto ? undefined : blockId,
    });
  },

  reflowTo: (canvasId, columns) => {
    const doc = get().docs[canvasId];
    if (!doc || !Number.isFinite(columns) || columns < 1) return;
    const held = native.get(canvasId);
    // what a narrowing is measured against is the LAYOUT's own right edge, not
    // the count the document last rendered at: `lastColumns` is raised by every
    // wider window that opens it, so reading it re-flowed a 7-column layout at
    // 7 the moment the reader had once seen it at 10 (AGENT-UX 16q)
    let from = held;
    if (!from) {
      const laid = laidOut(doc.blocks, columnsOfDoc(doc));
      from = { columns: Math.max(1, rightEdgeOf(laid)), blocks: laid };
    }
    if (columns >= from.columns) {
      // the window came back: the stored layout returns intact, and a document
      // that was never narrowed simply records the count
      native.delete(canvasId);
      if (!held) return get().setColumns(canvasId, columns);
      return setDoc(canvasId, { blocks: from.blocks, lastColumns: columns }, { persist: false });
    }
    if (!held) native.set(canvasId, from);
    const flowed = new Map(reflowCells(itemsOf(from.blocks), columns).map((i) => [i.id, i.cell]));
    // the derived layout is compared against the page as it STANDS, and a
    // block the flow lands where it already is keeps its object: a window drag
    // inside one column band is two custom-property writes and no React render
    // at a derived width as well as at a stored one (spec 6.3, AGENT-UX 16r)
    const standing = new Map(doc.blocks.map((b) => [b.id, b]));
    const blocks = from.blocks.map((b) => {
      const cell = flowed.get(b.id);
      if (!cell || !b.cell || sameCell(cell, b.cell)) return b;
      const now = standing.get(b.id);
      return now?.cell && sameCell(now.cell, cell) ? now : { ...b, cell };
    });
    const settled =
      doc.lastColumns === columns &&
      blocks.length === doc.blocks.length &&
      blocks.every((b, i) => b === doc.blocks[i]);
    if (settled) return;
    setDoc(canvasId, { blocks, lastColumns: columns }, { persist: false });
  },

  setColumns: (canvasId, columns) => {
    const doc = get().docs[canvasId];
    if (!doc || !Number.isFinite(columns) || columns < 1 || doc.lastColumns === columns) return;
    setDoc(canvasId, { blocks: doc.blocks, lastColumns: columns }, { persist: false });
  },

  columnsOf: (canvasId) => columnsOfDoc(get().docs[canvasId]),

  setFace: (canvasId, blockId, face) => {
    patch(canvasId, blockId, (b) =>
      b.kind === "result" && facesOf(b).includes(face) ? { ...b, face } : b,
    );
  },

  flip: (canvasId, blockId) => {
    patch(canvasId, blockId, (b) => {
      if (b.kind !== "result") return b;
      const faces = facesOf(b);
      if (faces.length < 2) return b;
      const at = faces.indexOf(b.face);
      return { ...b, face: faces[(at + 1) % faces.length] };
    });
  },

  compare: async (canvasId, blockId, profileB) => {
    // everything the run needs is read BEFORE the first await (LESSONS 3):
    // the block may be deleted, and the active connection changed, while a
    // query runs on a database that is not this window's
    const block = get().docs[canvasId]?.blocks.find((b) => b.id === blockId);
    if (!block || block.kind !== "result" || !block.sql)
      return { ok: false, message: "this block has no query to compare" };
    const meta = metaOf(get(), canvasId);
    if (!meta) return { ok: false, message: "this canvas is gone" };
    const sql = block.sql;
    const a: DiffSide = { profileId: meta.profileId, name: nameOf(meta.profileId), ms: block.ms };
    const b: DiffSide = { profileId: profileB, name: nameOf(profileB), ms: 0 };
    const columns = block.columns;
    const aRows = block.rows;
    const secs = useSettings.getState().statementTimeoutSecs;
    const timeoutMs = secs > 0 ? secs * 1000 : RUN_SQL_TIMEOUT_MS;

    set((s) => ({ comparing: { ...s.comparing, [blockId]: true } }));
    let session: string | null = null;
    try {
      // agent_connect starts read-only at the SERVER whatever the profile's
      // prod flag says (AGENT-SPEC 8.1), and the AST gate refuses anything but
      // a SELECT, so a production sibling is a legal target: nothing writes
      session = await agentConnect(profileB);
      const run = await agentRunReadonly(session, sql, DIFF_ROW_CAP + 1, timeoutMs);
      const built = buildDiff({
        columns,
        aRows,
        bColumns: run.columns,
        bRows: run.rows,
        aTotal: aRows.length,
        bTotal: run.row_count,
        a,
        b: { ...b, ms: run.ms },
      });
      if (!built.ok) return built;
      const diff = built.diff;
      patch(canvasId, blockId, (blk) =>
        blk.kind === "result" ? { ...blk, diff, face: "diff" } : blk,
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, message: firstLine(e) };
    } finally {
      set((s) => ({ comparing: without(s.comparing, blockId) }));
      if (session) void disconnect(session).catch(() => {});
    }
  },

  clearCompare: (canvasId, blockId) => {
    patch(canvasId, blockId, (b) => {
      if (b.kind !== "result" || !b.diff) return b;
      const { diff: _gone, ...rest } = b;
      // the diff stood in the table's place; the table is what it goes back to
      return { ...rest, face: b.face === "diff" ? "table" : b.face };
    });
  },

  noteAskedFrom: (exchangeId, blockId) => {
    const from = holderOf(get(), blockId);
    if (!from) return;
    set((s) => ({ askedFrom: { ...s.askedFrom, [exchangeId]: from } }));
  },

  rename: (canvasId, title) => {
    set((s) => ({ canvases: mapMeta(s.canvases, canvasId, (m) => ({ ...m, title })) }));
    // the tab is named by its document: one fact, one slot (DESIGN rule 14)
    const tab = useTabs.getState().tabs.find((t) => t.canvas_id === canvasId);
    if (tab) useTabs.getState().rename(tab.id, title);
    persist(canvasId);
  },

  newCanvas: () => {
    const pid = useConnections.getState().activeProfileId;
    if (!pid) return;
    const id = get().create(pid);
    useTabs.getState().openCanvasTab(id, titleOf(id), true);
  },

  openForQuestion: (profileId) => {
    const canvasId = get().create(profileId);
    const title = titleOf(canvasId);
    useTabs.getState().openCanvasTab(canvasId, title, false);
    return { canvasId, title };
  },

  newNote: () => {
    const pid = useConnections.getState().activeProfileId;
    if (!pid) return;
    let id = get().currentFor(pid);
    if (!id) {
      id = get().create(pid);
      useTabs.getState().openCanvasTab(id, titleOf(id), true);
    }
    // the empty note IS the edit: committing it empty takes it away again
    get().beginEdit(get().addNote(id, ""));
  },

  newDrawing: () => {
    const pid = useConnections.getState().activeProfileId;
    if (!pid) return;
    let id = get().currentFor(pid);
    if (!id) {
      id = get().create(pid);
      useTabs.getState().openCanvasTab(id, titleOf(id), true);
    }
    // an empty sheet STANDS where an empty note leaves: paper is a place to
    // draw and the element says so (drawing.css data-empty), where an empty
    // note is a caret and nothing at all
    get().addDrawing(id);
  },

  deleteCanvas: async (canvasId) => {
    const doomed = get().docs[canvasId]?.blocks ?? [];
    useRecents.getState().forget(metaOf(get(), canvasId)?.profileId, "canvas", canvasId); // B2 `Recent`
    // the tab goes with the document, here and in appdb (canvas_delete
    // unbinds the row): a tab whose canvas is gone would restore onto nothing
    const tab = useTabs.getState().tabs.find((t) => t.canvas_id === canvasId);
    if (tab) useTabs.getState().closeTab(tab.id);
    // closeTab remembers what it closed for the reopen stack; a deleted
    // canvas must not come back on the next chord pointing at nothing
    useTabs.setState((t) => ({
      closedStack: t.closedStack.filter((c) => c.canvas_id !== canvasId),
    }));
    set((s) => ({
      canvases: Object.fromEntries(
        Object.entries(s.canvases).map(([pid, list]) => [pid, list.filter((c) => c.id !== canvasId)]),
      ),
      docs: without(s.docs, canvasId),
      recent: Object.fromEntries(
        Object.entries(s.recent).filter(([, id]) => id !== canvasId),
      ),
    }));
    clearTimer(canvasId);
    native.delete(canvasId);
    for (const b of doomed) useAsk.getState().forgetBlock(b.id);
    useAgent.getState().forgetCanvasBlocks(doomed.map((b) => b.id));
    try {
      await canvasDelete(canvasId);
    } catch (e) {
      console.error("canvas_delete failed", e);
      set({ saveError: true });
    }
  },
}));

// ---- document edits -------------------------------------------------------

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = rec;
  return rest;
}

function mapMeta(
  canvases: Record<string, CanvasMeta[]>,
  canvasId: string,
  f: (m: CanvasMeta) => CanvasMeta,
): Record<string, CanvasMeta[]> {
  return Object.fromEntries(
    Object.entries(canvases).map(([pid, list]) => [
      pid,
      list.map((c) => (c.id === canvasId ? f(c) : c)),
    ]),
  );
}

/** the STORED layout, kept aside while a narrower window renders a derived one
 * (canvas-grid 4.6): a derived layout is never written to appdb, and the layout
 * the user made returns whole when the window does. A change at the derived
 * count commits it and the entry goes, which is what makes an edit an edit. */
const native = new Map<string, { columns: number; blocks: Block[] }>();

function setDoc(
  canvasId: string,
  doc: Partial<CanvasDoc> & { blocks: Block[] },
  opts?: { persist?: boolean },
): void {
  const write = opts?.persist !== false;
  // a write is a change, and a change is the document: a derived flow and the
  // migration's rows both stop being provisional here
  if (write) native.delete(canvasId);
  useCanvas.setState((s) => ({
    docs: { ...s.docs, [canvasId]: { ...s.docs[canvasId], ...doc, v: 2 } },
  }));
  if (write) persist(canvasId);
}

/** one layout commit, whatever the gesture was: the engine decides, the
 * document records, and appdb hears about it ONCE. Never per pointer move: a
 * block lands whole, which is the sentence the 400 ms debounce is written for */
function commitLayout(
  canvasId: string,
  columns: number,
  run: (items: GridItem[]) => GridItem[],
  opts: { user: boolean; clearAutoH?: string },
): void {
  const doc = useCanvas.getState().docs[canvasId];
  if (!doc || !Number.isFinite(columns) || columns < 1) return;
  const laid = laidOut(doc.blocks, columns);
  const at = new Map(run(itemsOf(laid)).map((i) => [i.id, i.cell]));
  let changed = laid.some((b, i) => b !== doc.blocks[i]);
  const blocks = laid.map((b) => {
    const cell = at.get(b.id) ?? b.cell;
    const clear = opts.clearAutoH === b.id && b.autoH === true;
    if (!cell) return b;
    if (!clear && b.cell && sameCell(cell, b.cell)) return b;
    changed = true;
    // the height is the user's now, and the surface stops measuring for it
    return clear ? { ...b, cell, autoH: undefined } : { ...b, cell };
  });
  if (!changed) return;
  // a layout the DOCUMENT made for itself (a note measuring its own words, a
  // narrower window) stands in memory and rides the next change out: opening a
  // canvas must never look like editing one
  setDoc(canvasId, { blocks, lastColumns: columns }, { persist: opts.user });
}

/** land one element on the cells it was given: pinned there, whatever it
 * overlaps pushed down, the layout floated up. The drop's own rule, so a
 * model's `at` and a hand's release resolve a collision the same way */
function pinAt(items: readonly GridItem[], id: string, cell: Cell, columns: number): GridItem[] {
  const others = items.filter((i) => i.id !== id);
  return moveCells([...others, { id, cell }], id, { x: cell.x, y: cell.y }, columns);
}

/** a place for a block on a page this wide: the corner asked for, held inside
 * the grid. `y` is never capped, because the canvas grows DOWN */
const cornerAt = (at: { x: number; y: number }, span: Span, columns: number): Cell => ({
  x: Math.min(Math.max(0, Math.floor(at.x) || 0), Math.max(0, columns - span.w)),
  y: Math.max(0, Math.floor(at.y) || 0),
  ...span,
});

/** the span the model asked for, as the canvas can hold it: never wider than
 * the page, never under the kind's floor. Not a refusal - the statement was
 * good and only the guess was wrong, and the tool says what it gave instead
 * (canvas-grid-spec 2.6, `faceFor`'s own shape) */
function askedSpan(block: Block, span: Span | undefined, columns: number): Span {
  if (!span) return openingSpan(block, columns);
  const min = minSpanFor(block);
  const wide = Math.max(1, columns);
  return {
    w: Math.min(Math.max(Math.floor(span.w) || 1, Math.min(min.w, wide)), wide),
    h: Math.max(Math.floor(span.h) || 1, min.h),
  };
}

/** one block into a document, at `at` in the reading order and on the first
 * free cells of the page. `under` is the block an answer was asked from: the
 * reply lands directly beneath it and what stood there moves down, which is
 * what "under the block it answered" means once the page is two-dimensional */
function insert(canvasId: string, block: Block, at: number, under?: Cell): void {
  const doc = useCanvas.getState().docs[canvasId];
  const columns = columnsOfDoc(doc);
  const standing = laidOut(doc?.blocks ?? [], columns);
  const items = itemsOf(standing);
  const span = openingSpan(block, columns);
  const landed = { id: block.id, cell: place(items, span, columns) };
  const all = under
    ? pinAt([...items, landed], block.id, { x: under.x, y: under.y + under.h, ...span }, columns)
    : [...items, landed];
  const cells = new Map(all.map((i) => [i.id, i.cell]));
  const blocks = standing.map((b) => {
    const cell = cells.get(b.id);
    return cell && b.cell && !sameCell(cell, b.cell) ? { ...b, cell } : b;
  });
  blocks.splice(Math.max(0, Math.min(at, blocks.length)), 0, {
    ...block,
    cell: cells.get(block.id) ?? landed.cell,
  });
  setDoc(canvasId, { blocks, lastColumns: columns });
}

function patch(canvasId: string, blockId: string, f: (b: Block) => Block): void {
  const doc = useCanvas.getState().docs[canvasId];
  if (!doc) return;
  const blocks = doc.blocks.map((b) => (b.id === blockId ? f(b) : b));
  if (blocks.every((b, i) => b === doc.blocks[i])) return;
  setDoc(canvasId, { blocks });
}

// ---- the model's blocks (B3) ----------------------------------------------

/** Exchanges whose FIRST canvas write clears what their previous attempt
 * wrote. Marked when a re-run starts and consumed by that write, so a re-run
 * that fails, is refused or is cancelled before writing leaves the standing
 * blocks alone (canvas-agent-spec 2.4 rule 2). Session-lived: a reload has no
 * run in flight to clear for. */
const pendingClear = new Set<string>();

/** the re-run rule, applied to the array the write is about to land in: the
 * previous attempt's blocks leave, and the exchange stops counting them */
function cleared(blocks: readonly Block[], exchangeId: string): Block[] {
  if (!pendingClear.delete(exchangeId)) return [...blocks];
  const gone = blocks.filter((b) => b.wroteBy === exchangeId);
  if (gone.length === 0) return [...blocks];
  for (const b of gone) useAsk.getState().forgetBlock(b.id);
  useAgent.getState().forgetCanvasBlocks(gone.map((b) => b.id));
  return blocks.filter((b) => b.wroteBy !== exchangeId);
}

/** the face the outline names: `diff` stands in the table's place, and the
 * model is never told about a comparison it cannot make (its schema's `face`
 * enum has four values, this one's five) */
const faceForModel = (b: ResultBlock): CanvasFace => (b.face === "diff" ? "table" : b.face);

/** The model's intent as the document holds it. The status line and the row
 * cap come from `capRun`, the same pair `Add to Canvas` reads, so `200 of
 * 1,842 rows` is one sentence in one place. The title line slot takes the
 * exchange's question on the FIRST block an answer writes and the model's own
 * title on every result after it (canvas-agent 4.2): one slot, two fields, so
 * the words keep whose they are. A face the rows cannot wear falls back to the
 * one they can, and the tool says so rather than refusing (spec 1.2, DESIGN
 * rule 11). */
function blockFromModel(b: ModelBlockInput): Block {
  if (b.kind === "note")
    return {
      id: b.id,
      kind: "note",
      text: b.text,
      autoH: true,
      wroteBy: b.wroteBy,
      ...(b.question ? { question: b.question } : null),
    };
  const { rows, status } = capRun(b.run);
  const built: ResultBlock = {
    id: b.id,
    kind: "result",
    question: b.question ?? "",
    ...(b.title ? { title: b.title } : null),
    prose: b.note ?? "",
    sql: b.sql,
    columns: b.run.columns,
    rows,
    // an assumption belongs to the EXCHANGE, and lands on the first result
    // block it wrote once the verdict has parsed it (spec 2.7): never here,
    // where nothing has been parsed yet
    chips: [],
    status,
    ms: b.run.ms,
    face: b.face,
    wroteBy: b.wroteBy,
  };
  return facesOf(built).includes(b.face) ? built : { ...built, face: defaultFace(built) };
}

/** One exchange as one block. A run makes a result block; prose with no run
 * makes a note carrying the question that produced it, so provenance survives
 * either way (LESSONS 4). Nothing at all makes nothing. */
function blockOf(ex: Exchange): Block | null {
  const run = ex.answer?.run ?? null;
  const prose = ex.text || ex.answer?.text || "";
  const id = crypto.randomUUID();
  if (!run)
    return prose.trim() === ""
      ? null
      : { id, kind: "note", text: prose, autoH: true, question: ex.question };
  // B3: the press keeps at most the document's own 200 rows and the status
  // line says `200 of 1,842 rows`, which is the `· showing 2,000` fragment
  // this replaces: one sentence, one place (capRun)
  const { rows, status } = capRun(run);
  return {
    id,
    kind: "result",
    question: ex.question,
    prose,
    sql: ex.answer?.sql ?? null,
    columns: run.columns,
    rows,
    // an assumption the user switched off is not one the answer made
    chips: (ex.answer?.assumptions ?? []).filter((a) => a.active).map((a) => a.label),
    status,
    ms: run.ms,
    // W7's rule: the face the reader was already looking at, which for one
    // row is its figures (B3's values face) and for more is the grid. A
    // press keeps a face; only the model's own write composes a reading
    // (`defaultFace`, canvas-agent 3.3)
    face: rows.length === 1 ? "values" : rows.length > 0 ? "table" : "sql",
  };
}

// ---- persistence ----------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(canvasId: string): void {
  const t = timers.get(canvasId);
  if (t) clearTimeout(t);
  timers.delete(canvasId);
  const r = retries.get(canvasId);
  if (r) clearTimeout(r);
  retries.delete(canvasId);
}

async function save(canvasId: string): Promise<void> {
  const s = useCanvas.getState();
  const meta = metaOf(s, canvasId);
  const doc = s.docs[canvasId];
  // a document that did not parse is never written over: it is unreadable,
  // not gone, and one write would make it both
  if (!meta || meta.broken || !doc) return;
  try {
    await canvasUpsert({
      id: meta.id,
      profile_id: meta.profileId,
      title: meta.title,
      doc_json: writeDoc(doc),
    });
    if (useCanvas.getState().saveError) useCanvas.setState({ saveError: false });
  } catch (e) {
    // surface and retry: a silently failing save would lie about safety
    console.error("canvas_upsert failed", e);
    useCanvas.setState({ saveError: true });
    const r = retries.get(canvasId);
    if (r) clearTimeout(r);
    retries.set(
      canvasId,
      setTimeout(() => void save(canvasId), 3000),
    );
  }
}

function persist(canvasId: string): void {
  // B2 `Recent`: every write is a touch, and a rename refreshes the title the
  // completion shows, because the row is read off the live canvas
  useRecents.getState().touch(metaOf(useCanvas.getState(), canvasId)?.profileId, "canvas", canvasId);
  const t = timers.get(canvasId);
  if (t) clearTimeout(t);
  timers.set(
    canvasId,
    setTimeout(() => {
      timers.delete(canvasId);
      void save(canvasId);
    }, SAVE_DEBOUNCE_MS),
  );
}

/** drop every pending write instead of firing it. The window never wants
 * this (a close flushes), but a harness that pulls the Tauri transport out
 * from under a live debounce does: the timer would otherwise land on a
 * backend that is gone, and the store would read a torn-down transport as a
 * failed save and start retrying against it */
export function cancelCanvasSaves(): void {
  for (const id of [...timers.keys(), ...retries.keys()]) clearTimer(id);
}

/** fire every debounced write NOW: window blur / close must not lose the last
 * block a user added (the tabs store's own contract) */
export function flushCanvases(): Promise<void> {
  const ids = [...timers.keys()];
  for (const id of ids) {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  }
  return Promise.all(ids.map((id) => save(id))).then(() => undefined);
}

// ---- the door from Ask (canvas/port.ts) -----------------------------------
//
// The pane names an exchange by its id and nothing else, so this side looks it
// up: everything a result block shows is already on that exchange, and a copy
// of it passed through the door would be the same facts in two shapes (DESIGN
// rule 14). The connection is the EXCHANGE's, read from the thread that holds
// it rather than from whatever connection is active by the time the click
// lands (LESSONS 4).

function exchangeById(id: string): { exchange: Exchange; profileId: string } | null {
  const s = useAgent.getState();
  for (const [threadId, list] of Object.entries(s.exchanges)) {
    const exchange = list.find((e) => e.id === id);
    if (!exchange) continue;
    const owner = Object.entries(s.threads).find(([, ts]) => ts.some((t) => t.id === threadId));
    if (owner) return { exchange, profileId: owner[0] };
  }
  return null;
}

setCanvasPort({
  addExchange: (exchangeId) => {
    const found = exchangeById(exchangeId);
    if (!found) return { ok: false, created: false, message: "that answer is gone" };
    const out = useCanvas.getState().addExchange(found.profileId, found.exchange);
    return out.ok
      ? { ok: true, created: out.created }
      : { ok: false, created: false, message: out.message };
  },
  newCanvas: () => useCanvas.getState().newCanvas(),
  newNote: () => useCanvas.getState().newNote(),
  newDrawing: () => useCanvas.getState().newDrawing(),
  newCanvasFor: (profileId) => useCanvas.getState().openForQuestion(profileId),
  drawingImage: (canvasId, blockId) => useCanvas.getState().drawingImage(canvasId, blockId),
  removeByExchange: (exchangeIds) => useCanvas.getState().removeByExchange(exchangeIds),
  clearOnNextWrite: (exchangeId) => useCanvas.getState().clearOnNextWrite(exchangeId),
  assumeOn: (exchangeId, labels) => useCanvas.getState().assumeOn(exchangeId, labels),
});

window.addEventListener?.("blur", () => void flushCanvases());
document.addEventListener?.("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushCanvases();
});

// the canvas a connection is "in" is the last canvas tab it looked at; a tab
// that was never selected is not more recent than one that was
useTabs.subscribe((s, prev) => {
  if (s.activeId === prev.activeId) return;
  const t = s.tabs.find((x) => x.id === s.activeId);
  if (t?.kind !== "canvas" || !t.canvas_id || !t.profile_id) return;
  const { canvas_id: id, profile_id: pid } = t;
  useCanvas.setState((c) => ({ recent: { ...c.recent, [pid]: id } }));
});
