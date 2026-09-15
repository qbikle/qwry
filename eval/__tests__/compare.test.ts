// The verdict is the whole point of the harness (EVAL.md section 1): if the
// comparison is wrong, every number in this repo is wrong and nothing else
// catches it. These tests pin the ported rules, not the implementation.

import { describe, expect, test } from "bun:test";
import {
  NULL_CELL,
  compareRows,
  limitShape,
  normCell,
  normalise,
  sameRows,
  tieCheck,
  withTieColumns,
} from "../compare";

const BOOL = 16;
const INT4 = 23;
const NUMERIC = 1700;
const FLOAT8 = 701;
const TEXT = 25;
const DATE = 1082;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;

describe("normCell", () => {
  test("a NULL is a glyph, never an empty string", () => {
    expect(normCell(null, TEXT)).toBe(NULL_CELL);
    expect(normCell("", TEXT)).toBe("");
  });

  test("trailing zeros go, at four decimal places", () => {
    expect(normCell("2.9800", NUMERIC)).toBe("2.98");
    expect(normCell("115.20", NUMERIC)).toBe("115.2");
    expect(normCell("3.0", FLOAT8)).toBe("3");
    expect(normCell("0.5", FLOAT8)).toBe("0.5");
  });

  test("a numeric and a double of the same value agree", () => {
    expect(normCell("4.99", NUMERIC)).toBe(normCell("4.99", FLOAT8));
    expect(normCell("100", NUMERIC)).toBe(normCell("100.0", FLOAT8));
    expect(normCell("0.123456", NUMERIC)).toBe(normCell("0.123456", FLOAT8));
    expect(normCell("-2.50", NUMERIC)).toBe(normCell("-2.5", FLOAT8));
  });

  test("numeric keeps every digit a float would lose", () => {
    // the verifier's case: both collapsed to 12345678901234.5684 through Number()
    expect(normCell("12345678901234.5678", NUMERIC)).toBe("12345678901234.5678");
    expect(normCell("12345678901234.5679", NUMERIC)).toBe("12345678901234.5679");
    expect(normCell("12345678901234.5678", NUMERIC)).not.toBe(
      normCell("12345678901234.5679", NUMERIC),
    );
    expect(normCell("99999999999999999999.00001", NUMERIC)).toBe("99999999999999999999");
    expect(normCell("0.99995", NUMERIC)).toBe("1");
    expect(normCell("-0.00004", NUMERIC)).toBe("0");
    expect(normCell("007.10", NUMERIC)).toBe("7.1");
  });

  test("integers and text pass through, booleans stay t/f", () => {
    expect(normCell("42", INT4)).toBe("42");
    expect(normCell("Sci-Fi", TEXT)).toBe("Sci-Fi");
    expect(normCell("t", BOOL)).toBe("t");
    expect(normCell("f", BOOL)).toBe("f");
  });

  test("a timestamp reads as ISO, and an offset gains its minutes", () => {
    expect(normCell("2005-05-24", DATE)).toBe("2005-05-24");
    expect(normCell("2005-05-24 22:53:30", TIMESTAMP)).toBe("2005-05-24T22:53:30");
    expect(normCell("2005-05-24 22:53:30+00", TIMESTAMPTZ)).toBe("2005-05-24T22:53:30+00:00");
    expect(normCell("2005-05-24 22:53:30+05:30", TIMESTAMPTZ)).toBe(
      "2005-05-24T22:53:30+05:30",
    );
  });
});

describe("multiset comparison", () => {
  test("row order never decides a verdict", () => {
    const a = normalise(
      [
        ["2", "b"],
        ["1", "a"],
      ],
      [INT4, TEXT],
    );
    const b = normalise(
      [
        ["1", "a"],
        ["2", "b"],
      ],
      [INT4, TEXT],
    );
    expect(sameRows(a, b)).toBe(true);
  });

  test("a duplicate row is not a set member: multiset, not set", () => {
    const twice = normalise([["1"], ["1"]], [INT4]);
    const once = normalise([["1"]], [INT4]);
    expect(sameRows(twice, once)).toBe(false);
  });

  test("an extra column is a different answer", () => {
    const one = normalise([["Action"]], [TEXT]);
    const two = normalise([["Action", "5"]], [TEXT, INT4]);
    expect(sameRows(one, two)).toBe(false);
  });

  test("tuples order element by element, shortest first", () => {
    expect(compareRows(["a"], ["b"])).toBeLessThan(0);
    expect(compareRows(["a", "b"], ["a"])).toBeGreaterThan(0);
    expect(compareRows(["a", "b"], ["a", "b"])).toBe(0);
  });
});

