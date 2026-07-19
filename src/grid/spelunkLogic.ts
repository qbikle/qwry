// Pure logic for the data-navigation wave: sort-chain math (multi-column
// sort), row-diff computation, histogram bucketing, and the SQL text for the
// FK picker + value-distribution queries. No runtime imports beyond the pure
// identifier quoting in lib/sqlIdent, so a bun harness can exercise the exact
// strings/orderings the app ships without loading Tauri/zustand.
import { qi, qualify } from "../lib/sqlIdent";

// ---- sort chain -------------------------------------------------------------

/** one entry of a multi-column sort chain; K = column key (name for browse
 * tabs, data index for editor results). `nulls` undefined = server/grid
 * default ordering. */
export interface ChainEntry<K> {
  key: K;
  dir: "asc" | "desc";
  nulls?: "first" | "last";
}

/** plain click: single-sort tri-state (existing grammar). The chain collapses
 * to just this column — asc → desc → cleared. A flip keeps the entry's NULLS
 * preference; switching columns starts fresh. */
export function cycleChain<K>(chain: ChainEntry<K>[], key: K): ChainEntry<K>[] {
  if (chain.length === 1 && chain[0].key === key) {
    if (chain[0].dir === "asc") return [{ ...chain[0], dir: "desc" }];
    return [];
  }
  return [{ key, dir: "asc" }];
}

/** shift-click: append this column to the chain (asc), or toggle an existing
 * entry asc → desc → removed. Positions of other entries never move. */
export function shiftToggleChain<K>(chain: ChainEntry<K>[], key: K): ChainEntry<K>[] {
  const i = chain.findIndex((e) => e.key === key);
  if (i === -1) return [...chain, { key, dir: "asc" }];
  if (chain[i].dir === "asc")
    return chain.map((e, j) => (j === i ? { ...e, dir: "desc" as const } : e));
  return chain.filter((_, j) => j !== i);
}

/** ⌥-click: cycle the NULLS placement on this column's entry —
 * default → FIRST → LAST → default. Not in the chain = no-op (returns the
 * SAME array so callers can skip the dispatch). */
export function altCycleNulls<K>(chain: ChainEntry<K>[], key: K): ChainEntry<K>[] {
  const i = chain.findIndex((e) => e.key === key);
  if (i === -1) return chain;
  return chain.map((e, j) => {
    if (j !== i) return e;
    const next = e.nulls === undefined ? "first" : e.nulls === "first" ? "last" : undefined;
    const { nulls: _drop, ...rest } = e;
    return next ? { ...rest, nulls: next } : rest;
  });
}

// ---- client-side stable multi-sort ------------------------------------------

/** wire-text comparison: numeric when the column is numeric-typed AND both
 * values parse (mirrors the original single-column client sort exactly). */
