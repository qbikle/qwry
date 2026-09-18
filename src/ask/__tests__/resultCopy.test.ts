import { describe, expect, test } from "bun:test";
import type { AgentRun } from "../../agent/types";
import { copiedRowsCue, finished, resultTsv } from "../resultCopy";

const run = (columns: string[], rows: (string | null)[][]): AgentRun => ({
  columns,
  rows,
  rowCount: rows.length,
  capped: false,
  ms: 1,
});

describe("finished", () => {
  test("ends the statement with exactly one semicolon", () => {
    expect(finished("SELECT 1")).toBe("SELECT 1;");
    expect(finished("SELECT 1;")).toBe("SELECT 1;");
    expect(finished("SELECT 1;;;")).toBe("SELECT 1;");
    expect(finished("  SELECT 1  \n")).toBe("SELECT 1;");
  });
});

describe("resultTsv", () => {
  test("is the grid's own TSV: tabs between cells, newlines between rows, no header", () => {
    expect(resultTsv(run(["a", "b"], [["1", "2"], ["3", "4"]]))).toBe("1\t2\n3\t4");
  });

  test("NULL copies as an empty cell, the empty string as itself", () => {
    expect(resultTsv(run(["a", "b"], [[null, ""], ["x", "y"]]))).toBe("\t\nx\ty");
  });

  test("a cell holding a tab, a newline or a quote is quoted the Excel way", () => {
    expect(resultTsv(run(["a", "b"], [["x\ty", "he said \"go\""], ["p", "q"]]))).toBe(
      '"x\ty"\t"he said ""go"""\np\tq',
    );
  });

  test("a single cell copies raw: TSV quoting reads as garbage in an input field", () => {
    expect(resultTsv(run(["n"], [["217"]]))).toBe("217");
    expect(resultTsv(run(["n"], [[null]]))).toBe("");
  });

  test("a single cell that holds a tab or a newline still quotes (Excel's own rule)", () => {
    expect(resultTsv(run(["n"], [["a\tb"]]))).toBe('"a\tb"');
  });
});

describe("copiedRowsCue", () => {
  test("names the rows the block holds, singular at one", () => {
    expect(copiedRowsCue(9)).toBe("Copied 9 rows");
    expect(copiedRowsCue(1)).toBe("Copied 1 row");
    expect(copiedRowsCue(0)).toBe("Copied 0 rows");
  });

  test("thousands are grouped, as the status line groups them", () => {
    expect(copiedRowsCue(2000)).toBe("Copied 2,000 rows");
  });
});
