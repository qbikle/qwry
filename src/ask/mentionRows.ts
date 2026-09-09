// The `@` under the caret and what the popover offers for it (W6, sectioned
// and fuzzy in B2). Pure and DOM-free: AskPanel reads the textarea and hands
// the text and the caret to `mentionQueryAt`, MentionPopover hands the
// fragment and what the connection has to `sectionsFor` and only draws the
// sections back, so the rule for which rows a fragment yields is a unit test
// (mentionRows.test.ts) and never a frame. The grammar itself is
// src/agent/mentions.ts: what a pick INSERTS is its `canonicalToken`, and the
// fragment rule here is that grammar read up to the caret (an identifier
// path, a `kind/` path, or a quoted name still open).
//
// B2 replaces W7's one flat run of every askable table by row count. With
// nothing typed the box is SECTIONED (item 1): the five category rows first
// (`tables/` · `columns/` · `saved/` · `canvases/` · `threads/`, each the
// token you would type, each opening a level), then `Recent`, `Tables`,
// `Saved`, `Canvases`, `Threads` under labelled hairlines, capped so the
// whole list is at most 23 rows, and absent when they hold nothing. A row
// `Recent` shows is not repeated in its own kind's section below (DESIGN rule
// 14): the section fills with the next by its own order. `Columns` gets no
// section, because a column row needs two typed characters and an empty
// filter has none; its category row is the door.
//
// The moment a fragment is typed the sections give way to ONE run with no
// labels (there is no boundary left to name): the categories the fragment
// reaches on top, then tables, columns, saved queries, canvases, threads.
// Inside a completed category (`@tables/pflg`) the run holds that one kind.
// Every run is capped per kind at ROW_CAP and scrolls inside a box whose
// height never moves (DESIGN rule 2).
//
// Matching is fuzzy.ts's subsequence, not a substring: exact then prefix
// stand above everything, then the best assignment of the filter's
// characters, and ties keep the connection's own order (tables largest
// first, columns by position, saved queries and threads as their lists hold
// them, canvases as their tabs stand). A relation is matched on the spellings
// the user would type, its bare name and its row's own label, never on
// `public.<name>`, which the box neither draws nor inserts. A column row
// still matches on the COLUMN's name alone; the table part is shown, not
// searched, and a filter that means a table's columns spells the dot
// (`order_v2.ord`), where the part before the last dot must PREFIX the
// table, not merely reach it.
// Legacy, system, housekeeping and partition relations are never rows
// (AGENT-SPEC section 6 rule 3: a row that cannot be the answer is a dead
// row), foreign tables neither (the candidate block drops them), and a
// category whose kind holds nothing is a dead row by the same rule.

import { canonicalToken, MENTION_PATHS, type CanvasRef, type MentionPath } from "../agent/mentions";
import { isBannedRelation } from "../agent/starterPool";
import type { MentionKind, Thread } from "../agent/types";
import type { MentionQuery } from "../stores/ask";
import type { Recent } from "../stores/recents";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import { fuzzyScore, FUZZY_PREFIX } from "./fuzzy";

export type { MentionPath };

/** columns are offered from this many typed characters: a one-letter filter
 * over every column is a flood, not a list. Inside `@columns/` the count does
 * not apply: the path IS the request */
export const COLUMN_MIN_FILTER = 2;
/** the most rows one kind contributes to a run. Fuzzy reaches far more names
 * than a substring did, and the answer to a long list is a cap and a scroller
 * inside a box of one height, never a taller box (DESIGN rule 2) */
export const ROW_CAP = 40;
/** how many rows each labelled section shows with the filter empty (item 1):
 * five categories plus at most 4 + 5 + 3 + 3 + 3 rows under five hairlines */
export const SECTION_CAP = { recent: 4, tables: 5, saved: 3, canvases: 3, threads: 3 } as const;

const PUBLIC = "public";

// ---- the caret's `@` -------------------------------------------------------

/** the grammar's word boundary (mentions.ts WORDY): `a@b` is one word */
const WORDY = /[\p{L}\p{N}_]/u;
/** a character of an identifier path fragment, the `kind/` path's slash
 * included (B2): `@tables/pflg` is one fragment, so a pick replaces all of it */
