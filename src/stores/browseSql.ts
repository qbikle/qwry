// Pure SQL generation for the table browser: filters, page-1 SELECT and
// keyset pagination. No runtime imports (type-only) so correctness harnesses
// can exercise the exact SQL the app generates without loading Tauri/zustand.
import type { TableInfo } from "./schema";

export type FilterOp =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "contains"
  | "starts with"
  | "ends with"
  | "LIKE"
  | "ILIKE"
  | "NOT LIKE"
  | "NOT ILIKE"
  | "~"
  | "!~"
  | "IN"
  | "NOT IN"
  | "IS"
  | "IS NOT"
  | "IS NULL"
  | "IS NOT NULL"
  | "IS TRUE"
  | "IS FALSE"
  | "raw SQL";

export const FILTER_OPS: FilterOp[] = [
  "=", "!=", ">", "<", ">=", "<=",
  "contains", "starts with", "ends with",
  "LIKE", "ILIKE", "NOT LIKE", "NOT ILIKE", "~", "!~",
  "IN", "NOT IN", "IS NULL", "IS NOT NULL", "IS TRUE", "IS FALSE",
  "raw SQL",
];

/** operators that make sense for a column's type — everything else is noise
 * (or a guaranteed server error, e.g. ILIKE on an integer) */
export function opsForType(type: string): FilterOp[] {
  const t = type.toLowerCase();
  if (t === "boolean" || t === "bool") return ["IS", "IS NOT", "raw SQL"];
  if (/int|numeric|decimal|real|double|float|money|serial|oid/.test(t))
    return ["=", "!=", ">", "<", ">=", "<=", "IN", "NOT IN", "IS NULL", "IS NOT NULL", "raw SQL"];
  if (/timestamp|date|time|interval/.test(t))
    return ["=", "!=", ">", "<", ">=", "<=", "IS NULL", "IS NOT NULL", "raw SQL"];
  if (/json|uuid|bytea/.test(t))
    return ["=", "!=", "IS NULL", "IS NOT NULL", "raw SQL"];
  return FILTER_OPS;
}

const NO_VALUE_OPS = new Set<FilterOp>(["IS NULL", "IS NOT NULL", "IS TRUE", "IS FALSE"]);
export const opNeedsValue = (op: FilterOp) => !NO_VALUE_OPS.has(op);

export interface Filter {
  col: string;
  op: FilterOp;
  value: string;
  enabled: boolean;
  /** how this row chains onto the previous one (ignored on the first) */
  conj: "AND" | "OR";
}

const ql = (v: string) => `'${v.replace(/'/g, "''")}'`;
const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** the folded filter expression (no leading WHERE), or null when no filter is
 * active. Folds left-associatively so the SQL means what the linear UI reads:
 * A OR B AND C compiles to ((A OR B) AND C), never A OR (B AND C) */
function filterExpr(filters: Filter[]): string | null {
  const active = filters.filter(
    (f) => f.enabled && f.col && (!opNeedsValue(f.op) || f.value !== ""),
  );
  if (active.length === 0) return null;
  const like = (v: string) => v.replace(/([%_\\])/g, "\\$1");
  const conds = active.map((f) => {
    switch (f.op) {
      case "IS NULL":
      case "IS NOT NULL":
      case "IS TRUE":
      case "IS FALSE":
        return `${qi(f.col)} ${f.op}`;
      case "IS":
      case "IS NOT": {
        // bool three-state — value comes from a fixed select, whitelisted
        const kw = ["TRUE", "FALSE", "NULL"].includes(f.value) ? f.value : "TRUE";
        return `${qi(f.col)} ${f.op} ${kw}`;
      }
      case "IN":
      case "NOT IN": {
        const vals = f.value.split(",").map((v) => ql(v.trim())).join(", ");
        return `${qi(f.col)} ${f.op} (${vals})`;
      }
      case "contains":
        return `${qi(f.col)} ILIKE ${ql(`%${like(f.value)}%`)}`;
      case "starts with":
        return `${qi(f.col)} ILIKE ${ql(`${like(f.value)}%`)}`;
      case "ends with":
        return `${qi(f.col)} ILIKE ${ql(`%${like(f.value)}`)}`;
      case "raw SQL":
        // explicit escape hatch — the value is a predicate, used verbatim
        return `(${f.value})`;
      default:
        return `${qi(f.col)} ${f.op} ${ql(f.value)}`;
    }
  });
  return conds
    .map((c) => `(${c})`)
    .reduce((acc, c, i) => (i === 0 ? c : `(${acc} ${active[i].conj} ${c})`));
}

export interface BrowseSort {
  col: string;
  dir: "ASC" | "DESC";
}

