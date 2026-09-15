// Execution-accuracy comparison (EVAL.md section 1) and the gold-check's tie
// test (EVAL.md section 2). SQL text is never compared: many correct queries
// answer one question, so the verdict is a multiset comparison of NORMALISED
// rows, ported from qwry-agent-lab/harness.py `norm_cell` / `run_sql`.
//
// The lab normalised Python objects psycopg had already parsed. This harness
// reads wire text, because AgentRun.rows is defined as what psql shows, so the
// same rules are applied with the column's type OID standing in for the Python
// type. The rules themselves are unchanged: NULL is a glyph, booleans are t/f,
// numbers lose trailing zeros at four decimal places, timestamps are ISO, and
// rows sort as tuples before they are compared.

/** SQL NULL, the same glyph the tools show the model (context.ts NULL_CELL). */
export const NULL_CELL = "∅";

const BOOL = 16;
const INT2 = 21;
const INT4 = 23;
const INT8 = 20;
const OID = 26;
const FLOAT4 = 700;
const FLOAT8 = 701;
const NUMERIC = 1700;
const DATE = 1082;
const TIME = 1083;
const TIMETZ = 1266;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;

const INTEGRAL = new Set([INT2, INT4, INT8, OID]);
const FRACTIONAL = new Set([FLOAT4, FLOAT8, NUMERIC]);
const TEMPORAL = new Set([DATE, TIME, TIMETZ, TIMESTAMP, TIMESTAMPTZ]);

/** harness.py's float branch: an integral value prints as an integer, anything
 * else at four decimal places with the trailing zeros stripped. Ported
 * literally, including the fact that a value below 0.00005 prints as "0." —
 * a rule that is only required to be the SAME on both sides of a comparison. */
function normNumber(text: string): string {
  const f = Number(text);
  if (!Number.isFinite(f)) return text;
  if (f === Math.trunc(f)) return String(Math.trunc(f));
  return f.toFixed(4).replace(/0+$/, "");
}

/** The same four-decimal rule for NUMERIC, done on the digit string: a
 * float64 round trip holds ~16 significant digits, so two different
 * 18-digit NUMERIC values collapsed to one string and compared EQUAL (a false
 * PASS). Decimal text is rounded half-up at four places with BigInt, never
 * parsed as a float. Anything that is not plain decimal text (NaN, Infinity,
 * exponents) falls back to the float rule, which is what PostgreSQL emits
 * for those anyway. */
function normDecimal(text: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return normNumber(text);
  const neg = m[1] === "-";
  let int = m[2].replace(/^0+(?=\d)/, "");
  let frac = m[3] ?? "";
  if (frac.length > 4) {
    const keep = frac.slice(0, 4);
    const roundUp = frac.charCodeAt(4) >= 53; // '5'
    let scaled = BigInt(int + keep) + (roundUp ? 1n : 0n);
    let s = scaled.toString().padStart(5, "0");
    int = s.slice(0, -4);
    frac = s.slice(-4);
  }
  frac = frac.replace(/0+$/, "");
  if (frac === "" && /^0*$/.test(int)) return "0";
  const body = frac === "" ? int : `${int}.${frac}`;
  return neg ? `-${body}` : body;
}

/** PostgreSQL writes a timestamp as `2005-05-24 22:53:30+00`; Python's
 * `isoformat()` writes `2005-05-24T22:53:30+00:00`. The gap is punctuation,
 * and closing it keeps a `timestamp` gold comparable to a `timestamptz`
 * prediction of the same instant. The offset is only recognised AFTER a clock
 * time: `2005-05-24` ends in something that looks exactly like an offset, and
 * a looser rule turned a plain date into `2005-05-24:00`. */
const OFFSET = /(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})(?::?(\d{2}))?$/;

function normTimestamp(text: string): string {
  return text
    .replace(" ", "T")
    .replace(OFFSET, (_m, time: string, hh: string, mm?: string) => `${time}${hh}:${mm ?? "00"}`);
}

/** One cell, by the type PostgreSQL declared for its column. */
export function normCell(value: string | null, typeOid: number): string {
  if (value === null) return NULL_CELL;
  if (typeOid === BOOL) return value;
  if (INTEGRAL.has(typeOid)) return value;
  if (typeOid === NUMERIC) return normDecimal(value);
  if (FRACTIONAL.has(typeOid)) return normNumber(value);
  if (TEMPORAL.has(typeOid)) return normTimestamp(value);
  return value;
}

/** Tuple order, as Python compares tuples of strings: element by element, the
 * shorter tuple first when one is a prefix of the other. */
export function compareRows(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/** A result set as the verdict sees it: normalised and sorted, so two queries
 * that answer the same question in a different row order still agree. */
export function normalise(
  rows: readonly (string | null)[][],
  typeOids: readonly number[],
): string[][] {
  return rows
    .map((row) => row.map((cell, i) => normCell(cell, typeOids[i] ?? 0)))
    .sort(compareRows);
}

/** Multiset equality. Column NAMES are never compared (the question pins the
 * columns, not their labels); column ORDER and arity are, because a tuple is
 * the unit of comparison. */
export function sameRows(a: readonly string[][], b: readonly string[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (compareRows(a[i], b[i]) !== 0) return false;
  }
  return true;
}

// ---- the LIMIT tie check (EVAL.md section 2) ------------------------------

/** Comments and string literals blanked, so a keyword scan cannot fire inside
 * one and offsets stay aligned with the original text. */
export function maskLiterals(sql: string): string {
  const out = sql.split("");
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) j++;
          else break;
        }
        j++;
      }
      for (let k = i + 1; k < Math.min(j, sql.length); k++) out[k] = " ";
      i = j;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") out[j++] = " ";
      i = j;
    }
  }
  return out.join("");
}

