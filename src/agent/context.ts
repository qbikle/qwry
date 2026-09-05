// Prefilter, index and candidate assembly (AGENT-SPEC sections 4.1-4.2), and
// every piece of model-facing text that CODE composes rather than the model:
// the candidate index, the describe_tables DDL, the run_sql and peek_values
// result blocks (section 5), and the one reading a probe gives the sanity line
// (section 4.6). They live together because both AgentTools implementations
// must produce byte-identical text: the PR gate scores the app's own loop
// through eval/tools.node.ts (EVAL.md section 3).
//
// Ported from qwry-agent-lab/agent_cc.py (`stem`, `toks`, `STOP`, `SYN`,
// `candidates`, `index_for`, `gold_tables`) and harness.py (`introspect`).
// The port keeps the lab's scoring rule (IDF over table and column tokens,
// base-name bonus, FK hubs, one-hop expansion, LEGACY exclusion): EVAL
// baselines are tied to it (28/28 recall on the 202-table staging schema,
// 31/33 on Pagila), so a "better" rule is a re-measurement, not a refactor.
// Not byte-identical to the Python: buildMeta() reads the app's snapshot, which
// excludes partition children, so the FK graph carries one edge per FK where
// the lab's pg_constraint query saw one per partition (Pagila's payment). Hub
// counts and the exact candidate ORDER differ; recall is pinned by test.
//
// Runtime-free by law (AGENT-SPEC section 2 rule 2): the only import is a TYPE
// from the schema store, erased at compile time. A test enforces it.

import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import { MODEL_ROW_CAP, UI_ROW_CAP } from "./tools";
import type { AgentRun, SanityFragment } from "./types";

/** One column as the prefilter and the DDL renderer see it. */
export interface ColumnMeta {
  name: string;
  type: string;
  notNull: boolean;
  comment: string | null;
}

/** One relation. `display` is the name the MODEL sees and writes back: bare
 * when it is unique across the snapshot's schemas, `schema.name` when it is
 * not. `schema` and `name` stay separate from here on, so no consumer ever
 * splits a dotted string (LESSONS 4). */
export interface TableMeta {
  schema: string;
  name: string;
  display: string;
  kind: TableInfo["kind"];
  columns: ColumnMeta[];
  pk: string[];
  comment: string | null;
  /** planner estimate (reltuples), never a count; -1 = never analyzed */
  approxRows: number;
  /** the table comment says LEGACY: never a candidate, never an answer */
  legacy: boolean;
}

/** One single-column foreign key, in display names. */
export interface FkMeta {
  src: string;
  srcCol: string;
  dst: string;
  dstCol: string;
}

export interface SchemaMeta {
  tables: TableMeta[];
  byDisplay: Map<string, TableMeta>;
  fks: FkMeta[];
}

/** One column's half of a describe result: what pg_stats sampled, and the
 * comment the database carried at that moment. `comment` is read live, so it
 * outranks the cached snapshot's copy. */
export interface ColumnValueEntry {
  values: string[];
  more: boolean;
  comment: string | null;
}

/** Describe results per table per column, keyed by display name. Built by the
 * AgentTools implementation from `agent_describe`; the renderer only formats
 * what it is given, because the pg_stats rules live in Rust. */
export type ColumnValueMap = Map<string, Map<string, ColumnValueEntry>>;

// ---- tokenisation (agent_cc.py) -------------------------------------------

/** Question words that match everything and therefore mean nothing. Checked
 * against the RAW word, before stemming, exactly as the lab does. */
export const STOP = new Set(
  ("the a an of in on for to and or by with how many what which who is are was were per each " +
    "all any from as at be do does did have has return count number total average list show " +
    "give me their there them that this these those")
    .split(" ")
    .filter(Boolean),
);

/** Synonyms that bridge business vocabulary to table vocabulary. Values are
 * unstemmed on purpose: they join the question's token set as written. */
