// The `pg` half of the headless harness: everything src-tauri/src/agent.rs and
// src-tauri/src/driver/postgres/introspect.rs do for the app, done over node
// (EVAL.md section 3, AGENT-SPEC section 2 rule 2). eval/tools.node.ts is the
// other half: it owns the model-facing TEXT, exactly as tools.tauri.ts does.
//
// The catalog SQL is ported from introspect.rs (TABLES_SQL, FKS_SQL, ENUMS_SQL,
// SCHEMAS_SQL) and the pg_stats rules from agent.rs `low_cardinality`, which is
// itself harness.py `sample_values(source="pgstats")`. Ports are literal on
// purpose: the PR gate scores the app's own loop through this file, so a
// "better" rule here silently rebases every baseline.
//
// Cell values are WIRE TEXT, never JS values: `types.getTypeParser` is
// overridden per query so `pg` hands back exactly what psql shows, which is
// what AgentRun.rows is defined to carry. The one place types matter is the
// verdict, and eval/compare.ts reads the column OIDs for that.

import type { Client } from "pg";
import type { EnumInfo, FkInfo, SchemaSnapshot, TableInfo } from "../src/stores/schema";

/** Distinct values a column may hold before it stops being a category
 * (agent.rs VALUES_CAP). */
export const VALUES_CAP = 20;
/** A sampled value longer than this is a payload, not a hint (agent.rs). */
export const VALUE_LEN_CAP = 40;
export const DESCRIBE_MAX = 40;
export const PEEK_TIMEOUT_MS = 5_000;
/** the exact DISTINCT's own cap before the bounded sample takes over (agent.rs) */
export const PEEK_EXACT_TIMEOUT_MS = 2_000;
export const PEEK_SCAN_ROWS = 20_000;
export const PEEK_SAMPLE_PCT = "0.5";
export const PROBE_TIMEOUT_MS = 10_000;
export const RUN_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** One row of a read-only run: wire text, `null` = SQL NULL, plus the column
 * type OIDs the verdict normaliser needs. */
export interface RawResult {
  columns: string[];
  typeOids: number[];
  rows: (string | null)[][];
  rowCount: number;
  capped: boolean;
  ms: number;
}

/** Everything arrives as the text PostgreSQL sent. */
const TEXT_TYPES = { getTypeParser: () => (v: string) => v };

// ---- catalog (introspect.rs) ----------------------------------------------

const TABLES_SQL = `
SELECT coalesce(json_agg(t), '[]') AS j FROM (
  SELECT c.oid::int8 AS table_oid, n.nspname AS schema, c.relname AS name,
         c.relkind::text AS kind,
         c.relhassubclass AS has_children,
         c.reltuples::float8 AS reltuples,
         td.description AS comment,
         (SELECT i.inhparent::int8 FROM pg_inherits i
          WHERE i.inhrelid = c.oid ORDER BY i.inhseqno LIMIT 1) AS parent_oid,
         coalesce((
           SELECT json_agg(json_build_object(
                    'name', a.attname,
                    'attnum', a.attnum,
                    'type', format_type(a.atttypid, a.atttypmod),
                    'type_oid', a.atttypid::int8,
                    'not_null', a.attnotnull,
                    'default', pg_get_expr(d.adbin, d.adrelid),
                    'generated', a.attgenerated,
                    'identity', a.attidentity,
                    'comment', cd.description)
                  ORDER BY a.attnum)
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           LEFT JOIN pg_description cd ON cd.objoid = a.attrelid
             AND cd.classoid = 'pg_class'::regclass AND cd.objsubid = a.attnum
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         ), '[]') AS columns,
         coalesce((
           SELECT json_agg(a.attname ORDER BY ord.n)
           FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS ord(attnum, n)
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ord.attnum
           WHERE i.indrelid = c.oid AND i.indisprimary
         ), '[]') AS pk
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_description td ON td.objoid = c.oid
    AND td.classoid = 'pg_class'::regclass AND td.objsubid = 0
  WHERE c.relkind IN ('r','v','m','p','f')
    AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  ORDER BY n.nspname, c.relname
) t`;

