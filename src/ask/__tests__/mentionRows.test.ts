// The `@` under the caret and the rows the popover offers for it (W6,
// mentionRows.ts): the grammar read up to the caret, the replacement span a
// pick covers, and the matching rule (substring on the name the user would
// type, a column by its own name, prefix before substring, legacy and system
// relations never rows, columns from two characters and capped).

import { describe, expect, test } from "bun:test";
import type { Thread } from "../../agent/types";
import type { SavedQuery } from "../../stores/saved";
import type { SchemaSnapshot, TableInfo } from "../../stores/schema";
import {
  COLUMN_ROW_CAP,
  mentionQueryAt,
  mentionRows,
  mentionTokenEnd,
  rowsHint,
  shortType,
} from "../mentionRows";

const col = (name: string, type = "text", attnum = 1): TableInfo["columns"][number] => ({
  name,
  attnum,
  type,
  type_oid: 0,
  not_null: false,
  default: null,
});

const table = (
  oid: number,
  name: string,
  columns: TableInfo["columns"],
  reltuples: number | null,
  extra: Partial<TableInfo> = {},
): TableInfo => ({
  table_oid: oid,
  schema: "public",
  name,
  kind: "r",
  columns,
  pk: ["id"],
  reltuples,
  comment: null,
  parent_oid: null,
  ...extra,
});

const snapshot: SchemaSnapshot = {
  tables: [
    table(1, "order_v2", [col("id", "uuid", 1), col("order_status", "text", 2), col("payment_status", "text", 3)], 2_104_331),
    table(2, "erp_order_cost_snapshot", [col("id", "uuid", 1), col("order_id", "uuid", 2), col("order_ref", "text", 3)], 318_204),
    table(3, "orders_legacy", [col("id", "bigint", 1), col("order_no", "text", 2)], 1_902_114, {
      comment: "LEGACY: replaced by order_v2",
    }),
    table(4, "wardrobe_products_v2", [col("id", "bigint", 1), col("product_id", "bigint", 2)], 9_811_402),
    table(5, "pg_statistic", [col("starelid", "oid", 1)], 400, { schema: "pg_catalog" }),
    table(6, "alembic_version", [col("version_num", "text", 1)], 1),
    table(7, "order_v2_2026_08", [col("id", "uuid", 1), col("order_status", "text", 2)], 200_000, { parent_oid: 1 }),
    table(8, "orders", [col("id", "bigint", 1), col("order_status", "text", 2)], 12, { schema: "archive" }),
    table(9, "wide", Array.from({ length: 60 }, (_, i) => col(`col_${i}`, "text", i + 1)), -1),
    table(10, "feed", [col("id", "bigint", 1)], 5, { kind: "f" }),
  ],
  foreign_keys: [],
  functions: [],
  schemas: ["public", "archive"],
  indexes: [],
  enums: [],
};

const saved: SavedQuery[] = [
  { id: "s1", name: "Monthly revenue", sql: "SELECT 1" },
  { id: "s2", name: "Orders by day", sql: "SELECT 2" },
];
const threads: Thread[] = [
  { id: "t-current", profileId: "p", title: "orders this month", createdAt: "2026-09-05T10:00:00Z" },
  { id: "t-refunds", profileId: "p", title: "how many orders were refunded in August", createdAt: "2026-09-04T10:00:00Z" },
  { id: "t-revenue", profileId: "p", title: "revenue last month", createdAt: "2026-09-02T10:00:00Z" },
];
const ctx = { snapshot, saved, threads, currentThreadId: "t-current" };

const labels = (rows: { label: string; column?: string }[]) => rows.map((r) => r.label + (r.column ?? ""));

