// The answer slot's grammar (DESIGN rule 14, W5). The corpus in
// fixtures/answers is sixteen answers in the shapes models actually send:
// direct, insight, prose with the model's own table and a link, a code block,
// and the shapes that are hostile to a streamed parse (a heading glued to the
// sentence before it, a fence glued mid-line, a lone pipe line, a table
// written without its leading pipes, an untagged fence holding SQL). Two
// properties run over all of them: nothing with its own slot survives the
// projection, and every prefix parses to the same settled blocks the whole
// text does.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { answerText, footerStatus, inlineTokens, parseBlocks, type Block, type InlineToken } from "../display";
import { parseAssumptions } from "../extract";

const DIR = join(import.meta.dir, "fixtures", "answers");
const CORPUS = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => ({ name: f, raw: readFileSync(join(DIR, f), "utf8") }));

const fixture = (name: string): string => {
  const f = CORPUS.find((c) => c.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f.raw;
};

const blocks = (name: string, hasRun = true): Block[] => parseBlocks(fixture(name), { hasRun });
const kinds = (bs: Block[]): string[] => bs.map((b) => b.kind);

/** the documented projection, written out so the contract is pinned by the
 * test and not by the implementation it checks */
const project = (bs: Block[]): string =>
  bs
    .map((b) =>
      b.kind === "list"
        ? b.items.map(flat).filter(Boolean).join("\n")
        : b.kind === "code"
          ? b.text.trim()
          : b.kind === "table"
            ? ""
            : flat(b.text),
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
const flat = (s: string): string => s.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1").trim();

const figures = (s: string): string[] =>
  inlineTokens(s)
    .filter((t) => t.kind === "figure")
    .map((t) => t.text);

// ---- blocks ----------------------------------------------------------------

describe("parseBlocks", () => {
  test("a direct answer is one paragraph; its fence and its Assumptions line have their own slots", () => {
    expect(blocks("direct-count.md")).toEqual([
      { kind: "p", text: "August had 2,763 orders, about 8% ahead of July." },
    ]);
  });

  test("a marked lead-in is a lead, keeping its colon as written, and the findings are one list", () => {
    expect(blocks("insight-orders.md")).toEqual([
      { kind: "lead", text: "Across 2,763 orders:" },
      {
        kind: "list",
        ordered: false,
        items: [
          "A prepaid basket averages ₹4,725, a COD basket ₹2,564.",
          "Failed payments are 22% of attempts, more than every refund and return combined.",
          "Collected ₹4,266,056 so far, and the COD still in transit would add another 23%.",
        ],
      },
    ]);
  });

  test("a heading is a lead whatever its depth, not a dropped line and not a hierarchy", () => {
    expect(kinds(blocks("insight-payments.md"))).toEqual(["lead", "list"]);
    expect(parseBlocks("# One\n\n## Two\n\n###### Six", { hasRun: true })).toEqual([
      { kind: "lead", text: "One" },
      { kind: "lead", text: "Two" },
      { kind: "lead", text: "Six" },
    ]);
  });

  test("a quote is its lines merged, and the ordered list keeps its order", () => {
    expect(blocks("steps-count.md")).toEqual([
      { kind: "lead", text: "Comment on `order_v2`:" },
      { kind: "quote", text: "One row per checkout attempt, failed included." },
      { kind: "p", text: "So a bare count is attempts, not orders. Counting the orders placed is two steps:" },
      {
        kind: "list",
        ordered: true,
        items: ["Drop the `failed` rows.", "Bucket the rest by `created_at`. `paid_at` lands days later for COD."],
      },
    ]);
    expect(blocks("quote-stack.md")).toEqual([
      {
        kind: "quote",
        text: "A row is an attempt, not a sale.\nFailed attempts are kept for fraud review and are never deleted.",
      },
      {
        kind: "p",
        text: "That comment is on `order_v2` and it is why the counts in the dashboard are 22% higher than finance's.",
      },
    ]);
  });

  test("one level: a nested marker is an item of the same list, a wrapped line joins the item above it", () => {
    const bs = blocks("nested-bullets.md");
    expect(kinds(bs)).toEqual(["p", "list"]);
    const list = bs[1] as Extract<Block, { kind: "list" }>;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(4);
    expect(list.items[1]).toBe("It is a FK to `customer.id`.");
    expect(list.items[2]).toBe(
      "`payment.customer_id` is copied at capture and can drift for guest checkouts, which is why 41 payments point at a customer that no longer exists.",
    );
  });

  test("every marker a model writes starts an item", () => {
    for (const [mark, ordered] of [
      ["-", false],
      ["*", false],
      ["+", false],
      ["•", false],
      ["1.", true],
      ["1)", true],
    ] as const) {
      expect(parseBlocks(`${mark} one`, { hasRun: true }), mark).toEqual([
        { kind: "list", ordered, items: ["one"] },
      ]);
    }
    // a marker needs its space, or it is prose: a rule, a bullet, a fragment
    expect(kinds(parseBlocks("-nope", { hasRun: true }))).toEqual(["p"]);
    expect(kinds(parseBlocks("---", { hasRun: true }))).toEqual([]);
  });

  test("the first marker decides the register, so a drift between `-` and `1.` is still one list", () => {
    expect(parseBlocks("1. one\n- two\n* three", { hasRun: true })).toEqual([
      { kind: "list", ordered: true, items: ["one", "two", "three"] },
    ]);
  });

  test("a non-SQL fence is code in its own register; a SQL fence never renders, tagged or not", () => {
    expect(blocks("coupon-shape.md")).toEqual([
      { kind: "p", text: "Coupons sit inside `metadata`, in this shape:" },
      { kind: "code", lang: "json", text: '{"coupon": {"code": "FIRST10", "kind": "percent", "value": 10}}' },
      { kind: "p", text: "1,096 of the August orders carry one." },
    ]);
    expect(blocks("fence-glued.md")).toEqual([
      { kind: "p", text: "The shape peek found is:" },
      { kind: "code", lang: "json", text: '{"tier": "signature", "since": "2026-04-02"}' },
      { kind: "p", text: "An untagged fence still holds the query, so it belongs to the SQL row, not the text:" },
      { kind: "p", text: "Signature is 3.1% of customers and 19% of revenue." },
    ]);
  });

  test("an unterminated fence is a code block still streaming", () => {
    expect(parseBlocks('Shape:\n\n```json\n{"a": 1', { hasRun: true })).toEqual([
      { kind: "p", text: "Shape:" },
      { kind: "code", lang: "json", text: '{"a": 1' },
    ]);
    expect(parseBlocks("Counted by sent_at.\n\n```sql\nSELECT count(*) FR", { hasRun: true })).toEqual([
      { kind: "p", text: "Counted by sent_at." },
    ]);
    expect(parseBlocks("Counted by sent_at.\n\n```", { hasRun: true })).toEqual([
      { kind: "p", text: "Counted by sent_at." },
    ]);
  });

  test("a table renders only without a run: with one it is the grid restated (rule 14)", () => {
    const withRun = blocks("stamp-compare.md", true);
    const noRun = blocks("stamp-compare.md", false);
    expect(kinds(withRun)).toEqual(["p", "p"]);
    expect(kinds(noRun)).toEqual(["p", "table", "p"]);
    expect(noRun[1]).toEqual({
      kind: "table",
      header: ["column", "set by", "null for"],
      rows: [
        ["created_at", "checkout", "never"],
        ["paid_at", "payment webhook", "COD in transit"],
        ["shipped_at", "warehouse", "unshipped"],
      ],
    });
  });

  test("a table needs a header, a separator and a body row; a lone pipe line is prose", () => {
    expect(kinds(blocks("pipe-prose.md", false))).toEqual(["p", "p"]);
    expect(parseBlocks("month | count\n--- | ---\n2026-08 | 2949786", { hasRun: false })).toEqual([
      { kind: "table", header: ["month", "count"], rows: [["2026-08", "2949786"]] },
    ]);
    // header and separator with nothing under them: a table under construction,
    // never the sentence it is not
    expect(parseBlocks("| status | rows |\n| --- | --- |", { hasRun: false })).toEqual([]);
    expect(parseBlocks("Values arrive as paid | pending | failed.", { hasRun: false })).toEqual([
      { kind: "p", text: "Values arrive as paid | pending | failed." },
    ]);
  });

  test("a short row is padded to the header, a long one is cut to it", () => {
    expect(parseBlocks("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |", { hasRun: false })).toEqual([
      {
        kind: "table",
        header: ["a", "b", "c"],
        rows: [
          ["1", "", ""],
          ["1", "2", "3"],
        ],
      },
    ]);
  });

  test("the W2 shapes: a glued heading becomes a lead, the rule and the images go", () => {
    expect(kinds(blocks("w2-breakdown.md", false))).toEqual(["p", "lead", "p", "table", "p"]);
    expect(kinds(blocks("w2-breakdown.md", true))).toEqual(["p", "lead", "p", "p"]);
    expect(blocks("w2-bulleted.md")).toEqual([
      {
        kind: "p",
        text: "Counted by `sent_at`, the only timestamp on the table. 4.65M this year, 2.95M of it in August.",
      },
      { kind: "lead", text: "Notes" },
      { kind: "list", ordered: true, items: ["The August spike is real."] },
    ]);
    expect(kinds(blocks("long-analysis.md"))).toEqual(["p", "p", "p"]);
  });

  test("an answer that is only the data the anatomy owns renders nothing at all", () => {
    expect(blocks("empty-answer.md")).toEqual([]);
    expect(parseBlocks("", { hasRun: true })).toEqual([]);
    expect(parseBlocks("   \n\n  ", { hasRun: true })).toEqual([]);
  });

  test("a bold line is a lead only when it ends in a colon, in or out of the bold", () => {
    expect(parseBlocks("**Across 2,763 orders**:", { hasRun: true })).toEqual([
      { kind: "lead", text: "Across 2,763 orders:" },
    ]);
    expect(parseBlocks("**Everything is fine.**", { hasRun: true })).toEqual([
      { kind: "p", text: "**Everything is fine.**" },
    ]);
    expect(parseBlocks("**a** and **b**:", { hasRun: true })).toEqual([{ kind: "p", text: "**a** and **b**:" }]);
  });
});

// ---- the projection --------------------------------------------------------

describe("answerText", () => {
  test("the W2 breakdown block keeps its prose and loses every slot the anatomy owns", () => {
    const out = answerText(fixture("w2-breakdown.md"));
    expect(out).not.toContain("## Answer");
    expect(out).not.toContain("#");
    expect(out).not.toContain("|");
    expect(out).not.toContain("```");
    expect(out).not.toContain("SELECT");
    expect(out).not.toMatch(/assumptions/i);
    expect(out).not.toContain("calendar year");
    expect(out).toContain("Let me get the monthly breakdown.");
    expect(out).toContain("Here are the notification histories added each month in 2026:");
    expect(out).toContain("Total: **4,647,023** notifications this year, with a large spike in August.");
    expect(out.endsWith("August.")).toBe(true);
  });

  test("what the display strips is exactly what the chips parse", () => {
    const bulleted = fixture("w2-bulleted.md");
    expect(parseAssumptions(fixture("w2-breakdown.md"))).toHaveLength(2);
    expect(parseAssumptions(bulleted)).toEqual([
      '"Added" refers to the sent_at column',
      "Deleted users are excluded",
      '"This year" means 2026',
    ]);
    for (const label of parseAssumptions(bulleted)) expect(answerText(bulleted)).not.toContain(label);
  });

  test("list items are one to a line, blocks a blank line apart, links their text", () => {
    expect(answerText("- first\n2. second\n* [docs](https://x.y)\n![img](https://x.y/a.png)")).toBe(
      "first\nsecond\ndocs",
    );
    expect(answerText(fixture("insight-orders.md"))).toBe(
      "Across 2,763 orders:\n\nA prepaid basket averages ₹4,725, a COD basket ₹2,564.\nFailed payments are 22% of attempts, more than every refund and return combined.\nCollected ₹4,266,056 so far, and the COD still in transit would add another 23%.",
    );
  });

  test("a table is never in the projection, run or no run", () => {
    const out = answerText("Two months stand out.\n\nmonth | count\n--- | ---\n2026-08 | 2949786\n\nA - B is fine.");
    expect(out).toBe("Two months stand out.\n\nA - B is fine.");
    expect(answerText(fixture("stamp-compare.md"))).not.toContain("payment webhook");
  });

  test("plain prose is returned as written, and an empty answer is empty", () => {
    const s = "Counted by `sent_at`, the only timestamp on the table. 4.65M this year, **2.95M** of it in August.";
    expect(answerText(s)).toBe(s);
    expect(answerText("")).toBe("");
    expect(answerText("   \n\n  ")).toBe("");
    expect(answerText(fixture("empty-answer.md"))).toBe("");
  });

  test("the projection is the blocks' text, for every answer in the corpus", () => {
    for (const { name, raw } of CORPUS) {
      expect(answerText(raw), name).toBe(project(parseBlocks(raw, { hasRun: true })));
    }
  });
});

// ---- inline ----------------------------------------------------------------

describe("inlineTokens", () => {
  test("bold, italic, code and links become tokens; an image becomes nothing", () => {
    expect(inlineTokens("Counted by `sent_at`, **most** of it *late*, see [docs](https://x.y) ![i](u)")).toEqual([
      { kind: "text", text: "Counted by " },
      { kind: "code", text: "sent_at" },
      { kind: "text", text: ", " },
      { kind: "bold", text: "most" },
      { kind: "text", text: " of it " },
      { kind: "italic", text: "late" },
      { kind: "text", text: ", see " },
      { kind: "link", text: "docs", href: "https://x.y" },
      { kind: "text", text: " " },
    ]);
  });

  test("link text keeps the register the model gave it: an identifier stays mono", () => {
    expect(inlineTokens("[`date_trunc`](https://x.y) has the rule")[0]).toEqual({
      kind: "link",
      text: "date_trunc",
      href: "https://x.y",
      code: true,
    });
    expect(inlineTokens("[date_trunc](https://x.y)")[0]).toEqual({
      kind: "link",
      text: "date_trunc",
      href: "https://x.y",
    });
  });

  test("an underscore is never italic: it is how identifiers are spelled", () => {
    expect(inlineTokens("created_at and paid_at")).toEqual([{ kind: "text", text: "created_at and paid_at" }]);
  });

  test("unbalanced markers stay literal, and an empty string renders no node", () => {
    expect(inlineTokens("a ** b ` c")).toEqual([{ kind: "text", text: "a ** b ` c" }]);
    expect(inlineTokens("")).toEqual([]);
  });

  test("a figure is a quantity, whether or not the model bolded it", () => {
    expect(figures("August had 2,763 orders, about 8% ahead of July.")).toEqual(["2,763", "8%"]);
    expect(figures("A prepaid basket averages ₹4,725, a COD basket ₹2,564.")).toEqual(["₹4,725", "₹2,564"]);
    expect(figures("$1,200 and €40.50 and £7")).toEqual(["$1,200", "€40.50", "£7"]);
    expect(figures("4.65M this year, 12.4k a day, 4.5x slower, -3.2% off")).toEqual([
      "4.65M",
      "12.4k",
      "4.5x",
      "-3.2%",
    ]);
    expect(figures("ran in 1,861.9 ms, or 1.9 s per batch")).toEqual(["1,861.9 ms", "1.9 s"]);
    expect(figures("**2.95M** of it in August")).toEqual(["2.95M"]);
    expect(inlineTokens("**2.95M**")).toEqual([{ kind: "figure", text: "2.95M" }]);
    expect(inlineTokens("**2.95M rows**")).toEqual([{ kind: "bold", text: "2.95M rows" }]);
  });

  test("a date, an id and a version hold digits and are not figures", () => {
    expect(figures("2026-08 was the spike")).toEqual([]);
    expect(figures("batch t1-01 wrote them")).toEqual([]);
    expect(figures("schema v2 is current")).toEqual([]);
    expect(figures("on 2026-08-14 between 10:30 and 11:05")).toEqual([]);
    expect(figures("version 4.5.1 of the driver")).toEqual([]);
    expect(figures("`412.6 ms` inside code")).toEqual([]);
    expect(figures("the 3 states and 5 rows")).toEqual(["3", "5"]);
  });

  test("no word is lost or invented: the tokens are the text with its markers off", () => {
    // the one thing the tokens do not preserve is emphasis around a figure,
    // which is the app's face, not the model's
    const bare = (s: string): string =>
      s
        .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
        .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
        .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
        .replace(/\*([^*\n]+?)\*/g, "$1")
        .replace(/`([^`\n]+)`/g, "$1");
    for (const { name, raw } of CORPUS) {
      for (const b of parseBlocks(raw, { hasRun: false })) {
        const texts: string[] = b.kind === "list" ? b.items : b.kind === "table" || b.kind === "code" ? [] : [b.text];
        for (const t of texts) {
          expect(
            inlineTokens(t)
              .map((k: InlineToken) => k.text)
              .join(""),
            `${name}: ${t}`,
          ).toBe(bare(t));
        }
      }
    }
  });
});

describe("footerStatus", () => {
  test("the status register with a space before every unit", () => {
    expect(footerStatus(1, 20_400, "Sonnet 5")).toBe("1 turn · 20.4 s · Sonnet 5");
    expect(footerStatus(3, 1_861.9, "Haiku 4.5")).toBe("3 turns · 1.9 s · Haiku 4.5");
  });

  test("a reloaded thread knows neither its turns nor its time, so it prints neither", () => {
    expect(footerStatus(0, 0, "Sonnet 5")).toBe("Sonnet 5");
    expect(footerStatus(0, 20_400, "Sonnet 5")).toBe("20.4 s · Sonnet 5");
  });
});

// ---- streaming --------------------------------------------------------------

describe("streaming", () => {
  test("every prefix of every answer parses to the settled blocks of the whole", () => {
    let checked = 0;
    for (const { name, raw } of CORPUS) {
      for (const hasRun of [true, false]) {
        const full = parseBlocks(raw, { hasRun });
        const whole = JSON.stringify(full);
        for (let n = 1; n <= raw.length; n++) {
          const got = parseBlocks(raw.slice(0, n), { hasRun });
          // the last block is the one still being written; everything before
          // it is settled and must already equal what the whole text parses to
          const settled = got.slice(0, -1);
          if (JSON.stringify(settled) !== JSON.stringify(full.slice(0, settled.length))) {
            expect(settled, `${name} @${n} of ${raw.length} (whole: ${whole})`).toEqual(full.slice(0, settled.length));
          }
          // and the projection of what has settled is a prefix of the final one
          const head = project(settled);
          if (head && !answerText(raw).startsWith(head)) {
            expect(answerText(raw), `${name} @${n}`).toStartWith(head);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  test("a completed line keeps its kind: only the block still being written may change", () => {
    // the two transitions the grammar cannot avoid, both in the last block
    expect(kinds(parseBlocks("a | b", { hasRun: false }))).toEqual(["p"]);
    expect(kinds(parseBlocks("a | b\n--- | ---\n1 | 2", { hasRun: false }))).toEqual(["table"]);
    expect(kinds(parseBlocks("```\nSEL", { hasRun: false }))).toEqual(["code"]);
    expect(kinds(parseBlocks("```\nSELECT 1", { hasRun: false }))).toEqual([]);
    // everything settled before them is untouched
    expect(kinds(parseBlocks("Prose.\n\na | b", { hasRun: false }))).toEqual(["p", "p"]);
    expect(kinds(parseBlocks("Prose.\n\na | b\n--- | ---\n1 | 2", { hasRun: false }))).toEqual(["p", "table"]);
  });

  test("a row without its leading pipe cannot settle the table a row short", () => {
    // a table written without leading pipes: mid-row the next line has no pipe
    // yet, and ending the table there hung a stray paragraph under a table
    // that then grew a row (the block after it had begun)
    const raw = "P.\n\nm | c\n--- | ---\n2026-08 | 291\n2026-09 | 327\n\nDone.";
    const full = parseBlocks(raw, { hasRun: false });
    expect(kinds(full)).toEqual(["p", "table", "p"]);
    for (const n of [35, 36, 41, 42]) {
      const got = parseBlocks(raw.slice(0, n), { hasRun: false });
      expect(kinds(got), `@${n}`).toEqual(["p", "table"]);
      expect(got.slice(0, -1), `@${n}`).toEqual(full.slice(0, 1));
    }
  });

  test("a blank line ends a table, so a sentence glued under the last row is inside its span", () => {
    // the price of a table that can grow: nothing renders a line the parser
    // cannot yet call a row, and GFM eats the same line as a row
    expect(parseBlocks("m | c\n--- | ---\n1 | 2\nDone.", { hasRun: false })).toEqual([
      { kind: "table", header: ["m", "c"], rows: [["1", "2"]] },
    ]);
    expect(parseBlocks("m | c\n--- | ---\n1 | 2\n\nDone.", { hasRun: false })).toEqual([
      { kind: "table", header: ["m", "c"], rows: [["1", "2"]] },
      { kind: "p", text: "Done." },
    ]);
    // only the last line: a glued line with text after it is prose, as before
    expect(kinds(parseBlocks("m | c\n--- | ---\n1 | 2\nDone.\n\nMore.", { hasRun: false }))).toEqual([
      "table",
      "p",
      "p",
    ]);
  });
});

// ---- properties -------------------------------------------------------------

/** deterministic LCG so a failing seed is reproducible */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PROSE = [
  "Counted by `sent_at`, the only timestamp on the table.",
  "4.65M this year, **2.95M** of it in August.",
  "Two months stand out; the rest are flat.",
  "The spike follows the campaign launch.",
];
const NOISE = [
  "```sql\nSELECT count(*) FROM t\n```",
  "```\nSELECT 1\n```",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "a | b\n--- | ---\n1 | 2",
  "## Answer",
  "# Result",
  "---",
  "***",
  "Assumptions: Added = sent_at; This Year = 2026",
  "**Assumptions:**\n- one\n- two",
  "Assumptions: none",
];

function compose(seed: number): { raw: string; spaced: string; prose: string[] } {
  const r = rng(seed);
  const parts: string[] = [];
  const prose: string[] = [];
  const n = 2 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    if (r() < 0.5) {
      const p = PROSE[Math.floor(r() * PROSE.length)];
      prose.push(p);
      parts.push(p);
    } else {
      parts.push(NOISE[Math.floor(r() * NOISE.length)]);
    }
  }
  return { raw: parts.join(r() < 0.5 ? "\n\n" : "\n"), spaced: parts.join("\n\n"), prose };
}