export const SYN: Readonly<Record<string, string>> = {
  signup: "user",
  signups: "user",
  signed: "user",
  registered: "user",
  joined: "user",
  follower: "follow",
  followers: "follow",
  following: "follow",
  buyer: "order",
  buyers: "order",
  purchase: "order",
  purchased: "order",
  spent: "order",
  spend: "order",
  paid: "order",
  revenue: "order",
  aov: "order",
  vton: "virtual",
  "try-on": "virtual",
  tryon: "virtual",
  subscriber: "subscription",
  subscribers: "subscription",
};

/** Crude English plural stemmer. Crude is the point: it is applied to both
 * sides of the match, so it only has to be consistent. */
export function stem(w: string): string {
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("sses") || w.endsWith("xes")) {
    return w.slice(0, -2);
  }
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

/** Stemmed content tokens: alphanumeric runs longer than two characters that
 * are not stop words. */
export function toks(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length > 2 && !STOP.has(w)) out.add(stem(w));
  }
  return out;
}

/** The question's tokens plus its synonym expansions. */
export function questionTokens(question: string): Set<string> {
  const q = toks(question);
  for (const w of question.toLowerCase().match(/[a-z0-9-]+/g) ?? []) {
    const syn = SYN[w];
    if (syn) q.add(syn);
  }
  return q;
}

const LEGACY_SUFFIX = /_v\d+$/;

/** The name with a trailing `_v2`-style version suffix removed. */
export function baseName(name: string): string {
  return name.replace(LEGACY_SUFFIX, "");
}

// ---- snapshot -> meta ------------------------------------------------------

/** Partitions are not relations the model should reason about: their parent
 * is (`NOT c.relispartition` in the lab's table query). */
function isPartitionChild(t: TableInfo, byOid: Map<number, TableInfo>): boolean {
  if (t.parent_oid == null) return false;
  return byOid.get(t.parent_oid)?.kind === "p";
}

/** Normalise a cached SchemaSnapshot into the shape the prefilter works in.
 * Views and materialised views are included: they are queryable and often ARE
 * the curated answer. Partition children are not. `Meta::build` in
 * `src-tauri/src/agent_mcp.rs` mirrors this byte for byte for the claude -p
 * provider: a change to either is a change to both. */
export function buildMeta(snapshot: SchemaSnapshot): SchemaMeta {
  const byOid = new Map(snapshot.tables.map((t) => [t.table_oid, t]));
  const kept = snapshot.tables.filter(
    (t) => t.kind !== "f" && !isPartitionChild(t, byOid),
  );

  const bareCount = new Map<string, number>();
  for (const t of kept) bareCount.set(t.name, (bareCount.get(t.name) ?? 0) + 1);

  const tables: TableMeta[] = kept
    .map((t) => ({
      schema: t.schema,
      name: t.name,
      display: (bareCount.get(t.name) ?? 0) > 1 ? `${t.schema}.${t.name}` : t.name,
      kind: t.kind,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.not_null,
        comment: c.comment ?? null,
      })),
      pk: t.pk,
      comment: t.comment ?? null,
      approxRows: t.reltuples == null ? -1 : Math.max(Math.round(t.reltuples), -1),
      legacy: (t.comment ?? "").includes("LEGACY"),
    }))
    .sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));

  const byDisplay = new Map(tables.map((t) => [t.display, t]));
  const byKey = new Map(tables.map((t) => [`${t.schema}.${t.name}`, t.display]));

  // single-column FKs only, as measured: the lab's graph is built from
  // `array_length(con.conkey, 1) = 1` and the recall number belongs to it
  const fks: FkMeta[] = [];
  for (const fk of snapshot.foreign_keys) {
    if (fk.src_cols.length !== 1 || fk.dst_cols.length !== 1) continue;
    const src = byKey.get(`${fk.src_schema}.${fk.src_table}`);
    const dst = byKey.get(`${fk.dst_schema}.${fk.dst_table}`);
    if (!src || !dst) continue;
    fks.push({ src, srcCol: fk.src_cols[0], dst, dstCol: fk.dst_cols[0] });
  }

  return { tables, byDisplay, fks };
}

