// What v4 was allowed to touch, and what it was not (AGENT-SPEC section 6,
// EVAL.md section 4). The measured lines of this prompt are the reason the
// agent scores what it scores: rule 1 alone took judgment injection from 4/4
// failing to 8/8 passing, and the two-turn work plan is what keeps a bench
// question at one turn. W5 rewrote the ANSWER SHAPE and nothing else, so
// those lines are pinned here byte for byte. W3b added three SQL rules to the
// same list W5 left alone and moved nothing else, so v3's shape and both of
// its examples are pinned here too: v4 exists to win back the accuracy v3
// spent, and a v4 that also moved the shape could not be read against it. A
// future wave that needs to move one of these moves this test in the same
// commit, deliberately, and re-baselines.

import { describe, expect, test } from "bun:test";
import { PROMPT_VERSION, SYSTEM_PROMPT, canvasMessage } from "../prompt";

/** byte-equal across v1, v2, v3 and v4 */
const MEASURED = [
  "- Do NOT add filters the question did not ask for (no is_deleted, no user_id <> 0, no status filters unless asked). If you think one is warranted, answer the question exactly as asked and list the assumption on the Assumptions line.",
  "- Return exactly the columns the question asks for, no extras.",
  "- Tables marked LEGACY are never the answer.",
  "Work plan (aim for two turns):",
  "1. FIRST turn: call describe_tables for every table you will use AND peek_values for every text/enum/status column you will filter on, all in the same turn.",
  "2. SECOND turn: run_sql. If the question came with a RISK CHECK, run the check queries in the same turn as (or before) the final query and act on what they show.",
  'one line starting with "Assumptions:" listing every interpretation you made that the question did not state, separated by semicolons. Each is a label of at most six words in Title Case, naming the column when one is involved (Added = sent_at; Excluding Deleted Users; This Year = 2026), never a quoted sentence. Write "Assumptions: none" when you made none.',
  "the final SQL in a ```sql block",
  "the final SQL in a ```sql code block",
];

/** the three SQL rules v4 added, one per measured loss (W3b) */
const V4_RULES = [
  "- Columns: the final SQL returns exactly the columns the question names and no other, not the column it orders by, not the count it ranked with, not an id; a figure the prose wants that the result will not carry comes from a query already run or one more run_sql, never from a column added to the final SQL.",
  "- Joins: two one-to-many relations joined to the same parent in one pass multiply each other's rows and inflate every SUM and COUNT, so aggregate each in its own CTE first and join the aggregates.",
  "- Rows and numbers: return the rows the data has, never padded with periods that have no rows (no generate_series spine unless the question asks for every period), and cast integer counts to numeric before dividing.",
];

describe("prompt v4", () => {
  test("the measured rules and the work plan are byte-equal to v2 and v3", () => {
    for (const line of MEASURED) expect(SYSTEM_PROMPT).toContain(line);
  });

  test("the version moved, because a string in this file did", () => {
    expect(PROMPT_VERSION).toBe("v4");
  });

  test("the three SQL rules v4 added are here, one per measured loss", () => {
    for (const line of V4_RULES) expect(SYSTEM_PROMPT).toContain(line);
  });

  test("they sit in the list that overrides instincts, above the work plan", () => {
    const rules = SYSTEM_PROMPT.indexOf("Rules that override your instincts:");
    const plan = SYSTEM_PROMPT.indexOf("Work plan (aim for two turns):");
    for (const line of V4_RULES) {
      const at = SYSTEM_PROMPT.indexOf(line);
      expect(at).toBeGreaterThan(rules);
      expect(at).toBeLessThan(plan);
    }
    // beside the column rule they sharpen, not somewhere else in the list
    expect(SYSTEM_PROMPT).toContain(
      "- Return exactly the columns the question asks for, no extras.\n" + V4_RULES[0],
    );
  });

  test("the escape from the extra column is another query, not another column", () => {
    // t3-08, t4-04, t5-01 all kept the column the prose read its figure from
    expect(SYSTEM_PROMPT).toContain("never from a column added to the final SQL");
    expect(SYSTEM_PROMPT).toContain("comes from a query already run or one more run_sql");
  });

  test("it says what the two shapes are and which question gets which", () => {
    expect(SYSTEM_PROMPT).toContain("A direct question gets ONE sentence.");
    expect(SYSTEM_PROMPT).toContain("two to four bullets");
    expect(SYSTEM_PROMPT).toContain("one-line bold lead-in ending in a colon");
    expect(SYSTEM_PROMPT).toContain("what stands out");
  });

  test("it shows the shape once well and once badly", () => {
    expect(SYSTEM_PROMPT).toContain("GOOD, for");
    expect(SYSTEM_PROMPT).toContain("BAD, same question");
    // the bad example is the failure mode the score names, in the shape the
    // model actually produces: a heading, and bullets that read the grid back
    expect(SYSTEM_PROMPT).toContain("## Orders in August");
    expect(SYSTEM_PROMPT).toContain("- 611 of 2,763 orders were COD, 22% of the month.");
  });

  test("it says what a bullet IS, not only what it must carry", () => {
    // the measured miss of v3's first draft: the shape arrived and DESIGN
    // rule 14 did not, because nothing in the prompt named the row read
    // aloud as the failure (EVAL.md section 3.x)
    expect(SYSTEM_PROMPT).toContain("never a row of the result read aloud");
    expect(SYSTEM_PROMPT).toContain("Each bullet is a comparison the grid cannot make for itself");
  });

  test("the examples are not the bench, so a bench answer cannot be copied from them", () => {
    for (const word of ["rental", "film", "pagila", "customer"]) {
      expect(SYSTEM_PROMPT.toLowerCase()).not.toContain(word);
    }
  });

  test("headings and a markdown table of the result are still refused", () => {
    expect(SYSTEM_PROMPT).toContain("Never a heading, never a markdown table of the result.");
  });
});