/** Positions of the top-level (paren depth 0) occurrences of a keyword. */
function topLevel(masked: string, keyword: RegExp): number[] {
  const hits: number[] = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0) {
      keyword.lastIndex = i;
      const m = keyword.exec(masked);
      if (m && m.index === i) hits.push(i);
    }
  }
  return hits;
}

export interface LimitShape {
  /** the row count the gold asks for */
  limit: number;
  /** the gold with its LIMIT raised by one */
  probeSql: string;
  /** ORDER BY expressions of the outermost query, in order */
  orderBy: string[];
}

/** The gold's trailing LIMIT and the ORDER BY that decides which rows it keeps.
 * `null` when the question does not pin a row count, which is most of them. */
export function limitShape(sql: string): LimitShape | null {
  const masked = maskLiterals(sql);
  const m = /\blimit\s+(\d+)\s*;?\s*$/i.exec(masked);
  if (!m) return null;
  const limit = Number(m[1]);
  const probeSql = `${sql.slice(0, m.index)}LIMIT ${limit + 1}`;

  const orderStarts = topLevel(masked, /\border\s+by\b/giy);
  const last = orderStarts.at(-1);
  if (last === undefined) return { limit, probeSql, orderBy: [] };
  const head = /^\s*order\s+by\s*/i.exec(masked.slice(last));
  const clause = sql.slice(last + (head?.[0].length ?? 0), m.index);
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  const maskedClause = maskLiterals(clause);
  for (let i = 0; i < clause.length; i++) {
    if (maskedClause[i] === "(") depth++;
    else if (maskedClause[i] === ")") depth--;
    else if (maskedClause[i] === "," && depth === 0) {
      items.push(clause.slice(start, i));
      start = i + 1;
    }
  }
  items.push(clause.slice(start));
  const orderBy = items
    .map((s) =>
      s
        .replace(/\s+(asc|desc)\b/gi, "")
        .replace(/\s+nulls\s+(first|last)\b/gi, "")
        .trim(),
    )
    .filter((s) => s.length > 0);
  return { limit, probeSql, orderBy };
}

/** The gold with its ORDER BY expressions added to the select list as
 * `__tie_N`, so an aggregate the question never asked to see can still be
 * compared across the boundary. Applied only to expressions that are not
 * already a result column: a select ALIAS cannot be referenced from the select
 * list that defines it. */
export function withTieColumns(sql: string, exprs: string[]): string | null {
  if (exprs.length === 0) return null;
  const masked = maskLiterals(sql);
  const selects = topLevel(masked, /\bselect\b/giy);
  const at = selects.at(-1);
  if (at === undefined) return null;
  const head = exprs.map((e, i) => `${e} AS __tie_${i}`).join(", ");
  return `${sql.slice(0, at)}SELECT ${head}, ${sql.slice(at + "select".length)}`;
}

export type TieVerdict =
  | { checked: false }
  | { checked: true; tie: boolean | null; rows: number };

/** Does the gold's LIMIT cut through a tie? Runs it with one more row than it
 * asks for and compares the ORDER BY key of the last row it keeps against the
 * first row it drops. A tie means two different answers are both right and the
 * question needs a tiebreaker before it can be scored (EVAL.md section 2).
 * `tie: null` = the boundary could not be read, which is reported, never
 * assumed away. */
export async function tieCheck(
  sql: string,
  run: (sql: string) => Promise<{ columns: string[]; typeOids: number[]; rows: (string | null)[][] }>,
): Promise<TieVerdict> {
  const shape = limitShape(sql);
  if (!shape) return { checked: false };

  const plain = await run(shape.probeSql);
  if (plain.rows.length <= shape.limit) {
    return { checked: true, tie: false, rows: plain.rows.length };
  }

  const lower = plain.columns.map((c) => c.toLowerCase());
  const positions: number[] = [];
  const unresolved: string[] = [];
  for (const expr of shape.orderBy) {
    const bare = expr.split(".").pop()?.replace(/"/g, "").toLowerCase() ?? "";
    const at = /^[a-z_][a-z0-9_]*$/.test(bare) ? lower.indexOf(bare) : -1;
    if (at !== -1) positions.push(at);
    else unresolved.push(expr);
  }

  let result = plain;
  let keys = positions;
  if (unresolved.length > 0) {
    const rewritten = withTieColumns(shape.probeSql, unresolved);
    if (rewritten) {
      try {
        const extra = await run(rewritten);
        const added = unresolved.map((_e, i) => extra.columns.indexOf(`__tie_${i}`));
        // the rewrite is only believed when the columns it asked for came
        // back: an assumed position would silently compare the wrong cells
        if (added.every((at) => at !== -1)) {
          result = extra;
          keys = [...added, ...positions.map((p) => extra.columns.indexOf(plain.columns[p]))]
            .filter((at) => at !== -1);
        }
      } catch {
        // the rewrite did not parse: report an unreadable boundary rather
        // than a clean bill of health
      }
    }
  }
  if (unresolved.length > 0 && result === plain) return { checked: true, tie: null, rows: plain.rows.length };
  if (keys.length === 0) return { checked: true, tie: null, rows: plain.rows.length };

  const kept = result.rows[shape.limit - 1];
  const dropped = result.rows[shape.limit];
  if (!kept || !dropped) return { checked: true, tie: null, rows: result.rows.length };
  const tie = keys.every(
    (k) => normCell(kept[k], result.typeOids[k] ?? 0) === normCell(dropped[k], result.typeOids[k] ?? 0),
  );
  return { checked: true, tie, rows: plain.rows.length };
}
