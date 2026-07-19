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
  | "BETWEEN"
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
  | "@>"
  | "IS"
  | "IS NOT"
  | "IS NULL"
  | "IS NOT NULL"
  | "IS TRUE"
  | "IS FALSE"
  | "raw SQL";

export const FILTER_OPS: FilterOp[] = [
  "=", "!=", ">", "<", ">=", "<=", "BETWEEN",
  "contains", "starts with", "ends with",
  "LIKE", "ILIKE", "NOT LIKE", "NOT ILIKE", "~", "!~",
  "IN", "NOT IN", "@>", "IS NULL", "IS NOT NULL", "IS TRUE", "IS FALSE",
  "raw SQL",
];

/** coarse type classes the operator registry and value editors key on */
export type TypeClass =
  | "bool"
  | "number"
  | "datetime"
  | "json"
  | "jsonb"
  | "uuid"
  | "bytea"
  | "enum"
  | "text";

export function typeClassOf(type: string, isEnum = false): TypeClass {
  if (isEnum) return "enum";
  const t = type.toLowerCase();
  if (t === "boolean" || t === "bool") return "bool";
  if (/int|numeric|decimal|real|double|float|money|serial|oid/.test(t)) return "number";
  if (/timestamp|date|time|interval/.test(t)) return "datetime";
  if (t === "jsonb") return "jsonb";
  if (t === "json") return "json";
  if (/uuid/.test(t)) return "uuid";
  if (/bytea/.test(t)) return "bytea";
  return "text";
}

/** operator registry, keyed by type class — everything else is noise (or a
 * guaranteed server error, e.g. ILIKE on an integer, `@>` on json-not-jsonb) */
const OPS_BY_CLASS: Record<TypeClass, FilterOp[]> = {
  bool: ["IS TRUE", "IS FALSE", "IS", "IS NOT", "IS NULL", "IS NOT NULL", "raw SQL"],
  number: ["=", "!=", ">", "<", ">=", "<=", "BETWEEN", "IN", "NOT IN", "IS NULL", "IS NOT NULL", "raw SQL"],
  datetime: ["=", "!=", ">", "<", ">=", "<=", "BETWEEN", "IS NULL", "IS NOT NULL", "raw SQL"],
  json: ["=", "!=", "IS NULL", "IS NOT NULL", "raw SQL"],
  jsonb: ["@>", "=", "!=", "IS NULL", "IS NOT NULL", "raw SQL"],
  uuid: ["=", "!=", "IN", "NOT IN", "IS NULL", "IS NOT NULL", "raw SQL"],
  bytea: ["=", "!=", "IS NULL", "IS NOT NULL", "raw SQL"],
  enum: ["=", "!=", "IN", "NOT IN", "IS NULL", "IS NOT NULL", "raw SQL"],
  text: [
    "=", "!=", ">", "<", ">=", "<=", "BETWEEN",
    "contains", "starts with", "ends with",
    "LIKE", "ILIKE", "NOT LIKE", "NOT ILIKE", "~", "!~",
    "IN", "NOT IN", "IS NULL", "IS NOT NULL", "raw SQL",
  ],
};

/** operators that make sense for a column's type. `isEnum` comes from the
 * snapshot's enum list (absent on old caches → callers pass false → text) */
export function opsForType(type: string, isEnum = false): FilterOp[] {
  return OPS_BY_CLASS[typeClassOf(type, isEnum)];
}

const NO_VALUE_OPS = new Set<FilterOp>(["IS NULL", "IS NOT NULL", "IS TRUE", "IS FALSE"]);
export const opNeedsValue = (op: FilterOp) => !NO_VALUE_OPS.has(op);

export interface Filter {
  col: string;
  op: FilterOp;
  value: string;
  /** second operand — BETWEEN only */
  value2?: string;
  enabled: boolean;
  /** how this row chains onto the previous one (ignored on the first) */
  conj: "AND" | "OR";
}

const ql = (v: string) => `'${v.replace(/'/g, "''")}'`;
const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** split a user-typed IN list on commas, honoring 'quoted' / "quoted" tokens
 * (doubled-quote escapes) so values may contain commas; bare tokens are
 * trimmed. Returns [] on empty or unparseable input (unterminated quote,
 * junk after a closing quote) — the caller treats that filter as inactive,
 * because `IN ()` is a syntax error and guessing would silently filter wrong */