describe("limitShape", () => {
  test("no LIMIT is not a boundary to check", () => {
    expect(limitShape("SELECT count(*) FROM film")).toBeNull();
  });

  test("the probe asks for one more row than the gold keeps", () => {
    const shape = limitShape(
      "SELECT customer_id, sum(amount) AS total FROM payment GROUP BY customer_id ORDER BY total DESC LIMIT 5",
    );
    expect(shape?.limit).toBe(5);
    expect(shape?.probeSql.endsWith("LIMIT 6")).toBe(true);
    expect(shape?.orderBy).toEqual(["total"]);
  });

  test("direction and NULLS ordering are not part of the key", () => {
    const shape = limitShape(
      "SELECT a, b FROM t ORDER BY b DESC NULLS LAST, a ASC LIMIT 3",
    );
    expect(shape?.orderBy).toEqual(["b", "a"]);
  });

  test("a LIMIT inside a subquery is not the outer boundary", () => {
    expect(limitShape("SELECT count(*) FROM (SELECT 1 LIMIT 5) s")).toBeNull();
  });

  test("an aggregate the question never asked to see becomes a tie column", () => {
    const sql = "SELECT rating FROM film GROUP BY rating ORDER BY count(*) DESC LIMIT 1";
    const shape = limitShape(sql);
    expect(shape?.orderBy).toEqual(["count(*)"]);
    expect(withTieColumns(shape?.probeSql ?? "", ["count(*)"])).toBe(
      "SELECT count(*) AS __tie_0,  rating FROM film GROUP BY rating ORDER BY count(*) DESC LIMIT 2",
    );
  });
});

describe("tieCheck", () => {
  const run = (rows: (string | null)[][], columns: string[], typeOids: number[]) =>
    async () => ({ columns, typeOids, rows });

  test("a question with no LIMIT is not checked", async () => {
    const out = await tieCheck("SELECT 1", run([], [], []));
    expect(out.checked).toBe(false);
  });

  test("equal keys across the boundary are a tie", async () => {
    const out = await tieCheck(
      "SELECT customer_id, total FROM t ORDER BY total DESC LIMIT 2",
      run(
        [
          ["1", "10"],
          ["2", "5"],
          ["3", "5"],
        ],
        ["customer_id", "total"],
        [INT4, NUMERIC],
      ),
    );
    expect(out).toEqual({ checked: true, tie: true, rows: 3 });
  });

  test("a clean boundary is reported clean", async () => {
    const out = await tieCheck(
      "SELECT customer_id, total FROM t ORDER BY total DESC LIMIT 2",
      run(
        [
          ["1", "10"],
          ["2", "5"],
          ["3", "4"],
        ],
        ["customer_id", "total"],
        [INT4, NUMERIC],
      ),
    );
    expect(out).toEqual({ checked: true, tie: false, rows: 3 });
  });

  test("fewer rows than the limit cannot tie at a boundary that does not exist", async () => {
    const out = await tieCheck(
      "SELECT a FROM t ORDER BY a LIMIT 5",
      run([["1"]], ["a"], [INT4]),
    );
    expect(out).toEqual({ checked: true, tie: false, rows: 1 });
  });

  test("an unreadable key is reported unknown, never assumed clean", async () => {
    const out = await tieCheck(
      "SELECT a FROM t ORDER BY count(*) DESC LIMIT 1",
      // the rewrite is attempted and this fake runner answers it the same way,
      // with no __tie_0 column, so no key resolves
      run([["x"], ["y"]], ["a"], [TEXT]),
    );
    expect(out).toEqual({ checked: true, tie: null, rows: 2 });
  });
});
