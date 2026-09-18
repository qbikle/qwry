// The New Chart dialog's composer (F2, AGENT-UX §16ii): three picks in, ONE
// aggregate statement out, plus the two sentences that statement is read as.
// Pure, with no store, no DOM and no session in it, because everything the
// dialog does stands on it: the preview runs what this returns, the widget
// keeps what this returned, and `Ask instead` hands the model the same picks
// in words. A composer that lived in the component could only be checked by
// looking at a frame (LESSONS 12: a reviewer that can execute beats one that
// reads).
//
// Identifiers are quoted only where a bare one would not parse, so the
// statement the reader sees under the preview is the statement they would have
// typed (`select status, count(*) as count from public.order_v2 …`), and a
// column named `select` or `Total Sales` still runs.
//
// One measure this wave (the chart face takes three series; a second is
// ledgered), no WHERE and no sort control: value descending for a text group,
// label ascending for a date one, and `Ask instead` is the route to anything
// else (DESIGN rule 15).

/** what a column's type makes it, for the three rows that care: a group, a
 * measure, and whether the `Per` row stands at all */
export type ColumnKind = "numeric" | "date" | "text";

/** the four the segmented control offers beside a measure column; `count`
 * is the measure row's own first entry and takes no column */
export type Aggregate = "sum" | "avg" | "min" | "max";

export type DateUnit = "day" | "week" | "month" | "year";

/** the units the `Per` row offers, in the order it draws them */
export const DATE_UNITS: readonly DateUnit[] = ["day", "week", "month", "year"];

export const AGGREGATES: readonly Aggregate[] = ["sum", "avg", "min", "max"];

/** what `to_char` is given per unit. A week is labelled by the day it starts
 * on, because `IYYY-IW` sorts right but reads as nothing a reader recognises.
 *
 * `year` is deliberately the one unit whose label does NOT parse as a date to
 * the chart face (`DATE_LABEL` in stores/canvas wants a month), so a chart by
 * year draws BARS. That is the honest reading of four or five points anyway,
 * and it is ledgered rather than worked around: the alternative was a label
 * padded to `2026-01` that lies about which month it counts. */
export const DATE_FORMAT: Record<DateUnit, string> = {
  day: "YYYY-MM-DD",
  week: "YYYY-MM-DD",
  month: "YYYY-MM",
  year: "YYYY",
};

/** the row caps the `Top` / `Last` picker offers. The last is the document's
 * own chart cap (`CHART_ROW_CAP`), because a statement that asks for more than
 * a widget can hold would draw no chart at all */
export const CHART_LIMITS: readonly number[] = [5, 10, 20, 50, 100, 200];

/** the count a fresh pick starts on, and the twelve a date group starts on:
 * twelve months is the reading a year of a line is asked for */
export const DEFAULT_LIMIT = 10;
export const DEFAULT_DATE_LIMIT = 12;

export interface ChartPicks {
  schema: string;
  table: string;
  group: string;
  groupKind: ColumnKind;
  /** read only when `groupKind` is "date" */
  unit: DateUnit;
  /** null = `Count rows`, the measure row's own first entry */
  measure: string | null;
  /** read only when `measure` is a column */
  agg: Aggregate;
  limit: number;
}

/** what `Ask instead` can say with picks that are not complete yet: the table
 * alone, or nothing at all */
export interface AskPicks {
  table: string | null;
  group: string | null;
  groupKind: ColumnKind;
  unit: DateUnit;
  measure: string | null;
  agg: Aggregate;
}

// ---- identifiers ----------------------------------------------------------

/** PostgreSQL's reserved words, plus the type/function names that cannot open
 * a column reference. Short on purpose: an unreserved word that reads oddly
 * unquoted still parses, and quoting every identifier would put `"status"` in
 * front of a reader who typed `status` (DESIGN rule 14's spirit: the statement
 * says the table, so it should say it the way the reader would). */
const RESERVED = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "authorization", "between", "binary", "both", "case", "cast", "check",
  "collate", "collation", "column", "concurrently", "constraint", "create",
  "cross", "current_catalog", "current_date", "current_role", "current_schema",
  "current_time", "current_timestamp", "current_user", "default", "deferrable",
  "desc", "distinct", "do", "else", "end", "except", "false", "fetch", "for",
  "foreign", "freeze", "from", "full", "grant", "group", "having", "ilike",
  "in", "initially", "inner", "intersect", "into", "is", "isnull", "join",
  "lateral", "leading", "left", "like", "limit", "localtime", "localtimestamp",
  "natural", "not", "notnull", "null", "offset", "on", "only", "or", "order",
  "outer", "overlaps", "placing", "primary", "references", "returning",
  "right", "select", "session_user", "similar", "some", "symmetric", "table",
  "tablesample", "then", "to", "trailing", "true", "union", "unique", "user",
  "using", "variadic", "verbose", "when", "where", "window", "with",
]);

