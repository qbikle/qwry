// Every branch of the tolerant extractor (AGENT-SPEC section 4.6). The
// tolerance is worth 22 points on a small model, so each branch is pinned:
// a "cleanup" that drops one is a measured regression, not a refactor.

import { describe, expect, test } from "bun:test";
import {
  buildAssumptions,
  detectFilters,
  extractSql,
  parseAssumptions,
} from "../extract";

describe("extractSql", () => {
  test("empty input has no branch at all", () => {
    expect(extractSql("").how).toBe("none");
    expect(extractSql(null).sql).toBeNull();
    expect(extractSql(undefined).how).toBe("none");
  });

  test("tool-call syntax wins over everything after it", () => {
    const out = extractSql(
      "<|tool_call_start|>[sql('SELECT count(*) FROM film;')]<|tool_call_end|>\n```sql\nSELECT 1\n```",
    );
    expect(out.how).toBe("tool-call");
    expect(out.sql).toBe("SELECT count(*) FROM film");
  });

  test("tool-call syntax unescapes the quote it was wrapped in", () => {
    const out = extractSql(`[sql("SELECT * FROM film WHERE rating = \\"G\\"")]`);
    expect(out.how).toBe("tool-call");
    expect(out.sql).toBe('SELECT * FROM film WHERE rating = "G"');
  });

  test("an empty tool call yields no SQL, and still names its branch", () => {
    const out = extractSql("[sql('   ;  ')]");
    expect(out.how).toBe("tool-call");
    expect(out.sql).toBeNull();
  });

  test("sql fence, case-insensitively", () => {
    const out = extractSql("Here you go:\n```SQL\nSELECT 1;\n```\nthat is all");
    expect(out.how).toBe("sql-fence");
    expect(out.sql).toBe("SELECT 1");
  });

  test("bare fence when the language tag is missing", () => {
    const out = extractSql("```\nSELECT 2\n```");
    expect(out.how).toBe("fence");
    expect(out.sql).toBe("SELECT 2");
  });

  test("raw text when the model forgot to fence at all", () => {
    const out = extractSql("SELECT 3;");
    expect(out.how).toBe("raw");
    expect(out.sql).toBe("SELECT 3");
  });

  test("stray special tokens are stripped from the raw branch", () => {
    const out = extractSql("<|im_start|>SELECT 4<|im_end|>");
    expect(out.how).toBe("raw");
    expect(out.sql).toBe("SELECT 4");
  });

  test("stray special tokens are stripped inside a fence too", () => {
    const out = extractSql("```sql\nSELECT 5 <|eot_id|>\n```");
    expect(out.sql).toBe("SELECT 5");
  });

  test("every trailing semicolon goes, whitespace and all", () => {
    expect(extractSql("```sql\n SELECT 6 ;; \n```").sql).toBe("SELECT 6");
  });

  test("the first sql fence wins when the model shows its work", () => {
    const out = extractSql("```sql\nSELECT 7\n```\nand then\n```sql\nSELECT 8\n```");
    expect(out.sql).toBe("SELECT 7");
  });
});

describe("parseAssumptions", () => {
  test("none means no chips", () => {
    expect(parseAssumptions("Assumptions: none")).toEqual([]);
    expect(parseAssumptions("assumptions: None.")).toEqual([]);
  });

  test("semicolons split one line into chips", () => {
    expect(
      parseAssumptions("Assumptions: paid means payment_status 'paid'; 2025 by created_at"),
    ).toEqual(["paid means payment_status 'paid'", "2025 by created_at"]);
  });

  test("newlines and bullets split too", () => {
    expect(parseAssumptions("Assumptions:\n- excluded deleted users\n- utc dates")).toEqual([
      "excluded deleted users",
      "utc dates",
    ]);
  });

  test("a fence after the line is not an assumption", () => {
    const text = "Assumptions: one thing\n```sql\nSELECT 1\n```";
    expect(parseAssumptions(text)).toEqual(["one thing"]);
  });

  test("no line, no chips", () => {
    expect(parseAssumptions("Here is the answer.")).toEqual([]);
  });
});

describe("detectFilters", () => {
  test("an unasked is_deleted filter becomes a chip", () => {
    const found = detectFilters("SELECT count(*) FROM users WHERE is_deleted = false", "How many users are there?");
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("Excluding Deleted Rows");
  });

  test("the same filter is not a chip when the question asked for it", () => {
    expect(
      detectFilters("SELECT count(*) FROM users WHERE is_deleted = false", "How many users are not deleted?"),
    ).toEqual([]);
  });

  test("deleted_at IS NULL counts as the same interpretation", () => {
    const found = detectFilters("SELECT 1 FROM users WHERE u.deleted_at IS NULL", "How many users?");
    expect(found).toHaveLength(1);
  });

  test("a status equality the question never mentioned", () => {
    const found = detectFilters(
      "SELECT count(*) FROM orders WHERE payment_status = 'paid'",
      "How many orders are paid?",
    );
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("payment_status = 'paid'");
  });

  test("a status equality the question spelled out is not an assumption", () => {
    expect(
      detectFilters(
        "SELECT count(*) FROM orders WHERE payment_status = 'paid'",
        "How many orders have payment_status paid?",
      ),
    ).toEqual([]);
  });

  test("an unasked user_id <> 0 becomes a chip", () => {
    const found = detectFilters("SELECT 1 FROM t WHERE user_id <> 0", "How many rows?");
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("Excluding Zero Ids");
  });
});

describe("buildAssumptions", () => {
  test("model chips come first, detected ones after, all active", () => {
    const chips = buildAssumptions({
      text: "Answer.\n\nAssumptions: 2025 by created_at",
      sql: "SELECT count(*) FROM users WHERE is_deleted = false",
      question: "How many users signed up in 2025?",
    });
    expect(chips).toHaveLength(2);
    expect(chips[0].source).toBe("model");
    expect(chips[0].label).toBe("2025 by created_at");
    expect(chips[1].source).toBe("detected");
    expect(chips[1].fragment).toBe("is_deleted = false");
    expect(chips.every((c) => c.active)).toBe(true);
  });

  test("no text and no sql yields no chips", () => {
    expect(buildAssumptions({ text: null, sql: null, question: "anything" })).toEqual([]);
  });
});