describe("properties", () => {
  test("no fence, table, rule or Assumptions line survives the projection; idempotent", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { raw } = compose(seed);
      const out = answerText(raw);
      expect(out, `seed ${seed}`).not.toContain("```");
      expect(out, `seed ${seed}`).not.toMatch(/^[ \t]*\|/m);
      expect(out, `seed ${seed}`).not.toMatch(/^[ \t]*#{1,6}[ \t]/m);
      expect(out, `seed ${seed}`).not.toMatch(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/m);
      expect(out, `seed ${seed}`).not.toMatch(/assumptions[*_]*\s*:/i);
      expect(out, `seed ${seed}`).not.toContain("SELECT");
      expect(answerText(out), `seed ${seed}`).toBe(out);
    }
  });

  test("prose survives verbatim, in order, when a blank line separates it from the noise", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { spaced, prose } = compose(seed);
      const out = answerText(spaced);
      let at = 0;
      for (const p of prose) {
        const i = out.indexOf(p, at);
        expect(i, `seed ${seed}: ${JSON.stringify(p)} missing from ${JSON.stringify(out)}`).toBeGreaterThanOrEqual(0);
        at = i + p.length;
      }
    }
  });

  test("the corpus is idempotent: the projection of a projection is itself", () => {
    for (const { name, raw } of CORPUS) {
      const out = answerText(raw);
      expect(answerText(out), name).toBe(out);
    }
  });
});