const FKS_SQL = `
SELECT coalesce(json_agg(t), '[]') AS j FROM (
  SELECT sn.nspname AS src_schema, sc.relname AS src_table,
         (SELECT json_agg(a.attname ORDER BY ord.n)
          FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ord.attnum
         ) AS src_cols,
         dn.nspname AS dst_schema, dc.relname AS dst_table,
         (SELECT json_agg(a.attname ORDER BY ord.n)
          FROM unnest(con.confkey) WITH ORDINALITY AS ord(attnum, n)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ord.attnum
         ) AS dst_cols
  FROM pg_constraint con
  JOIN pg_class sc ON sc.oid = con.conrelid
  JOIN pg_namespace sn ON sn.oid = sc.relnamespace
  JOIN pg_class dc ON dc.oid = con.confrelid
  JOIN pg_namespace dn ON dn.oid = dc.relnamespace
  WHERE con.contype = 'f'
    AND sn.nspname NOT IN ('pg_catalog','information_schema')
) t`;

const ENUMS_SQL = `
SELECT coalesce(json_agg(t), '[]') AS j FROM (
  SELECT n.nspname AS schema, t.typname AS name,
         coalesce((SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid), '[]') AS labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE t.typtype = 'e'
    AND n.nspname NOT IN ('pg_catalog','information_schema')
  ORDER BY n.nspname, t.typname
) t`;

const SCHEMAS_SQL = `
SELECT coalesce(json_agg(nspname ORDER BY nspname), '[]') AS j
FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog','information_schema')
  AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'`;

async function jsonCell<T>(client: Client, sql: string): Promise<T> {
  const res = await client.query<{ j: T }>(sql);
  return res.rows[0].j;
}

/** The snapshot the app caches, built live. `functions` and `indexes` are the
 * sidebar's, not the agent's: `buildMeta` reads tables and foreign_keys only,
 * so fetching 3k catalog functions per bench run would buy the model nothing.
 * They are present and empty rather than absent, because the type says they
 * exist and a harness that lied about the shape would hide a real drift. */
export async function introspect(client: Client): Promise<SchemaSnapshot> {
  // sequential, not Promise.all: one client is one PostgreSQL session and a
  // session runs one statement at a time (the app's Rust side batches these
  // into a single round trip; four round trips over loopback are free)
  const tables = await jsonCell<TableInfo[]>(client, TABLES_SQL);
  const foreignKeys = await jsonCell<FkInfo[]>(client, FKS_SQL);
  const enums = await jsonCell<EnumInfo[]>(client, ENUMS_SQL);
  const schemas = await jsonCell<string[]>(client, SCHEMAS_SQL);
  return {
    tables,
    foreign_keys: foreignKeys,
    functions: [],
    schemas,
    indexes: [],
    enums,
  };
}

// ---- the gate (AGENT-SPEC section 8.1) ------------------------------------

/** agent.rs DENIED_FUNCS, verbatim. `default_transaction_read_only` stops none
 * of these (measured, w0-pg-query-gate.md section 3). */
const DENIED_FUNCS = [
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
  "pg_rotate_logfile", "pg_read_file", "pg_read_binary_file", "pg_ls_dir",
  "pg_ls_logdir", "pg_ls_waldir", "pg_ls_tmpdir", "lo_import", "lo_export",
  "lo_read", "lo_write", "lo_create", "lo_unlink", "lo_open", "dblink",
  "dblink_exec", "dblink_connect", "set_config", "pg_sleep", "pg_sleep_for",
  "pg_sleep_until",
];

/** Strings, dollar-quoted bodies and comments removed, so a keyword scan can
 * never fire on `WHERE note = 'delete me'`. */
