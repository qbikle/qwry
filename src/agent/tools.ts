// Module map for src/agent (AGENT-SPEC section 2 is the authority; this is the
// index, not a second spec). TypeScript owns the loop, Rust owns the database.
//
//   tools.schema.json   the five tool schemas, section 5. ONE source of truth:
//                       this file imports it and agent_mcp.rs include_str!s it
//   tools.ts            this file: TOOL_SCHEMAS + the AgentTools interface
//   tools.tauri.ts      AgentTools over Tauri commands (the app)
//   canvas.tauri.ts     CanvasTools over the read gate and the canvas document
//   loop.ts             the turn loop, section 4; streams events to the store
//   context.ts          prefilter, index, candidate assembly, sections 4.1-4.2
//   risk.ts             risky-shape classifier, section 4.4
//   prompt.ts           frozen system prompt + PROMPT_VERSION, section 6
//   extract.ts          tolerant SQL/assumption/answer extraction, section 4.6
//   types.ts            shared value types (runs, verdicts, chips, trace)
//   platform.tauri.ts   Platform over Tauri commands
//   providers/          Provider interface, adapters, presets, registry (7)
//   ../stores/agent.ts  zustand: threads, turns, chips, sanity, trace, status
//   eval/tools.node.ts, eval/platform.node.ts   the same interfaces over pg
//
// Rules that bind every file here: only Rust talks to PostgreSQL; nothing under
// src/agent except *.tauri.ts imports Tauri or a store at runtime; keys live in
// the Keychain and never enter this layer.

import schema from "./tools.schema.json";
import type { ToolSchema } from "./providers/types";
import type {
  AgentRun,
  CanvasFace,
  CanvasToolName,
  SanityFragment,
  ToolName,
} from "./types";

export type { CanvasFace, CanvasToolName, ToolName } from "./types";

/** The five tools every provider sees, rendered per wire format by each
 * adapter. Byte-identical to what agent_mcp.rs serves, because both sides read
 * tools.schema.json. Anthropic caches the tools+system prefix, so the array
 * must stay stable between requests of a thread or the whole prefix misses. A
 * run with a canvas target is offered three more (toolsFor) and this array
 * does not move for it: a run without one presents exactly these bytes. */
export const TOOL_SCHEMAS: readonly ToolSchema[] = schema.tools;

export const TOOL_NAMES: readonly ToolName[] = [
  "list_tables",
  "describe_tables",
  "peek_values",
  "run_sql",
  "probe",
];

/** The gate's refusal for a `run_sql` argument that is not a statement at all
 * (agent.rs `PROSE_REASON`, served verbatim by both tool layers). Mirrored
 * here as a substring, not re-worded: the loop and the claude adapter count
 * two of these in a row and end the exchange with the model's own prose
 * rather than watching it re-explain itself to the turn cap (W7). */
export const PROSE_REFUSAL = "this is prose, not SQL";

/** Whether a tool result is that refusal. The text arrives wrapped as
 * `ERROR: <first line>` on every path, so the match is on the substring. */
export const isProseRefusal = (text: string): boolean => text.includes(PROSE_REFUSAL);

/** Two in a row ends the exchange. One is a mistake the model can correct on
 * the next turn; two is the spiral (W7: twelve turns of the same refusal). */
export const PROSE_STRIKES = 2;

/** Rows shown to the MODEL in a run_sql or probe result (section 5). Never
 * lower it to save tokens: the lean variant did and looped to the turn cap
 * re-querying what it could not see. Prune history instead. */
export const MODEL_ROW_CAP = 50;

/** Rows kept for the UI grid; the full result the user scrolls (section 5). */
export const UI_ROW_CAP = 2000;

/** peek_values upper bound, matching the schema's `maximum`. */
export const PEEK_MAX = 50;

/** probe takes at most this many queries, each capped at PROBE_ROW_CAP rows. */
export const PROBE_MAX = 6;
export const PROBE_ROW_CAP = 5;

/** run_sql's timeout when the statement_timeout setting names none (section 5).
 * The setting's 0 means "no timeout" for a SESSION, which is not a shape a tool
 * call has: agent.rs clamps a tool timeout to a one-second floor, so 0 has to
 * land here rather than there. agent_mcp.rs::RUN_SQL_TIMEOUT_MS is the same
 * number for the child process that cannot read the setting. */
export const RUN_SQL_TIMEOUT_MS = 10_000;

