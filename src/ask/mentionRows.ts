// The `@` under the caret and what the popover offers for it (W6). Pure and
// DOM-free: AskPanel reads the textarea and hands the text and the caret to
// `mentionQueryAt`, MentionPopover hands the fragment and what the connection
// has to `mentionRows` and only draws the rows back, so the rule for which
// rows a fragment yields is a unit test (mentionRows.test.ts) and never a
// frame. The grammar itself is src/agent/mentions.ts: what a pick INSERTS is
// its `canonicalToken`, and the fragment rule here is that grammar read up to
// the caret (an identifier path, or a quoted name still open).
//
// The groups are the order the popover draws them in and nothing more: W7
// took the headings out and gave every row its kind (`MentionRow.kind`) as an
// icon instead, so a fragment's rows read as one run, tables first.
//
// Rows are matched by the name the user would type, never fuzzily: a row
// under `ord` contains `ord`, and a column row matches on the COLUMN's name
// alone (the table part is shown, not searched; a filter that means a table's
// columns spells the dot: `order_v2.ord`). A prefix match outranks a
// substring match, and ties keep the connection's own order (tables largest
// first, columns by position, saved queries and threads as their lists hold
// them). Legacy, system, housekeeping and partition relations are never rows
// (AGENT-SPEC section 6 rule 3: a row that cannot be the answer is a dead
// row), foreign tables neither (the candidate block drops them).

import { canonicalToken } from "../agent/mentions";
import { isBannedRelation } from "../agent/starterPool";
import type { MentionKind, Thread } from "../agent/types";
import type { MentionQuery } from "../stores/ask";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot, TableInfo } from "../stores/schema";

/** columns are offered from this many typed characters: a one-letter filter
 * over every column is a flood, not a list */
export const COLUMN_MIN_FILTER = 2;
/** the most column rows one fragment yields */
export const COLUMN_ROW_CAP = 40;

const PUBLIC = "public";

// ---- the caret's `@` -------------------------------------------------------

/** the grammar's word boundary (mentions.ts WORDY): `a@b` is one word */
const WORDY = /[\p{L}\p{N}_]/u;
/** a character of an identifier path fragment */
const PATH = /[A-Za-z0-9_.]/;
/** one unquoted segment of the grammar's identifier path */
const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const boundary = (text: string, at: number) => at === 0 || !WORDY.test(text[at - 1]);

/** The `@` token the caret sits in, with the text typed after the `@` up to
 * the caret as the filter; null when the caret is not inside one. An
 * identifier path ends at a space or any character outside `[A-Za-z0-9_.]`;
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
  kind: MentionKind;
  /** cmdk's value: unique (kind and identity), so Enter routes by it */
  value: string;
  /** what a pick inserts, `@` included (mentions.ts canonicalToken) */
  token: string;
  /** a table's display name, a saved query's name, a thread's title; a column
   * row's table part (`owner`) rides here and its column in `column` */
  label: string;
  /** a column row: `.column`, whole; the label is the table it belongs to */
  column?: string;
  /** the mono hint slot: a table's row estimate or column count, a column's
   * type; null for a saved query and a thread (the name is the whole fact) */
  hint: string | null;
}

/** the four kinds in the order the popover lays them out; the popover draws
 * them as one flat run, each row wearing its kind */
export interface MentionGroups {
  tables: MentionRow[];
  columns: MentionRow[];
  saved: MentionRow[];
  threads: MentionRow[];
  count: number;
}

export interface MentionRowsCtx {
  snapshot: SchemaSnapshot | null | undefined;
  saved: readonly SavedQuery[];
  threads: readonly Thread[];
  /** the thread being asked in: never offered to itself */
  currentThreadId?: string | null;
}

/** 2 = prefix, 1 = substring, 0 = no match; case-insensitive */
const score = (candidate: string, needle: string): number => {
  const c = candidate.toLowerCase();
  return c.startsWith(needle) ? 2 : needle && c.includes(needle) ? 1 : 0;
};

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

interface Scored<T> {
  item: T;
  score: number;
  order: number;
}

const ranked = <T>(list: Scored<T>[]) =>
  list.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);

/** The rows a fragment yields, grouped in the order the popover draws them.
 * `quoted` = the fragment is inside `@"…"`: a saved query or a thread, never
 * a relation. */
export function mentionRows(filter: string, quoted: boolean, ctx: MentionRowsCtx): MentionGroups {
  const needle = filter.toLowerCase();
  const out: MentionGroups = { tables: [], columns: [], saved: [], threads: [], count: 0 };

  if (!quoted) {
    // largest first, then by name: the connection's order for every tie
    const askable = (ctx.snapshot?.tables ?? [])
      .filter((t) => !banned(t))
      .sort((a, b) => rows(b) - rows(a) || display(a).localeCompare(display(b)));

    out.tables = ranked(
      askable.map((t, order) => ({
        item: t,
        score: Math.max(score(t.name, needle), score(qualified(t), needle)),
        order,
      })),
    ).map(({ item: t }) => ({
      kind: "table",
      value: `table:${qualified(t)}`,
      token: canonicalToken("table", { schema: t.schema, table: t.name }),
      label: display(t),
      hint: tableHint(t),
    }));

    if (filter.length >= COLUMN_MIN_FILTER) {
      // `owner.col`: the part before the last dot names the table (as a whole
      // name or its prefix), the rest filters its columns; no dot: the column
      // name alone, over every table
      const dot = filter.lastIndexOf(".");
      const head = dot === -1 ? null : needle.slice(0, dot);
      const tail = dot === -1 ? needle : needle.slice(dot + 1);
      const scored: Scored<{ t: TableInfo; c: TableInfo["columns"][number] }>[] = [];
      askable.forEach((t, ti) => {
        if (head !== null && score(t.name, head) !== 2 && score(qualified(t), head) !== 2) return;
        // the grammar has no quoted path: a column whose path would need
        // quotes has no token, so no row
        if (!BARE.test(t.name) || (t.schema !== PUBLIC && !BARE.test(t.schema))) return;
        t.columns.forEach((c, ci) => {
          if (!BARE.test(c.name)) return;
          const s = head !== null && tail === "" ? 2 : score(c.name, tail);
          if (s > 0) scored.push({ item: { t, c }, score: s, order: ti * 4096 + ci });
        });
      });
      out.columns = ranked(scored)
        .slice(0, COLUMN_ROW_CAP)
        .map(({ item: { t, c } }) => ({
          kind: "column",
          value: `column:${qualified(t)}.${c.name}`,
          token: canonicalToken("column", { schema: t.schema, table: t.name, column: c.name }),
          label: display(t),
          column: `.${c.name}`,
          hint: shortType(c.type),
        }));
    }
  }

  out.saved = ranked(
    ctx.saved
      .filter((q) => nameable(q.name))
      .map((q, order) => ({ item: q, score: score(q.name, needle), order })),
  ).map(({ item: q }) => ({
    kind: "saved",
    value: `saved:${q.id}`,
    token: canonicalToken("saved", { id: q.id, name: q.name, sql: q.sql }),
    label: q.name,
    hint: null,
  }));

  out.threads = ranked(
    ctx.threads
      .filter((t) => t.id !== ctx.currentThreadId && nameable(t.title))
      .map((t, order) => ({ item: t, score: score(t.title, needle), order })),
  ).map(({ item: t }) => ({
    kind: "thread",
    value: `thread:${t.id}`,
    token: canonicalToken("thread", { id: t.id, title: t.title }),
    label: t.title,
    hint: null,
  }));

  out.count = out.tables.length + out.columns.length + out.saved.length + out.threads.length;
  return out;
}