/** one ORDER BY key of a keyset-paginated browse. `cast` is the column's own
 * type text (server-side format_type output from the schema snapshot — the
 * same wire-text + `::cast` approach the edit path uses), so seek values are
 * compared with the column's type semantics, never as bare strings. */
export interface KeysetKey {
  col: string;
  dir: "ASC" | "DESC";
  cast: string;
  /** catalog says NOT NULL — enables the row-value fast path */
  notNull: boolean;
}

/** row-estimate ceiling for ctid keyset on PK-less tables (see gate below) */
export const CTID_KEYSET_MAX_ESTIMATE = 1_000_000;

/** The total-order sort keys for keyset pagination: the user's sort column
 * (if any) followed by a unique tiebreaker — the PK, or ctid for PK-less
 * ordinary tables. The tiebreaker inherits the sort direction so every key
 * runs the same way (row-value seeks stay valid, and one composite index
 * serves both directions via backward scan).
 *
 * Returns null when this relation CANNOT be keyset-paginated safely — the
 * caller must fall back to the offset approach instead of a wrong-rows
 * keyset. Non-keysettable: views/matviews/foreign tables (no PK, no usable
 * ctid), partitioned tables without a PK (ctid is not unique across
 * partitions), inheritance parents without a PK (child heaps have colliding
 * ctids — TimescaleDB hypertables are relkind='r' PK-less parents),
 * PK-less tables on PG < 14 (no tid btree opclass, so `ORDER BY ctid` / tid
 * comparisons fail), PK-less tables too big (or unsized) for the ctid gate
 * below, and any sort/PK column missing from the snapshot (schema drift —
 * refuse rather than guess). */
export function keysetKeys(
  table: TableInfo,
  sort: BrowseSort | null,
  serverVersionNum: number | null | undefined,
): KeysetKey[] | null {
  const dir = sort?.dir ?? "ASC";
  const colInfo = (name: string) => table.columns.find((c) => c.name === name);
  let tiebreak: KeysetKey[];
  if (table.pk.length > 0) {
    tiebreak = [];
    for (const pc of table.pk) {
      if (sort && pc === sort.col) continue; // already a key via the sort
      const ci = colInfo(pc);
      if (!ci) return null;
      tiebreak.push({ col: pc, dir, cast: ci.type, notNull: ci.not_null });
    }
  } else if (
    table.kind === "r" &&
    (serverVersionNum ?? 0) >= 140000 &&
    // has_children (relhassubclass) must be a known false: an inheritance
    // parent's SELECT scans child heaps whose ctids collide with the parent's
    // — a ctid seek would splice wrong rows. undefined = old cached snapshot
    // that never captured the flag → refuse (fail safe; the live introspect
    // corrects it).
    table.has_children === false &&
    // Size gate (tradeoff): TID scans carry no pathkeys, so EVERY page of
    // `ORDER BY ctid` is a full seq scan + top-N sort — O(table) per page.
    // That stays interactive only on smallish heaps; above ~1M estimated rows
    // it violates never-slow, so we take the documented offset fallback (its
    // dup/drop risk on PK-less physical order beats multi-second pages).
    // reltuples < 0 (never analyzed) or missing (old cache) = no estimate →
    // refuse (fail safe).
    typeof table.reltuples === "number" &&
    table.reltuples >= 0 &&
    table.reltuples <= CTID_KEYSET_MAX_ESTIMATE
  ) {
    tiebreak = [{ col: "ctid", dir, cast: "tid", notNull: true }];
  } else {
    return null;
  }
  if (!sort) return tiebreak;
  const sc = colInfo(sort.col);
  if (!sc) return null;
  // the sort key is ALWAYS treated as nullable: its snapshot not_null can go
  // stale (external ALTER between introspect and scroll) and a wrongly
  // trusted NOT NULL would silently drop the whole NULL partition. The extra
  // OR IS NULL term matches nothing on a truly NOT NULL column. PK/ctid keys
  // keep their flag — NOT NULL is structural there for as long as the PK the
  // snapshot promised exists at all.
  return [{ col: sort.col, dir: sort.dir, cast: sc.type, notNull: false }, ...tiebreak];
}

const orderBy = (keys: KeysetKey[]) =>
  `\nORDER BY ${keys.map((k) => `${qi(k.col)} ${k.dir}`).join(", ")}`;

/** ordinary tables without a PK get ctid so they stay editable/deletable
 * (and so the ctid keyset tiebreaker is present in the result) */
const selectCols = (table: TableInfo) =>
  table.pk.length === 0 && table.kind === "r" ? "ctid, *" : "*";

