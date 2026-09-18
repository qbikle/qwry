// The harness's own half of AGENT-SPEC section 8.1. The app's gate is the
// `pg_query` AST walk in src-tauri/src/agent.rs; this is the same POLICY
// without a parser, and the read-only transaction behind it is what actually
// stops a write. These tests pin the policy and, as importantly, pin the
// shapes that must NOT be refused: a gate that rejects `last_update` would
// make the bench measure the gate instead of the model.

import { describe, expect, test } from "bun:test";
import { gateSql, lowCardinality, VALUES_CAP } from "../introspect.node";

describe("gateSql refuses", () => {
  const refused: [string, string][] = [
    ["DELETE FROM film", "DELETE"],
    ["UPDATE film SET title = 'x'", "UPDATE"],
    ["INSERT INTO film (title) VALUES ('x')", "INSERT"],
    ["WITH d AS (DELETE FROM film RETURNING 1) SELECT * FROM d", "data-modifying CTE"],
    ["SELECT 1; SELECT 2", "exactly one"],
    ["SELECT * FROM film FOR UPDATE", "row lock"],
    ["SELECT * FROM film FOR NO KEY UPDATE", "row lock"],
    ["SELECT (SELECT 1 FROM film FOR SHARE)", "row lock"],
    ["SELECT title INTO tmp FROM film", "materializes a new table"],
    ["SELECT pg_sleep(1)", "pg_sleep"],
    ["SELECT set_config('x', 'y', false)", "set_config"],
    ["SELECT pg_read_file('/etc/passwd')", "pg_read_file"],
    ["COPY film TO STDOUT", "not allowed"],
    ["SET work_mem = '1GB'", "not allowed"],
    ["", "empty statement"],
  ];
  for (const [sql, expected] of refused) {
    test(sql || "(empty)", () => {
      expect(gateSql(sql) ?? "").toContain(expected);
    });
  }
});

describe("gateSql allows", () => {
  const allowed = [
    "SELECT count(*) FROM film",
    "SELECT count(*) FROM film;",
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
    "EXPLAIN SELECT 1",
    "(SELECT 1) UNION (SELECT 2)",
    // the shapes a keyword scan gets wrong if it is careless
    "SELECT last_update FROM film LIMIT 1",
    "SELECT update_time FROM t ORDER BY update_time",
    "SELECT count(*) FROM users WHERE is_deleted = false",
    "SELECT count(*) FROM film WHERE title = 'DELETE FROM film'",
    "SELECT 1 -- DELETE FROM film",
    "WITH deleted AS (SELECT 1) SELECT * FROM deleted",
  ];
  for (const sql of allowed) {
    test(sql, () => {
      expect(gateSql(sql)).toBeNull();
    });
  }
});

describe("lowCardinality", () => {
  const row = (over: Partial<Parameters<typeof lowCardinality>[0]>) => ({
    schema: "public",
    table: "film",
    column: "rating",
    n_distinct: 5,
    reltuples: 1000,
    mcv: ["G", "PG", "R"] as (string | null)[] | null,
    hist: null,
    ...over,
  });

  test("most_common_vals and histogram_bounds are one sample, sorted and deduped", () => {
    expect(lowCardinality(row({ mcv: ["R", "G"], hist: ["G", "PG"] }))).toEqual({
      values: ["G", "PG", "R"],
      more: false,
    });
  });

  test("a negative n_distinct is a FRACTION of the row count, not a count", () => {
    // -0.001 * 1000 = 1 distinct value: a category
    expect(lowCardinality(row({ n_distinct: -0.001 }))?.values).toEqual(["G", "PG", "R"]);
    // -0.5 * 1000 = 500: not a category
    expect(lowCardinality(row({ n_distinct: -0.5 }))).toBeNull();
  });

  test("more distinct values than the cap is not a category", () => {
    expect(lowCardinality(row({ n_distinct: VALUES_CAP + 1 }))).toBeNull();
  });

  test("a column with no statistics says nothing rather than guessing", () => {
    expect(lowCardinality(row({ n_distinct: null }))).toBeNull();
    expect(lowCardinality(row({ mcv: null, hist: null }))).toBeNull();
  });

  test("a long value is a payload, not a hint", () => {
    expect(lowCardinality(row({ mcv: ["x".repeat(41)] }))).toBeNull();
  });

  test("a NULL inside the sampled array is dropped, not rendered", () => {
    expect(lowCardinality(row({ mcv: ["G", null, "PG"] }))?.values).toEqual(["G", "PG"]);
  });
});
