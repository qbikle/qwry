import { describe, expect, test } from "bun:test";
import type { TraceStep } from "../../agent/types";
import { sanityStep } from "../sanityStep";

const tool = (id: string, name: string, args: Record<string, unknown>): TraceStep => ({
  step: "tool",
  ms: 1,
  id,
  name,
  args: JSON.stringify(args),
  result: "",
  isError: false,
});

const rangeSql = 'select min("added_at"), max("added_at")\nfrom wardrobe_products_v2';
const countSql = "select count(*) from wardrobe_products_v2 w join users u on u.id = w.user_id where w.added_at < u.created_at";

const trace: TraceStep[] = [
  { step: "context", ms: 3, candidates: ["orders", "users"], text: "CANDIDATE TABLES" },
  tool("t1", "describe_tables", { names: ["orders"] }),
  tool("t2", "peek_values", { table: "orders", column: "status" }),
  tool("t3", "peek_values", { table: "orders", column: "payment_status" }),
  tool("t4", "peek_values", { table: "users", column: "payment_status" }),
  tool("t5", "probe", { sqls: [rangeSql, countSql] }),
  tool("t6", "run_sql", { sql: "select 1" }),
  { step: "verdict", ms: 2, verdict: { status: "answered", sql: "select 1", rowCount: 1 } },
];

describe("sanityStep (AGENT-UX section 4)", () => {
  test("a fragment that names its step opens that step, whatever its text says", () => {
    expect(sanityStep({ text: "checked payment_status values", warn: false, stepId: "t4" }, trace)).toBe(
      "t4",
    );
    expect(sanityStep({ text: "42,524 first adds before signup", warn: true, sql: countSql, stepId: "t6" }, trace)).toBe(
      "t6",
    );
  });

  test("a step id the trace does not carry falls back to the structural match", () => {
    expect(sanityStep({ text: "checked payment_status values", warn: false, stepId: "gone" }, trace)).toBe(
      "t3",
    );
    expect(sanityStep({ text: "checked amount values", warn: false, stepId: "gone" }, trace)).toBeNull();
  });

  test("a probe fragment opens the probe call that listed its statement", () => {
    expect(sanityStep({ text: "added at 2019-03 → 2026-09", warn: false, sql: rangeSql }, trace)).toBe("t5");
    expect(sanityStep({ text: "42,524 first adds before signup", warn: true, sql: countSql }, trace)).toBe(
      "t5",
    );
  });

  test("a checked-values fragment opens the peek_values call for that column", () => {
    expect(sanityStep({ text: "checked payment_status values", warn: false }, trace)).toBe("t3");
    expect(sanityStep({ text: "checked status values", warn: false }, trace)).toBe("t2");
  });

  test("the first peek on a column wins, matching sanityLine's dedupe", () => {
    const only = trace.filter((t) => t.step !== "tool" || t.id !== "t3");
    expect(sanityStep({ text: "checked payment_status values", warn: false }, only)).toBe("t4");
  });

  test("nothing in the trace claims the fragment: null, never a guess", () => {
    expect(sanityStep({ text: "checked amount values", warn: false }, trace)).toBeNull();
    expect(sanityStep({ text: "3 rows checked", warn: false, sql: "select 3" }, trace)).toBeNull();
    expect(sanityStep({ text: "checked status values", warn: false }, [])).toBeNull();
  });

  test("args that are not JSON still match a probe by raw text", () => {
    const loose: TraceStep[] = [
      { step: "tool", ms: 1, id: "p", name: "probe", args: "sqls=select 2", result: "", isError: false },
    ];
    expect(sanityStep({ text: "2 rows checked", warn: false, sql: "select 2" }, loose)).toBe("p");
  });
});