/** Every AgentTools method returns BOTH halves of a tool call: `textForModel`
 * is exactly what goes back into the conversation, `result` is the structured
 * data the UI keeps (grid rows, sanity fragments, trace entries). Neither is
 * derived from the other later: rendering a result twice from one source is
 * how a trace starts disagreeing with what the model actually saw.
 *
 * `error` is set when the call failed. It is not an exception: a failed tool
 * call is normal (the repair loop feeds `textForModel` straight back, in the
 * `ERROR: <first line>` shape section 5 mandates), so `textForModel` is always
 * present and `result` is null. */
export interface ToolOutcome<T> {
  textForModel: string;
  result: T | null;
  error?: string;
}

/** One table as `list_tables` reports it. */
export interface TableBrief {
  schema: string;
  name: string;
  /** planner estimate (reltuples), not a count */
  approxRows: number;
  comment: string | null;
}

/** One described table: the DDL text the model reads is composed by the
 * implementation from the cached schema snapshot plus pg_stats values, so the
 * structured half carries the pieces the UI wants to show. */
export interface TableDescription {
  schema: string;
  name: string;
  comment: string | null;
  columns: {
    name: string;
    type: string;
    notNull: boolean;
    isPrimaryKey: boolean;
    references: { schema: string; name: string; column: string } | null;
    comment: string | null;
    /** low-cardinality values from pg_stats, at most 20 */
    values: string[];
  }[];
}

export interface PeekOutcome {
  table: string;
  column: string;
  values: string[];
  /** more distinct values exist than were returned */
  more: boolean;
  /** a big table: the values come from a bounded sample, not the whole table */
  sampled: boolean;
}

export interface ProbeOutcome {
  sql: string;
  run: AgentRun | null;
  error: string | null;
  /** what this probe says about the data, for the sanity line (AGENT-UX 4) */
  fragment: SanityFragment | null;
}

/** The tool surface the loop calls. Implemented twice: over Tauri commands for
 * the app (tools.tauri.ts) and over `pg` for the headless harness
 * (eval/tools.node.ts). Both must behave identically, because EVAL.md scores
 * the app's own loop through the node one.
 *
 * Table and column names arrive as the MODEL wrote them: bare, unqualified,
 * possibly wrong. The implementation resolves a bare name against the schema
 * snapshot and carries schema and name separately from there on; it never
 * splits a dotted string (LESSONS 4). An unresolvable name is an `error`
 * naming the valid options, never a throw. */
export interface AgentTools {
  listTables(): Promise<ToolOutcome<TableBrief[]>>;
  describeTables(names: string[]): Promise<ToolOutcome<TableDescription[]>>;
  peekValues(
    table: string,
    column: string,
    limit?: number,
  ): Promise<ToolOutcome<PeekOutcome>>;
  /** the only method whose structured half feeds the results grid */
  runSql(sql: string): Promise<ToolOutcome<AgentRun>>;
  probe(sqls: string[]): Promise<ToolOutcome<ProbeOutcome[]>>;
}

// ---- the canvas family (B3) -------------------------------------------------
//
// Three tools a run offers only when its exchange has a canvas target, and the
// pure half of what they do: the union the model may write, the caps, the
// refusals, the short-id resolution, the placement clamp and the outline's one
// renderer. Nothing here touches a store or Tauri; canvas.tauri.ts runs the SQL
// and hands the blocks to the document (AGENT-SPEC section 2 rule 2).

/** The three canvas schemas, from the same file the five come from. Offered
 * ONLY with a target (toolsFor): the tool list is prompt surface (EVAL.md
 * section 4), so a run without one must present the byte-identical five, and a
 * tool the model can see but that always refuses is W7's prose spiral with a
 * new name. There is no canvas_create and no canvas_delete (canvas-agent-spec
 * section 1.1): the target is captured in the tool, so writing outside it has
 * no wire representation, and a delete stays the user's own keypress. */
export const CANVAS_TOOL_SCHEMAS: readonly ToolSchema[] = schema.canvasTools;

export const CANVAS_TOOL_NAMES: readonly CanvasToolName[] = [
  "canvas_write",
  "canvas_replace",
  "canvas_read",
];

/** The array a run hands its provider: the five, plus the canvas family when
 * the exchange has a target. ONE gate for both halves of the prompt surface,
 * so a message can never describe tools it does not offer. */
export const toolsFor = (canvas: boolean): ToolSchema[] =>
  canvas ? [...TOOL_SCHEMAS, ...CANVAS_TOOL_SCHEMAS] : [...TOOL_SCHEMAS];