function stripLiterals(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) i++;
          else break;
        }
        i++;
      }
      out += quote === "'" ? " '' " : ' "" ';
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length - 1;
        out += " '' ";
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Statement count, counting only semicolons outside literals and comments. */
function statementCount(bare: string): number {
  const parts = bare.split(";").map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length;
}

/** The gate as far as a lexer can take it. `pg_query` (libpg_query 17) is the
 * app's gate and this is NOT a second implementation of it: it is the same
 * POLICY (DECISIONS 2026-09-05, gate policy) enforced without a parser, so the
 * harness refuses everything the app refuses in every shape a model has been
 * measured to write. The real read-only enforcement is the transaction below,
 * as it is in the app; a divergence here shows up as an EXEC-FAIL to
 * investigate, never as a write. */
export function gateSql(sql: string): string | null {
  const bare = stripLiterals(sql);
  const trimmed = bare.trim().replace(/;+\s*$/, "");
  if (!trimmed) return "empty statement";
  const n = statementCount(bare);
  if (n > 1) return `${n} statements in one call; run_sql takes exactly one`;

  const head = /^\s*\(*\s*([A-Za-z_]+)/.exec(trimmed)?.[1]?.toUpperCase() ?? "";
  if (!["SELECT", "WITH", "EXPLAIN", "TABLE", "VALUES"].includes(head)) {
    return `${head || "statement"} not allowed (only SELECT / WITH...SELECT / EXPLAIN)`;
  }
  for (const verb of ["INSERT", "UPDATE", "DELETE", "MERGE"]) {
    if (new RegExp(`(^|[\\s(,])${verb}\\s`, "i").test(trimmed)) {
      return `data-modifying CTE (${verb})`;
    }
  }
  if (/\bINTO\s+(?!STRICT\b)[A-Za-z_"(]/i.test(trimmed) && !/\bINSERT\b/i.test(trimmed)) {
    return "SELECT INTO / CTAS materializes a new table (write)";
  }
  if (/\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i.test(trimmed)) {
    return "FOR UPDATE/FOR SHARE takes a row lock";
  }
  for (const fn of DENIED_FUNCS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(trimmed)) {
      return `denied function call: ${fn}()`;
    }
  }
  return null;
}

// ---- read-only execution (agent.rs run_readonly) --------------------------

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}

/** PostgreSQL errors carry a DETAIL/HINT tail the model does not need and a
 * first line that is the whole diagnosis (agent_mcp.rs first_line). */
export const firstLine = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.split("\n")[0].trim() || "query failed";
};

/** One gated, read-only, timed statement. The transaction carries BOTH halves
 * of AGENT-SPEC section 8.1 the app sets server-side: read-only for the
 * transaction and a statement timeout, so a runaway bench question costs one
 * timeout rather than a session. */
export async function runReadonly(
  client: Client,
  sql: string,
  maxRows: number,
  timeoutMs: number,
): Promise<RawResult> {
  const refusal = gateSql(sql);
  if (refusal) throw new SqlError(refusal);
  const timeout = Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const stmt = sql.trim().replace(/;+\s*$/, "");
  const started = Date.now();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL transaction_read_only = on");
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    const res = await client.query({
      text: stmt,
      rowMode: "array",
      types: TEXT_TYPES,
    });
    await client.query("COMMIT");
    const ms = Date.now() - started;
    const all = res.rows as (string | null)[][];
    const capped = all.length > maxRows;
    return {
      columns: res.fields.map((f) => f.name),
      typeOids: res.fields.map((f) => f.dataTypeID),
      rows: all.slice(0, maxRows),
      rowCount: all.length,
      capped,
      ms,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new SqlError(firstLine(e));
  }
}

// ---- pg_stats values (agent.rs describe) ----------------------------------

export interface ColumnValues {
  column: string;
  values: string[];
  more: boolean;
  comment: string | null;
}