export function parseInList(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;
    const q = input[i];
    if (q === "'" || q === '"') {
      i++;
      let val = "";
      let closed = false;
      while (i < n) {
        if (input[i] === q) {
          if (input[i + 1] === q) {
            val += q;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        val += input[i++];
      }
      if (!closed) return [];
      out.push(val);
      while (i < n && /\s/.test(input[i])) i++;
      if (i < n) {
        if (input[i] !== ",") return [];
        i++;
      }
    } else {
      let j = i;
      while (j < n && input[j] !== ",") j++;
      const t = input.slice(i, j).trim();
      if (t !== "") out.push(t);
      i = j + 1;
    }
  }
  return out;
}

/** a filter row participates in the WHERE only when it has everything it
 * needs — half-typed rows must never change the query */
function filterActive(f: Filter): boolean {
  if (!f.enabled || !f.col) return false;
  if (!opNeedsValue(f.op)) return true;
  if (f.op === "BETWEEN") return f.value !== "" && (f.value2 ?? "") !== "";
  if (f.op === "IN" || f.op === "NOT IN") return parseInList(f.value).length > 0;
  return f.value !== "";
}

/** the folded filter expression (no leading WHERE), or null when no filter is
 * active. Folds left-associatively so the SQL means what the linear UI reads:
 * A OR B AND C compiles to ((A OR B) AND C), never A OR (B AND C) */
function filterExpr(filters: Filter[]): string | null {
  const active = filters.filter(filterActive);
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
        const vals = parseInList(f.value).map(ql).join(", ");
        return `${qi(f.col)} ${f.op} (${vals})`;
      }
      case "BETWEEN":
        return `${qi(f.col)} BETWEEN ${ql(f.value)} AND ${ql(f.value2 ?? "")}`;
      case "@>":
        return `${qi(f.col)} @> ${ql(f.value)}::jsonb`;
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

/** The WHERE body the browse actually embeds. `rawWhere` non-null means raw
 * mode: its text is the WHERE, used as written (user-owned, validated only by
 * running) — builder filters are ignored ENTIRELY, empty raw text = no WHERE
 * (the hidden builder rows must never filter behind the user's back).
 * Exported so the filter bar's SQL-preview chip shows EXACTLY the text the
 * queries use. */
export function compiledWhere(filters: Filter[], rawWhere?: string | null): string | null {
  if (rawWhere != null) return rawWhere.trim() || null;
  return filterExpr(filters);
}

/** one link of the user's multi-column sort chain. This exact shape is the
 * store contract (`useBrowser.getState().setSortChain(chain)`) the grid
 * header and the toolbar sort popover both drive. */
export interface SortKey {
  column: string;
  dir: "asc" | "desc";
  /** explicit NULLS placement; absent = PostgreSQL's default for the
   * direction (ASC ⇒ NULLS LAST, DESC ⇒ NULLS FIRST) */
  nulls?: "first" | "last";
}
export type SortChain = SortKey[];

/** legacy single-column sort shape — kept for the setSort back-compat shim
 * and the store's `sort` mirror of sortChain[0] */
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
  /** EFFECTIVE NULLS placement of this key in the executed ORDER BY —
   * the user's override when given, else the PG default for the direction.
   * The seek ladder branches on this, so overrides page correctly. */
  nulls: "FIRST" | "LAST";
}

const defaultNulls = (dir: "ASC" | "DESC"): "FIRST" | "LAST" =>
  dir === "ASC" ? "LAST" : "FIRST";

/** row-estimate ceiling for ctid keyset on PK-less tables (see gate below) */
export const CTID_KEYSET_MAX_ESTIMATE = 1_000_000;