/** a name PostgreSQL reads unquoted exactly as it is written: lower case,
 * opening on a letter or `_`, and not a reserved word */
const BARE = /^[a-z_][a-z0-9_$]*$/;

/** an identifier as the statement must carry it: bare where bare is faithful,
 * double-quoted (inner quotes doubled) where it is not */
export function quoteIdent(name: string): string {
  if (BARE.test(name) && !RESERVED.has(name)) return name;
  return `"${name.split('"').join('""')}"`;
}

// ---- the column's own reading ---------------------------------------------

const NUMERIC_TYPES = new Set([
  "smallint", "integer", "int", "int2", "int4", "int8", "bigint",
  "numeric", "decimal", "real", "float", "float4", "float8",
  "double precision", "money",
]);

const DATE_TYPES = new Set([
  "date", "timestamp", "timestamptz",
  "timestamp with time zone", "timestamp without time zone",
]);

/** the type string a snapshot carries (`format_type`'s own words) read as one
 * of three kinds. An ARRAY of anything is text: nothing in it can be summed or
 * truncated, and offering it as a measure would compose a statement that
 * fails at the server rather than a chart (LESSONS 5's inverse: refuse what
 * cannot work, never what merely looks unusual). */
export function columnKindOf(type: string): ColumnKind {
  const raw = type.trim().toLowerCase();
  if (raw.endsWith("[]") || raw.startsWith("array")) return "text";
  // `numeric(10,2)`, `timestamp(3) with time zone`: the precision is not part
  // of the kind
  const bare = raw.replace(/\(\s*\d+\s*(,\s*\d+\s*)?\)/g, "").replace(/\s+/g, " ").trim();
  if (NUMERIC_TYPES.has(bare)) return "numeric";
  if (DATE_TYPES.has(bare)) return "date";
  return "text";
}

// ---- the statement --------------------------------------------------------

const measureOf = (p: ChartPicks): string =>
  p.measure === null
    ? `count(*) as ${quoteIdent("count")}`
    : `${p.agg}(${quoteIdent(p.measure)}) as ${quoteIdent(`${p.agg}_${p.measure}`)}`;

/** the one statement three picks compose. Nulls are included: a group with no
 * value is a real answer about the table and dropping it would make the chart
 * disagree with a `count(*)` of the same relation.
 *
 * A DATE group asks for the NEWEST N and then reads them left to right, which
 * takes two orderings and therefore a subquery: `order by 1 desc limit 12`
 * chooses the twelve months, `order by 1` on the outside draws them in the
 * direction a line is read. A text group needs no wrap: the biggest N and the
 * order the bars stand in are the same ordering. */
export function chartSql(p: ChartPicks): string {
  const rel = `${quoteIdent(p.schema)}.${quoteIdent(p.table)}`;
  const measure = measureOf(p);
  if (p.groupKind === "date") {
    const label = `to_char(date_trunc('${p.unit}', ${quoteIdent(p.group)}), '${DATE_FORMAT[p.unit]}') as ${quoteIdent(p.group)}`;
    const newest = `select ${label}, ${measure} from ${rel} group by 1 order by 1 desc limit ${p.limit}`;
    return `select * from (${newest}) t order by 1`;
  }
  return `select ${quoteIdent(p.group)}, ${measure} from ${rel} group by 1 order by 2 desc limit ${p.limit}`;
}

/** the widget's own title line: the READING, never the table (the statement
 * under it says the table, DESIGN rule 14). Identifiers wear data's clothes
 * inside chrome (WRITING's identifiers rule): backticks, which `titleOf`
 * renders as mono the same way the model's own titles are rendered. */
export function chartTitle(p: ChartPicks): string {
  const measure = p.measure === null ? "count" : `${p.agg} \`${p.measure}\``;
  const by = p.groupKind === "date" ? `${p.unit} of \`${p.group}\`` : `\`${p.group}\``;
  return `${measure} by ${by}`;
}

/** the words `Ask instead` leaves in the composer after the canvas pill: the
 * picks as a person would have typed them (WRITING's app-composed-question
 * register, sentence case, no terminal period). With no table picked yet it is
 * the sentence the `Chart…` row has always left there. */
export function chartAskWords(p: AskPicks): string {
  if (!p.table) return "add a chart of ";
  const measure = p.measure === null ? "" : `${p.agg} ${p.measure} in `;
  if (!p.group) return `add a chart of ${measure}${p.table}`;
  const by = p.groupKind === "date" ? `${p.unit} of ${p.group}` : p.group;
  return `add a chart of ${measure}${p.table} by ${by}`;
}
