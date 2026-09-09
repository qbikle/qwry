// The `@` under the caret and the rows the popover offers for it (W6,
// sectioned and fuzzy in B2, mentionRows.ts): the grammar read up to the
// caret, the replacement span a pick covers, the `kind/` path the box stands
// inside, and the list itself — the sectioned view an empty filter opens on,
// the one run a fragment collapses to, the caps, and the matching rule (a
// subsequence, exact and prefix above it, ties in the connection's order).

import { describe, expect, test } from "bun:test";
import type { CanvasRef } from "../../agent/mentions";
import type { Thread } from "../../agent/types";
import type { Recent } from "../../stores/recents";
import type { SavedQuery } from "../../stores/saved";
import type { SchemaSnapshot, TableInfo } from "../../stores/schema";
import {
  COLUMN_MIN_FILTER,
  ROW_CAP,
  SECTION_CAP,
  mentionQueryAt,
  mentionTokenEnd,
  narrowTo,
  rowsHint,
  sectionsFor,
  shortType,
  splitFilter,
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
const canvases: CanvasRef[] = [
  { id: "c1", title: "August finance" },
  { id: "c2", title: "Returns by city" },
];
/** what this connection reached for last: one of each kind, newest first */
const recents: Recent[] = [
  { kind: "table", key: "public.order_v2" },
  { kind: "saved", key: "s1" },
  { kind: "canvas", key: "c1" },
  { kind: "thread", key: "t-refunds" },
];

const ctx = { snapshot, saved, threads, canvases, recents, currentThreadId: "t-current" };
/** the connection before it was used: no recents, no canvases */
const cold = { snapshot, saved, threads, currentThreadId: "t-current" };

const labels = (rows: { label: string; column?: string }[]) => rows.map((r) => r.label + (r.column ?? ""));
const list = (filter: string, quoted = false, c: typeof cold | typeof ctx = ctx) =>
  sectionsFor(filter, quoted, c);

describe("mentionQueryAt", () => {
  test("an @ at a word boundary with the fragment typed so far", () => {
    expect(mentionQueryAt("which @ord", 10)).toEqual({ at: 6, filter: "ord" });
    expect(mentionQueryAt("which @", 7)).toEqual({ at: 6, filter: "" });
    expect(mentionQueryAt("@ord", 4)).toEqual({ at: 0, filter: "ord" });
    expect(mentionQueryAt("(@order_v2.ord", 14)).toEqual({ at: 1, filter: "order_v2.ord" });
  });

  test("a `kind/` path is part of the fragment, so a pick replaces all of it", () => {
    expect(mentionQueryAt("which @tables/pflg", 18)).toEqual({ at: 6, filter: "tables/pflg" });
    expect(mentionQueryAt("which @tables/", 14)).toEqual({ at: 6, filter: "tables/" });
    expect(mentionTokenEnd("see @tables/ord now", 4, 12)).toBe(15);
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

describe("the `kind/` path", () => {
  test("a filter splits at its slash, and only at one of the five words", () => {
    expect(splitFilter("tables/pflg")).toEqual({ path: "tables", text: "pflg" });
    expect(splitFilter("canvases/")).toEqual({ path: "canvases", text: "" });
    expect(splitFilter("pflg")).toEqual({ path: null, text: "pflg" });
    // a table actually named `tables` is still reachable by typing its name
    expect(splitFilter("tables")).toEqual({ path: null, text: "tables" });
    expect(splitFilter("docs/readme")).toEqual({ path: null, text: "docs/readme" });
    expect(splitFilter("/x")).toEqual({ path: null, text: "/x" });
  });

  test("a category row inserts the path and its slash, and takes no space", () => {
    expect(narrowTo("tables")).toBe("@tables/");
    expect(narrowTo("canvases")).toBe("@canvases/");
  });
});

describe("the sectioned box (nothing typed)", () => {
  test("the categories open it, then Recent and one section per kind", () => {
    const box = list("");
    expect(box.sections.map((s) => s.label)).toEqual([
      null,
      "Recent",
      "Tables",
      "Saved",
      "Canvases",
      "Threads",
    ]);
    expect(box.path).toBeNull();
  });

  test("the category rows are the tokens you would type, with no count in the hint", () => {
    const [cats] = list("").sections;
    expect(labels(cats.rows)).toEqual(["tables/", "columns/", "saved/", "canvases/", "threads/"]);
    expect(cats.rows.map((r) => r.token)).toEqual([
      "@tables/",
      "@columns/",
      "@saved/",
      "@canvases/",
      "@threads/",
    ]);
    expect(cats.rows.every((r) => r.hint === null && r.path !== undefined)).toBe(true);
    // the glyph each path wears; a canvas rides the ladder's fifth kind
    expect(cats.rows.map((r) => r.kind)).toEqual(["table", "column", "saved", "block", "thread"]);
  });

  test("Recent is what the connection reached for, one row per kind, newest first", () => {
    const recent = list("").sections[1];
    expect(labels(recent.rows)).toEqual([
      "order_v2",
      "Monthly revenue",
      "August finance",
      "how many orders were refunded in August",
    ]);
    // a row is read off the LIVE connection, so it keeps its own hint
    expect(recent.rows[0].hint).toBe("~2.1M rows");
    expect(recent.rows[1].hint).toBeNull();
  });

  test("a row Recent shows is not repeated in its own kind's section", () => {
    const [, , tables, savedSec, canvasSec, threadSec] = list("").sections;
    expect(labels(tables.rows)).not.toContain("order_v2");
    expect(labels(savedSec.rows)).toEqual(["Orders by day"]);
    expect(labels(canvasSec.rows)).toEqual(["Returns by city"]);
    expect(labels(threadSec.rows)).toEqual(["revenue last month"]);
  });

  test("Tables goes by recent use, then by size, and the whole box stays small", () => {
    // order_v2 leads by recency when Recent has no room for it
    const busy = list("", false, { ...ctx, recents: [{ kind: "table", key: "public.order_v2" }, { kind: "saved", key: "s1" }, { kind: "saved", key: "s2" }, { kind: "thread", key: "t-refunds" }, { kind: "thread", key: "t-revenue" }] });
    expect(labels(busy.sections[1].rows)).toEqual([
      "order_v2",
      "Monthly revenue",
      "Orders by day",
      "how many orders were refunded in August",
    ]);
    expect(labels(busy.sections[2].rows)).toEqual([
      "wardrobe_products_v2",
      "erp_order_cost_snapshot",
      "archive.orders",
      "wide",
    ]);
    const cold5 = list("", false, { ...ctx, recents: [{ kind: "thread", key: "t-refunds" }] });
    expect(labels(cold5.sections[2].rows)).toEqual([
      "wardrobe_products_v2",
      "order_v2",
      "erp_order_cost_snapshot",
      "archive.orders",
      "wide",
    ]);
    expect(cold5.sections[2].rows).toHaveLength(SECTION_CAP.tables);
    expect(list("").count).toBeLessThanOrEqual(
      5 + SECTION_CAP.recent + SECTION_CAP.tables + SECTION_CAP.saved + SECTION_CAP.canvases + SECTION_CAP.threads,
    );
  });

  test("a section with nothing is absent, and so is a category with nothing behind it", () => {
    const box = list("", false, cold);
    expect(box.sections.map((s) => s.label)).toEqual([null, "Tables", "Saved", "Threads"]);
    expect(labels(box.sections[0].rows)).toEqual(["tables/", "columns/", "saved/", "threads/"]);
    const bare = sectionsFor("", false, { snapshot: null, saved: [], threads: [] });
    expect(bare.count).toBe(0);
    expect(bare.sections).toEqual([]);
  });

  test("Columns has no section of its own: a column row needs two characters", () => {
    expect(list("").rows.some((r) => r.kind === "column" && r.path === undefined)).toBe(false);
  });
});

describe("a typed fragment", () => {
  test("one run, no labels, and the categories it reaches on top", () => {
    const box = list("ta");
    expect(box.sections).toHaveLength(1);
    expect(box.sections[0].label).toBeNull();
    expect(labels(box.rows.filter((r) => r.path !== undefined))).toEqual(["tables/", "threads/"]);
  });

  test("`ord`: tables and columns by their own name, prefix first, ties by size", () => {
    const box = list("ord");
    const kind = (k: string) => box.rows.filter((r) => r.path === undefined && r.kind === k);
    expect(labels(kind("table"))).toEqual([
      "order_v2",
      "archive.orders",
      "erp_order_cost_snapshot",
      // fuzzy reaches further than W7's substring did: w-a-r-d-r-o-b-e ... o·r·d
      "wardrobe_products_v2",
    ]);
    expect(labels(kind("column"))).toEqual([
      "order_v2.order_status",
      "erp_order_cost_snapshot.order_id",
      "erp_order_cost_snapshot.order_ref",
      "archive.orders.order_status",
    ]);
    expect(labels(kind("saved"))).toEqual(["Orders by day"]);
    expect(labels(kind("thread"))).toEqual(["how many orders were refunded in August"]);
    expect(labels(kind("block"))).toEqual([]);
  });

  test("legacy, system, housekeeping, partition and foreign relations are never rows", () => {
    const every = list("").rows.concat(list("e").rows, list("ord").rows);
    for (const dead of ["orders_legacy", "pg_catalog.pg_statistic", "alembic_version", "order_v2_2026_08", "feed"]) {
      expect(labels(every)).not.toContain(dead);
    }
  });

  test("a table's hint is its row estimate, else its column count; a column's is its type", () => {
    const box = list("ord");
    const tables = box.rows.filter((r) => r.kind === "table" && r.path === undefined);
    expect(tables.map((r) => r.hint)).toEqual(["~2.1M rows", "~12 rows", "~318k rows", "~9.8M rows"]);
    expect(list("wide").rows[0].hint).toBe("60 columns");
    expect(box.rows.filter((r) => r.kind === "column")[0].hint).toBe("text");
  });

  test("tokens are the grammar's canonical form: bare paths, quoted names, the schema when not public", () => {
    const box = list("ord");
    const token = (label: string) => box.rows.find((r) => r.label === label)?.token;
    expect(token("order_v2")).toBe("@order_v2");
    expect(token("archive.orders")).toBe("@archive.orders");
    expect(token("Orders by day")).toBe('@"Orders by day"');
    expect(token("how many orders were refunded in August")).toBe(
      '@"how many orders were refunded in August"',
    );
    const archive = list("archive.ord");
    expect(archive.rows.filter((r) => r.kind === "column").map((r) => r.token)).toEqual([
      "@archive.orders.order_status",
    ]);
  });

  test("an exact match, then a prefix, then the looser reading", () => {
    // both hold `v2` on a word start; order_v2 holds it nearer the beginning
    expect(labels(list("v2").rows.filter((r) => r.kind === "table"))).toEqual([
      "order_v2",
      "wardrobe_products_v2",
    ]);
    // `wide` is exact and stands above every table it shares letters with
    expect(list("wide").rows[0].label).toBe("wide");
  });

  test("`public.` is not a spelling the filter searches", () => {
    const tables = (filter: string) =>
      labels(list(filter).rows.filter((r) => r.kind === "table" && r.path === undefined));
    // scoring `public.<name>` handed the `p` fuzzy's head bonus on every
    // public relation and `@pu` a PREFIX match on all four of them, so both
    // runs below were the whole database in pool order
    expect(tables("p")).toEqual(["wardrobe_products_v2", "erp_order_cost_snapshot"]);
    expect(tables("pu")).toEqual(["wardrobe_products_v2"]);
    // outside `public` a relation is still reached by its bare name and by
    // the label its row draws
    expect(tables("orders")[0]).toBe("archive.orders");
    expect(tables("archive.ord")[0]).toBe("archive.orders");
  });

  test("columns from two characters, and capped", () => {
    // the `columns/` category still stands: it is the door, not a column
    expect(list("o").rows.some((r) => r.kind === "column" && r.path === undefined)).toBe(false);
    expect(labels(list("o").rows.filter((r) => r.kind === "column"))).toEqual(["columns/"]);
    expect(labels(list("o").rows.filter((r) => r.kind === "table"))).toContain("order_v2");
    expect(COLUMN_MIN_FILTER).toBe(2);
    expect(list("col_").rows.filter((r) => r.kind === "column")).toHaveLength(ROW_CAP);
  });

  test("a dotted fragment names the table and filters its columns; an empty tail lists them all", () => {
    const cols = (filter: string) =>
      labels(list(filter).rows.filter((r) => r.kind === "column" && r.path === undefined));
    expect(cols("order_v2.")).toEqual([
      "order_v2.id",
      "order_v2.order_status",
      "order_v2.payment_status",
    ]);
    expect(cols("order_v2.pay")).toEqual(["order_v2.payment_status"]);
    expect(list("order_v2.pay").rows.some((r) => r.kind === "table")).toBe(false);
    expect(cols("erp.order_")).toEqual([
      "erp_order_cost_snapshot.order_id",
      "erp_order_cost_snapshot.order_ref",
    ]);
    // the head must PREFIX the table: a dotted filter is a decision
    expect(cols("wpv.id")).toEqual([]);
  });

  test("nothing matched is an empty count, so the popover unmounts", () => {
    expect(list("zzq").count).toBe(0);
    expect(list("zzq").sections).toEqual([]);
  });
});

describe("inside a category", () => {
  test("one kind, one run, no labels, and the path the box stands in", () => {
    const box = list("tables/ord");
    expect(box.path).toBe("tables");
    expect(box.sections).toHaveLength(1);
    expect(box.sections[0].label).toBeNull();
    expect(labels(box.rows)).toEqual([
      "order_v2",
      "archive.orders",
      "erp_order_cost_snapshot",
      "wardrobe_products_v2",
    ]);
  });

  test("the sketch's own `pflg` run, which is what the head bonus is for", () => {
    // DECISIONS' B2 line pins this order: the head bonus belongs to the `p`
    // of `pipeline`, and scoring `public.<name>` gave it to `public` on all
    // three, which floated `wardrobe_products_flatlay_grid` and its four
    // word starts into second place
    // seeded out of the order it is asserted in, so the assertion pins the
    // SCORE, not the pool's own order (a tie would fail this run)
    const flatlay: SchemaSnapshot = {
      ...snapshot,
      tables: [
        table(22, "wardrobe_products_flatlay_grid", [col("id", "bigint", 1)], 640_231),
        table(21, "pipeline_flatlay_logs", [col("id", "bigint", 1)], 2_318_004),
        table(20, "product_flatlay_generations", [col("id", "uuid", 1)], 8_142_990),
      ],
    };
    expect(labels(sectionsFor("tables/pflg", false, { ...cold, snapshot: flatlay }).rows)).toEqual([
      "product_flatlay_generations",
      "pipeline_flatlay_logs",
      "wardrobe_products_flatlay_grid",
    ]);
  });

  test("an empty rest lists the kind in the connection's own order", () => {
    expect(labels(list("tables/").rows)).toEqual([
      "wardrobe_products_v2",
      "order_v2",
      "erp_order_cost_snapshot",
      "archive.orders",
      "wide",
    ]);
    expect(labels(list("saved/").rows)).toEqual(["Monthly revenue", "Orders by day"]);
    expect(labels(list("canvases/").rows)).toEqual(["August finance", "Returns by city"]);
    expect(labels(list("threads/").rows)).toEqual([
      "how many orders were refunded in August",
      "revenue last month",
    ]);
  });

  test("`columns/` is the door the two-character rule does not guard", () => {
    const box = list("columns/c");
    expect(box.rows.every((r) => r.kind === "column")).toBe(true);
    expect(box.rows).toHaveLength(ROW_CAP);
    expect(box.rows[0].label).toBe("wide");
    expect(box.rows[0].column).toBe(".col_0");
  });

  test("a canvas row names the whole canvas, quoted, and wears the ladder's fifth kind", () => {
    const [first] = list("canvases/aug").rows;
    expect(first).toMatchObject({ kind: "block", label: "August finance", token: '@"August finance"', hint: null });
    expect(first.path).toBeUndefined();
  });
});

describe("a quoted fragment", () => {
  test("saved queries, canvases and threads only, spaces included", () => {
    const box = list("monthly r", true);
    expect(box.rows.some((r) => r.kind === "table" || r.kind === "column")).toBe(false);
    expect(labels(box.rows)).toEqual(["Monthly revenue"]);
    expect(labels(list("revenue last", true).rows)).toEqual(["revenue last month"]);
    expect(labels(list("august f", true).rows)).toEqual(["August finance"]);
  });

  test("no categories: a path is never quoted", () => {
    expect(list("", true).rows.some((r) => r.path !== undefined)).toBe(false);
    expect(labels(list("", true).rows)).toEqual([
      "Monthly revenue",
      "Orders by day",
      "August finance",
      "Returns by city",
      "how many orders were refunded in August",
      "revenue last month",
    ]);
  });

  test("the current thread is never offered to itself", () => {
    // `orders this month` is the thread being asked in and has no row
    expect(labels(list("orders", true).rows)).toEqual([
      "Orders by day",
      "how many orders were refunded in August",
    ]);
  });
});

describe("Recent reads the live connection", () => {
  test("a pointer to something the connection no longer has is not a row", () => {
    const stale = list("", false, {
      ...ctx,
      recents: [
        { kind: "table", key: "public.gone" },
        { kind: "saved", key: "s-gone" },
        { kind: "canvas", key: "c-gone" },
        { kind: "thread", key: "t-gone" },
        // a banned relation is not a row either, however recently it was used
        { kind: "table", key: "public.orders_legacy" },
        { kind: "column", key: "public.order_v2.payment_status" },
      ],
    });
    expect(labels(stale.sections[1].rows)).toEqual(["order_v2.payment_status"]);
    expect(stale.sections[1].label).toBe("Recent");
  });

  test("the current thread is not a recent row of its own thread", () => {
    const own = list("", false, { ...ctx, recents: [{ kind: "thread", key: "t-current" }] });
    expect(own.sections.map((s) => s.label)).not.toContain("Recent");
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

describe("the keystroke budget", () => {
  // the real shape this replaces a dump of: ~200 relations and ~4000 columns,
  // scored on every keystroke. CLAUDE.md's budget is 16 ms from key to
  // completion, and the box is one part of that
  const big: SchemaSnapshot = {
    ...snapshot,
    tables: Array.from({ length: 200 }, (_, i) =>
      table(
        100 + i,
        `${["product", "wardrobe", "erp_order_cost", "pipeline", "tax_invoice"][i % 5]}_${i}_generations`,
        Array.from({ length: 20 }, (_, c) => col(`${["order", "product", "created", "payment", "snapshot"][c % 5]}_${c}_id`, "text", c + 1)),
        (200 - i) * 5000,
      ),
    ),
  };
  const heavy = { ...ctx, snapshot: big };

  test("a sectioned box and a fragment both land well inside 16 ms", () => {
    const pass = () => {
      sectionsFor("", false, heavy);
      sectionsFor("pflg", false, heavy);
      sectionsFor("order_", false, heavy);
      sectionsFor("columns/pay", false, heavy);
    };
    for (let i = 0; i < 5; i++) pass();
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const at = performance.now();
      pass();
      best = Math.min(best, performance.now() - at);
    }
    expect(best).toBeLessThan(16);
  });
});