const PATH = /[A-Za-z0-9_./]/;
/** one unquoted segment of the grammar's identifier path */
const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const boundary = (text: string, at: number) => at === 0 || !WORDY.test(text[at - 1]);

/** The `@` token the caret sits in, with the text typed after the `@` up to
 * the caret as the filter; null when the caret is not inside one. An
 * identifier path ends at a space or any character outside `[A-Za-z0-9_./]`;
 * a quoted name (`@"Monthly rev`) runs to the caret with its spaces and ends
 * at the closing quote or a newline. The caret inside a finished token
 * (`@ord|er_v2`) still counts: a pick replaces the whole token
 * (mentionTokenEnd), the way an editor's completion replaces the word. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret;
  while (i > 0 && PATH.test(text[i - 1])) i--;
  if (i > 0 && text[i - 1] === "@" && boundary(text, i - 1)) {
    return { at: i - 1, filter: text.slice(i, caret) };
  }
  if (caret >= 2) {
    const open = text.lastIndexOf('@"', caret - 2);
    if (open !== -1 && boundary(text, open)) {
      const body = text.slice(open + 2, caret);
      if (!/["\n]/.test(body)) return { at: open, filter: body };
    }
  }
  return null;
}

/** where the token a pick replaces ends: past the rest of an identifier path
 * the caret sits in, or past a quoted name's closing quote when one is typed
 * on the caret's line; else the caret itself */
export function mentionTokenEnd(text: string, at: number, caret: number): number {
  if (text[at + 1] === '"') {
    const nl = text.indexOf("\n", caret);
    const line = nl === -1 ? text.length : nl;
    const close = text.indexOf('"', caret);
    return close !== -1 && close < line ? close + 1 : caret;
  }
  let end = caret;
  while (end < text.length && PATH.test(text[end])) end++;
  return end;
}

// ---- the `kind/` path ------------------------------------------------------

/** A filter split at its slash: `tables/pflg` is the `tables` path with
 * `pflg` typed inside it, `pflg` alone is no path at all. A head that is not
 * one of the five words is not a path either, so a table actually named
 * `tables` is still reachable by typing its name. */
export interface MentionFilter {
  path: MentionPath | null;
  /** what is typed after the path, or the whole filter when there is none */
  text: string;
}

export function splitFilter(filter: string): MentionFilter {
  const slash = filter.indexOf("/");
  if (slash > 0) {
    const head = filter.slice(0, slash).toLowerCase();
    if ((MENTION_PATHS as readonly string[]).includes(head)) {
      return { path: head as MentionPath, text: filter.slice(slash + 1) };
    }
  }
  return { path: null, text: filter };
}

/** what a category row inserts: the path and its slash, NO space, so the box
 * re-reads the fragment and stands inside that kind instead of closing */
export const narrowTo = (path: MentionPath): string => `@${path}/`;

// ---- hints -------------------------------------------------------------------

/** psql's spellings for the long type names, so a hint fits its slot at the
 * floor; everything else is the type as the catalog names it */
const TYPE_SHORT: Record<string, string> = {
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
  "character varying": "varchar",
  "double precision": "float8",
  "bit varying": "varbit",
  character: "char",
};

export function shortType(type: string): string {
  const m = /^([a-z][a-z ]*[a-z])(.*)$/.exec(type);
  return m ? (TYPE_SHORT[m[1]] ?? m[1]) + m[2] : type;
}

/** `~2.1M rows`, `~318k rows`, `~412 rows`; null with no estimate (-1 or a
 * relation the planner never counted) */
export function rowsHint(reltuples: number | null | undefined): string | null {
  if (reltuples == null || reltuples < 0) return null;
  const n = Math.round(reltuples);
  if (n === 1) return "~1 row";
  const unit = n >= 1e9 ? (["B", 1e9] as const) : n >= 1e6 ? (["M", 1e6] as const) : n >= 1e3 ? (["k", 1e3] as const) : null;
  if (!unit) return `~${n} rows`;
  const v = n / unit[1];
  return `~${v < 9.95 ? v.toFixed(1) : String(Math.round(v))}${unit[0]} rows`;
}

