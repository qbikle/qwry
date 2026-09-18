// The picker's match (B2 item 2, fuzzy.ts). Three things are under test and
// only three: the tiers (an exact match, then a prefix, then everything
// else), the subsequence contract in both directions (every subsequence
// matches, nothing else does), and the orders the sketch draws, which are the
// whole reason the score is not a substring test. Plus the budget: the
// popover calls this once per candidate on every keystroke and typing is
// never animated.

import { describe, expect, test } from "bun:test";
import { FUZZY_ANY, FUZZY_EXACT, FUZZY_MAX_LEN, FUZZY_PREFIX, fuzzyScore } from "../fuzzy";

/** the contract in one line, so the property tests can state it */
function isSubsequence(q: string, c: string): boolean {
  const a = q.toLowerCase();
  const b = c.toLowerCase();
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) if (b[j] === a[i]) i++;
  return i === a.length;
}

/** a deterministic PRNG: a property failure has to reproduce */
let seed = 0x2f6e2b1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz_.".split("");

const name = (len: number) =>
  Array.from({ length: len }, () => pick(ALPHABET)).join("");

/** a random non-empty subsequence of `c` */
function subseqOf(c: string): string {
  let out = "";
  for (const ch of c) if (rnd() < 0.35) out += ch;
  return out.length > 0 ? out : c[0];
}

describe("the tiers", () => {
  test("an exact match outranks everything, case-insensitively", () => {
    expect(fuzzyScore("order_v2", "order_v2")).toBe(FUZZY_EXACT);
    expect(fuzzyScore("ORDER_V2", "order_v2")).toBe(FUZZY_EXACT);
    expect(fuzzyScore("Monthly revenue", "Monthly revenue")).toBe(FUZZY_EXACT);
  });

  test("a prefix scores one value, so the caller's own order breaks the tie", () => {
    expect(fuzzyScore("ord", "order_v2")).toBe(FUZZY_PREFIX);
    expect(fuzzyScore("ord", "orders_legacy")).toBe(FUZZY_PREFIX);
    expect(fuzzyScore("ta", "tables/")).toBe(FUZZY_PREFIX);
  });

  test("an empty filter matches everything at one score", () => {
    expect(fuzzyScore("", "order_v2")).toBe(FUZZY_ANY);
    expect(fuzzyScore("", "")).toBe(FUZZY_ANY);
  });

  test("nothing matches an empty name, and a filter longer than the name", () => {
    expect(fuzzyScore("ord", "")).toBe(0);
    expect(fuzzyScore("order_v2_long", "order_v2")).toBe(0);
  });

  test("a subsequence scores under every prefix match", () => {
    const loose = fuzzyScore("pflg", "product_flatlay_generations");
    expect(loose).toBeGreaterThan(0);
    expect(loose).toBeLessThan(FUZZY_PREFIX);
  });
});

describe("what the sketch draws", () => {
  test("pflg reaches product_flatlay_generations, and word starts beat the rest", () => {
    const pfg = fuzzyScore("pflg", "product_flatlay_generations");
    const pfl = fuzzyScore("pflg", "pipeline_flatlay_logs");
    const wpfg = fuzzyScore("pflg", "wardrobe_products_flatlay_grid");
    expect(pfg).toBeGreaterThan(pfl);
    expect(pfl).toBeGreaterThan(wpfg);
    expect(wpfg).toBeGreaterThan(0);
  });

  test("ta reaches tables/ first and threads/ second", () => {
    expect(fuzzyScore("ta", "tables/")).toBeGreaterThan(fuzzyScore("ta", "threads/"));
    expect(fuzzyScore("ta", "threads/")).toBeGreaterThan(0);
  });

  test("the BEST reading wins, not the leftmost: `ta` means metada`ta`", () => {
    // greedy would take the `t` of `product` and an `a` five characters later
    // and score product_metadata level with product_flatlay_generations
    expect(fuzzyScore("ta", "product_metadata")).toBeGreaterThan(
      fuzzyScore("ta", "product_flatlay_generations"),
    );
    // and the sketch's own tail order falls out of the leading gap alone
    expect(fuzzyScore("ta", "product_flatlay_generations")).toBeGreaterThan(
      fuzzyScore("ta", "erp_order_cost_snapshot_daily_rollup"),
    );
  });

  test("a run beats the same characters scattered mid-word", () => {
    expect(fuzzyScore("ord", "erp_order_cost")).toBeGreaterThan(fuzzyScore("ord", "xoxrxdx"));
  });

  test("a word start beats a mid-word letter", () => {
    expect(fuzzyScore("us", "erp_users")).toBeGreaterThan(fuzzyScore("us", "erp_bonus_x"));
  });

  test("the name's own first character outranks a boundary further in", () => {
    // the pin behind the sketch's pflg order: `pipeline_flatlay_logs` stands
    // above `wardrobe_products_flatlay_grid` and its four word starts
    expect(fuzzyScore("pflg", "pipeline_flatlay_logs")).toBeGreaterThan(
      fuzzyScore("pflg", "wardrobe_products_flatlay_grid"),
    );
  });

  test("a camel step opens a word the way `_` does", () => {
    expect(fuzzyScore("mr", "MonthlyRevenue")).toBeGreaterThan(fuzzyScore("mr", "xmonthlyxrevenue"));
  });
});

