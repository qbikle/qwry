// The presentation score (EVAL.md section 3.x). Five heuristics decide what
// prompt v3 is rewarded for, so each one is pinned against an answer written
// by hand to fail exactly it, and the ladder they make together is pinned as
// a whole: a shaped insight answer 1.0, a wall of prose 0.4, a plain direct
// answer 0.6. A check that cannot tell those three apart is not a score.

import { describe, expect, test } from "bun:test";
import { presentationScore, presentationMean } from "../presentation";
import { gateAgainst, presentationOver } from "../../scripts/agent-eval";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../../src/agent/prompt";

const SQL = "\n```sql\nSELECT date_trunc('month', rental_date), count(*) FROM rental GROUP BY 1\n```\n";

/** the months grid the insight answers sit beside */
const monthsRun = {
  columns: ["month", "rentals"],
  rows: [
    ["2022-07", "6709"],
    ["2022-08", "5686"],
    ["2026-07", "1240"],
  ],
};

const good = `**Rentals peak in mid 2022:**

- July 2022 took 6,709 rentals, 13% of everything on record.
- The 2026 months average 1,240 a month, a fifth of that peak.
- Store 2 handled 51% of the year's rentals.
${SQL}
Assumptions: Month = rental_date`;

const wall = `The rental table covers a little over four years and the monthly counts are extremely uneven across that span, with the middle of 2022 carrying by far the largest share of the activity before the volume settles down to a much lower and much steadier rate that holds through the 2026 months on record, which between them add up to a fraction of that early peak.
${SQL}
Assumptions: Month = rental_date`;

/** the same wall as the model actually streams it, soft-wrapped at the width
 * of its own output: a paragraph, not five short sentences */
const wrappedWall = wall.replace(/, /g, ",\n");

/** the categories grid, whose labels a bullet can quote back word for word */
const categoryRun = {
  columns: ["name", "rentals"],
  rows: [
    ["Sci-Fi", "7935"],
    ["Documentary", "7900"],
  ],
};

const restates = `**Categories worth a look:**

- Sci-Fi leads with 7,935 rentals, 15% clear of the quietest category.
- The top four are within 3% of each other, so the lead is not a gap.
${SQL}
Assumptions: none`;

const headings = `## Overview

Rental volume is front-loaded.

### By month

- July 2022 took 6,709 rentals, 13% of everything on record.
- The 2026 months average 1,240 a month, a fifth of that peak.
${SQL}`;

const direct = "There are 1,000 films in the database.\n```sql\nSELECT count(*) FROM film\n```\nAssumptions: none";

