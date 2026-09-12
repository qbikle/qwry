// Starter suggestions for the empty state (AGENT-UX section 1): questions
// drawn from the connection's real nouns, phrased the way a person would type
// them (table words de-snaked, `_v2` twins folded). "How many rows in each
// table?" is never one of them. Pure, store-free and deterministic per
// snapshot so it can be unit-tested against a fixture.
//
// W2d: `starterPool` yields up to twelve, the instant fallback for the
// model-generated pool (src/agent/starterPool.ts) and the pool the empty state
// rotates through three at a time (useStarters.ts); `starterQuestions` keeps
// its three-question contract as the pool's first triple. `rotateStarters` is
// the one place a triple is cut from a pool, whichever pool it is.

import type { FkInfo, SchemaSnapshot, TableInfo } from "../stores/schema";
import { HOUSEKEEPING, LEGACY, STARTER_POOL_SIZE, SYSTEM_SCHEMAS } from "../agent/starterPool";

const TIME_COL = /(created|added|inserted|signed|placed|ordered|started|updated|_at$|_on$|date)/i;
const STATUS_COL = /(status|state|kind|category|type|source|platform|channel|plan|tier|role)$/i;
const TEXTISH = /^(text|character varying|varchar|citext|bpchar|character|name|USER-DEFINED)/i;

export const STARTERS_SHOWN = 3;

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
      !LEGACY.test(t.comment ?? ""),
  );
}

const key = (schema: string, name: string) => `${schema}.${name}`;
const bySize = (a: TableInfo, b: TableInfo) =>
  (b.reltuples ?? 0) - (a.reltuples ?? 0) || a.name.localeCompare(b.name);

/** The pool the questions draw from: the largest tables plus the FK hubs (the
 * tables most other tables point at), largest first. Ties break on name so
 * the same snapshot always yields the same questions. */
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

/** one FK edge between two pool tables, child → parent */
interface Edge {
  child: TableInfo;
  parent: TableInfo;
}

/** the pool's FK edges, parent with the most rows first (the hub is the
 * interesting side), then the largest child; one edge per table pair */
function edges(snapshot: SchemaSnapshot, byKey: Map<string, TableInfo>): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  const sorted = [...snapshot.foreign_keys].sort(
    (a: FkInfo, b: FkInfo) =>
      bySize(byKey.get(key(a.dst_schema, a.dst_table)) ?? EMPTY, byKey.get(key(b.dst_schema, b.dst_table)) ?? EMPTY) ||
      bySize(byKey.get(key(a.src_schema, a.src_table)) ?? EMPTY, byKey.get(key(b.src_schema, b.src_table)) ?? EMPTY),
  );
  for (const fk of sorted) {
    const child = byKey.get(key(fk.src_schema, fk.src_table));
    const parent = byKey.get(key(fk.dst_schema, fk.dst_table));
    if (!child || !parent || child === parent) continue;
    const k = `${key(child.schema, child.name)}>${key(parent.schema, parent.name)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ child, parent });
  }
  return out;
}

// ---- the shapes ---------------------------------------------------------------
// each takes the i-th table or edge of its list and answers null past the end,
// so the rounds below read as a plan rather than a wall of bounds checks

const monthly = (t?: TableInfo) => {
  const c = t && timeCol(t);
  return c ? `How many ${noun(t.name)} were ${verb(c.name)} each month this year?` : null;
};
const recentDays = (t?: TableInfo) => {
  const c = t && timeCol(t);
  return c ? `How many ${noun(t.name)} were ${verb(c.name)} in the last 30 days?` : null;
};
const recent20 = (t?: TableInfo) => {
  const c = t && timeCol(t);
  return c ? `What are the 20 most recently ${verb(c.name)} ${noun(t.name)}?` : null;
};
const sample = (t?: TableInfo) => (t ? `What do 10 sample ${noun(t.name)} look like?` : null);
const split = (t?: TableInfo) => {
  const c = t && statusCol(t);
  return c ? `How are ${noun(t.name)} split by ${words(c.name)}?` : null;
};
const commonest = (t?: TableInfo) => {
  const c = t && statusCol(t);
  return c ? `Which ${words(c.name)} is most common among ${noun(t.name)}?` : null;
};
const mostChildren = (e?: Edge) => (e ? `Which ${noun(e.parent.name)} have the most ${noun(e.child.name)}?` : null);
const noChildren = (e?: Edge) => (e ? `How many ${noun(e.parent.name)} have no ${noun(e.child.name)}?` : null);

/** Up to twelve questions the user could have typed, from the schema's own
 * names: a trend, a join and a distribution first (the three the empty state
 * always showed), then the same shapes over the next tables and edges with a
 * second reading of each, then fills from the largest tables. `asked`
 * excludes questions already in the thread (section 6). Fewer come back only
 * when the schema offers nothing more to say. */
export function starterPool(
  snapshot: SchemaSnapshot | undefined,
  asked: ReadonlySet<string> = new Set(),
): string[] {
  if (!snapshot) return [];
  const tables = candidates(snapshot);
  if (tables.length === 0) return [];
  const top = pool(snapshot, tables);
  const byKey = new Map(top.map((t) => [key(t.schema, t.name), t]));
  const dated = top.filter((t) => timeCol(t));
  const statused = top.filter((t) => statusCol(t));
  const joins = edges(snapshot, byKey);
  const out: string[] = [];
  const push = (q: string | null) => {
    if (q && out.length < STARTER_POOL_SIZE && !asked.has(q) && !out.includes(q)) out.push(q);
  };

  push(monthly(dated[0]));
  push(mostChildren(joins[0]));
  push(split(statused[0]));
  const rounds = Math.max(dated.length, statused.length, joins.length);
  for (let i = 0; i < rounds && out.length < STARTER_POOL_SIZE; i++) {
    push(noChildren(joins[i]));
    push(recentDays(dated[i]));
    push(commonest(statused[i]));
    push(monthly(dated[i + 1]));
    push(mostChildren(joins[i + 1]));
    push(split(statused[i + 1]));
  }
  for (const t of top) push(timeCol(t) ? recent20(t) : sample(t));
  for (const t of top) push(sample(t));
  return out;
}

/** Three questions the user could have typed: the pool's first triple. */
export function starterQuestions(
  snapshot: SchemaSnapshot | undefined,
  asked: ReadonlySet<string> = new Set(),
): string[] {
  return starterPool(snapshot, asked).slice(0, STARTERS_SHOWN);
}

/** the form two questions are compared in: case, spacing and a thread
 * title's trailing ellipsis do not make a question new */
export const questionKey = (q: string) =>
  q
    .trim()
    .replace(/…$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

/** The triple shown from a pool, generated or heuristic: every question whose
 * key is in `taken` (asked in any thread of the connection) is out, and the
 * three start at `start` and wrap around what remains, so a cursor that keeps
 * climbing keeps walking the pool. Fewer than three only when fewer remain. */
export function rotateStarters(
  pool: readonly string[],
  taken: ReadonlySet<string>,
  start: number,
): string[] {
  const open = pool.filter((q) => !taken.has(questionKey(q)));
  const n = open.length;
  if (n === 0) return [];
  const from = ((Math.trunc(start) % n) + n) % n;
  const out: string[] = [];
  for (let i = 0; i < Math.min(STARTERS_SHOWN, n); i++) out.push(open[(from + i) % n]);
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
