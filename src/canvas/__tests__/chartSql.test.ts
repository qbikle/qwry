// The composer every other part of the New Chart dialog stands on (F2): the
// statement, the two sentences it is read as, and the classifier that decides
// whether the `Per` row stands at all. No store, no DOM: this file is the
// reason the dialog can be changed without re-reading a frame to know what it
// will run.

import { describe, expect, test } from "bun:test";
import {
  chartAskWords,
  chartSql,
  chartTitle,
  columnKindOf,
  CHART_LIMITS,
  DATE_FORMAT,
  quoteIdent,
  type ChartPicks,
} from "../chartSql";

const picks = (over: Partial<ChartPicks> = {}): ChartPicks => ({
  schema: "public",
  table: "order_v2",
  group: "status",
  groupKind: "text",
  unit: "month",
  measure: null,
  agg: "sum",
  limit: 10,
  ...over,
});

describe("quoteIdent", () => {
  test("a bare lower-case name stays bare", () => {
    expect(quoteIdent("status")).toBe("status");
    expect(quoteIdent("created_at")).toBe("created_at");
    expect(quoteIdent("_x9$")).toBe("_x9$");
  });

  test("anything a bare name cannot carry is quoted", () => {
    expect(quoteIdent("Total Sales")).toBe('"Total Sales"');
    expect(quoteIdent("Status")).toBe('"Status"');
    expect(quoteIdent("2fast")).toBe('"2fast"');
    expect(quoteIdent("order-id")).toBe('"order-id"');
  });

  test("a reserved word is quoted even though it looks bare", () => {
    expect(quoteIdent("select")).toBe('"select"');
    expect(quoteIdent("group")).toBe('"group"');
    expect(quoteIdent("user")).toBe('"user"');
  });

  test("count is NOT reserved: the alias reads as the reader would type it", () => {
    expect(quoteIdent("count")).toBe("count");
  });

  test("an inner quote is doubled, never dropped", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe("columnKindOf", () => {
  test("the numeric types", () => {
    for (const t of [
      "integer",
      "bigint",
      "smallint",
      "numeric",
      "real",
      "double precision",
      "decimal",
      "numeric(10,2)",
      "INTEGER",
    ])
      expect(columnKindOf(t)).toBe("numeric");
  });

  test("the date types", () => {
    for (const t of [
      "date",
      "timestamp",
      "timestamptz",
      "timestamp with time zone",
      "timestamp without time zone",
      "timestamp(3) with time zone",
    ])
      expect(columnKindOf(t)).toBe("date");
  });

  test("everything else is text", () => {
    for (const t of ["text", "character varying(255)", "uuid", "jsonb", "boolean", "interval"])
      expect(columnKindOf(t)).toBe("text");
  });

  test("an array of numbers is text: nothing in it can be summed", () => {
    expect(columnKindOf("integer[]")).toBe("text");
    expect(columnKindOf("timestamp[]")).toBe("text");
  });
});

describe("chartSql, a text group", () => {
  test("count rows: the reading the sketch draws", () => {
    expect(chartSql(picks())).toBe(
      "select status, count(*) as count from public.order_v2 group by 1 order by 2 desc limit 10",
    );
  });

  test("every aggregate names its own column", () => {
    expect(chartSql(picks({ measure: "amount", agg: "sum" }))).toContain("sum(amount) as sum_amount");
    expect(chartSql(picks({ measure: "amount", agg: "avg" }))).toContain("avg(amount) as avg_amount");
    expect(chartSql(picks({ measure: "amount", agg: "min" }))).toContain("min(amount) as min_amount");
    expect(chartSql(picks({ measure: "amount", agg: "max" }))).toContain("max(amount) as max_amount");
  });

  test("the relation is schema-qualified and both halves are quoted when they must be", () => {
    expect(chartSql(picks({ schema: "Analytics", table: "order daily" }))).toContain(
      'from "Analytics"."order daily"',
    );
  });

  test("a group that needs quoting is quoted in the projection, never in the ordering", () => {
    const sql = chartSql(picks({ group: "Order Status" }));
    expect(sql).toStartWith('select "Order Status", count(*) as count');
    expect(sql).toEndWith("group by 1 order by 2 desc limit 10");
  });

  test("the limit is the pick", () => {
    for (const limit of CHART_LIMITS) expect(chartSql(picks({ limit }))).toEndWith(`limit ${limit}`);
  });
});

describe("chartSql, a date group", () => {
  const dated = (over: Partial<ChartPicks> = {}) =>
    chartSql(picks({ group: "created_at", groupKind: "date", measure: "amount", agg: "avg", limit: 12, ...over }));

  test("the newest N, then read left to right", () => {
    expect(dated()).toBe(
      "select * from (select to_char(date_trunc('month', created_at), 'YYYY-MM') as created_at, " +
        "avg(amount) as avg_amount from public.order_v2 group by 1 order by 1 desc limit 12) t order by 1",
    );
  });

  test("every unit carries its own format", () => {
    expect(dated({ unit: "day" })).toContain("date_trunc('day', created_at), 'YYYY-MM-DD')");
    expect(dated({ unit: "week" })).toContain("date_trunc('week', created_at), 'YYYY-MM-DD')");
    expect(dated({ unit: "month" })).toContain("date_trunc('month', created_at), 'YYYY-MM')");
    expect(dated({ unit: "year" })).toContain("date_trunc('year', created_at), 'YYYY')");
    expect(DATE_FORMAT.year).toBe("YYYY");
  });

  test("the label keeps the column's own name, so the chart's axis is the column", () => {
    expect(dated()).toContain("as created_at,");
  });

  test("count rows over a date group needs no measure column", () => {
    expect(dated({ measure: null })).toContain("count(*) as count");
  });
});

describe("chartTitle", () => {
  test("the three readings the section names", () => {
    expect(chartTitle(picks())).toBe("count by `status`");
    expect(chartTitle(picks({ measure: "amount", agg: "sum" }))).toBe("sum `amount` by `status`");
    expect(
      chartTitle(picks({ group: "created_at", groupKind: "date", measure: "amount", agg: "avg" })),
    ).toBe("avg `amount` by month of `created_at`");
  });

  test("the title never names the table: the statement under it does", () => {
    expect(chartTitle(picks())).not.toContain("order_v2");
  });
});

describe("chartAskWords", () => {
  const ask = (over: Partial<Parameters<typeof chartAskWords>[0]> = {}) =>
    chartAskWords({
      table: "order_v2",
      group: "status",
      groupKind: "text",
      unit: "month",
      measure: null,
      agg: "sum",
      ...over,
    });

  test("the picks, in the words a person would have typed", () => {
    expect(ask()).toBe("add a chart of order_v2 by status");
  });

  test("a measure rides in front of the table", () => {
    expect(ask({ measure: "amount", agg: "avg" })).toBe("add a chart of avg amount in order_v2 by status");
  });

  test("a date group names its unit", () => {
    expect(ask({ group: "created_at", groupKind: "date" })).toBe(
      "add a chart of order_v2 by month of created_at",
    );
  });

  test("a table with no group yet stops at the table", () => {
    expect(ask({ group: null })).toBe("add a chart of order_v2");
  });

  test("no picks at all is the sentence the Chart… row has always left", () => {
    expect(ask({ table: null, group: null })).toBe("add a chart of ");
  });
});
