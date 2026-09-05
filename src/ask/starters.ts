// Starter suggestions for the empty state (AGENT-UX section 1): three
// questions drawn from the connection's real nouns, phrased the way a person
// would type them (table words de-snaked, `_v2` twins folded). "How many rows
// in each table?" is never one of them. Pure, store-free and deterministic
// per snapshot so it can be unit-tested against a fixture.

import type { FkInfo, SchemaSnapshot, TableInfo } from "../stores/schema";

const SYSTEM_SCHEMAS = new Set(["pg_catalog", "information_schema", "pg_toast"]);
/** bookkeeping relations nobody asks questions about */
const HOUSEKEEPING = /(migration|alembic_version|flyway|knex_|schema_version|ar_internal_metadata|spatial_ref_sys)/i;
const TIME_COL = /(created|added|inserted|signed|placed|ordered|started|updated|_at$|_on$|date)/i;
const STATUS_COL = /(status|state|kind|category|type|source|platform|channel|plan|tier|role)$/i;
const TEXTISH = /^(text|character varying|varchar|citext|bpchar|character|name|USER-DEFINED)/i;

const isTime = (type: string) => /timestamp|date/i.test(type);

/** relations the user actually asks about: plain tables and partitioned
 * parents, not LEGACY twins, not partitions, not system schemas, not the
 * migration ledger */
function candidates(snapshot: SchemaSnapshot): TableInfo[] {
  return snapshot.tables.filter(
    (t) =>
      (t.kind === "r" || t.kind === "p") &&
      !SYSTEM_SCHEMAS.has(t.schema) &&
      !t.parent_oid &&
      !HOUSEKEEPING.test(t.name) &&
      !/LEGACY/i.test(t.comment ?? ""),
  );
}

const key = (schema: string, name: string) => `${schema}.${name}`;
const bySize = (a: TableInfo, b: TableInfo) =>
  (b.reltuples ?? 0) - (a.reltuples ?? 0) || a.name.localeCompare(b.name);

/** The pool the questions draw from: the largest tables plus the FK hubs (the
 * tables most other tables point at), largest first. Ties break on name so
 * the same snapshot always yields the same three questions. */
function pool(snapshot: SchemaSnapshot, tables: TableInfo[]): TableInfo[] {
  const byKey = new Map(tables.map((t) => [key(t.schema, t.name), t]));
  const inbound = new Map<string, number>();
  for (const fk of snapshot.foreign_keys) {
    const k = key(fk.dst_schema, fk.dst_table);
    if (byKey.has(k)) inbound.set(k, (inbound.get(k) ?? 0) + 1);
  }
  const largest = [...tables].sort(bySize).slice(0, 8);
  const hubs = [...tables]
    .filter((t) => (inbound.get(key(t.schema, t.name)) ?? 0) > 0)
    .sort(
      (a, b) =>
        (inbound.get(key(b.schema, b.name)) ?? 0) - (inbound.get(key(a.schema, a.name)) ?? 0) ||
        bySize(a, b),
    )
    .slice(0, 4);
  return [...new Set([...largest, ...hubs])].sort(bySize);
}

/** `wardrobe_products_v2` → "wardrobe products", `order_v2` → "orders",
 * `users` → "users": the words a person would type */
export function noun(name: string): string {
  const words = name
    .replace(/_v\d+$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return name.toLowerCase();
  words[words.length - 1] = plural(words[words.length - 1]);
  return words.join(" ");
}

function plural(word: string): string {
  if (/s$/i.test(word)) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** `payment_status` → "payment status" */
const words = (col: string) => col.replace(/_/g, " ").toLowerCase();

const timeCol = (t: TableInfo) =>
  t.columns.find((c) => isTime(c.type) && TIME_COL.test(c.name)) ??
  t.columns.find((c) => isTime(c.type));
const statusCol = (t: TableInfo) =>
  t.columns.find((c) => STATUS_COL.test(c.name) && TEXTISH.test(c.type));
const verb = (col: string) => (/created|signed|placed|ordered|started/i.test(col) ? "created" : "added");

/** Three questions the user could have typed, from the schema's own names.
 * `asked` excludes questions already in the thread (section 6). Fewer than
 * three come back only when the schema offers nothing to say. */
export function starterQuestions(
  snapshot: SchemaSnapshot | undefined,
  asked: ReadonlySet<string> = new Set(),
): string[] {
  if (!snapshot) return [];
  const tables = candidates(snapshot);
  if (tables.length === 0) return [];
  const top = pool(snapshot, tables);
  const byKey = new Map(top.map((t) => [key(t.schema, t.name), t]));
  const out: string[] = [];
  const push = (q: string) => {
    if (out.length < 3 && !asked.has(q) && !out.includes(q)) out.push(q);
  };

  // a time-shaped question on the biggest dated table
  for (const t of top) {
    const c = timeCol(t);
    if (c) {
      push(`How many ${noun(t.name)} were ${verb(c.name)} each month this year?`);
      break;
    }
  }
  // a join-shaped question on the first FK edge between two pool tables,
  // parent with the most children first (the hub is the interesting side)
  const edges = [...snapshot.foreign_keys].sort(
    (a: FkInfo, b: FkInfo) =>
      bySize(byKey.get(key(a.dst_schema, a.dst_table)) ?? EMPTY, byKey.get(key(b.dst_schema, b.dst_table)) ?? EMPTY) ||
      bySize(byKey.get(key(a.src_schema, a.src_table)) ?? EMPTY, byKey.get(key(b.src_schema, b.src_table)) ?? EMPTY),
  );
  for (const fk of edges) {
    const child = byKey.get(key(fk.src_schema, fk.src_table));
    const parent = byKey.get(key(fk.dst_schema, fk.dst_table));
    if (child && parent && child !== parent) {
      push(`Which ${noun(parent.name)} have the most ${noun(child.name)}?`);
      break;
    }
  }
  // a distribution question on a status-like column
  for (const t of top) {
    const c = statusCol(t);
    if (c) {
      push(`How are ${noun(t.name)} split by ${words(c.name)}?`);
      break;
    }
  }
  // fill from the largest tables until three
  for (const t of top) {
    if (out.length >= 3) break;
    const c = timeCol(t);
    push(
      c
        ? `What are the 20 most recently ${verb(c.name)} ${noun(t.name)}?`
        : `What do 10 sample ${noun(t.name)} look like?`,
    );
  }
  return out;
}

/** a table that is not in the pool sorts last */
const EMPTY: TableInfo = {
  table_oid: 0,
  schema: "",
  name: "￿",
  kind: "r",
  columns: [],
  pk: [],
  reltuples: -1,
};