describe("the subsequence contract", () => {
  test("every subsequence of a name matches it", () => {
    for (let i = 0; i < 400; i++) {
      const candidate = name(4 + Math.floor(rnd() * 24));
      const q = subseqOf(candidate);
      expect(fuzzyScore(q, candidate)).toBeGreaterThan(0);
    }
  });

  test("nothing that is not a subsequence matches", () => {
    for (let i = 0; i < 400; i++) {
      const candidate = name(4 + Math.floor(rnd() * 24));
      const missing = ALPHABET.find((ch) => !candidate.includes(ch));
      if (!missing) continue;
      const q = subseqOf(candidate) + missing;
      expect(isSubsequence(q, candidate)).toBe(false);
      expect(fuzzyScore(q, candidate)).toBe(0);
    }
  });

  test("score and subsequence agree, both ways, on random pairs", () => {
    for (let i = 0; i < 600; i++) {
      const candidate = name(1 + Math.floor(rnd() * 20));
      const q = name(1 + Math.floor(rnd() * 5));
      expect(fuzzyScore(q, candidate) > 0).toBe(isSubsequence(q, candidate));
    }
  });

  test("a prefix always outranks a subsequence that is not one", () => {
    for (let i = 0; i < 300; i++) {
      const candidate = name(6 + Math.floor(rnd() * 18));
      const q = subseqOf(candidate);
      const score = fuzzyScore(q, candidate);
      if (candidate.toLowerCase().startsWith(q.toLowerCase())) {
        expect(score).toBeGreaterThanOrEqual(FUZZY_PREFIX);
      } else {
        expect(score).toBeLessThan(FUZZY_PREFIX);
      }
    }
  });

  test("case never changes a score", () => {
    for (let i = 0; i < 200; i++) {
      const candidate = name(6 + Math.floor(rnd() * 12));
      const q = subseqOf(candidate);
      expect(fuzzyScore(q.toUpperCase(), candidate)).toBe(fuzzyScore(q, candidate));
      expect(fuzzyScore(q, candidate.toUpperCase())).toBe(fuzzyScore(q, candidate));
    }
  });

  test("a very long name is searched to its documented bound and never throws", () => {
    const long = `${"x".repeat(FUZZY_MAX_LEN)}_order_v2`;
    expect(fuzzyScore("xx", long)).toBeGreaterThan(0);
    expect(fuzzyScore("orderv2", long)).toBe(0);
  });
});

describe("the budget", () => {
  test("500 rows in under 1 ms", () => {
    const rows = Array.from(
      { length: 500 },
      (_, i) => `${pick(["product", "wardrobe", "erp_order", "pipeline", "users", "tax_invoice"])}_${name(6)}_${i}`,
    );
    const pass = () => {
      let total = 0;
      for (const r of rows) total += fuzzyScore("pflg", r);
      return total;
    };
    for (let i = 0; i < 20; i++) pass(); // let the JIT settle, as a keystroke would
    let best = Infinity;
    for (let i = 0; i < 10; i++) {
      const at = performance.now();
      pass();
      best = Math.min(best, performance.now() - at);
    }
    expect(best).toBeLessThan(1);
  });
});