describe("mentionQueryAt", () => {
  test("an @ at a word boundary with the fragment typed so far", () => {
    expect(mentionQueryAt("which @ord", 10)).toEqual({ at: 6, filter: "ord" });
    expect(mentionQueryAt("which @", 7)).toEqual({ at: 6, filter: "" });
    expect(mentionQueryAt("@ord", 4)).toEqual({ at: 0, filter: "ord" });
    expect(mentionQueryAt("(@order_v2.ord", 14)).toEqual({ at: 1, filter: "order_v2.ord" });
  });

  test("a space or a non-path character after the fragment closes it", () => {
    expect(mentionQueryAt("which @ord ", 11)).toBeNull();
    expect(mentionQueryAt("which @ord,", 11)).toBeNull();
    expect(mentionQueryAt("which @ord\n", 11)).toBeNull();
  });

  test("an @ inside a word is not a tag", () => {
    expect(mentionQueryAt("mail me@ord", 11)).toBeNull();
    expect(mentionQueryAt("नाम@users", 9)).toBeNull();
  });

  test("the caret inside a finished token still counts, with the fragment up to it", () => {
    expect(mentionQueryAt("see @order_v2 now", 7)).toEqual({ at: 4, filter: "or" });
  });

  test("a quoted name runs to the caret with its spaces and closes at the quote", () => {
    expect(mentionQueryAt('with @"Monthly rev', 18)).toEqual({ at: 5, filter: "Monthly rev" });
    expect(mentionQueryAt('with @"', 7)).toEqual({ at: 5, filter: "" });
    expect(mentionQueryAt('with @"Monthly revenue"', 23)).toBeNull();
    expect(mentionQueryAt('with @"Monthly\nrevenue', 22)).toBeNull();
    expect(mentionQueryAt('x@"Monthly', 10)).toBeNull();
  });

  test("a selection, not a caret, is nothing to complete", () => {
    expect(mentionQueryAt("which @ord", -1)).toBeNull();
    expect(mentionQueryAt("which @ord", 11)).toBeNull();
  });
});

describe("mentionTokenEnd", () => {
  test("a path runs past the caret to its end", () => {
    expect(mentionTokenEnd("see @order_v2 now", 4, 7)).toBe(13);
    expect(mentionTokenEnd("see @ord", 4, 8)).toBe(8);
    expect(mentionTokenEnd("see @order_v2.", 4, 14)).toBe(14);
  });

  test("a quoted name runs past its closing quote on the caret's line, else to the caret", () => {
    expect(mentionTokenEnd('x @"Monthly revenue" y', 2, 6)).toBe(20);
    expect(mentionTokenEnd('x @"Monthly rev', 2, 15)).toBe(15);
    expect(mentionTokenEnd('x @"Monthly rev\n"y"', 2, 15)).toBe(15);
  });
});