export interface TableValues {
  schema: string;
  name: string;
  comment: string | null;
  columns: ColumnValues[];
}

export interface TableRef {
  schema: string;
  name: string;
}

interface StatRow {
  schema: string;
  table: string;
  column: string;
  n_distinct: number | null;
  reltuples: number;
  mcv: (string | null)[] | null;
  hist: (string | null)[] | null;
}

interface CommentRow {
  schema: string;
  table: string;
  comment: string | null;
  columns: { column: string; comment: string | null }[];
}

/** harness.py `sample_values(source="pgstats")`, rule for rule, as agent.rs
 * ports it: `n_distinct < 0` is a FRACTION of the row count, not a count;
 * repeated values land in most_common_vals and unique-ish ones in
 * histogram_bounds, so the union of both is the sample; a column the planner
 * thinks holds more than VALUES_CAP distinct values is not a category; nor is
 * one whose values are longer than VALUE_LEN_CAP. */
export function lowCardinality(row: StatRow): { values: string[]; more: boolean } | null {
  if (row.n_distinct === null || row.n_distinct === undefined) return null;
  const nd = row.n_distinct;
  const est = nd < 0 ? -nd * row.reltuples : nd;
  if (est > VALUES_CAP) return null;
  const set = new Set<string>();
  for (const list of [row.mcv, row.hist]) {
    for (const v of list ?? []) if (v !== null) set.add(v);
  }
  if (set.size === 0) return null;
  const sorted = [...set].sort();
  if (sorted.some((v) => [...v].length > VALUE_LEN_CAP)) return null;
  return { values: sorted.slice(0, VALUES_CAP), more: sorted.length > VALUES_CAP };
}

const ql = (s: string) => `'${s.replace(/'/g, "''")}'`;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Low-cardinality pg_stats values plus table and column comments for the
 * given tables, in ONE round trip for all of them (agent.rs `describe`). Every
 * requested table gets an entry, in request order, even when it has nothing to
 * say, so the caller can tell "nothing to report" from "not there". */
export async function describeValues(
  client: Client,
  tables: TableRef[],
): Promise<TableValues[]> {
  if (tables.length === 0) return [];
  if (tables.length > DESCRIBE_MAX) {
    throw new SqlError(
      `describe_tables takes at most ${DESCRIBE_MAX} tables; ${tables.length} were asked for`,
    );
  }
  const pairs = tables.map((t) => `(${ql(t.schema)}, ${ql(t.name)})`).join(", ");
  // most_common_vals/histogram_bounds are anyarray: the ::text::text[] pair is
  // the only cast that works for every column type (harness.py does the same)
  const stats = await jsonCell<StatRow[]>(
    client,
    `
SELECT coalesce(json_agg(t), '[]') AS j FROM (
  SELECT s.schemaname AS schema, s.tablename AS "table", s.attname AS "column",
         s.n_distinct::float8 AS n_distinct,
         c.reltuples::float8 AS reltuples,
         s.most_common_vals::text::text[] AS mcv,
         s.histogram_bounds::text::text[] AS hist
  FROM pg_stats s
  JOIN pg_namespace n ON n.nspname = s.schemaname
  JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.tablename
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = s.attname
    AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type ty ON ty.oid = a.atttypid
  WHERE (s.schemaname, s.tablename) IN (${pairs})
    AND (ty.typtype = 'e' OR ty.typname IN ('text','varchar','bpchar','char'))
  ORDER BY s.schemaname, s.tablename, a.attnum
) t`,
  );
  const comments = await jsonCell<CommentRow[]>(
    client,
    `
SELECT coalesce(json_agg(t), '[]') AS j FROM (
  SELECT n.nspname AS schema, c.relname AS "table",
         td.description AS comment,
         coalesce((
           SELECT json_agg(json_build_object('column', a.attname, 'comment', cd.description)
                           ORDER BY a.attnum)
           FROM pg_attribute a
           JOIN pg_description cd ON cd.objoid = c.oid
             AND cd.classoid = 'pg_class'::regclass AND cd.objsubid = a.attnum
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         ), '[]') AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_description td ON td.objoid = c.oid
    AND td.classoid = 'pg_class'::regclass AND td.objsubid = 0
  WHERE (n.nspname, c.relname) IN (${pairs})
) t`,
  );

  return tables.map((t) => {
    const columns = new Map<string, ColumnValues>();
    for (const row of stats.filter((r) => r.schema === t.schema && r.table === t.name)) {
      const low = lowCardinality(row);
      if (low) {
        columns.set(row.column, {
          column: row.column,
          values: low.values,
          more: low.more,
          comment: null,
        });
      }
    }
    const meta = comments.find((c) => c.schema === t.schema && c.table === t.name);
    for (const c of meta?.columns ?? []) {
      const entry = columns.get(c.column) ?? {
        column: c.column,
        values: [],
        more: false,
        comment: null,
      };
      entry.comment = c.comment;
      columns.set(c.column, entry);
    }
    return {
      schema: t.schema,
      name: t.name,
      comment: meta?.comment ?? null,
      // BTreeMap in agent.rs: the model reads the columns in name order there,
      // so it reads them in name order here
      columns: [...columns.values()].sort((a, b) => (a.column < b.column ? -1 : 1)),
    };
  });
}