describe("presentationScore", () => {
  test("a shaped insight answer scores 1.0", () => {
    const out = presentationScore(good, monthsRun);
    expect(out.checks).toEqual({
      bullets_in_range: 1,
      sentences_short: 1,
      figure_per_finding: 1,
      no_grid_restatement: 1,
      one_lead_in_at_most: 1,
    });
    expect(out.score).toBe(1);
  });

  test("a wall of prose keeps only the two checks it cannot spoil", () => {
    const out = presentationScore(wall, monthsRun);
    expect(out.checks.bullets_in_range).toBe(0);
    expect(out.checks.figure_per_finding).toBe(0);
    expect(out.checks.sentences_short).toBe(0);
    expect(out.score).toBe(0.4);
  });

  test("a bullet that reads two cells of one grid row back is the grid restated", () => {
    const out = presentationScore(restates, categoryRun);
    expect(out.checks.no_grid_restatement).toBe(0);
    expect(out.score).toBe(0.8);
  });

  test("the same answer with no run on screen is the model's own comparison", () => {
    expect(presentationScore(restates, null).checks.no_grid_restatement).toBe(1);
  });

  test("one value carried twice across a row is one fact, not the row", () => {
    // a count column repeated as a total is an ordinary shape: every order of
    // the month was paid, so `orders` and `paid` hold the same number, and a
    // bullet naming it once names one figure
    const carried = {
      columns: ["month", "orders", "paid"],
      rows: [["2026-08", "2763", "2763"]],
    };
    const one = "**August:**\n\n- All 2,763 orders in the month were paid.\n- The next month is running 12% behind.\n" + SQL;
    expect(presentationScore(one, carried).checks.no_grid_restatement).toBe(1);
    // and two distinct values of that same row still are the row
    const two = "**August:**\n\n- 2,763 orders in August, 1,204 of them prepaid.\n- The next month is running 12% behind.\n" + SQL;
    const both = { columns: ["month", "orders", "prepaid"], rows: [["2026-08", "2763", "1204"]] };
    expect(presentationScore(two, both).checks.no_grid_restatement).toBe(0);
  });

  test("a soft wrap is not a full stop", () => {
    expect(presentationScore(wrappedWall, monthsRun).checks.sentences_short).toBe(0);
  });

  test("a heading hierarchy is more than the one lead-in", () => {
    const out = presentationScore(headings, null);
    expect(out.checks.one_lead_in_at_most).toBe(0);
    expect(out.score).toBe(0.8);
  });

  test("a direct answer is short and honest and still not an insight answer", () => {
    const out = presentationScore(direct, { columns: ["count"], rows: [["1000"]] });
    expect(out.checks.sentences_short).toBe(1);
    expect(out.checks.one_lead_in_at_most).toBe(1);
    expect(out.checks.bullets_in_range).toBe(0);
    expect(out.score).toBe(0.6);
  });

  test("one finding is a sentence wearing a bullet, five are a wall with markers", () => {
    const items = (n: number) =>
      `${Array.from({ length: n }, (_, i) => `- Month ${i} took ${i + 1},200 rentals.`).join("\n")}\n`;
    expect(presentationScore(items(1), null).checks.bullets_in_range).toBe(0);
    expect(presentationScore(items(2), null).checks.bullets_in_range).toBe(1);
    expect(presentationScore(items(4), null).checks.bullets_in_range).toBe(1);
    expect(presentationScore(items(5), null).checks.bullets_in_range).toBe(0);
  });

  test("a figure the model bolded is still the finding's figure", () => {
    // the renderer re-tokenizes bold and draws the number at tier 1, so a
    // score that stopped at the top level would mark this bullet figureless
    // while the app drew its figure
    const bolded =
      "- **$0.00 payments exist**: 24 of them, all on one day.\n" +
      "- **Staff 2 leads**, by 0.5%.\n" +
      "- **Only 2 staff** run the counter, dead even.\n";
    expect(presentationScore(bolded, null).checks.figure_per_finding).toBe(1);
  });

  test("a date, an id and a version are not the finding's figure", () => {
    const dated = "- The 2026-08 bucket is empty.\n- Question t1-01 still runs on v2.\n";
    expect(presentationScore(dated, null).checks.figure_per_finding).toBe(0);
  });

  test("two leads in a row are two leads", () => {
    const stacked = "**One:**\n\n**Two:**\n\n- August took 611 orders, 22% of the year.\n- July took 540, 19%.\n";
    expect(presentationScore(stacked, null).checks.one_lead_in_at_most).toBe(0);
  });

  test("a sentence at the limit passes and one word past it does not", () => {
    const line = (n: number) => `${Array.from({ length: n }, () => "word").join(" ")}.`;
    expect(presentationScore(line(30), null).checks.sentences_short).toBe(1);
    expect(presentationScore(line(31), null).checks.sentences_short).toBe(0);
  });
});

describe("presentationMean", () => {
  test("the run's one number, and null for a bench with no insight question", () => {
    expect(presentationMean([])).toBeNull();
    expect(presentationMean([{ score: 1, checks: {} }, { score: 0.6, checks: {} }])).toBe(0.8);
  });
});