export function browseSql(s: {
  table: TableInfo;
  filters: Filter[];
  sort: BrowseSort | null;
  limit: number;
  /** keyset sort keys — when present they define the ORDER BY (they already
   * start with the user sort); null/absent = non-keysettable legacy shape */
  keys?: KeysetKey[] | null;
}): string {
  const t = `${qi(s.table.schema)}.${qi(s.table.name)}`;
  const f = filterExpr(s.filters);
  const where = f ? `\nWHERE ${f}` : "";
  const order =
    s.keys && s.keys.length > 0
      ? orderBy(s.keys)
      : s.sort
        ? `\nORDER BY ${qi(s.sort.col)} ${s.sort.dir}`
        : "";
  return `SELECT ${selectCols(s.table)} FROM ${t}${where}${order}\nLIMIT ${s.limit}`;
}

/** "Strictly after the row whose key values are `last`" under ORDER BY keys.
 *
 * Correctness notes (the browse ORDER BY never emits NULLS clauses, so PG
 * defaults apply — ASC ⇒ NULLS LAST, DESC ⇒ NULLS FIRST):
 * - Row-value comparison `(a, b) > (v1, v2)` is only used when every key runs
 *   the same direction AND every key column is NOT NULL by catalog — a NULL
 *   anywhere would silently drop its whole partition (row-value comparisons
 *   yield NULL, and mixed directions break lexicographic order outright).
 * - Otherwise the expanded OR-ladder form is generated, with NULL partitions
 *   handled explicitly: ASC after value v ⇒ `k > v OR k IS NULL` (the NULL
 *   partition still lies ahead); ASC after NULL ⇒ nothing is after within
 *   this key (tie-break deeper); DESC after NULL ⇒ `k IS NOT NULL`; DESC
 *   after value v ⇒ `k < v`.
 * - Equality steps use `= 'v'::cast` / `IS NULL` rather than
 *   IS NOT DISTINCT FROM — semantically identical for known values and it
 *   stays indexable (same call as the bedrock ctid-guard decision).
 *
 * Returns null when no seek predicate exists (e.g. the unique tiebreaker
 * value is somehow NULL) — the caller must fall back, never guess. */
export function seekPredicate(
  keys: KeysetKey[],
  last: (string | null)[],
): string | null {
  if (keys.length === 0 || keys.length !== last.length) return null;
  if (last[keys.length - 1] === null) return null; // tiebreaker must locate a row
  const lit = (k: KeysetKey, v: string) => `${ql(v)}::${k.cast}`;

  if (
    keys.every((k) => k.dir === keys[0].dir && k.notNull) &&
    last.every((v) => v !== null)
  ) {
    const cols = keys.map((k) => qi(k.col)).join(", ");
    const vals = keys.map((k, i) => lit(k, last[i]!)).join(", ");
    const cmp = keys[0].dir === "ASC" ? ">" : "<";
    return keys.length === 1
      ? `${cols} ${cmp} ${vals}`
      : `(${cols}) ${cmp} (${vals})`;
  }

  const branches: string[] = [];
  const eq: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = last[i];
    let strict: string | null;
    if (k.dir === "ASC") {
      strict =
        v === null
          ? null
          : k.notNull
            ? `${qi(k.col)} > ${lit(k, v)}`
            : `(${qi(k.col)} > ${lit(k, v)} OR ${qi(k.col)} IS NULL)`;
    } else {
      strict = v === null ? `${qi(k.col)} IS NOT NULL` : `${qi(k.col)} < ${lit(k, v)}`;
    }
    if (strict !== null) branches.push([...eq, strict].join(" AND "));
    eq.push(v === null ? `${qi(k.col)} IS NULL` : `${qi(k.col)} = ${lit(k, v)}`);
  }
  if (branches.length === 0) return null;
  return branches.length === 1 ? branches[0] : branches.map((b) => `(${b})`).join(" OR ");
}

/** The next browse page: WHERE = active filters AND the keyset seek from the
 * last loaded row's key values. Null when the seek can't be built — caller
 * falls back to the offset approach. */
export function browsePageSql(s: {
  table: TableInfo;
  filters: Filter[];
  keys: KeysetKey[];
  last: (string | null)[];
  limit: number;
}): string | null {
  const seek = seekPredicate(s.keys, s.last);
  if (!seek) return null;
  const t = `${qi(s.table.schema)}.${qi(s.table.name)}`;
  const f = filterExpr(s.filters);
  const where = f ? `\nWHERE (${f}) AND (${seek})` : `\nWHERE ${seek}`;
  return `SELECT ${selectCols(s.table)} FROM ${t}${where}${orderBy(s.keys)}\nLIMIT ${s.limit}`;
}