// ---- rows ----------------------------------------------------------------------

export interface MentionRow {
  /** never `tab`: that kind is minted by `Explain with Ask` and never typed,
   * so the popover has no row for it (AGENT-UX 15). A canvas rides `block`
   * (mentions.ts BlockRef.canvas), which is also the glyph it wears */
  kind: Exclude<MentionKind, "tab">;
  /** a CATEGORY row: ↩, → or a click completes the path and the box stands
   * inside that kind instead of closing. Absent on every other row */
  path?: MentionPath;
  /** cmdk's value: unique (kind and identity), so Enter routes by it */
  value: string;
  /** what a pick inserts, `@` included (mentions.ts canonicalToken); a
   * category row's is its path and slash, and takes no trailing space */
  token: string;
  /** a table's display name, a saved query's name, a canvas's title, a
   * thread's title, a category's path word; a column row's table part
   * (`owner`) rides here and its column in `column` */
  label: string;
  /** a column row: `.column`, whole; the label is the table it belongs to */
  column?: string;
  /** the mono hint slot: a table's row estimate or column count, a column's
   * type; null for everything whose name is the whole fact */
  hint: string | null;
}

/** One band of the box: rows, and the hairline label above them. `label` is
 * null for a run that names no boundary (the categories that open the box,
 * and the single run a typed fragment collapses to). */
export interface MentionSection {
  label: string | null;
  rows: MentionRow[];
}

/** What the box holds for one filter: the sections it draws, every row in
 * draw order (what ↑↓ walks and what a cmdk value looks up), and the category
 * it stands inside. A section with no rows is never here. */
export interface MentionList {
  sections: MentionSection[];
  rows: MentionRow[];
  count: number;
  path: MentionPath | null;
}

export interface MentionRowsCtx {
  snapshot: SchemaSnapshot | null | undefined;
  saved: readonly SavedQuery[];
  threads: readonly Thread[];
  /** the thread being asked in: never offered to itself */
  currentThreadId?: string | null;
  /** the connection's canvases, in the order their tabs stand */
  canvases?: readonly CanvasRef[];
  /** what this connection reached for last, newest first (stores/recents) */
  recents?: readonly Recent[];
}

/** the starters' ban (partitions, system schemas, housekeeping, LEGACY) plus
 * foreign tables, which the candidate block drops */
const banned = (t: TableInfo) => t.kind === "f" || isBannedRelation(t);

const display = (t: TableInfo) => (t.schema === PUBLIC ? t.name : `${t.schema}.${t.name}`);
const qualified = (t: TableInfo) => `${t.schema}.${t.name}`;
const rows = (t: TableInfo) => (t.reltuples == null ? -1 : t.reltuples);

const tableHint = (t: TableInfo) =>
  rowsHint(t.reltuples) ?? `${t.columns.length} ${t.columns.length === 1 ? "column" : "columns"}`;

/** a name the grammar can carry: one line, so the token closes */
const nameable = (name: string) => name.length > 0 && !name.includes("\n");

/** a table whose path would need quotes has no column token, so no column row
 * (the grammar has no quoted PATH) */
const pathable = (t: TableInfo) => BARE.test(t.name) && (t.schema === PUBLIC || BARE.test(t.schema));

const tableRow = (t: TableInfo): MentionRow => ({
  kind: "table",
  value: `table:${qualified(t)}`,
  token: canonicalToken("table", { schema: t.schema, table: t.name }),
  label: display(t),
  hint: tableHint(t),
});

const columnRow = (t: TableInfo, c: TableInfo["columns"][number]): MentionRow => ({
  kind: "column",
  value: `column:${qualified(t)}.${c.name}`,
  token: canonicalToken("column", { schema: t.schema, table: t.name, column: c.name }),
  label: display(t),
  column: `.${c.name}`,
  hint: shortType(c.type),
});

const savedRow = (q: SavedQuery): MentionRow => ({
  kind: "saved",
  value: `saved:${q.id}`,
  token: canonicalToken("saved", { id: q.id, name: q.name, sql: q.sql }),
  label: q.name,
  hint: null,
});