// EVAL.md section 3.x: the score is reported beside accuracy and may never
// move it down; symmetrically, a prompt that keeps accuracy and loses the
// shape is a regression the gate has to see.
describe("the presentation rule of the gate", () => {
  const baseline = {
    runs: [
      {
        bench: "eval/bench/pagila-insight.json",
        provider: "claude-code",
        model: "claude-haiku-4-5",
        prompt_version: PROMPT_VERSION,
        passed: 8,
        total: 8,
        recall: null,
        turn_cap_hits: 0,
        avg_turns: 1,
        date: "2026-09-06",
        presentation: 0.8,
      },
    ],
  };
  const run = (over: Partial<Parameters<typeof gateAgainst>[1]> = {}) => ({
    bench: "eval/bench/pagila-insight.json",
    provider: "claude-code",
    model: "claude-haiku-4-5",
    passed: 8,
    total: 8,
    recall: null,
    turnCapHits: 0,
    presentation: 0.8,
    ...over,
  });

  test("holding or beating the baseline passes", () => {
    expect(gateAgainst(baseline, run()).ok).toBe(true);
    expect(gateAgainst(baseline, run({ presentation: 0.95 })).ok).toBe(true);
  });

  test("a check flipping on one answer is variance; a real loss is not", () => {
    expect(gateAgainst(baseline, run({ presentation: 0.75 })).ok).toBe(true);
    const dropped = gateAgainst(baseline, run({ presentation: 0.7 }));
    expect(dropped.ok).toBe(false);
    expect(dropped.lines.join(" ")).toContain("presentation 0.7");
  });

  test("a baseline row from before the score does not arm the rule", () => {
    const older = { runs: [{ ...baseline.runs[0], presentation: undefined }] };
    expect(gateAgainst(older, run({ presentation: 0.1 })).ok).toBe(true);
  });
});

// EVAL.md section 3.x, the other half of the gate: the mean is taken over the
// answers it may be taken over. A question whose SQL never ran has no grid
// beside it, `no_grid_restatement` is 1 where there is no grid, and averaging
// that in would let a prompt buy presentation by breaking the query.
describe("the mean the gate reads", () => {
  const row = (id: string, score: number, ok: boolean) => ({ id, presentation: { score, checks: {} }, ok });

  test("an answer whose SQL never ran is not a presentation measurement", () => {
    const out = presentationOver([row("ins-01", 0.8, true), row("ins-02", 0.8, true), row("ins-05", 1, false)]);
    expect(out.mean).toBe(0.8);
    expect(out.scored.map((r) => r.id)).toEqual(["ins-01", "ins-02"]);
    expect(out.unscored.map((r) => r.id)).toEqual(["ins-05"]);
  });

  test("the free point of a failed query cannot lift the run's number", () => {
    // the wave's own measured run: seven answers scored, and ins-05, which
    // timed out, scoring a perfect 1.0 on the strength of having no grid
    const ran = [0.8, 0.8, 0.8, 0.6, 0.8, 0.8, 0.8].map((s, i) => row(`ins-0${i + 1}`, s, true));
    expect(presentationOver(ran).mean).toBe(0.771);
    expect(presentationOver([...ran, row("ins-05", 1, false)]).mean).toBe(0.771);
    expect(presentationMean([...ran, row("ins-05", 1, false)].map((r) => r.presentation))).toBe(0.8);
  });

  test("a bench with no insight question has no mean, not a zero", () => {
    expect(presentationOver([{ presentation: null, ok: true }]).mean).toBeNull();
  });
});

// The prompt and the score have to want the same thing (DESIGN rule 14). v3's
// first GOOD example read three cells of one result row back, which is
// exactly what `no_grid_restatement` refuses, and the measured run followed
// the example rather than the rule. So the example is scored here, against
// the grid the question it answers would put on screen.
describe("prompt v3's own examples, scored", () => {
  const afterLine = (marker: string) =>
    SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("\n", SYSTEM_PROMPT.indexOf(marker)) + 1);
  const goodExample = afterLine("GOOD, for").split("BAD, same question")[0].trim();
  const badExample = afterLine("BAD, same question").trim();
  /** what "what stands out in orders last month?" puts in the grid */
  const ordersRun = {
    columns: ["month", "orders", "cod_orders", "cod_share", "avg_paid", "avg_cod"],
    rows: [["2026-08", "2763", "611", "22", "4725", "2564"]],
  };

  test("the GOOD example scores what the prompt asks a model to score", () => {
    const out = presentationScore(goodExample, ordersRun);
    expect(out.checks).toEqual({
      bullets_in_range: 1,
      sentences_short: 1,
      figure_per_finding: 1,
      no_grid_restatement: 1,
      one_lead_in_at_most: 1,
    });
  });

  test("the BAD example is the grid read aloud, and scores as it", () => {
    const out = presentationScore(badExample, ordersRun);
    expect(out.checks.no_grid_restatement).toBe(0);
    expect(out.score).toBeLessThan(presentationScore(goodExample, ordersRun).score);
  });
});