export function compareWire(a: string, b: string, numeric: boolean): number {
  if (numeric) {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface SortSpec {
  col: number;
  mul: 1 | -1;
  numeric: boolean;
  /** true = NULLs sort to the top; false = bottom. Compute via nullsFirstOf
   * so the client default matches the server's direction-dependent one. */
  nullsFirst: boolean;
}

/** effective NULL placement for a chain entry — PG semantics: an explicit
 * NULLS FIRST/LAST wins; the default is DIRECTION-DEPENDENT (ASC ⇒ NULLS
 * LAST, DESC ⇒ NULLS FIRST), so the three ⌥-cycle states are three distinct
 * behaviors: default follows the direction, first/last stay pinned. */
export function nullsFirstOf(dir: "asc" | "desc", nulls?: "first" | "last"): boolean {
  return nulls ? nulls === "first" : dir === "desc";
}

/** stable multi-key sort of `base` (data-row indexes) by the chain specs —
 * ties keep base order (Array.sort stability), so layering under the
 * quick-filter view map preserves stream order for equal keys. */
export function multiSortIndices(
  base: readonly number[],
  rows: readonly (readonly (string | null)[])[],
  specs: readonly SortSpec[],
): number[] {
  const idx = [...base];
  idx.sort((a, b) => {
    for (const s of specs) {
      const va = rows[a]?.[s.col] ?? null;
      const vb = rows[b]?.[s.col] ?? null;
      if (va === null || vb === null) {
        if (va === null && vb === null) continue;
        return (va === null ? 1 : -1) * (s.nullsFirst ? -1 : 1);
      }
      const c = compareWire(va, vb, s.numeric);
      if (c !== 0) return c * s.mul;
    }
    return 0;
  });
  return idx;
}

// ---- row diff ---------------------------------------------------------------

/** per-column "differs" mask for two rows (SQL NULL only equals NULL) */
export function diffMask(
  a: readonly (string | null)[],
  b: readonly (string | null)[],
): boolean[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<boolean>(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] ?? null) !== (b[i] ?? null);
  return out;
}

// ---- histogram --------------------------------------------------------------

export const HISTOGRAM_TOP = 12;

export interface HistBucket {
  value: string | null;
  count: number;
  /** count / total (0 when total is 0) */
  share: number;
}

/** top-N value counts over loaded rows; NULL is its own bucket, labeled
 * separately — `distinct` counts NON-NULL values only (`hasNull` says whether
 * a NULL bucket exists) */
export function bucketize(
  values: readonly (string | null)[],
  top = HISTOGRAM_TOP,
): { buckets: HistBucket[]; total: number; distinct: number; hasNull: boolean } {
  const counts = new Map<string | null, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const entries = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const total = values.length;
  const hasNull = counts.has(null);
  return {
    buckets: entries
      .slice(0, top)
      .map(([value, count]) => ({ value, count, share: total > 0 ? count / total : 0 })),
    total,
    distinct: counts.size - (hasNull ? 1 : 0),
    hasNull,
  };
}

/** json (not jsonb) has no equality operator — server GROUP BY would error;
 * the caller must bucket client-side over loaded rows instead */
export function jsonNoEquality(typeName: string | undefined): boolean {
  if (!typeName) return false;
  const t = typeName.toLowerCase();
  return t === "json" || t === "_json" || t === "json[]";
}

/** value-distribution query: one round trip returns the top groups plus the
 * whole-source totals via window aggregates (sum of group counts = total
 * rows, count(*) over groups = group count, count(col) over groups = distinct
 * NON-NULL values since each group row carries its key — windows run after
 * GROUP BY and before LIMIT; group count minus non-null count says whether a
 * NULL bucket exists). `where` is a pre-compiled predicate or null. */
export function histogramSql(s: {
  schema: string;
  table: string;
  column: string;
  where: string | null;
}): string {
  const w = s.where ? `\nWHERE ${s.where}` : "";
  return (
    `SELECT ${qi(s.column)}, count(*), sum(count(*)) OVER (), count(*) OVER (), count(${qi(s.column)}) OVER ()` +
    `\nFROM ${qualify(s.schema, s.table)}${w}` +
    `\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT ${HISTOGRAM_TOP}`
  );
}

// ---- FK picker --------------------------------------------------------------

/** single-quoted SQL text literal (the app-wide '' doubling) */
export const sqlLit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** escape LIKE/ILIKE metacharacters so user text matches literally */
export const likeEscape = (v: string) => v.replace(/([%_\\])/g, "\\$1");

export interface FkPickTarget {
  schema: string;
  table: string;
  /** the referenced (unique) column the FK points at */
  refCol: string;
  /** up to 2 text-ish display columns of the referenced table */
  labelCols: string[];
}

/** live search over the referenced table: the referenced key (::text) and the
 * label columns are ILIKE-matched; empty search lists the first page */
export function fkPickerSql(t: FkPickTarget, search: string): string {
  const cols = [t.refCol, ...t.labelCols].map(qi).join(", ");
  let where = "";
  if (search !== "") {
    const pat = sqlLit(`%${likeEscape(search)}%`);
    const hay = [
      `${qi(t.refCol)}::text ILIKE ${pat}`,
      ...t.labelCols.map((c) => `${qi(c)} ILIKE ${pat}`),
    ];
    where = `\nWHERE ${hay.join(" OR ")}`;
  }
  return `SELECT ${cols} FROM ${qualify(t.schema, t.table)}${where}\nLIMIT 50`;
}

const TEXTISH = /^(text|citext|name|character varying|character|varchar|bpchar)\b|^(text|citext|name|varchar|bpchar)\(/;

/** up to 2 human-readable label columns for the picker (text-family scalars,
 * never arrays, never the referenced key itself) */
export function textishLabelCols(
  columns: readonly { name: string; type: string }[],
  exclude: string,
): string[] {
  return columns
    .filter((c) => {
      if (c.name === exclude) return false;
      const t = c.type.toLowerCase();
      if (t.endsWith("]")) return false; // arrays
      return TEXTISH.test(t) || t === "text";
    })
    .slice(0, 2)
    .map((c) => c.name);
}