const canvasRow = (c: CanvasRef): MentionRow => ({
  kind: "block",
  value: `canvas:${c.id}`,
  token: canonicalToken("block", { id: c.id, name: c.title, canvas: true }),
  label: c.title,
  hint: null,
});

const threadRow = (t: Thread): MentionRow => ({
  kind: "thread",
  value: `thread:${t.id}`,
  token: canonicalToken("thread", { id: t.id, title: t.title }),
  label: t.title,
  hint: null,
});

/** which kind each path fills, and so which glyph its row wears. `canvases/`
 * lands on the ladder's fifth kind, where a canvas rides beside a block */
const PATH_KIND: Record<MentionPath, MentionRow["kind"]> = {
  tables: "table",
  columns: "column",
  saved: "saved",
  canvases: "block",
  threads: "thread",
};

const categoryRow = (path: MentionPath): MentionRow => ({
  kind: PATH_KIND[path],
  path,
  value: `path:${path}`,
  token: narrowTo(path),
  label: `${path}/`,
  hint: null,
});

// ---- ranking ---------------------------------------------------------------

interface Scored<T> {
  item: T;
  score: number;
  order: number;
}

/** matched, best first, ties in the caller's own order, capped */
const ranked = <T>(list: Scored<T>[], cap: number): T[] =>
  list
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, cap)
    .map((s) => s.item);

/** What the connection has to offer, built once per call: a resolution cache
 * is a stale cache (mentions.ts's own rule), so this lives for one call. */
interface Pool {
  /** askable relations, largest first then by name: the order every tie
   * falls back to */
  tables: TableInfo[];
  byQualified: Map<string, TableInfo>;
  saved: SavedQuery[];
  canvases: CanvasRef[];
  threads: Thread[];
}

function poolOf(ctx: MentionRowsCtx): Pool {
  const tables = (ctx.snapshot?.tables ?? [])
    .filter((t) => !banned(t))
    .sort((a, b) => rows(b) - rows(a) || display(a).localeCompare(display(b)));
  const byQualified = new Map<string, TableInfo>();
  for (const t of tables) {
    const key = qualified(t).toLowerCase();
    if (!byQualified.has(key)) byQualified.set(key, t);
  }
  return {
    tables,
    byQualified,
    saved: ctx.saved.filter((q) => nameable(q.name)),
    canvases: (ctx.canvases ?? []).filter((c) => nameable(c.title)),
    threads: ctx.threads.filter((t) => t.id !== ctx.currentThreadId && nameable(t.title)),
  };
}

/** the categories a box may draw: a kind with nothing behind it is a dead row
 * (AGENT-SPEC section 6 rule 3), so it is not drawn at all */
function paths(pool: Pool): MentionPath[] {
  const has: Record<MentionPath, boolean> = {
    tables: pool.tables.length > 0,
    columns: pool.tables.some(pathable),
    saved: pool.saved.length > 0,
    canvases: pool.canvases.length > 0,
    threads: pool.threads.length > 0,
  };
  return MENTION_PATHS.filter((p) => has[p]);
}

/** Both spellings the grammar takes for a relation: its bare name (a name in
 * `public`, or an outside one the ladder still reaches by name alone) and the
 * name the ROW shows, which is `schema.name` only outside `public`. Never
 * `qualified(t)`: scoring `public.<name>`, as W6 did, gave every public table
 * the head bonus for the `p` of `public` and a prefix match for `@p`, which
 * inverted the `pflg` order the sketch and DECISIONS pin
 * (product_flatlay_generations · pipeline_flatlay_logs ·
 * wardrobe_products_flatlay_grid); a spelling the completion never draws and
 * never inserts is not a string the filter searches. */
const scoreTable = (filter: string, t: TableInfo) =>
  Math.max(fuzzyScore(filter, t.name), fuzzyScore(filter, display(t)));

function tableRun(filter: string, pool: Pool, cap: number): MentionRow[] {
  return ranked(
    pool.tables.map((item, order) => ({ item, score: scoreTable(filter, item), order })),
    cap,
  ).map(tableRow);
}