// ---- speed ------------------------------------------------------------------

describe("speed", () => {
  test("a 4k answer parses 1000 times in under 50 ms: it runs on every streamed delta", () => {
    let big = "";
    while (big.length < 4096) big += `${CORPUS.map((c) => c.raw).join("\n\n")}\n\n`;
    big = big.slice(0, 4096);
    const round = () => {
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) parseBlocks(big, { hasRun: true });
      return (performance.now() - t0) * 10; // the 1000-parse cost this round paid for
    };
    round(); // warm
    // The budget is still 50 ms for 1000 parses; what changed is the reading.
    // One 1000-parse wall clock times the SEAT as much as the parse: this
    // unchanged loop read 478 ms once on a shared machine (15x its own
    // median), so a stopwatch here fails code that did not move. Twenty
    // hundred-parse rounds and the FASTEST of them is the parse without the
    // contention: under eight spinners on eight cores the mean went to 97 ms
    // and the worst round to 316, while the minimum held at 28.3-29.6 ms. It
    // stays a real ceiling, because no scheduler makes a round faster than
    // the code in it: a 2x regression puts every round over 50, and a 10x one
    // puts the fastest at ~300.
    let ms = Infinity;
    for (let r = 0; r < 20; r++) ms = Math.min(ms, round());
    console.log(`parseBlocks: 1000 x 4k = ${ms.toFixed(1)} ms (fastest of 20 rounds)`);
    expect(ms).toBeLessThan(50);
  });
});
