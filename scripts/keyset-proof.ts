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
// (relhassubclass — colliding child ctids proven live), the reltuples
// size gate (mocked estimates), NULLS FIRST/LAST overrides (ladder
// variants), multi-column sort chains (mixed directions, tiebreaker
// absorbed into the chain), raw-WHERE composition with the seek, BETWEEN /
// quoted-IN filters through the paging pipeline, and ⌘L jump re-anchoring
// (offset page → keyset continuation, gapless).
//
// v0.8.1 additions: NULLS override on a deeper (non-head) chain key,
// overrides on BOTH keys at once, mixed directions over data with NULLs in
// both columns, sort chain + ctid tiebreak, jump re-anchor landing INSIDE a
// NULL partition under a chain+override, single-col-PK anchor truncation
// (chain [pk, nullable] must stay keyset when pages end on NULL — never the
// silent offset fallback; provePaging now asserts keyset-vs-fallback
// explicitly), and raw WHERE ending in a `--` line comment paged through
// the newline-safe seek composition.

import { spawnSync } from "bun";
import {
  browseCountSql,
  browsePageSql,
  browseSql,
  compiledWhere,
  keysetKeys,
  parseInList,
  CTID_KEYSET_MAX_ESTIMATE,
  type Filter,
  type KeysetKey,
  type SortChain,
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
  chain: SortChain,
  vnum: number,
  expectRows: number,
  rawWhere: string | null = null,
): void {
  const before = failures;
  const keys = keysetKeys(table, chain, vnum);
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
  let page = query(browseSql({ table, filters, sort: chain, limit: PAGE, keys, rawWhere }));
  let pages = 1;
  let fallbackPages = 0;
  collected.push(...page);
  while (page.length === PAGE && pages < 100) {
    const lastRow = page[page.length - 1];
    const last = keyIdx.map((i: number) => lastRow[i]);
    const sql = browsePageSql({ table, filters, keys, last, limit: PAGE, rawWhere });
    if (!sql) {
      fallbackPages++;
      break;
    }
    page = query(sql);
    pages++;
    collected.push(...page);
  }
  // keyset must STAY keyset: a null page SQL is the silent offset fallback —
  // an O(n²) regression even when the fallback would return the right rows
  check(
    fallbackPages === 0,
    `${name}: every continuation page used a keyset seek (no offset fallback)`,
  );

  const reference = query(browseSql({ table, filters, sort: chain, limit: 100000, keys, rawWhere }));
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
DROP TABLE IF EXISTS ${T("qwry_kp_multi")};
DROP TABLE IF EXISTS ${T("qwry_kp_ctid2")};
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

CREATE TABLE ${T("qwry_kp_multi")} (id int PRIMARY KEY, g int, s int);
INSERT INTO ${T("qwry_kp_multi")} SELECT i,
  CASE WHEN i % 7 = 0 THEN NULL ELSE i % 4 END,
  CASE WHEN i % 5 = 0 THEN NULL ELSE i % 3 END
FROM generate_series(1, 60) i;

CREATE TABLE ${T("qwry_kp_ctid2")} (x int, v text);
INSERT INTO ${T("qwry_kp_ctid2")} SELECT CASE WHEN i % 6 = 0 THEN NULL ELSE i % 5 END, 'd' || i FROM generate_series(1, 45) i;
ANALYZE ${T("qwry_kp_ctid2")};

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
  const multi = introspectTable(S, "qwry_kp_multi");
  const ctid2 = introspectTable(S, "qwry_kp_ctid2");
  const parent = introspectTable(S, "qwry_kp_parent");
  const child = introspectTable(S, "qwry_kp_child");

  const flt = (col: string, op: Filter["op"], value: string, value2?: string): Filter => ({
    col, op, value, value2, enabled: true, conj: "AND",
  });

  // -- the original 8 paging cases (single-sort → 0/1-link chains) ----------
  // 1. single-col PK, no sort → row-value fast path on one key
  provePaging("1 pk no-sort", pk, [], [], vnum, 53);
  // 2. filter + keyset: seek predicate folds with the active WHERE
  provePaging("2 pk filtered", pk, [flt("v", "contains", "beta")], [], vnum, 36);
  // 3. composite PK, no sort → multi-key row-value seek
  provePaging("3 composite pk", comp, [], [], vnum, 60);
  // 4. duplicate sort values + NULL partition, ASC (OR-ladder; crosses from
  //    values into NULLS LAST, and pages INSIDE both dup runs and NULLs)
  provePaging("4 dups+nulls ASC", nulls, [], [{ column: "s", dir: "asc" }], vnum, 55);
  // 5. same DESC (starts inside the NULLS FIRST partition → IS NOT NULL branch)
  provePaging("5 dups+nulls DESC", nulls, [], [{ column: "s", dir: "desc" }], vnum, 55);
  // 6. sort ON the PK itself DESC (sort col == tiebreak col dedup path)
  provePaging("6 sort-on-pk DESC", pk, [], [{ column: "id", dir: "desc" }], vnum, 53);
  // 7. PK-less ordinary table → ctid keyset in physical order
  provePaging("7 ctid keyset", ctid, [], [], vnum, 40);
  // 8. typed casts: timestamptz sort with duplicate values, DESC
  provePaging("8 timestamptz DESC dups", typed, [], [{ column: "t", dir: "desc" }], vnum, 48);

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
    check(keysetKeys(parent, [], vnum) === null, "K1: ctid keyset REFUSED on the parent");
    // old cached snapshot (field missing) = UNKNOWN → refuse, fail safe
    const stale = { ...parent } as TableInfo & { has_children?: boolean | null };
    delete stale.has_children;
    check(keysetKeys(stale, [], vnum) === null, "K1: unknown has_children (old cache) → refused");
    // and the generated page-1 plan is the documented offset fallback
    const plan = browseSql({ table: parent, filters: [], sort: [], limit: PAGE, keys: keysetKeys(parent, [], vnum) });
    check(!plan.includes("ORDER BY"), "K1: fallback plan has no ctid ORDER BY");
    // the leaf child is a normal heap → keyset allowed (proves the gate is
    // exactly relhassubclass, not a blanket PK-less refusal)
    check(child.has_children === false, "K1: child has_children=false");
    check(keysetKeys(child, [], vnum)?.[0]?.col === "ctid", "K1: child still gets ctid keyset");
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
    check(keysetKeys(at(CTID_KEYSET_MAX_ESTIMATE), [], vnum) !== null, "K5: estimate == 1M → allowed");
    check(keysetKeys(at(CTID_KEYSET_MAX_ESTIMATE + 1), [], vnum) === null, "K5: estimate > 1M → refused");
    check(keysetKeys(at(-1), [], vnum) === null, "K5: reltuples=-1 (never analyzed) → refused");
    check(keysetKeys(at(null), [], vnum) === null, "K5: reltuples null → refused");
    check(keysetKeys(at(undefined), [], vnum) === null, "K5: reltuples missing (old cache) → refused");
    check(keysetKeys(ctid, [], 130000) === null, "K5: PG<14 still refused regardless of size");
    caseDone("10 K5 size gate", before);
  }

  // -- v0.8: NULLS overrides (ladder variants) -------------------------------
  // 11. ASC NULLS FIRST: starts INSIDE the NULL partition (after-NULL under
  //     placement FIRST ⇒ IS NOT NULL branch), then pages through the values
  provePaging("11 override ASC NULLS FIRST", nulls, [], [{ column: "s", dir: "asc", nulls: "first" }], vnum, 55);
  // 12. DESC NULLS LAST: values first (after-value ⇒ `< v OR IS NULL`), then
  //     pages INSIDE the trailing NULL partition on the tiebreaker
  provePaging("12 override DESC NULLS LAST", nulls, [], [{ column: "s", dir: "desc", nulls: "last" }], vnum, 55);

  // -- v0.8: multi-column chains ---------------------------------------------
  // 13. mixed directions across the chain; both PK cols ARE the chain, so the
  //     tiebreaker is fully absorbed (dedup path) and the ladder runs mixed
  provePaging("13 chain mixed dirs (a↑ b↓)", comp, [], [{ column: "a", dir: "asc" }, { column: "b", dir: "desc" }], vnum, 60);
  // 14. chain + override + PK-in-chain: dup/NULL sort key overridden to LAST
  //     under DESC, tiebroken by the PK also sorted DESC inside the chain
  provePaging(
    "14 chain override+pk-in-chain",
    nulls,
    [],
    [{ column: "s", dir: "desc", nulls: "last" }, { column: "id", dir: "desc" }],
    vnum,
    55,
  );

  // -- v0.8: raw-WHERE escape hatch composes with the seek -------------------
  // 15. raw WHERE only (ORs inside — must be parenthesized against the seek)
  provePaging("15 raw WHERE", pk, [], [], vnum, 39, "v LIKE 'beta%' OR id <= 9");
  // 16. raw WHERE + sort chain over dups+NULLs
  provePaging("16 raw WHERE + sort", nulls, [], [{ column: "s", dir: "asc" }], vnum, 50, "id > 5");

  // -- v0.8: new filter ops flow through the same safe pipeline --------------
  // 17. BETWEEN (two operands) on a numeric column
  provePaging("17 BETWEEN filter", typed, [flt("n", "BETWEEN", "10", "60")], [], vnum, 34);
  // 18. IN with quoted-string parsing (a quoted value carrying a comma rides
  //     along; every literal still goes through ql)
  provePaging(
    "18 IN quoted filter",
    pk,
    [flt("v", "IN", "beta-1, 'beta-2', \"alpha-3\", beta-4, alpha-6, beta-7, beta-8, alpha-9, beta-10, beta-11, alpha-12, beta-13, beta-14, alpha-15, beta-16, beta-17, alpha-18, beta-19, beta-20, alpha-21, beta-22, beta-23, alpha-24, beta-25")],
    [],
    vnum,
    24,
  );

  // -- J1: ⌘L jump — offset page, then keyset re-anchor ----------------------
  {
    const before = failures;
    const keys = keysetKeys(pk, [], vnum)!;
    const reference = query(browseSql({ table: pk, filters: [], sort: [], limit: 100000, keys }));
    const jumpSql = browseSql({ table: pk, filters: [], sort: [], limit: PAGE, keys, offset: 10 });
    check(jumpSql.endsWith(`LIMIT ${PAGE} OFFSET 10`), "J1: jump page-1 SQL carries OFFSET");
    const jump = query(jumpSql);
    check(
      JSON.stringify(jump) === JSON.stringify(reference.slice(10, 10 + PAGE)),
      "J1: offset jump page equals the reference slice",
    );
    // continuation: seek from the LANDED page's last row (loadMore's path —
    // the offset never appears again)
    const colNames = pk.columns.map((c) => c.name);
    const keyIdx = keys.map((k) => colNames.indexOf(k.col));
    const last = keyIdx.map((i) => jump[jump.length - 1][i]);
    const nextSql = browsePageSql({ table: pk, filters: [], keys, last, limit: PAGE });
    check(nextSql !== null && !nextSql.includes("OFFSET"), "J1: continuation is a pure keyset seek");
    const next = query(nextSql!);
    check(
      JSON.stringify(next) === JSON.stringify(reference.slice(10 + PAGE, 10 + 2 * PAGE)),
      "J1: keyset continuation after a jump stays gapless",
    );
    caseDone("19 J1 jump re-anchor", before);
  }

  // -- K6: generated-SQL shapes (no server needed beyond two live probes) ----
  {
    const before = failures;
    // NULLS clause emitted ONLY when it differs from the direction's default
    const chainOver: SortChain = [{ column: "s", dir: "asc", nulls: "first" }];
    const kOver = keysetKeys(nulls, chainOver, vnum)!;
    const sqlOver = browseSql({ table: nulls, filters: [], sort: chainOver, limit: 5, keys: kOver });
    check(sqlOver.includes(`"s" ASC NULLS FIRST`), "K6: override emits NULLS FIRST");
    check(!sqlOver.includes(`"id" ASC NULLS`), "K6: default tiebreaker emits no NULLS clause");
    const chainDef: SortChain = [{ column: "s", dir: "asc" }];
    const kDef = keysetKeys(nulls, chainDef, vnum)!;
    check(
      !browseSql({ table: nulls, filters: [], sort: chainDef, limit: 5, keys: kDef }).includes("NULLS"),
      "K6: default placement keeps the pre-override SQL shape",
    );
    // offset-fallback ORDER BY (keys=null) carries the same override text
    check(
      browseSql({ table: parent, filters: [], sort: [{ column: "v", dir: "desc", nulls: "last" }], limit: 5, keys: null })
        .includes(`"v" DESC NULLS LAST`),
      "K6: offset-fallback ORDER BY honors the override",
    );
    // IN parsing: quoted commas, doubled-quote escapes, refusals
    check(JSON.stringify(parseInList("a, 'b, c', d")) === JSON.stringify(["a", "b, c", "d"]), "K6: quoted comma stays one value");
    check(JSON.stringify(parseInList("'it''s', x")) === JSON.stringify(["it's", "x"]), "K6: doubled-quote escape");
    check(parseInList("'unterminated").length === 0, "K6: unterminated quote → refuse");
    check(parseInList("'a' junk, b").length === 0, "K6: junk after quoted token → refuse");
    check(parseInList("  ").length === 0, "K6: blank input → no values");
    check(
      browseSql({ table: pk, filters: [flt("v", "IN", "a, 'b, c'")], sort: [], limit: 5 }).includes(`"v" IN ('a', 'b, c')`),
      "K6: IN folds parsed values through ql",
    );
    // BETWEEN emission + half-typed rows stay inactive
    check(
      browseSql({ table: typed, filters: [flt("n", "BETWEEN", "10", "60")], sort: [], limit: 5 }).includes(`"n" BETWEEN '10' AND '60'`),
      "K6: BETWEEN emits both bounds",
    );
    check(
      !browseSql({ table: typed, filters: [flt("n", "BETWEEN", "10")], sort: [], limit: 5 }).includes("WHERE"),
      "K6: BETWEEN missing second bound = inactive",
    );
    check(
      !browseSql({ table: pk, filters: [flt("v", "IN", "'unterminated")], sort: [], limit: 5 }).includes("WHERE"),
      "K6: unparseable IN = inactive (never IN ())",
    );
    // raw-WHERE ownership: raw mode replaces builder filters entirely
    check(compiledWhere([flt("v", "=", "x")], "id < 5") === "id < 5", "K6: raw text wins over builder");
    check(compiledWhere([flt("v", "=", "x")], "   ") === null, "K6: empty raw = NO where (builder must not leak through)");
    check(compiledWhere([flt("v", "=", "x")], null) === `("v" = 'x')`, "K6: builder mode compiles the chip text");
    // count SQL uses the SAME where body
    check(
      browseCountSql({ table: pk, filters: [], rawWhere: "id < 5" }) ===
        `SELECT count(*) FROM "qwry_test"."qwry_kp_pk"\nWHERE id < 5`,
      "K6: count(*) composes the same WHERE",
    );
    // page SQL ANDs the raw text with the seek, parenthesized — the closing
    // paren + seek on their OWN line so a trailing `--` can't eat them
    const pkeys = keysetKeys(pk, [], vnum)!;
    const psql = browsePageSql({ table: pk, filters: [], keys: pkeys, last: ["10"], limit: 5, rawWhere: "id < 40 OR v = 'x'" });
    check(psql !== null && psql.includes(`WHERE (id < 40 OR v = 'x'\n) AND (`), "K6: raw WHERE ANDs with the keyset seek");
    // live: the raw predicate + jsonb-free ops actually execute
    const live = query(browseSql({ table: pk, filters: [flt("v", "IN", "'beta-1', beta-2")], sort: [], limit: 10, keys: pkeys }));
    check(live.length === 2, "K6: live quoted-IN query returns exactly the named rows");
    caseDone("20 K6 SQL shapes", before);
  }

  // -- v0.8.1: deeper/multi NULLS overrides + mixed dirs over 2-NULL data ----
  // 21. override on a DEEPER (non-head) chain key: g pages by default, the
  //     override sits on s — the ladder's inner branches carry it
  provePaging("21 deeper-key override", multi, [], [{ column: "g", dir: "asc" }, { column: "s", dir: "asc", nulls: "first" }], vnum, 60);
  // 22. overrides on BOTH keys simultaneously (both non-default placements)
  provePaging("22 overrides on both keys", multi, [], [{ column: "g", dir: "asc", nulls: "first" }, { column: "s", dir: "desc", nulls: "last" }], vnum, 60);
  // 23. mixed directions, default placements, NULLs present in BOTH columns
  provePaging("23 mixed dirs, NULLs in both", multi, [], [{ column: "g", dir: "asc" }, { column: "s", dir: "desc" }], vnum, 60);

  // -- v0.8.1: sort chain over a PK-less table → ctid tiebreak ---------------
  // 24. chain key with dups AND a NULL partition, tiebroken by ctid (pages
  //     inside dup runs and inside the NULL partition on physical order)
  provePaging("24 chain + ctid tiebreak", ctid2, [], [{ column: "x", dir: "asc" }], vnum, 45);

  // -- v0.8.1: ⌘L jump landing INSIDE a NULL partition, chain + override -----
  // 25. NULLS FIRST override puts the 25-row NULL partition up front; the
  //     jump lands inside it, so the re-anchor seeks from a NULL sort value
  //     (after-NULL under FIRST ⇒ IS NOT NULL branch + tiebreak descent)
  {
    const before = failures;
    const chain: SortChain = [{ column: "s", dir: "asc", nulls: "first" }];
    const keys = keysetKeys(nulls, chain, vnum)!;
    const reference = query(browseSql({ table: nulls, filters: [], sort: chain, limit: 100000, keys }));
    const jump = query(browseSql({ table: nulls, filters: [], sort: chain, limit: PAGE, keys, offset: 5 }));
    check(
      JSON.stringify(jump) === JSON.stringify(reference.slice(5, 5 + PAGE)),
      "25: offset jump page inside the NULL partition equals the reference slice",
    );
    const colNames = nulls.columns.map((c) => c.name);
    const keyIdx = keys.map((k) => colNames.indexOf(k.col));
    const last = keyIdx.map((i) => jump[jump.length - 1][i]);
    check(last[0] === null, "25: landed page's sort anchor is a NULL (proves we're inside the partition)");
    const nextSql = browsePageSql({ table: nulls, filters: [], keys, last, limit: PAGE });
    check(nextSql !== null && !nextSql.includes("OFFSET"), "25: continuation is a pure keyset seek");
    const next = query(nextSql!);
    check(
      JSON.stringify(next) === JSON.stringify(reference.slice(5 + PAGE, 5 + 2 * PAGE)),
      "25: keyset continuation from a NULL anchor stays gapless",
    );
    caseDone("25 jump re-anchor in NULL partition (chain+override)", before);
  }

  // -- v0.8.1: single-col-PK anchor truncation (finding: NULL terminal key) --
  // 26. chain [pk, nullable]: the absorbed single-col PK anchor already
  //     totally orders, so the keys truncate to [id] and pages ending on
  //     s IS NULL (ids 31+) keep seeking — the pre-fix code returned null
  //     from seekPredicate there and silently fell back to offset paging
  provePaging("26 anchor truncation [pk, nullable]", nulls, [], [{ column: "id", dir: "asc" }, { column: "s", dir: "asc" }], vnum, 55);

  // -- v0.8.1: raw WHERE ending in a line comment pages safely ---------------
  // 27. page 1 and count always survived a trailing `--` (nothing follows the
  //     WHERE body on its line); page 2 used to be a syntax error because the
  //     one-line wrap let the comment eat the seek — prove full paging now,
  //     with a nullable sort chain so the seek is the OR-ladder form
  provePaging("27 raw WHERE trailing --", pk, [], [{ column: "v", dir: "asc" }], vnum, 48, "id > 5 -- tail comment");

  // -- K7: anchor-truncation + comment-composition SQL shapes ----------------
  {
    const before = failures;
    const chainPkS: SortChain = [{ column: "id", dir: "asc" }, { column: "s", dir: "asc" }];
    const kTrunc = keysetKeys(nulls, chainPkS, vnum)!;
    check(kTrunc.length === 1 && kTrunc[0].col === "id", "K7: [pk, nullable] truncates to the anchor alone");
    check(
      browseSql({ table: nulls, filters: [], sort: chainPkS, limit: 5, keys: kTrunc }) ===
        browseSql({ table: nulls, filters: [], sort: [{ column: "id", dir: "asc" }], limit: 5, keys: keysetKeys(nulls, [{ column: "id", dir: "asc" }], vnum) }),
      "K7: truncated chain is byte-identical to the bare [pk] chain",
    );
    const kDeep = keysetKeys(nulls, [{ column: "s", dir: "asc" }, { column: "id", dir: "asc" }], vnum)!;
    check(kDeep.length === 2, "K7: keys BEFORE a terminal anchor are kept (no over-truncation)");
    const kCompPart = keysetKeys(comp, [{ column: "a", dir: "asc" }], vnum)!;
    check(kCompPart.length === 2, "K7: one column of a composite PK is NOT unique-alone — no truncation");
    const kCompFull = keysetKeys(comp, [{ column: "a", dir: "asc" }, { column: "b", dir: "desc" }], vnum)!;
    check(kCompFull.length === 2, "K7: fully absorbed composite PK keeps today's behavior");
    const kMidAnchor = keysetKeys(nulls, [{ column: "id", dir: "desc" }, { column: "s", dir: "desc", nulls: "last" }], vnum)!;
    check(kMidAnchor.length === 1 && kMidAnchor[0].dir === "DESC", "K7: truncation holds under DESC + suffix override");
    const kCtidChain = keysetKeys(ctid2, [{ column: "x", dir: "asc" }], vnum)!;
    check(kCtidChain[kCtidChain.length - 1]?.col === "ctid", "K7: chain over a PK-less table tiebreaks on ctid");
    // trailing line comment cannot eat the wrap: paren + seek on their own line
    const pkeys = keysetKeys(pk, [], vnum)!;
    const pComment = browsePageSql({ table: pk, filters: [], keys: pkeys, last: ["10"], limit: 5, rawWhere: "id < 40 -- note" });
    check(pComment !== null && pComment.includes(`WHERE (id < 40 -- note\n) AND (`), "K7: seek survives a trailing line comment");
    const [cRow] = query(browseCountSql({ table: pk, filters: [], rawWhere: "id > 5 -- tail comment" }));
    check(Number(cRow?.[0]) === 48, "K7: count(*) with a trailing line comment executes live");
    caseDone("28 K7 truncation + comment shapes", before);
  }
} finally {
  exec(`
DROP TABLE IF EXISTS ${T("qwry_kp_pk")};
DROP TABLE IF EXISTS ${T("qwry_kp_comp")};
DROP TABLE IF EXISTS ${T("qwry_kp_nulls")};
DROP TABLE IF EXISTS ${T("qwry_kp_ctid")};
DROP TABLE IF EXISTS ${T("qwry_kp_typed")};
DROP TABLE IF EXISTS ${T("qwry_kp_multi")};
DROP TABLE IF EXISTS ${T("qwry_kp_ctid2")};
DROP TABLE IF EXISTS ${T("qwry_kp_child")};
DROP TABLE IF EXISTS ${T("qwry_kp_parent")} CASCADE;
`);
}

console.log(`\n${cases} cases, ${asserts} assertions, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