/** Rows of a canvas result echoed back to the MODEL: enough to write the note
 * truthfully, never enough to be a second run_sql (probe's own number). */
export const CANVAS_ECHO_ROWS = 5;
/** Rows a canvas result BLOCK keeps, for a model write and for `Add to Canvas`
 * alike: a reading, not an export. The chart and diff faces already stop
 * reading at this number, and the whole document is one debounced blob. */
export const CANVAS_BLOCK_ROWS = 200;
/** Blocks one canvas_write may append (probe's own maxItems). */
export const CANVAS_WRITE_MAX = 6;
/** Blocks one exchange may write, across every call: the runaway-loop bound,
 * W7's prose-spiral precedent. */
export const CANVAS_EXCHANGE_MAX = 8;
/** How long Rust waits for this side to answer an MCP canvas call; mirrored in
 * agent_mcp.rs, because the child cannot read this file. */
export const CANVAS_BRIDGE_TIMEOUT_MS = 20_000;

/** Field caps, mirrored by the schema's own maxLength so a well-behaved
 * provider refuses before the model spends a turn. */
export const CANVAS_NOTE_CAP = 2000;
export const CANVAS_TITLE_CAP = 120;
export const CANVAS_PROSE_CAP = 600;

/** Characters of a block id the outline prints, and the fewest a handle may
 * carry: 4 hex digits of a uuid, unique on any canvas a person reads. */
export const CANVAS_HANDLE = 4;
/** Where the outline ellipsizes a block's first line. */
export const CANVAS_LINE_CAP = 60;

/** The strip's chip for every canvas call, coalesced `canvas ×2` the way
 * `run ×3` is: the chip counts CALLS, the trace's own unit (AGENT-UX 16). */
export const CANVAS_CHIP = "canvas";

/** The canvas is a grid of cells (C2, canvas-grid-spec section 2.6), so a
 * block stands somewhere rather than merely after something. `at` is its
 * top-left corner and `span` its size, both in CELLS and both optional: a
 * block that names neither is placed by the canvas at its kind's own size.
 * The engine's `Cell` (canvas/grid.ts) is these two halves together, and it
 * is composed here rather than imported, because this half of the agent
 * imports nothing from the canvas. */
export interface ModelAt {
  x: number;
  y: number;
}
export interface ModelSpan {
  w: number;
  h: number;
}
export type ModelCell = ModelAt & ModelSpan;

/** The placement fields both block kinds carry, written once. */
export interface ModelPlace {
  at?: ModelAt;
  span?: ModelSpan;
}

/** The column count a canvas answers when nothing is measuring it: no tab is
 * open on it, or it has never been laid out. ADVISORY, exactly as
 * `lastColumns` is: it informs the outline and the clamp and refuses nothing
 * (LESSONS 5). The number is the 960 card's own count under the C2 cell
 * (base 108, gutter 12, page inset 16), which is the width the harness and a
 * 14" window with the Ask pane open both stand at. */
export const COLUMNS_FALLBACK = 7;

/** One block as the MODEL writes it: an INTENT. The document holds a result
 * (columns, rows, status, ms); this holds the statement that will produce one.
 * canvas.tauri.ts is the one place the two meet, exactly as tools.tauri.ts is
 * the one place the wire record and the domain record meet. */
export type ModelBlock =
  | ({ kind: "note"; text: string } & ModelPlace)
  | ({
      kind: "result";
      sql: string;
      /** at most six words; absent on the first block of an answer, which
       * wears the question instead (LESSONS 4, the question stands once) */
      title?: string;
      /** one sentence above the face */
      note?: string;
      /** an explicit override; absent means the rows decide */
      face?: CanvasFace;
    } & ModelPlace);

/** What a canvas write reports back to the loop: every block this exchange
 * has put on the canvas, and how many of them stood IN PLACE of one already
 * there. Read off the seam that landed them, never re-parsed out of the
 * model-facing text, so the pane's `3 blocks · 1 replaced` and the document
 * are one reading (LESSONS 13). */
export interface CanvasWriteResult {
  canvasId: string;
  blockIds: string[];
  replaced: number;
}

/** One line of the outline, as the DOCUMENT reads itself. `line` is the
 * block's own first line (a question, a model title, a note's opening) and is
 * ellipsized by the renderer here, so the store never formats for a model.
 * `modelWritten` is the consent gate: a block with no `wroteBy` is the user's
 * own work and canvas_replace refuses it. */