/** `owner.col`: the part before the last dot names the table (as a whole name
 * or its PREFIX, never a looser reach: a dotted filter is a decision, not a
 * guess), the rest filters its columns; no dot, the column name alone over
 * every table. An empty tail lists the table's columns in position order. */
function columnRun(filter: string, pool: Pool, cap: number): MentionRow[] {
  const dot = filter.lastIndexOf(".");
  const head = dot === -1 ? null : filter.slice(0, dot);
  const tail = dot === -1 ? filter : filter.slice(dot + 1);
  const scored: Scored<{ t: TableInfo; c: TableInfo["columns"][number] }>[] = [];
  pool.tables.forEach((t, ti) => {
    if (head !== null && scoreTable(head, t) < FUZZY_PREFIX) return;
    if (!pathable(t)) return;
    t.columns.forEach((c, ci) => {
      if (!BARE.test(c.name)) return;
      const score = fuzzyScore(tail, c.name);
      if (score > 0) scored.push({ item: { t, c }, score, order: ti * 4096 + ci });
    });
  });
  return ranked(scored, cap).map(({ t, c }) => columnRow(t, c));
}

const savedRun = (filter: string, pool: Pool, cap: number) =>
  ranked(
    pool.saved.map((item, order) => ({ item, score: fuzzyScore(filter, item.name), order })),
    cap,
  ).map(savedRow);

const canvasRun = (filter: string, pool: Pool, cap: number) =>
  ranked(
    pool.canvases.map((item, order) => ({ item, score: fuzzyScore(filter, item.title), order })),
    cap,
  ).map(canvasRow);

const threadRun = (filter: string, pool: Pool, cap: number) =>
  ranked(
    pool.threads.map((item, order) => ({ item, score: fuzzyScore(filter, item.title), order })),
    cap,
  ).map(threadRow);

/** one kind, whichever path the box stands inside */
function pathRun(path: MentionPath, filter: string, pool: Pool): MentionRow[] {
  switch (path) {
    case "tables":
      return tableRun(filter, pool, ROW_CAP);
    case "columns":
      return columnRun(filter, pool, ROW_CAP);
    case "saved":
      return savedRun(filter, pool, ROW_CAP);
    case "canvases":
      return canvasRun(filter, pool, ROW_CAP);
    case "threads":
      return threadRun(filter, pool, ROW_CAP);
  }
}

/** A typed fragment: one run, the categories it reaches on top (they are the
 * cheapest way to narrow what follows), then the kinds in the categories'
 * own order. */
function fragmentRun(filter: string, pool: Pool): MentionRow[] {
  const cats = ranked(
    paths(pool).map((item, order) => ({ item, score: fuzzyScore(filter, `${item}/`), order })),
    MENTION_PATHS.length,
  ).map(categoryRow);
  return [
    ...cats,
    ...tableRun(filter, pool, ROW_CAP),
    ...(filter.length >= COLUMN_MIN_FILTER ? columnRun(filter, pool, ROW_CAP) : []),
    ...savedRun(filter, pool, ROW_CAP),
    ...canvasRun(filter, pool, ROW_CAP),
    ...threadRun(filter, pool, ROW_CAP),
  ];
}

/** A quoted fragment (`@"Monthly rev`) names one of the kinds the grammar
 * quotes, so a relation is never a row and no category is either: a path is
 * unquoted. */
const quotedRun = (filter: string, pool: Pool): MentionRow[] => [
  ...savedRun(filter, pool, ROW_CAP),
  ...canvasRun(filter, pool, ROW_CAP),
  ...threadRun(filter, pool, ROW_CAP),
];

// ---- the sectioned box (an empty filter) -----------------------------------

/** The row a recents pointer stands for, read off the LIVE connection: a
 * dropped table, a deleted bookmark or a closed canvas simply has no row
 * (LESSONS 5, and the pointer is not a copy of the name). */