// ---- prefilter (section 4.1) ----------------------------------------------

/** Base tables only. Measured on the Pagila bench: including views and
 * materialised views costs a point of recall (30/33 against 31/33), because
 * every view competes for a slot under the k + 8 cap and the curated view of a
 * table scores like the table. The tools still reach them by name: a view the
 * model finds through list_tables is describable and queryable. */
const isBase = (t: TableMeta) => t.kind === "r" || t.kind === "p";

/** Table names, in the order the model should see them: IDF-weighted lexical
 * match (table-name tokens weigh 3x, an exact base-name hit is worth +6),
 * LEGACY tables excluded, then the top-3 inbound FK hubs, then a one-hop FK
 * expansion of the top 5 picks. Target 15-25 names; the cap is k + 8. */
export function candidates(question: string, meta: SchemaMeta, k = 14): string[] {
  const q = questionTokens(question);
  const base = meta.tables.filter(isBase);

  const tableToks = new Map<string, Set<string>>();
  const colToks = new Map<string, Set<string>>();
  for (const t of base) {
    tableToks.set(t.display, toks(t.name.replace(/_/g, " ")));
    const cols = new Set<string>();
    for (const c of t.columns) for (const w of toks(c.name.replace(/_/g, " "))) cols.add(w);
    colToks.set(t.display, cols);
  }

  // document frequency over every table, LEGACY ones included: a token that is
  // common in the schema is uninformative wherever it appears
  const df = new Map<string, number>();
  for (const t of base) {
    for (const w of tableToks.get(t.display) ?? []) df.set(w, (df.get(w) ?? 0) + 1);
    for (const w of colToks.get(t.display) ?? []) {
      if (!(tableToks.get(t.display) ?? new Set()).has(w)) df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const n = base.length;
  const idf = (w: string) => Math.log(n / (df.get(w) ?? 1)) + 0.1;

  const scored: { name: string; score: number; order: number }[] = [];
  base.forEach((t, order) => {
    if (t.legacy) return;
    let score = 0;
    for (const w of tableToks.get(t.display) ?? []) if (q.has(w)) score += 3 * idf(w);
    for (const w of colToks.get(t.display) ?? []) if (q.has(w)) score += idf(w);
    const base = baseName(t.name).replace(/_/g, " ");
    if (q.has(stem(base)) || q.has(base)) score += 6;
    if (score) scored.push({ name: t.display, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const picked = scored.slice(0, k).map((s) => s.name);

  const inbound = new Map<string, number>();
  for (const fk of meta.fks) inbound.set(fk.dst, (inbound.get(fk.dst) ?? 0) + 1);
  const order = new Map(base.map((t, i) => [t.display, i]));
  const eligible = (name: string) => {
    const t = meta.byDisplay.get(name);
    return !!t && isBase(t) && !t.legacy;
  };
  const hubs = [...inbound.entries()]
    .filter(([name]) => eligible(name))
    .sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, 3)
    .map(([name]) => name);
  for (const h of hubs) if (!picked.includes(h)) picked.push(h);

  // one hop out of the strongest picks: bridge tables carry the join a lexical
  // match can never see
  for (const t of picked.slice(0, 5)) {
    for (const fk of meta.fks) {
      const other = fk.src === t ? fk.dst : fk.dst === t ? fk.src : null;
      if (other === null || other === t) continue;
      if (!picked.includes(other) && eligible(other)) picked.push(other);
    }
  }

  return picked.slice(0, k + 8);
}

// ---- candidate index (section 4.2) -----------------------------------------

/** Tables whose names differ only by a `_v\d+` suffix and that carry no
 * comment to tell them apart. Four table comments recovered 3 bench points
 * lost to exactly this confusion; where the comments are missing, the note
 * says so out loud rather than letting the model guess. */
function legacyTwin(meta: SchemaMeta, t: TableMeta): string | null {
  if (t.comment) return null;
  const base = baseName(t.name);
  for (const other of meta.tables) {
    if (other.display === t.display) continue;
    if (other.comment) continue;
    if (baseName(other.name) !== base) continue;
    if (other.name === t.name) continue;
    return other.display;
  }
  return null;
}

/** The CANDIDATE TABLES block: one line per table as `t(col, col)  -- comment`,
 * then the FK edges among the candidates as `a.col -> b.col`. */
export function indexFor(meta: SchemaMeta, names: string[]): string {
  const set = new Set(names);
  const lines: string[] = [];
  for (const name of names) {
    const t = meta.byDisplay.get(name);
    if (!t) continue;
    const twin = legacyTwin(meta, t);
    const note = t.comment
      ? `  -- ${t.comment}`
      : twin
        ? `  -- possible legacy twin of ${twin}`
        : "";
    lines.push(`${name}(${t.columns.map((c) => c.name).join(", ")})${note}`);
  }
  for (const fk of meta.fks) {
    if (set.has(fk.src) && set.has(fk.dst)) {
      lines.push(`${fk.src}.${fk.srcCol} -> ${fk.dst}.${fk.dstCol}`);
    }
  }
  return lines.join("\n");
}

// ---- describe_tables renderer (section 5) ---------------------------------

function valuesNote(entry: { values: string[]; more: boolean }): string | null {
  if (entry.values.length === 0) return null;
  const list = entry.values.map((v) => `'${v}'`).join(", ");
  return `values: ${list}${entry.more ? " … (more exist)" : ""}`;
}

/** The DDL text `describe_tables` returns: a CREATE TABLE per name, row
 * estimate and table comment on the header, PRIMARY KEY / REFERENCES inline,
 * and the column comment plus real stored values after the comma. A column
 * comment read live by the describe call wins over the snapshot's; the header
 * comment stays the snapshot's, which is the one the candidate block quoted.
 * `describe_text` in `src-tauri/src/agent_mcp.rs` mirrors this byte for byte
 * for the claude -p provider: a change to either is a change to both. */
export function renderDescribe(
  meta: SchemaMeta,
  names: string[],
  values: ColumnValueMap = new Map(),
): string {
  const blocks: string[] = [];
  for (const name of names) {
    const t = meta.byDisplay.get(name);
    if (!t) continue;
    const pk = new Set(t.pk);
    const refs = new Map<string, string>();
    for (const fk of meta.fks) {
      if (fk.src === name && !refs.has(fk.srcCol)) {
        refs.set(fk.srcCol, `${fk.dst}(${fk.dstCol})`);
      }
    }
    const rows = t.approxRows >= 0 ? `~${t.approxRows} rows` : null;
    const head = [rows, t.comment].filter(Boolean).join("; ");
    const lines = [`CREATE TABLE ${name} (${head ? `  -- ${head}` : ""}`];
    const cols = values.get(name);
    const decls = t.columns.map((c) => {
      const parts = [`  ${c.name} ${c.type}`];
      if (pk.has(c.name)) parts.push("PRIMARY KEY");
      const ref = refs.get(c.name);
      if (ref) parts.push(`REFERENCES ${ref}`);
      const entry = cols?.get(c.name);
      const notes = [
        entry?.comment ?? c.comment,
        entry ? valuesNote(entry) : null,
      ].filter(Boolean);
      return { decl: parts.join(" "), note: notes.join("; ") };
    });
    decls.forEach((d, i) => {
      const sep = i < decls.length - 1 ? "," : "";
      lines.push(`${d.decl}${sep}${d.note ? `  -- ${d.note}` : ""}`);
    });
    lines.push(");");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

// ---- recall (EVAL.md section 1) -------------------------------------------

/** The tables a gold query reads, for the per-question recall number. Matches
 * bare names only, which is what the benches are written in. */
export function goldTables(sql: string | null | undefined, meta: SchemaMeta): Set<string> {
  const out = new Set<string>();
  for (const m of (sql ?? "").matchAll(/(?:from|join)\s+"?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (meta.byDisplay.has(m[1])) out.add(m[1]);
  }
  return out;
}

/** Did the candidate set contain every table the gold query uses? `null` when
 * the question has no gold SQL to judge against. */
export function recallOf(
  picked: string[],
  goldSql: string | null | undefined,
  meta: SchemaMeta,
): boolean | null {
  const need = goldTables(goldSql, meta);
  if (need.size === 0) return null;
  const set = new Set(picked);
  for (const t of need) if (!set.has(t)) return false;
  return true;
}

// ---- result text (section 5) ----------------------------------------------

/** SQL NULL in a result block. The eval harness normalises the same way, so
 * the two AgentTools implementations stay comparable. */
export const NULL_CELL = "∅";

/** `name  (~rows)  -- comment` per table, the whole connection. */
export function formatTableList(meta: SchemaMeta): string {
  return meta.tables
    .map(
      (t) =>
        `${t.display}  (~${Math.max(t.approxRows, 0)} rows)` +
        (t.comment ? `  -- ${t.comment}` : ""),
    )
    .join("\n");
}

/** The result block the model reads: header, up to 50 rows, and a truthful
 * count. Never fewer than 50 rows: the lean variant tried it and looped to the
 * turn cap re-querying what it could not see (section 5). `run_text` in
 * `src-tauri/src/agent_mcp.rs` mirrors this byte for byte for the claude -p
 * provider: a change to either is a change to both. */
export function formatRun(run: AgentRun): string {
  const shown = run.rows.slice(0, MODEL_ROW_CAP);
  const head = run.columns.join(" | ");
  const body = shown.map((r) => r.map((c) => c ?? NULL_CELL).join(" | ")).join("\n");
  const tail = run.capped
    ? `\n(${run.rowCount} rows, capped at ${UI_ROW_CAP}; showing ${shown.length})`
    : run.rowCount > shown.length
      ? `\n(${run.rowCount} rows total, showing ${shown.length})`
      : `\n(${run.rowCount} rows)`;
  return `${head}\n${body}${tail}`;
}

/** Distinct values, with the marker that says the list is not exhaustive. */
export function formatPeek(values: string[], more: boolean): string {
  const list = values.map((v) => `'${v}'`).join(", ");
  return list ? `${list}${more ? " … (more exist)" : ""}` : "(no non-null values)";
}

/** One block per probe, each in the run_sql format, each labelled with the
 * statement that produced it: one failure never sinks the batch. */
export function formatProbes(
  probes: { sql: string; run: AgentRun | null; error: string | null }[],
): string {
  return probes
    .map((p) => `-- ${p.sql}\n${p.run ? formatRun(p.run) : `ERROR: ${p.error ?? "failed"}`}`)
    .join("\n\n");
}

const shortValue = (v: string | null): string =>
  v === null ? NULL_CELL : /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v;

const humanise = (col: string) => col.replace(/^(min|max)_/, "").replace(/_/g, " ");

/** What one probe says about the data, for the sanity line (AGENT-UX 4). Only
 * two shapes are read, both unambiguous: a min/max pair and a single count.
 * Anything else yields no fragment, because a decorative fragment is a lie. */
export function probeFragment(sql: string, run: AgentRun): SanityFragment | null {
  if (run.rows.length !== 1) return null;
  const row = run.rows[0];
  const lower = run.columns.map((c) => c.toLowerCase());

  const min = lower.findIndex((c) => c.startsWith("min"));
  const max = lower.findIndex((c) => c.startsWith("max"));
  if (min !== -1 && max !== -1 && min !== max) {
    const subject = humanise(lower[min]) || "range";
    return {
      text: `${subject} ${shortValue(row[min])} → ${shortValue(row[max])}`,
      warn: false,
      sql,
    };
  }

  if (row.length === 1 && /count\s*\(/i.test(sql)) {
    const n = Number(row[0]);
    if (!Number.isFinite(n)) return null;
    const subject = humanise(lower[0]);
    const label = subject && subject !== "count" ? subject : "rows checked";
    return { text: `${n.toLocaleString("en-US")} ${label}`, warn: n > 0, sql };
  }
  return null;
}