export interface CanvasOutlineEntry {
  id: string;
  kind: "note" | "result";
  line: string;
  rows?: number;
  columns?: string[];
  face?: CanvasFace;
  modelWritten: boolean;
  /** C2: where the block stands on the grid, read straight off the document.
   * Absent on a document the grid has not reached yet, and the outline then
   * says nothing about geometry rather than guessing at it. */
  cell?: ModelCell;
}

export interface CanvasOutline {
  canvasId: string;
  title: string;
  /** how many columns wide the canvas is, so `at` is a place and not a guess */
  columns: number;
  blocks: CanvasOutlineEntry[];
}

/** The canvas surface the loop calls, implemented once over the store and the
 * read gate (canvas.tauri.ts). `title` and `outline()` are read BEFORE the
 * first await of a run, for the CANVAS user-message block; `canvasId` is
 * captured at construction and no tool takes one, so the model cannot address
 * a canvas at all (canvas-agent-spec section 4 item 7). */
export interface CanvasTools {
  readonly canvasId: string;
  readonly title: string;
  /** what the canvas holds right now, read straight off the document. The
   * CANVAS user-message block and canvas_read both render THESE, through
   * outlineLine, so the message and the tool can never disagree about what
   * stands there (LESSONS 13). Read before the run's first await. */
  outline(): readonly CanvasOutlineEntry[];
  /** the column count the target is laid out at, read at the same moment the
   * outline is. Optional so a caller that only reads the document needs no
   * grid; absent answers COLUMNS_FALLBACK wherever a number is owed. */
  columns?(): number;
  write(args: unknown): Promise<ToolOutcome<CanvasWriteResult>>;
  replace(args: unknown): Promise<ToolOutcome<CanvasWriteResult>>;
  read(): Promise<ToolOutcome<CanvasOutline>>;
  /** the `claude -p` bridge: answer the MCP server's `canvas-tool-call`
   * events for this session until the returned stop is called. `onWrite` is
   * how the block ids reach the loop's canvasWrite event on that path, since
   * the loop never sees the call. Absent on a platform with no bridge. */
  serve?(onWrite: (result: CanvasWriteResult) => void): () => void;
}

// ---- validating what the model wrote ---------------------------------------
//
// Every refusal names the way out (LESSONS 9). `ERROR: <first line>` is the
// shape section 5 mandates on every path, so the loop feeds these straight
// back and the model reads them the way it reads a gate refusal.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A cap refusal, one sentence for three fields: what it is, what the cap is,
 * and what to write instead. */
const overCap = (field: string, length: number, cap: number, advice: string) =>
  bad(`ERROR: \`${field}\` is ${length.toLocaleString()} characters; the cap is ${cap}. ${advice}`);

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const FACES: readonly CanvasFace[] = ["chart", "table", "values", "sql"];
const isFace = (v: unknown): v is CanvasFace => FACES.includes(v as CanvasFace);

/** One whole cell as the model wrote it. A number is floored, because half a
 * cell is not a place; anything else is not a co-ordinate at all, and the
 * caller names the field rather than inventing one. */
const cells = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;

/** `7 columns`, the canvas's own width, said in one place. */
export const columnsSaid = (columns: number): string =>
  `${columns} ${columns === 1 ? "column" : "columns"}`;

const PLACE_ADVICE = "Read the grid off canvas_read, or leave it off and the canvas places the block";

/** A block's `at` and `span`: absent, or whole cells. A number OUT OF RANGE is
 * not refused here, because the canvas clamps it and the reply says so
 * (clampPlace); a value of the wrong shape is, because there is nothing to
 * clamp. Below zero is pulled to zero without a sentence: a negative cell is
 * not a narrower canvas, it is a number the grid has no room for either way. */
function parsePlace(b: Record<string, unknown>): Parsed<ModelPlace> {
  const out: ModelPlace = {};
  if (b.at !== undefined) {
    const at = obj(b.at);
    const x = at ? cells(at.x) : null;
    const y = at ? cells(at.y) : null;
    if (x === null || y === null) {
      return bad(`ERROR: \`at\` is \`x\` and \`y\`, whole cells of the grid. ${PLACE_ADVICE}`);
    }
    out.at = { x: Math.max(0, x), y: Math.max(0, y) };
  }
  if (b.span !== undefined) {
    const span = obj(b.span);
    const w = span ? cells(span.w) : null;
    const h = span ? cells(span.h) : null;
    if (w === null || h === null) {
      return bad(`ERROR: \`span\` is \`w\` and \`h\`, whole cells of the grid. ${PLACE_ADVICE}`);
    }
    out.span = { w: Math.max(1, w), h: Math.max(1, h) };
  }
  return { ok: true, value: out };
}