/** The total-order sort keys for keyset pagination: the user's sort chain
 * (if any) followed by a unique tiebreaker — the PK, or ctid for PK-less
 * ordinary tables. The tiebreaker inherits the FIRST chain key's direction
 * (chain-less browses stay ASC) — same rule the single-sort era used, so one
 * composite index still serves both directions via backward scan; deeper
 * chain keys keep their own directions (the ladder handles mixed dirs).
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
  chain: SortChain,
  serverVersionNum: number | null | undefined,
): KeysetKey[] | null {
  const dir = chain[0]?.dir === "desc" ? "DESC" : "ASC";
  const colInfo = (name: string) => table.columns.find((c) => c.name === name);
  const chainCols = new Set(chain.map((k) => k.column));
  let tiebreak: KeysetKey[];
  if (table.pk.length > 0) {
    tiebreak = [];
    for (const pc of table.pk) {
      if (chainCols.has(pc)) continue; // already a key via the chain
      const ci = colInfo(pc);
      if (!ci) return null;
      tiebreak.push({ col: pc, dir, cast: ci.type, notNull: ci.not_null, nulls: defaultNulls(dir) });
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
    tiebreak = [{ col: "ctid", dir, cast: "tid", notNull: true, nulls: defaultNulls(dir) }];
  } else {
    return null;
  }
  if (chain.length === 0) return tiebreak;
  const head: KeysetKey[] = [];
  for (const k of chain) {
    const sc = colInfo(k.column);
    if (!sc) return null;
    const kd = k.dir === "desc" ? "DESC" : "ASC";
    // chain keys are ALWAYS treated as nullable: their snapshot not_null can
    // go stale (external ALTER between introspect and scroll) and a wrongly
    // trusted NOT NULL would silently drop the whole NULL partition. The
    // extra NULL terms match nothing on a truly NOT NULL column. PK/ctid
    // tiebreak keys keep their flag — NOT NULL is structural there for as
    // long as the PK the snapshot promised exists at all.
    head.push({
      col: k.column,
      dir: kd,
      cast: sc.type,
      notNull: false,
      nulls: k.nulls === "first" ? "FIRST" : k.nulls === "last" ? "LAST" : defaultNulls(kd),
    });
  }
  const keys = [...head, ...tiebreak];
  // Anchor truncation: when the absorbed SINGLE-column PK sits in the chain,
  // it already totally orders every row at its position (catalog NOT NULL +
  // unique-alone) — the chain suffix after it is ordering-irrelevant. Keeping
  // the suffix is worse than useless: a page ending on a trailing key's NULL
  // makes seekPredicate refuse (NULL terminal) and the browse silently falls
  // back to O(n²) offset paging. Truncate after the anchor, so
  // [id asc(PK), s asc] seeks on id alone — byte-identical to a bare [id asc]
  // chain. Only a genuinely unique-alone anchor qualifies: a single column of
  // a composite PK is not, so composite absorption keeps its full key list
  // (and the ctid tiebreaker is always terminal — nothing to truncate).
  if (table.pk.length === 1) {
    const a = keys.findIndex((k) => k.col === table.pk[0]);
    if (a >= 0 && colInfo(table.pk[0])?.not_null === true) return keys.slice(0, a + 1);
  }
  return keys;
}

/** NULLS clause is emitted only when it differs from the PG default for the
 * direction — default chains keep byte-identical SQL to the pre-override era
 * (and default-order index scans stay natural) */
const nullsClause = (dir: "ASC" | "DESC", nulls: "FIRST" | "LAST") =>
  nulls === defaultNulls(dir) ? "" : ` NULLS ${nulls}`;

const orderBy = (keys: KeysetKey[]) =>
  `\nORDER BY ${keys.map((k) => `${qi(k.col)} ${k.dir}${nullsClause(k.dir, k.nulls)}`).join(", ")}`;

/** ORDER BY term for one chain key on the offset-fallback path (no keyset
 * keys) — same NULLS-emission rule as the keyset ORDER BY */
const sortKeySql = (k: SortKey) => {
  const dir = k.dir === "desc" ? "DESC" : "ASC";
  const eff: "FIRST" | "LAST" =
    k.nulls === "first" ? "FIRST" : k.nulls === "last" ? "LAST" : defaultNulls(dir);
  return `${qi(k.column)} ${dir}${nullsClause(dir, eff)}`;
};

/** ordinary tables without a PK get ctid so they stay editable/deletable
 * (and so the ctid keyset tiebreaker is present in the result) */
const selectCols = (table: TableInfo) =>
  table.pk.length === 0 && table.kind === "r" ? "ctid, *" : "*";

