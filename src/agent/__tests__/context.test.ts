// Prefilter recall, the candidate index and the DDL renderer (AGENT-SPEC
// sections 4.1, 4.2, 5).
//
// The recall number is the gate EVAL.md section 1 logs per question. It is
// pinned here against the real Pagila schema (fixtures/pagila-snapshot.json,
// regenerated with fixtures/snapshot.sql) so a scoring change that loses a
// table fails a unit test rather than a bench run.

import { describe, expect, test } from "bun:test";
import {
  buildMeta,
  candidates,
  goldTables,
  indexFor,
  recallOf,
  renderDescribe,
  stem,
  toks,
  type ColumnValueMap,
} from "../context";
import type { SchemaSnapshot } from "../../stores/schema";
import snapshot from "./fixtures/pagila-snapshot.json";
import questions from "./fixtures/pagila-questions.json";

const pagila = buildMeta(snapshot as unknown as SchemaSnapshot);

/** Measured 2026-09-05 on the lab Pagila. The two misses are two-hop joins the
 * one-hop expansion cannot reach (t2-05 customer to country, t4-02 payment to
 * inventory); the prompt tells the model to call list_tables when the
 * candidates do not fit. A drop below this is a regression. */
const RECALL_BASELINE = 31;
const KNOWN_MISSES = ["t2-05", "t4-02"];

describe("tokenisation", () => {
  test("stem folds the plurals the schema actually uses", () => {
    expect(stem("users")).toBe("user");
    expect(stem("categories")).toBe("category");
    expect(stem("addresses")).toBe("address");
    expect(stem("boxes")).toBe("box");
    expect(stem("film")).toBe("film");
  });

  test("toks drops stop words and short words, and stems the rest", () => {
    expect([...toks("How many films are in the database?")].sort()).toEqual([
      "database",
      "film",
    ]);
  });
});

describe("buildMeta", () => {
  test("partition children are not relations the model reasons about", () => {
    expect(pagila.byDisplay.has("payment")).toBe(true);
    expect(pagila.byDisplay.has("payment_p2022_01")).toBe(false);
  });

  test("views stay reachable by name even though the prefilter skips them", () => {
    expect(pagila.byDisplay.has("film_list")).toBe(true);
    expect(candidates("list the film titles", pagila)).toContain("film");
  });

  test("single-column foreign keys become graph edges", () => {
    expect(pagila.fks.some((f) => f.src === "rental" && f.dst === "inventory")).toBe(true);
  });
});

describe("prefilter recall on Pagila", () => {
  test(`holds at ${RECALL_BASELINE}/33`, () => {
    const missed: string[] = [];
    for (const q of questions) {
      if (recallOf(candidates(q.question, pagila), q.gold_sql, pagila) === false) {
        missed.push(q.id);
      }
    }
    expect(missed).toEqual(KNOWN_MISSES);
    expect(questions.length - missed.length).toBeGreaterThanOrEqual(RECALL_BASELINE);
  });

  test("every candidate set stays inside the k + 8 cap", () => {
    for (const q of questions) {
      expect(candidates(q.question, pagila).length).toBeLessThanOrEqual(22);
    }
  });

  test("goldTables only names tables the snapshot knows", () => {
    expect([...goldTables("SELECT * FROM film JOIN nope ON true", pagila)]).toEqual(["film"]);
    expect(recallOf(["film"], null, pagila)).toBeNull();
  });
});

// ---- legacy twins (section 4.2) -------------------------------------------

const twinSnapshot = (): SchemaSnapshot => ({
  tables: [
    {
      table_oid: 1,
      schema: "public",
      name: "orders",
      kind: "r",
      columns: [{ name: "id", attnum: 1, type: "integer", type_oid: 23, not_null: true, default: null }],
      pk: ["id"],
      reltuples: 10,
      comment: null,
    },
    {
      table_oid: 2,
      schema: "public",
      name: "orders_v2",
      kind: "r",
      columns: [
        { name: "id", attnum: 1, type: "integer", type_oid: 23, not_null: true, default: null },
        { name: "total", attnum: 2, type: "numeric", type_oid: 1700, not_null: false, default: null },
      ],
      pk: ["id"],
      reltuples: 20,
      comment: null,
    },
    {
      table_oid: 3,
      schema: "public",
      name: "carts",
      kind: "r",
      columns: [{ name: "id", attnum: 1, type: "integer", type_oid: 23, not_null: true, default: null }],
      pk: ["id"],
      reltuples: 5,
      comment: "LEGACY: replaced by orders_v2",
    },
  ],
  foreign_keys: [],
  functions: [],
  schemas: ["public"],
  indexes: [],
  enums: [],
});

describe("legacy twins and LEGACY comments", () => {
  const meta = buildMeta(twinSnapshot());

  test("a commentless _v twin says so, in both directions", () => {
    const index = indexFor(meta, ["orders", "orders_v2"]);
    expect(index).toContain("orders(id)  -- possible legacy twin of orders_v2");
    expect(index).toContain("orders_v2(id, total)  -- possible legacy twin of orders");
  });

  test("one real comment silences the note on both, as section 4.2 says", () => {
    const commented = twinSnapshot();
    commented.tables[0].comment = "current orders";
    const index = indexFor(buildMeta(commented), ["orders", "orders_v2"]);
    expect(index).toContain("orders(id)  -- current orders");
    expect(index).toContain("orders_v2(id, total)");
    expect(index.includes("possible legacy twin of")).toBe(false);
  });

  test("the synonym map bridges business words to table words", () => {
    expect(candidates("who are the buyers", meta)).toContain("orders");
  });

  test("a LEGACY table is never a candidate", () => {
    expect(candidates("how many carts are there", meta)).toEqual([]);
  });
});

describe("renderDescribe", () => {
  const meta = buildMeta(twinSnapshot());
  const values: ColumnValueMap = new Map([
    [
      "orders_v2",
      new Map([["total", { values: ["1.00", "2.00"], more: true, comment: null }]]),
    ],
  ]);

  test("header carries the row estimate and the comment", () => {
    const ddl = renderDescribe(buildMeta(twinSnapshot()), ["carts"]);
    expect(ddl).toContain("CREATE TABLE carts (  -- ~5 rows; LEGACY: replaced by orders_v2");
  });

  test("the comma comes before the values note, and the last column has none", () => {
    const ddl = renderDescribe(meta, ["orders_v2"], values);
    expect(ddl).toContain("  id integer PRIMARY KEY,");
    expect(ddl).toContain("  total numeric  -- values: '1.00', '2.00' … (more exist)");
    expect(ddl.endsWith(");")).toBe(true);
  });

  test("REFERENCES is rendered from the FK graph", () => {
    const ddl = renderDescribe(pagila, ["rental"]);
    expect(ddl).toContain("inventory_id integer REFERENCES inventory(inventory_id)");
  });

  test("an unknown name renders nothing rather than a hole", () => {
    expect(renderDescribe(meta, ["nope"])).toBe("");
  });

  test("a comment read by the describe call outranks the cached snapshot's", () => {
    const fresh: ColumnValueMap = new Map([
      ["orders_v2", new Map([["total", { values: [], more: false, comment: "gross, minor units" }]])],
    ]);
    expect(renderDescribe(meta, ["orders_v2"], fresh)).toContain(
      "total numeric  -- gross, minor units",
    );
  });
});