function recentRow(one: Recent, pool: Pool): MentionRow | null {
  switch (one.kind) {
    case "table": {
      const t = pool.byQualified.get(one.key.toLowerCase());
      return t ? tableRow(t) : null;
    }
    case "column": {
      const dot = one.key.lastIndexOf(".");
      const t = dot === -1 ? undefined : pool.byQualified.get(one.key.slice(0, dot).toLowerCase());
      const c = t?.columns.find((col) => col.name.toLowerCase() === one.key.slice(dot + 1).toLowerCase());
      return t && c && pathable(t) && BARE.test(c.name) ? columnRow(t, c) : null;
    }
    case "saved": {
      const q = pool.saved.find((s) => s.id === one.key);
      return q ? savedRow(q) : null;
    }
    case "thread": {
      const t = pool.threads.find((th) => th.id === one.key);
      return t ? threadRow(t) : null;
    }
    case "canvas": {
      const c = pool.canvases.find((cv) => cv.id === one.key);
      return c ? canvasRow(c) : null;
    }
  }
}

/** the rank a table's recency gives it, for the `Tables` order */
function tableRank(recents: readonly Recent[]): Map<string, number> {
  const rank = new Map<string, number>();
  recents.forEach((r, i) => {
    if (r.kind === "table" && !rank.has(r.key.toLowerCase())) rank.set(r.key.toLowerCase(), i);
  });
  return rank;
}

function sectioned(ctx: MentionRowsCtx, pool: Pool): MentionSection[] {
  const recents = ctx.recents ?? [];
  const recent: MentionRow[] = [];
  const shown = new Set<string>();
  for (const one of recents) {
    if (recent.length === SECTION_CAP.recent) break;
    const row = recentRow(one, pool);
    if (!row || shown.has(row.value)) continue;
    recent.push(row);
    shown.add(row.value);
  }

  // a row `Recent` already shows is not repeated below it (DESIGN rule 14):
  // the kind's section fills with the next by its own order, and the rows are
  // built as they are taken so a 200-table connection builds five
  const fresh = <T>(items: readonly T[], row: (one: T) => MentionRow, cap: number): MentionRow[] => {
    const out: MentionRow[] = [];
    for (const one of items) {
      const built = row(one);
      if (shown.has(built.value)) continue;
      out.push(built);
      if (out.length === cap) break;
    }
    return out;
  };

  // by recent use, then by size: a recent `Recent` could not fit leads the
  // section, and everything else keeps the connection's own order
  const rank = tableRank(recents);
  const tables = pool.tables
    .map((t, order) => ({ t, order, rank: rank.get(qualified(t).toLowerCase()) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);

  return [
    { label: null, rows: paths(pool).map(categoryRow) },
    { label: "Recent", rows: recent },
    { label: "Tables", rows: fresh(tables, ({ t }) => tableRow(t), SECTION_CAP.tables) },
    { label: "Saved", rows: fresh(pool.saved, savedRow, SECTION_CAP.saved) },
    { label: "Canvases", rows: fresh(pool.canvases, canvasRow, SECTION_CAP.canvases) },
    { label: "Threads", rows: fresh(pool.threads, threadRow, SECTION_CAP.threads) },
  ];
}

// ---- the one entry point ---------------------------------------------------

/** What the box holds for the fragment under the caret. `quoted` = the
 * fragment is inside `@"…"`. Four shapes, and the box's height is the same in
 * all of them: the sectioned list (nothing typed), one kind (inside a
 * category), one run (a fragment), one run of the quoted kinds. */
export function sectionsFor(filter: string, quoted: boolean, ctx: MentionRowsCtx): MentionList {
  const pool = poolOf(ctx);
  const { path, text } = quoted ? { path: null, text: filter } : splitFilter(filter);
  const sections: MentionSection[] = quoted
    ? [{ label: null, rows: quotedRun(text, pool) }]
    : path
      ? [{ label: null, rows: pathRun(path, text, pool) }]
      : text.length === 0
        ? sectioned(ctx, pool)
        : [{ label: null, rows: fragmentRun(text, pool) }];
  const kept = sections.filter((s) => s.rows.length > 0);
  const drawn = kept.flatMap((s) => s.rows);
  return { sections: kept, rows: drawn, count: drawn.length, path };
}