export function browseSql(s: {
  table: TableInfo;
  filters: Filter[];
  sort: SortChain;
  limit: number;
  /** keyset sort keys — when present they define the ORDER BY (they already
   * start with the user's chain); null/absent = non-keysettable legacy shape */
  keys?: KeysetKey[] | null;
  /** raw-WHERE escape hatch text — replaces the builder filters when set */
  rawWhere?: string | null;
  /** jump-to-row: OFFSET of the page's first row (0 = top). Documented
   * tradeoff: the jump page itself is offset-paginated (honest, one-shot);
   * scrolling onward re-anchors keyset from the landed page's last row. */
  offset?: number;
}): string {
  const t = `${qi(s.table.schema)}.${qi(s.table.name)}`;
  const f = compiledWhere(s.filters, s.rawWhere);
  const where = f ? `\nWHERE ${f}` : "";
  const order =
    s.keys && s.keys.length > 0
      ? orderBy(s.keys)
      : s.sort.length > 0
        ? `\nORDER BY ${s.sort.map(sortKeySql).join(", ")}`
        : "";
  const off = s.offset && s.offset > 0 ? ` OFFSET ${Math.floor(s.offset)}` : "";
  return `SELECT ${selectCols(s.table)} FROM ${t}${where}${order}\nLIMIT ${s.limit}${off}`;
}

/** exact-count-on-demand SQL: count(*) over the SAME WHERE the browse uses
 * (builder or raw) — the footer's number must describe the rows being
 * browsed, never a different set */
export function browseCountSql(s: {
  table: TableInfo;
  filters: Filter[];
  rawWhere?: string | null;
}): string {
  const t = `${qi(s.table.schema)}.${qi(s.table.name)}`;
  const f = compiledWhere(s.filters, s.rawWhere);
  return `SELECT count(*) FROM ${t}${f ? `\nWHERE ${f}` : ""}`;
}

/** "Strictly after the row whose key values are `last`" under ORDER BY keys.
 *
 * Correctness notes (each key carries its EFFECTIVE NULLS placement — the PG
 * default for its direction unless the user overrode it; the ladder branches
 * on that placement, so overridden chains page correctly too):
 * - Row-value comparison `(a, b) > (v1, v2)` is only used when every key runs
 *   the same direction AND every key column is NOT NULL by catalog — a NULL
 *   anywhere would silently drop its whole partition (row-value comparisons
 *   yield NULL, and mixed directions break lexicographic order outright).
 *   NULLS placement is irrelevant there: a catalog-NOT NULL column has no
 *   NULL partition to place.
 * - Otherwise the expanded OR-ladder form is generated, per key:
 *   after value v ⇒ `k > v` (ASC) / `k < v` (DESC), plus `OR k IS NULL` when
 *   the NULL partition sorts after the values (placement LAST, nullable key);
 *   after NULL ⇒ `k IS NOT NULL` when the values are still ahead (placement
 *   FIRST), else nothing is after within this key (tie-break deeper).
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
    if (v === null) {
      // all NULLs tie at this key: with NULLS FIRST every non-NULL value is
      // still ahead; with NULLS LAST nothing is after (tie-break deeper)
      strict = k.nulls === "FIRST" ? `${qi(k.col)} IS NOT NULL` : null;
    } else {
      const cmp = k.dir === "ASC" ? ">" : "<";
      const base = `${qi(k.col)} ${cmp} ${lit(k, v)}`;
      // the NULL partition lies ahead only when it sorts after the values
      strict = k.nulls === "LAST" && !k.notNull ? `(${base} OR ${qi(k.col)} IS NULL)` : base;
    }
    if (strict !== null) branches.push([...eq, strict].join(" AND "));
    eq.push(v === null ? `${qi(k.col)} IS NULL` : `${qi(k.col)} = ${lit(k, v)}`);
  }
  if (branches.length === 0) return null;
  return branches.length === 1 ? branches[0] : branches.map((b) => `(${b})`).join(" OR ");
}

/** The next browse page: WHERE = the active WHERE body (builder filters or
 * raw text) AND the keyset seek from the last loaded row's key values. Null
 * when the seek can't be built — caller falls back to the offset approach. */
export function browsePageSql(s: {
  table: TableInfo;
  filters: Filter[];
  keys: KeysetKey[];
  last: (string | null)[];
  limit: number;
  rawWhere?: string | null;
}): string | null {
  const seek = seekPredicate(s.keys, s.last);
  if (!seek) return null;
  const t = `${qi(s.table.schema)}.${qi(s.table.name)}`;
  const f = compiledWhere(s.filters, s.rawWhere);
  // the closing paren and the seek live on their OWN line: a raw WHERE ending
  // in a line comment (`… --`) must not eat the wrap and the seek (page 1 and
  // count survive that text — page 2 must too)
  const where = f ? `\nWHERE (${f}\n) AND (${seek})` : `\nWHERE ${seek}`;
  return `SELECT ${selectCols(s.table)} FROM ${t}${where}${orderBy(s.keys)}\nLIMIT ${s.limit}`;
}