/** What the canvas can give of what the model asked for, and the sentence when
 * the two differ. Never a refusal and never a silent cut: the blocks were
 * good, only the geometry was out of reach, which is the shape faceFor already
 * uses for a face the rows cannot wear (DESIGN rule 11, canvas-grid-spec 2.6).
 * A block whose cell is taken is not clamped at all: the engine pushes what
 * stands there down, so an overlap is a layout, not an impossibility. */
export function clampPlace(place: ModelPlace, columns: number): ModelPlace & { said: string[] } {
  const cols = Math.max(1, Math.floor(columns));
  const said: string[] = [];
  const span = place.span ? { ...place.span } : undefined;
  if (span && span.w > cols) {
    said.push(`asked for ${span.w} wide, the canvas is ${columnsSaid(cols)}, placed ${cols} wide`);
    span.w = cols;
  }
  const at = place.at ? { ...place.at } : undefined;
  // with no span the tool does not know the block's width, so the only claim
  // it can make is that the column itself does not exist; the store's own
  // resize pulls x back once the kind's default width is known
  const last = cols - (span?.w ?? 1);
  if (at && at.x > last) {
    said.push(`asked for column ${at.x}, the canvas is ${columnsSaid(cols)}, placed at column ${last}`);
    at.x = last;
  }
  return { ...(at ? { at } : {}), ...(span ? { span } : {}), said };
}

/** One block of the union. An unknown `face` is NOT a refusal: the tool falls
 * back to the face the rows deserve and says so in its reply, because a model
 * that guessed a face wrong still wrote a good statement (DESIGN rule 11). */
export function parseCanvasBlock(v: unknown): Parsed<ModelBlock> {
  const b = obj(v);
  if (!b) return bad("ERROR: a block needs `kind`: 'note' or 'result'");
  const placed = parsePlace(b);
  if (!placed.ok) return placed;
  const place = placed.value;
  if (b.kind === "note") {
    const text = typeof b.text === "string" ? b.text : "";
    if (!text.trim()) {
      return bad(
        "ERROR: a note block needs `text`, and it cannot be empty. Deleting a block is the user's own action",
      );
    }
    if (text.length > CANVAS_NOTE_CAP) {
      return overCap("text", text.length, CANVAS_NOTE_CAP, "Write the finding, not the transcript");
    }
    return { ok: true, value: { kind: "note", text, ...place } };
  }
  if (b.kind === "result") {
    const sql = str(b.sql);
    if (!sql) return bad("ERROR: a result block needs `sql`, one read-only statement");
    const title = str(b.title);
    if (title && title.length > CANVAS_TITLE_CAP) {
      return overCap("title", title.length, CANVAS_TITLE_CAP, "Six words name a block");
    }
    const note = str(b.note);
    if (note && note.length > CANVAS_PROSE_CAP) {
      return overCap("note", note.length, CANVAS_PROSE_CAP, "One sentence rides above a face");
    }
    return {
      ok: true,
      value: {
        kind: "result",
        sql,
        ...(title ? { title: title.trim() } : {}),
        ...(note ? { note: note.trim() } : {}),
        ...(isFace(b.face) ? { face: b.face } : {}),
        ...place,
      },
    };
  }
  return bad("ERROR: a block needs `kind`: 'note' or 'result'");
}

/** canvas_write's `blocks`, in order. One bad block refuses the whole call:
 * a half-applied batch would leave the model writing a note about results
 * that are not on the page. */
export function parseCanvasBlocks(v: unknown): Parsed<ModelBlock[]> {
  const raw = asBlockArray(v);
  if (!raw) {
    return bad(`ERROR: canvas_write needs \`blocks\`, an array of 1 to ${CANVAS_WRITE_MAX} blocks`);
  }
  const out: ModelBlock[] = [];
  for (const item of raw) {
    const one = parseCanvasBlock(item);
    if (!one.ok) return one;
    out.push(one.value);
  }
  return { ok: true, value: out };
}

/** A `blocks` argument that is an array of the right length, or null. A model
 * that wrote ONE block without its array gets the same reading rather than a
 * refusal it has to spend a turn on. */
function asBlockArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v.length >= 1 && v.length <= CANVAS_WRITE_MAX ? v : null;
  return typeof v === "object" && v !== null ? [v] : null;
}

