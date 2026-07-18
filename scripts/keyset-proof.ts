#!/usr/bin/env bun
// Keyset pagination proof harness — PERMANENT regression gate.
//
// Drives the app's REAL SQL generators (src/stores/browseSql.ts: keysetKeys /
// browseSql / browsePageSql) against live staging fixtures, pages through
// psql exactly the way loadMore does (seek from the last row's key values),
// and asserts ORDER-SENSITIVE sequence equality against the one-shot
// reference query. Any skip/dup/reorder across a page boundary fails.
//
// Usage:
//   source ~/.claude/.env.claude
//   QWRY_TEST_HOST=$STAGING_DB_HOST QWRY_TEST_USER=$STAGING_DB_USER \
//   QWRY_TEST_PASSWORD=$STAGING_DB_PASSWORD bun scripts/keyset-proof.ts
//
// Same env vars as the Rust staging suite. Connects to db "squad" (override:
// QWRY_TEST_DB2); fixtures live in schema qwry_test and are dropped at the
// end. NEVER point this at prod.
//
// Covers: PK / composite-PK row-value seeks, duplicate sort values across
// page boundaries, NULL partitions (ASC + DESC, paging inside the
// partition), sort-on-PK DESC, typed casts (timestamptz), filter folding,
// ctid keyset on PK-less tables, inheritance-parent ctid refusal
// (relhassubclass — colliding child ctids proven live), and the reltuples
// size gate (mocked estimates).

import { spawnSync } from "bun";
import {
  browsePageSql,
  browseSql,
  keysetKeys,
  CTID_KEYSET_MAX_ESTIMATE,
  type Filter,
  type KeysetKey,
} from "../src/stores/browseSql";
import type { TableInfo } from "../src/stores/schema";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env ${k} — source ~/.claude/.env.claude and map QWRY_TEST_* (see header)`);
    process.exit(2);
  }
  return v;
};

const HOST = env("QWRY_TEST_HOST");
const USER = env("QWRY_TEST_USER");
const PASSWORD = env("QWRY_TEST_PASSWORD");
const DB = process.env.QWRY_TEST_DB2 ?? "squad";
if (/prod/i.test(HOST) || /prod/i.test(DB)) {
  console.error(`refusing to run against a prod-looking target (${HOST}/${DB})`);
  process.exit(2);
}

const FS = "\u001f"; // unit separator — never appears in fixture data
const NULLMARK = "\u0007"; // psql null marker — never appears in fixture data
const PAGE = 7; // small page so every case crosses several boundaries

function psqlRaw(sql: string, viaStdin = false): string {
  const args = [
    "psql", "-h", HOST, "-U", USER, "-d", DB,
    "-X", "-q", "-v", "ON_ERROR_STOP=1",
    "-A", "-t", "-F", FS, "-P", `null=${NULLMARK}`,
  ];
  const proc = viaStdin
    ? spawnSync({ cmd: [...args, "-f", "-"], stdin: Buffer.from(sql), env: { ...process.env, PGPASSWORD: PASSWORD } })
    : spawnSync({ cmd: [...args, "-c", sql], env: { ...process.env, PGPASSWORD: PASSWORD } });
  if (proc.exitCode !== 0) {
    throw new Error(`psql failed (${proc.exitCode}):\n${proc.stderr.toString()}\nSQL:\n${sql}`);
  }
  return proc.stdout.toString();
}

/** run a SELECT, rows as (string|null)[][] — the shape loadMore sees */
function query(sql: string): (string | null)[][] {
  const out = psqlRaw(sql);
  if (out.replace(/\n+$/, "") === "") return [];
  return out
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.split(FS).map((cell) => (cell === NULLMARK ? null : cell)));
}

const exec = (sql: string): void => void psqlRaw(sql, true);

/** live TableInfo for one fixture — same catalog fields the Rust introspect
 * captures (format_type text, attnotnull, pk order, relhassubclass,
 * reltuples), so the TS gates see exactly what the app would */
function introspectTable(schema: string, name: string): TableInfo {
  const cell = psqlRaw(`
