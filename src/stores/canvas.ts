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
  RUN_SQL_TIMEOUT_MS,
  type CanvasOutlineEntry,
} from "../agent/tools";
import type { AgentRun, CanvasFace } from "../agent/types";
import { SCALAR_MAX_COLS } from "../ask/ScalarResult";
import { msText } from "../lib/duration";
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

export type Block = ResultBlock | NoteBlock;

export interface CanvasDoc {
  blocks: Block[];
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

/** the chart the block's rows can carry, or null when there is none: over the
 * row cap, over three numeric columns, with no label column or with two, the
 * face does not exist. Never a message in its place. */
export function chartOf(block: Block): ChartSpec | null {
  if (block.kind !== "result") return null;
  const rows = block.rows;
  if (rows.length === 0 || rows.length > CHART_ROW_CAP) return null;
  const { labels, numbers } = columnKinds(block.columns, rows);
  if (labels.length !== 1) return null;
  if (numbers.length < 1 || numbers.length > CHART_MAX_SERIES) return null;
  const li = labels[0];
  const text = rows.map((r) => r[li] ?? "");
  return {
    kind: text.every((t) => DATE_LABEL.test(t)) ? "line" : "bars",
    label: block.columns[li],
    labels: text,
    series: numbers.map((ci) => ({
      name: block.columns[ci],
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
  if (block.diff) faces.push("diff");
  // one row of five or more columns is a grid, not a figure row: ScalarResult
  // draws at most SCALAR_MAX_COLS pairs, so offering `values` past that would
  // name a face the run cannot stand on (DESIGN rule 11)
  else if (block.rows.length === 1 && block.columns.length <= SCALAR_MAX_COLS) faces.push("values");
  else if (block.rows.length > 0) faces.push("table");
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
export type ModelBlockInput =
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
    };

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
  /** commit an edited note; empty text deletes it (the fold precedent: the
   * preview is the commit) */
  updateNote: (canvasId: string, blockId: string, text: string) => void;
  remove: (canvasId: string, blockId: string) => void;
  /** move a block one place up (-1) or down (+1); a no-op at either end */
  move: (canvasId: string, blockId: string, delta: 1 | -1) => void;
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
        let doc: CanvasDoc | null = null;
        try {
          const parsed = JSON.parse(r.doc_json) as CanvasDoc;
          if (parsed && Array.isArray(parsed.blocks)) doc = parsed;
        } catch {
          doc = null;
        }
        // a canvas we could not read is listed and never written to: an
        // overwrite would turn an unreadable document into a deleted one
        metas.push({
          id: r.id,
          profileId: r.profile_id,
          title: r.title,
          updatedAt: r.updated_at,
          ...(doc ? null : { broken: true }),
        });
        if (doc) docs[r.id] = doc;
        else console.error("canvas doc did not parse", r.id);
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
    const doc: CanvasDoc = { blocks: [] };
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
      insert(from.canvasId, block, at + 1);
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
    const kept = cleared(doc.blocks, blocks[0].wroteBy);
    const at = after ? kept.findIndex((b) => b.id === after) : -1;
    const made = blocks.map(blockFromModel);
    const put = at >= 0 ? at + 1 : kept.length;
    setDoc(canvasId, { blocks: [...kept.slice(0, put), ...made, ...kept.slice(put)] });
    return made.map((b) => b.id);
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
    // reply still stands under the block it answered (A3 item 4)
    const made = blockFromModel(block);
    const blocks = [...kept];
    blocks[at] = old.askedFrom ? { ...made, askedFrom: old.askedFrom } : made;
    setDoc(canvasId, { blocks });
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
      line: b.kind === "result" ? b.question || b.title || "" : b.text.split("\n")[0],
      modelWritten: b.wroteBy !== undefined,
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
      setDoc(canvasId, { blocks: doc.blocks.filter((b) => !gone.includes(b)) });
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
    const block: NoteBlock = { id: crypto.randomUUID(), kind: "note", text };
    insert(canvasId, block, at ?? get().docs[canvasId]?.blocks.length ?? 0);
    return block.id;
  },

  updateNote: (canvasId, blockId, text) => {
    // a note emptied in edit deletes itself on commit
    if (text.trim() === "") return get().remove(canvasId, blockId);
    patch(canvasId, blockId, (b) => (b.kind === "note" ? { ...b, text } : b));
  },

  remove: (canvasId, blockId) => {
    const doc = get().docs[canvasId];
    if (!doc || !doc.blocks.some((b) => b.id === blockId)) return;
    setDoc(canvasId, { blocks: doc.blocks.filter((b) => b.id !== blockId) });
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
    if (!doc) return;
    const i = doc.blocks.findIndex((b) => b.id === blockId);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= doc.blocks.length) return;
    const blocks = [...doc.blocks];
    const [moved] = blocks.splice(i, 1);
    blocks.splice(to, 0, moved);
    setDoc(canvasId, { blocks });
  },

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

function setDoc(canvasId: string, doc: CanvasDoc): void {
  useCanvas.setState((s) => ({ docs: { ...s.docs, [canvasId]: doc } }));
  persist(canvasId);
}

function insert(canvasId: string, block: Block, at: number): void {
  const doc = useCanvas.getState().docs[canvasId] ?? { blocks: [] };
  const blocks = [...doc.blocks];
  blocks.splice(Math.max(0, Math.min(at, blocks.length)), 0, block);
  setDoc(canvasId, { blocks });
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
  if (!run) return prose.trim() === "" ? null : { id, kind: "note", text: prose, question: ex.question };
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
      doc_json: JSON.stringify(doc),
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
  newCanvasFor: (profileId) => useCanvas.getState().openForQuestion(profileId),
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
