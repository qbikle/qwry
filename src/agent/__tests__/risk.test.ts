// The risky-shape classifier (AGENT-SPEC section 4.4). The bench outcome is
// pinned by id: 7 of the 28 lab questions fire, and that number is the
// measurement the RISK CHECK block's value was established against.

import { describe, expect, test } from "bun:test";
import { RISK_BLOCK, isRisky } from "../risk";
import questions from "./fixtures/risk-questions.json";

/** The seven, from qwry-agent-lab bench/questions-staging.json and
 * questions-hard.json. Three are staging time or ranking questions, four are
 * the hard cohort, economics, growth and funnel questions. */
const FIRE = ["s3-02", "s3-04", "s3-05", "h-01", "h-02", "h-03", "h-04"];

describe("isRisky", () => {
  test("exactly seven of the 28 bench questions fire", () => {
    const fired = questions.filter((q) => isRisky(q.question)).map((q) => q.id);
    expect(fired).toEqual(FIRE);
    expect(fired).toHaveLength(7);
    expect(questions).toHaveLength(28);
  });

  test("the quiet 21 stay quiet", () => {
    const quiet = questions.filter((q) => !isRisky(q.question)).map((q) => q.id);
    expect(quiet).toHaveLength(21);
    expect(quiet.some((id) => FIRE.includes(id))).toBe(false);
  });

  test("each shape the regex is for", () => {
    expect(isRisky("signups within 30 days of the cohort start")).toBe(true);
    expect(isRisky("what percentage converted")).toBe(true);
    expect(isRisky("50% of buyers")).toBe(true);
    expect(isRisky("week-over-week growth")).toBe(true);
    expect(isRisky("retention after the first order")).toBe(true);
    expect(isRisky("month over month churn funnel")).toBe(true);
  });

  test("a plain count is not risky", () => {
    expect(isRisky("How many users are not deleted?")).toBe(false);
    expect(isRisky("List the titles of all films rated G")).toBe(false);
  });

  test("the classifier is not stateful", () => {
    const q = "How many users signed up in each month of 2025?";
    expect(isRisky(q)).toBe(true);
    expect(isRisky(q)).toBe(true);
  });

  test("the block states all four checks section 6.5 mandates", () => {
    expect(RISK_BLOCK).toContain("min() and max()");
    expect(RISK_BLOCK).toContain("outside the expected order");
    expect(RISK_BLOCK).toContain("lower AND upper bounds");
    expect(RISK_BLOCK).toContain("State what the probes showed");
  });
});
