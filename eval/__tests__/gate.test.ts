// The PR gate's decision (EVAL.md section 4). It is the only thing standing
// between a prompt edit and a silent quality regression, so its three failing
// conditions and its one honest refusal are pinned here.

import { describe, expect, test } from "bun:test";
import { gateAgainst } from "../../scripts/agent-eval";
import { PROMPT_VERSION } from "../../src/agent/prompt";

const baseline = {
  runs: [
    {
      bench: "eval/bench/pagila.json",
      provider: "claude-code",
      model: "claude-haiku-4-5",
      prompt_version: PROMPT_VERSION,
      passed: 33,
      total: 33,
      recall: 0.94,
      turn_cap_hits: 0,
      avg_turns: 1,
      date: "2026-09-05",
    },
  ],
};

const run = (over: Partial<Parameters<typeof gateAgainst>[1]> = {}) => ({
  bench: "eval/bench/pagila.json",
  provider: "claude-code",
  model: "claude-haiku-4-5",
  passed: 33,
  total: 33,
  recall: 0.94,
  turnCapHits: 0,
  ...over,
});

describe("gateAgainst", () => {
  test("matching the baseline passes", () => {
    expect(gateAgainst(baseline, run()).ok).toBe(true);
  });

  test("one question is noise; two is a regression", () => {
    expect(gateAgainst(baseline, run({ passed: 32 })).ok).toBe(true);
    const two = gateAgainst(baseline, run({ passed: 31 }));
    expect(two.ok).toBe(false);
    expect(two.lines.join(" ")).toContain("2 questions below the baseline");
  });

  test("a turn-cap hit fails even at full accuracy", () => {
    const out = gateAgainst(baseline, run({ turnCapHits: 1 }));
    expect(out.ok).toBe(false);
    expect(out.lines.join(" ")).toContain("turn cap");
  });

  test("prefilter recall may not slip", () => {
    expect(gateAgainst(baseline, run({ recall: 0.94 })).ok).toBe(true);
    expect(gateAgainst(baseline, run({ recall: 0.97 })).ok).toBe(true);
    expect(gateAgainst(baseline, run({ recall: 0.9 })).ok).toBe(false);
  });

  test("a bench nobody measured is unmeasured, not green", () => {
    const out = gateAgainst(baseline, run({ model: "claude-opus-5" }));
    expect(out.ok).toBe(false);
    expect(out.lines[0]).toContain("no baseline");
  });

  test("the bench is matched by name, so a path change is not a new bench", () => {
    expect(gateAgainst(baseline, run({ bench: "./eval/bench/pagila.json" })).ok).toBe(true);
  });
});