// ---- peek_values (agent.rs peek_values) -----------------------------------

export interface PeekResult {
  values: string[];
  more: boolean;
  /** the exact DISTINCT timed out; a bounded random-page sample answered */
  sampled: boolean;
}

/** Distinct non-null values of one column, under a 5s statement timeout so a
 * wide unindexed column cannot stall the bench. The column is validated
 * against pg_attribute first, so a wrong guess comes back as the list of real
 * columns rather than a bare SQL error the model has to decode. */
export async function peekValues(
  client: Client,
  schema: string,
  table: string,
  column: string,
  limit: number,
): Promise<PeekResult> {
  const path = `${qi(schema)}.${qi(table)}`;
  const cols = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = ${ql(path)}::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
  );
  const names = cols.rows.map((r) => r.attname);
  if (names.length === 0) throw new SqlError(`no readable columns on ${schema}.${table}`);
  if (!names.includes(column)) {
    throw new SqlError(
      `no column "${column}" on ${schema}.${table}. Columns: ${names.join(", ")}`,
    );
  }
  const col = qi(column);
  const distinct = async (timeoutMs: number, from: string) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL transaction_read_only = on");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const res = await client.query({
      text: `SELECT DISTINCT ${col} FROM ${from} LIMIT ${limit + 1}`,
      rowMode: "array",
      types: TEXT_TYPES,
    });
    await client.query("COMMIT");
    return (res.rows as (string | null)[][])
      .map((r) => r[0])
      .filter((v): v is string => v !== null);
  };
  const finish = (all: string[], sampled: boolean): PeekResult => ({
    values: all.slice(0, limit),
    more: all.length > limit,
    sampled,
  });
  try {
    return finish(await distinct(PEEK_EXACT_TIMEOUT_MS, `${path} WHERE ${col} IS NOT NULL`), false);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (!/statement timeout/.test(firstLine(e))) throw new SqlError(firstLine(e));
  }
  // the exact scan was too slow for this table (agent.rs peek_values): a
  // bounded sample of random pages answers instead, and the caller says so
  try {
    const from =
      `(SELECT ${col} FROM ${path} TABLESAMPLE SYSTEM (${PEEK_SAMPLE_PCT}) ` +
      `WHERE ${col} IS NOT NULL LIMIT ${PEEK_SCAN_ROWS}) s`;
    return finish(await distinct(PEEK_TIMEOUT_MS, from), true);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new SqlError(firstLine(e));
  }
}