SELECT json_build_object(
  'table_oid', c.oid::int8,
  'schema', n.nspname,
  'name', c.relname,
  'kind', c.relkind::text,
  'has_children', c.relhassubclass,
  'reltuples', c.reltuples::float8,
  'columns', coalesce((SELECT json_agg(json_build_object(
      'name', a.attname, 'attnum', a.attnum,
      'type', format_type(a.atttypid, a.atttypmod),
      'type_oid', a.atttypid::int8,
      'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'),
  'pk', coalesce((SELECT json_agg(a.attname ORDER BY ord.n)
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS ord(attnum, n)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ord.attnum
    WHERE i.indrelid = c.oid AND i.indisprimary), '[]'))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '${schema}' AND c.relname = '${name}'`).trim();
  if (!cell) throw new Error(`fixture ${schema}.${name} not found`);
  return JSON.parse(cell) as TableInfo;
}

let failures = 0;
let asserts = 0;
let cases = 0;
function check(cond: boolean, label: string): void {
  asserts++;
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}
function caseDone(name: string, before: number): void {
  cases++;
  console.log(`${failures === before ? "PASS" : "FAIL"}  ${name}`);
}

/** page through exactly like loadMore: page 1 via browseSql, then
 * browsePageSql seeded from the previous page's last row, until a short
 * page; assert the concatenation equals the one-shot reference */
function provePaging(
  name: string,
  table: TableInfo,
  filters: Filter[],
  sort: { col: string; dir: "ASC" | "DESC" } | null,
  vnum: number,
  expectRows: number,
): void {
  const before = failures;
  const keys = keysetKeys(table, sort, vnum);
  check(keys !== null, `${name}: keysetKeys must allow keyset here`);
  if (!keys) return caseDone(name, before);

  // result column order, as the app's SELECT produces it (ctid is prepended
  // for PK-less ordinary tables — mirrors browseSql's selectCols)
  const colNames =
    table.pk.length === 0 && table.kind === "r"
      ? ["ctid", ...table.columns.map((c) => c.name)]
      : table.columns.map((c) => c.name);
  const keyIdx = keys.map((k: KeysetKey) => colNames.indexOf(k.col));
  check(keyIdx.every((i: number) => i >= 0), `${name}: every key column present in the result`);

  const collected: (string | null)[][] = [];
  let page = query(browseSql({ table, filters, sort, limit: PAGE, keys }));
  let pages = 1;
  collected.push(...page);
  while (page.length === PAGE && pages < 100) {
    const lastRow = page[page.length - 1];
    const last = keyIdx.map((i: number) => lastRow[i]);
    const sql = browsePageSql({ table, filters, keys, last, limit: PAGE });
    check(sql !== null, `${name}: seek predicate must build (page ${pages + 1})`);
    if (!sql) break;
    page = query(sql);
    pages++;
    collected.push(...page);
  }

  const reference = query(browseSql({ table, filters, sort, limit: 100000, keys }));
  check(reference.length === expectRows, `${name}: reference row count ${reference.length} ≠ expected ${expectRows}`);
  check(pages >= 3, `${name}: must cross ≥2 page boundaries (got ${pages} pages)`);
  check(
    JSON.stringify(collected) === JSON.stringify(reference),
    `${name}: paged sequence must equal the one-shot ORDER BY (order-sensitive)`,
  );
  caseDone(`${name} (${pages} pages, ${collected.length} rows)`, before);
}

// ---------------------------------------------------------------------------

const S = "qwry_test";
const T = (n: string) => `${S}.${n}`;

console.log(`keyset-proof: ${HOST}/${DB} schema ${S}, page size ${PAGE}`);

exec(`
CREATE SCHEMA IF NOT EXISTS ${S};
DROP TABLE IF EXISTS ${T("qwry_kp_pk")};
DROP TABLE IF EXISTS ${T("qwry_kp_comp")};
DROP TABLE IF EXISTS ${T("qwry_kp_nulls")};
DROP TABLE IF EXISTS ${T("qwry_kp_ctid")};
DROP TABLE IF EXISTS ${T("qwry_kp_typed")};
DROP TABLE IF EXISTS ${T("qwry_kp_child")};
DROP TABLE IF EXISTS ${T("qwry_kp_parent")} CASCADE;

CREATE TABLE ${T("qwry_kp_pk")} (id int PRIMARY KEY, v text);
INSERT INTO ${T("qwry_kp_pk")} SELECT i, CASE WHEN i % 3 = 0 THEN 'alpha-' || i ELSE 'beta-' || i END FROM generate_series(1, 53) i;

CREATE TABLE ${T("qwry_kp_comp")} (a int, b int, v text, PRIMARY KEY (a, b));
INSERT INTO ${T("qwry_kp_comp")} SELECT i / 10 + 1, i % 10 + 1, 'r' || i FROM generate_series(0, 59) i;

CREATE TABLE ${T("qwry_kp_nulls")} (id int PRIMARY KEY, s int);
INSERT INTO ${T("qwry_kp_nulls")} SELECT i, i % 5 FROM generate_series(1, 30) i;
INSERT INTO ${T("qwry_kp_nulls")} SELECT i, NULL FROM generate_series(31, 55) i;

CREATE TABLE ${T("qwry_kp_ctid")} (x int, v text);
INSERT INTO ${T("qwry_kp_ctid")} SELECT i, 'c' || i FROM generate_series(1, 40) i;
ANALYZE ${T("qwry_kp_ctid")};

CREATE TABLE ${T("qwry_kp_typed")} (id int PRIMARY KEY, t timestamptz, n numeric);
INSERT INTO ${T("qwry_kp_typed")} SELECT i, '2026-07-01 00:00:00+00'::timestamptz + make_interval(hours => i / 4), i * 1.5 FROM generate_series(1, 48) i;

CREATE TABLE ${T("qwry_kp_parent")} (id int, v text);
CREATE TABLE ${T("qwry_kp_child")} () INHERITS (${T("qwry_kp_parent")});
INSERT INTO ${T("qwry_kp_parent")} SELECT i, 'p' || i FROM generate_series(1, 12) i;
INSERT INTO ${T("qwry_kp_child")} SELECT i, 'c' || i FROM generate_series(1, 12) i;
ANALYZE ${T("qwry_kp_parent")};
ANALYZE ${T("qwry_kp_child")};
`);

try {
  const vnum = Number(psqlRaw(`SELECT current_setting('server_version_num')`).trim());
  check(vnum >= 140000, `server_version_num ${vnum} (ctid cases need PG 14+)`);

  const pk = introspectTable(S, "qwry_kp_pk");
  const comp = introspectTable(S, "qwry_kp_comp");
  const nulls = introspectTable(S, "qwry_kp_nulls");
  const ctid = introspectTable(S, "qwry_kp_ctid");
  const typed = introspectTable(S, "qwry_kp_typed");
  const parent = introspectTable(S, "qwry_kp_parent");
  const child = introspectTable(S, "qwry_kp_child");

  const flt = (col: string, op: Filter["op"], value: string): Filter => ({
    col, op, value, enabled: true, conj: "AND",
  });

  // -- the original 8 paging cases -----------------------------------------
  // 1. single-col PK, no sort → row-value fast path on one key
  provePaging("1 pk no-sort", pk, [], null, vnum, 53);
  // 2. filter + keyset: seek predicate folds with the active WHERE
  provePaging("2 pk filtered", pk, [flt("v", "contains", "beta")], null, vnum, 36);
  // 3. composite PK, no sort → multi-key row-value seek
  provePaging("3 composite pk", comp, [], null, vnum, 60);
  // 4. duplicate sort values + NULL partition, ASC (OR-ladder; crosses from
  //    values into NULLS LAST, and pages INSIDE both dup runs and NULLs)
  provePaging("4 dups+nulls ASC", nulls, [], { col: "s", dir: "ASC" }, vnum, 55);
  // 5. same DESC (starts inside the NULLS FIRST partition → IS NOT NULL branch)
  provePaging("5 dups+nulls DESC", nulls, [], { col: "s", dir: "DESC" }, vnum, 55);
  // 6. sort ON the PK itself DESC (sort col == tiebreak col dedup path)
  provePaging("6 sort-on-pk DESC", pk, [], { col: "id", dir: "DESC" }, vnum, 53);
  // 7. PK-less ordinary table → ctid keyset in physical order
  provePaging("7 ctid keyset", ctid, [], null, vnum, 40);
  // 8. typed casts: timestamptz sort with duplicate values, DESC
  provePaging("8 timestamptz DESC dups", typed, [], { col: "t", dir: "DESC" }, vnum, 48);

  // -- K1: inheritance-parent ctid refusal ----------------------------------
  {
    const before = failures;
    // the hazard is real: the parent's scan unions child heaps whose ctids
    // collide with the parent's — ORDER BY ctid is not a total order here
    const [row] = query(`SELECT count(*), count(DISTINCT ctid) FROM ${T("qwry_kp_parent")}`);
    check(Number(row[0]) === 24, "K1: parent scan sees parent+child rows");
    check(Number(row[1]) < Number(row[0]), "K1: colliding ctids across child heaps (the hazard)");
    check(parent.has_children === true, "K1: introspected parent has_children=true");
    check(parent.kind === "r", "K1: inheritance parent is relkind r (hypertable shape)");
    check(keysetKeys(parent, null, vnum) === null, "K1: ctid keyset REFUSED on the parent");
    // old cached snapshot (field missing) = UNKNOWN → refuse, fail safe
    const stale = { ...parent } as TableInfo & { has_children?: boolean | null };
    delete stale.has_children;
    check(keysetKeys(stale, null, vnum) === null, "K1: unknown has_children (old cache) → refused");
    // and the generated page-1 plan is the documented offset fallback
    const plan = browseSql({ table: parent, filters: [], sort: null, limit: PAGE, keys: keysetKeys(parent, null, vnum) });
    check(!plan.includes("ORDER BY"), "K1: fallback plan has no ctid ORDER BY");
    // the leaf child is a normal heap → keyset allowed (proves the gate is
    // exactly relhassubclass, not a blanket PK-less refusal)
    check(child.has_children === false, "K1: child has_children=false");
    check(keysetKeys(child, null, vnum)?.[0]?.col === "ctid", "K1: child still gets ctid keyset");
    caseDone("9 K1 inheritance-parent refusal", before);
  }

  // -- K5: reltuples size gate (mocked estimates) ---------------------------
  {
    const before = failures;
    check(
      typeof ctid.reltuples === "number" && ctid.reltuples >= 0,
      "K5: analyzed fixture carries a real reltuples",
    );
    const at = (reltuples: number | null | undefined): TableInfo => {
      const t = { ...ctid } as TableInfo & { reltuples?: number | null };
      if (reltuples === undefined) delete t.reltuples;
      else t.reltuples = reltuples;
      return t;
    };
    check(keysetKeys(at(CTID_KEYSET_MAX_ESTIMATE), null, vnum) !== null, "K5: estimate == 1M → allowed");
    check(keysetKeys(at(CTID_KEYSET_MAX_ESTIMATE + 1), null, vnum) === null, "K5: estimate > 1M → refused");
    check(keysetKeys(at(-1), null, vnum) === null, "K5: reltuples=-1 (never analyzed) → refused");
    check(keysetKeys(at(null), null, vnum) === null, "K5: reltuples null → refused");
    check(keysetKeys(at(undefined), null, vnum) === null, "K5: reltuples missing (old cache) → refused");
    check(keysetKeys(ctid, null, 130000) === null, "K5: PG<14 still refused regardless of size");
    caseDone("10 K5 size gate", before);
  }
} finally {
  exec(`
DROP TABLE IF EXISTS ${T("qwry_kp_pk")};
DROP TABLE IF EXISTS ${T("qwry_kp_comp")};
DROP TABLE IF EXISTS ${T("qwry_kp_nulls")};
DROP TABLE IF EXISTS ${T("qwry_kp_ctid")};
DROP TABLE IF EXISTS ${T("qwry_kp_typed")};
DROP TABLE IF EXISTS ${T("qwry_kp_child")};
DROP TABLE IF EXISTS ${T("qwry_kp_parent")} CASCADE;
`);
}

console.log(`\n${cases} cases, ${asserts} assertions, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