// ---- the CANVAS block (B3) --------------------------------------------------
// It rides the USER message, so PROMPT_VERSION does not move and no baseline
// row is owed (EVAL.md section 4). Pinned byte for byte the way A4's WRITES
// block is: it is the only place the model is told that the answer lands
// somewhere other than this reply, and a reword that drops a clause changes
// what the model writes into a person's document.
describe("the canvas block", () => {
  test("it names the target, the shapes and the one-line reply, byte for byte", () => {
    expect(canvasMessage("Canvas 4")).toBe(
      '\nCANVAS: the user is reading a canvas called "Canvas 4" and your answer goes INTO it through canvas_write, canvas_replace and canvas_read, not into this\n' +
        "reply. A result block carries one read-only SELECT; the canvas runs it, keeps its rows and prints its own status line under them. It stands on its chart\n" +
        "when the rows have one label column and one to three numeric columns, on its values when it returns one row, and on its table otherwise, so name a face\n" +
        "only to override that. Every result after the first carries a title of at most six words naming what it shows; the first wears the question. A note block\n" +
        "carries markdown: at most one bold lead-in ending in a colon and two to four bullets, each ONE finding with its own figure, a comparison the blocks above\n" +
        "cannot make for themselves, never a figure a result on this canvas already prints and never a markdown table. An insight question gets two to five blocks,\n" +
        "the results first and one note last; a direct question gets one result and no note. Write the results first and read their shapes back before you write the\n" +
        "note. Call canvas_read before writing into a canvas that already holds blocks, and replace a block you wrote yourself when new work supersedes it rather\n" +
        "than writing a second one beside it. A question that asks to change data is answered in this reply exactly as before, never as a block. When the blocks\n" +
        "are written, finish HERE with one sentence naming what you wrote and no ```sql block: each result's assumptions ride that block, so no Assumptions line\n" +
        "is needed here.",
    );
  });

  test("the outline is the tool layer's own lines, and absent on an empty canvas", () => {
    expect(canvasMessage("Sales")).not.toContain("OUTLINE OF");
    const one = canvasMessage("Sales", [
      {
        id: "9c110000-0000-4000-8000-000000000002",
        kind: "result",
        line: "Revenue by month",
        rows: 12,
        columns: ["month", "revenue"],
        face: "chart",
        modelWritten: true,
      },
    ]);
    expect(one).toContain(
      '\nOUTLINE OF "Sales" (1 block):\n9c11  result  Revenue by month · 12 rows: month, revenue · chart face',
    );
  });

  test("no dead sentence: the rules with no tool behind them are not stated", () => {
    const block = canvasMessage("Sales");
    // there is no canvas_create and no tool takes a canvas id, so "never
    // create a canvas" would be a sentence guarding nothing (DESIGN rule 11)
    expect(block).not.toContain("create a canvas");
    // and there is no delete tool: canvas_replace refuses an empty block, so
    // the model cannot delete by emptying either
    expect(block).not.toContain("delete");
  });

  test("the system prompt is untouched by it", () => {
    expect(PROMPT_VERSION).toBe("v4");
    expect(SYSTEM_PROMPT).not.toContain("CANVAS:");
    expect(SYSTEM_PROMPT).not.toContain("canvas");
  });
});