/** A block id as the model wrote it: the whole uuid, or the first 4 or more
 * characters the outline printed. Ambiguity and absence each name their way
 * out; neither is ever resolved to a guess. */
export function resolveHandle(ids: readonly string[], raw: unknown): Parsed<string> {
  const want = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!want) return bad("ERROR: `block_id` is the id, or its first 4 characters, as canvas_read printed it");
  const exact = ids.find((id) => id.toLowerCase() === want);
  if (exact) return { ok: true, value: exact };
  if (want.length < CANVAS_HANDLE) {
    return bad(`ERROR: '${want}' is too short. Use at least ${CANVAS_HANDLE} characters of the id`);
  }
  const hits = ids.filter((id) => id.toLowerCase().startsWith(want));
  if (hits.length === 1) return { ok: true, value: hits[0] };
  if (hits.length === 0) {
    return bad(`ERROR: no block '${want}' on this canvas. Call canvas_read for the block ids`);
  }
  return bad(
    `ERROR: '${want}' matches ${hits.length} blocks. Use at least ${CANVAS_HANDLE} characters of the id`,
  );
}

/** The bridge's own failure: the child asked and this side never answered, so
 * the model is told to say its findings where it can (LESSONS 9). Mirrored in
 * agent_mcp.rs, which is the side that times out. */
export const CANVAS_BRIDGE_LOST = "ERROR: the canvas did not answer. Say your findings here instead";

// ---- the outline, one renderer ---------------------------------------------

/** A block's first line as a line: whitespace collapsed, ellipsized. Every
 * place a block is named to the model goes through this, so an outline line
 * and a write's own reply cannot cut the same note at two lengths. */
export const gist = (text: string, cap = CANVAS_LINE_CAP): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > cap ? `${one.slice(0, cap).trimEnd()}…` : one;
};

/** The short handle the outline prints and the model writes back. */
export const handleOf = (id: string): string => id.slice(0, CANVAS_HANDLE);

/** One block's line: the handle, the kind, then dot-separated facts about it.
 * The one line shape, so the outline and a write's own reply read alike; each
 * caller says which facts belong on it, since a write prints the rows under
 * the line and the outline has nowhere else to put them (DESIGN rule 14). */
export function blockLine(
  id: string,
  kind: "note" | "result",
  parts: readonly (string | null | undefined)[],
): string {
  const said = parts.filter((p): p is string => !!p);
  return `${handleOf(id)}  ${kind.padEnd(6)}  ${said.join(" · ")}`;
}

/** `12 rows: month, revenue`, the shape a result's rows have. */
export const rowsPart = (rows: number, columns?: readonly string[]): string =>
  `${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"}` +
  (columns?.length ? `: ${columns.join(", ")}` : "");

/** `at 0,2 6×4`: where a block stands and how big it is. One renderer for the
 * outline and for a write's own reply, so a block's place reads the same in
 * both (LESSONS 13). Absent on a document with no geometry yet. */
export const cellPart = (cell?: ModelCell): string | null =>
  cell ? `at ${cell.x},${cell.y} ${cell.w}×${cell.h}` : null;

/** One block as the outline prints it. A result names its shape because that
 * is what stops the model writing a note about columns that never came back. */
export function outlineLine(entry: CanvasOutlineEntry): string {
  return blockLine(entry.id, entry.kind, [
    gist(entry.line) || "(untitled)",
    entry.kind === "result" && entry.rows !== undefined
      ? rowsPart(entry.rows, entry.columns)
      : null,
    entry.kind === "result" && entry.face ? `${entry.face} face` : null,
    cellPart(entry.cell),
  ]);
}

/** The whole outline, headed the way canvas_read heads it. Empty is one
 * sentence, never a header over nothing (DESIGN rule 11). The head carries the
 * canvas's width, because `at` written against the wrong column count is a
 * guess; a caller with no grid to read leaves it off rather than stating a
 * number it does not have. */
export function outlineText(
  title: string,
  blocks: readonly CanvasOutlineEntry[],
  columns?: number,
): string {
  const wide = columns === undefined ? "" : `, ${columnsSaid(columns)} wide`;
  if (blocks.length === 0) return `Canvas "${title}" is empty${wide}.`;
  const count = `${blocks.length} ${blocks.length === 1 ? "block" : "blocks"}`;
  return [`Canvas "${title}", ${count}${wide}.`, ...blocks.map(outlineLine)].join("\n");
}