describe("mentionRows", () => {
  test("`ord`: tables and columns by their own name, prefix before substring, one bookmark, one other thread", () => {
    const g = mentionRows("ord", false, ctx);
    expect(labels(g.tables)).toEqual(["order_v2", "archive.orders", "erp_order_cost_snapshot"]);
    expect(labels(g.columns)).toEqual([
      "order_v2.order_status",
      "erp_order_cost_snapshot.order_id",
      "erp_order_cost_snapshot.order_ref",
      "archive.orders.order_status",
    ]);
    expect(labels(g.saved)).toEqual(["Orders by day"]);
    expect(labels(g.threads)).toEqual(["how many orders were refunded in August"]);
    expect(g.count).toBe(9);
  });

  test("legacy, system, housekeeping, partition and foreign relations are never rows", () => {
    const g = mentionRows("", false, ctx);
    expect(labels(g.tables)).toEqual(["wardrobe_products_v2", "order_v2", "erp_order_cost_snapshot", "archive.orders", "wide"]);
  });

  test("a table's hint is its row estimate, else its column count; a column's is its type", () => {
    const g = mentionRows("ord", false, ctx);
    expect(g.tables.map((r) => r.hint)).toEqual(["~2.1M rows", "~12 rows", "~318k rows"]);
    expect(g.columns.map((r) => r.hint)).toEqual(["text", "uuid", "text", "text"]);
    expect(mentionRows("wide", false, ctx).tables[0].hint).toBe("60 columns");
    expect(g.saved[0].hint).toBeNull();
    expect(g.threads[0].hint).toBeNull();
  });

  test("tokens are the grammar's canonical form: bare paths, quoted names, the schema when not public", () => {
    const g = mentionRows("ord", false, ctx);
    expect(g.tables.map((r) => r.token)).toEqual(["@order_v2", "@archive.orders", "@erp_order_cost_snapshot"]);
    expect(g.columns[0].token).toBe("@order_v2.order_status");
    expect(g.saved[0].token).toBe('@"Orders by day"');
    expect(g.threads[0].token).toBe('@"how many orders were refunded in August"');
    const archive = mentionRows("archive.ord", false, ctx);
    expect(archive.tables.map((r) => r.token)).toEqual(["@archive.orders"]);
    expect(archive.columns.map((r) => r.token)).toEqual(["@archive.orders.order_status"]);
  });

  test("a prefix match outranks a substring match; ties keep the largest table first", () => {
    const g = mentionRows("v2", false, ctx);
    expect(labels(g.tables)).toEqual(["wardrobe_products_v2", "order_v2"]);
    const p = mentionRows("pro", false, ctx);
    expect(labels(p.tables)).toEqual(["wardrobe_products_v2"]);
    expect(labels(p.columns)).toEqual(["wardrobe_products_v2.product_id"]);
  });

  test("columns from two characters, capped, and the filter never fuzzes", () => {
    expect(mentionRows("o", false, ctx).columns).toEqual([]);
    expect(labels(mentionRows("o", false, ctx).tables)).toContain("order_v2");
    expect(mentionRows("col_", false, ctx).columns).toHaveLength(COLUMN_ROW_CAP);
    expect(labels(mentionRows("ord", false, ctx).tables)).not.toContain("wardrobe_products_v2");
  });

  test("a dotted fragment names the table and filters its columns; an empty tail lists them all", () => {
    expect(labels(mentionRows("order_v2.", false, ctx).columns)).toEqual([
      "order_v2.id",
      "order_v2.order_status",
      "order_v2.payment_status",
    ]);
    expect(labels(mentionRows("order_v2.pay", false, ctx).columns)).toEqual(["order_v2.payment_status"]);
    expect(mentionRows("order_v2.pay", false, ctx).tables).toEqual([]);
    expect(labels(mentionRows("erp.order_", false, ctx).columns)).toEqual([
      "erp_order_cost_snapshot.order_id",
      "erp_order_cost_snapshot.order_ref",
    ]);
  });

  test("a quoted fragment offers saved queries and threads only, spaces included", () => {
    const g = mentionRows("monthly r", true, ctx);
    expect(g.tables).toEqual([]);
    expect(g.columns).toEqual([]);
    expect(labels(g.saved)).toEqual(["Monthly revenue"]);
    expect(labels(mentionRows("revenue last", true, ctx).threads)).toEqual(["revenue last month"]);
  });

  test("the current thread is never offered to itself", () => {
    expect(labels(mentionRows("orders", false, ctx).threads)).toEqual(["how many orders were refunded in August"]);
  });

  test("nothing matched is an empty count, so the popover unmounts", () => {
    expect(mentionRows("zzz", false, ctx).count).toBe(0);
    expect(mentionRows("", false, { snapshot: null, saved: [], threads: [] }).count).toBe(0);
  });
});

describe("hints", () => {
  test("row estimates in the status register", () => {
    expect(rowsHint(2_104_331)).toBe("~2.1M rows");
    expect(rowsHint(318_204)).toBe("~318k rows");
    expect(rowsHint(12_043_118)).toBe("~12M rows");
    expect(rowsHint(9_960_000)).toBe("~10M rows");
    expect(rowsHint(412)).toBe("~412 rows");
    expect(rowsHint(1)).toBe("~1 row");
    expect(rowsHint(0)).toBe("~0 rows");
    expect(rowsHint(-1)).toBeNull();
    expect(rowsHint(null)).toBeNull();
  });

  test("psql's short type names", () => {
    expect(shortType("timestamp with time zone")).toBe("timestamptz");
    expect(shortType("timestamp without time zone")).toBe("timestamp");
    expect(shortType("character varying(120)")).toBe("varchar(120)");
    expect(shortType("double precision")).toBe("float8");
    expect(shortType("numeric(12,2)")).toBe("numeric(12,2)");
    expect(shortType("bigint[]")).toBe("bigint[]");
    expect(shortType("uuid")).toBe("uuid");
  });
});
