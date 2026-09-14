// The answer slot's renderer (W5, D2 items 6 and 7): each block kind lands in
// its register, figures wear .fig whether or not the model bolded them, links
// open in the browser for http(s) only and stay text for anything else, and
// the live region holds (polite on the newest exchange, :empty when nothing
// renders). The parser's own rules are display.test's; this file checks what
// the renderer makes of the blocks it is handed, which after D2 includes the
// two calls the parser deliberately does NOT make: how long a marked lead-in
// may be before it is a sentence, and where a list folds. The grid species and
// the statement shape are stubbed, and so is the read-only SQL face: all three
// reach the stores, which touch `document` at load, and none of them is what
// this file tests (the stub records what the block handed it).

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../grid/Grid", () => ({
  Grid: ({ statement, readOnly, maxRows }: { statement: { columns: { name: string }[]; rows: unknown[][] }; readOnly?: boolean; maxRows?: number }) => (
    <table data-readonly={readOnly ? "" : undefined} data-max-rows={maxRows} data-cols={statement.columns.map((c) => c.name).join(",")} data-rows={statement.rows.length} />
  ),
}));
mock.module("../SqlFace", () => ({
  SqlFace: ({ text, variant }: { text: string; variant?: string }) => <code data-variant={variant}>{text}</code>,
}));
mock.module("../AnswerBlock", () => ({
  statementFromRun: (run: { columns: string[]; rows: unknown[][] }) => ({
    columns: run.columns.map((name) => ({ name })),
    rows: run.rows,
  }),
}));

const { AnswerText } = await import("../AnswerText");

const html = (raw: string, hasRun = true, live = true) =>
  renderToStaticMarkup(<AnswerText raw={raw} hasRun={hasRun} live={live} />);

/** AnswerText's own FOLD_AT, restated: the renderer keeps it private and this
 * file is what pins the number */
const FOLD_AT = 12;
/** an ordered list of n steps, the shape a model writes when it is listing */
const steps = (n: number) => [...Array(n)].map((_, i) => `${i + 1}. Step ${i + 1}.`).join("\n");

const INSIGHT = [
  "**Across 2,763 orders:**",
  "- A prepaid basket averages ₹4,725, a COD basket ₹2,564.",
  "- Failed payments are 22% of attempts, more than every refund and return combined.",
  "- Collected ₹4,266,056 so far, and the COD still in transit would add another 23%.",
  "",
  "```sql",
  "SELECT payment_status, COUNT(*) AS orders FROM order_v2 GROUP BY 1",
  "```",
  "",
  "Assumptions: Last Month = August 2026; Orders = created_at",
].join("\n");

describe("AnswerText", () => {
  test("an insight answer is a lead-in over a list, its figures in .fig, and nothing the anatomy owns", () => {
    const out = html(INSIGHT);
    expect(out).toContain('<div class="ans-lead">Across <span class="fig">2,763</span> orders:</div>');
    expect(out.match(/<li>/g)).toHaveLength(3);
    expect(out).toContain('<ul role="list">');
    expect(out).not.toContain("<ol");
    for (const fig of ["₹4,725", "₹2,564", "22%", "₹4,266,056", "23%"]) {
      expect(out).toContain(`<span class="fig">${fig}</span>`);
    }
    expect(out).not.toContain("SELECT");
    expect(out).not.toContain("<pre");
    expect(out).not.toMatch(/assumptions/i);
    expect(out).not.toContain("**");
  });

  test("a figure the model bolded is a figure, not a bold; a figure inside a bolded phrase is both", () => {
    expect(html("Total **4,647,023** this year.")).toBe(
      '<div class="ans-text" aria-live="polite" aria-atomic="false"><p>Total <span class="fig">4,647,023</span> this year.</p></div>',
    );
    expect(html("**Total 4,647,023 orders** this year.")).toContain(
      '<b>Total <span class="fig">4,647,023</span> orders</b>',
    );
  });

  test("the model's own table is the grid without a run and nothing with one", () => {
    const raw = "Use `created_at`:\n\n| column | set by |\n|---|---|\n| created_at | checkout |\n| paid_at | webhook |";
    expect(html(raw, true)).not.toContain("ans-grid");
    expect(html(raw, true)).not.toContain("checkout");
    const out = html(raw, false);
    expect(out).toContain('<div class="ans-grid"><table data-readonly="" data-max-rows="6" data-cols="column,set by" data-rows="2"></table></div>');
  });

  test("a quote, an ordered list and a non-SQL fence land in their elements", () => {
    const raw = [
      "**Comment on `order_v2`:**",
      "> One row per checkout attempt, failed included.",
      "",
      "Two steps:",
      "",
      "1. Drop the `failed` rows.",
      "2. Bucket the rest by `created_at`.",
      "",
      "```json",
      '{"coupon": {"code": "FIRST10"}}',
      "```",
    ].join("\n");
    const out = html(raw);
    expect(out).toContain('<div class="ans-lead">Comment on <code>order_v2</code>:</div>');
    expect(out).toContain("<blockquote>One row per checkout attempt, failed included.</blockquote>");
    expect(out).toContain(
      '<ol role="list"><li>Drop the <code>failed</code> rows.</li><li>Bucket the rest by <code>created_at</code>.</li></ol>',
    );
    expect(out).toContain("<pre>{&quot;coupon&quot;: {&quot;code&quot;: &quot;FIRST10&quot;}}</pre>");
  });

  test("links: http(s) become anchors, an identifier in backticks keeps its mono inside one, other schemes are their text", () => {
    const out = html(
      "See [`date_trunc`](https://www.postgresql.org/docs/current/functions-datetime.html), [the docs](http://x.y) and [mail](mailto:a@b.c).",
    );
    expect(out).toContain(
      '<a href="https://www.postgresql.org/docs/current/functions-datetime.html"><code>date_trunc</code></a>',
    );
    expect(out).toContain('<a href="http://x.y">the docs</a>');
    expect(out).not.toContain("mailto:");
    expect(out).toContain("and mail.");
  });

  test("prose keeps its soft breaks in a <p>; the live region is the slot, polite only on the newest", () => {
    expect(html("First line.\nSecond line.", true, true)).toBe(
      '<div class="ans-text" aria-live="polite" aria-atomic="false"><p>First line.\nSecond line.</p></div>',
    );
    expect(html("x", true, false)).toContain('aria-live="off"');
  });

  test("nothing to render leaves the slot empty for :empty", () => {
    expect(html("")).toBe('<div class="ans-text" aria-live="polite" aria-atomic="false"></div>');
    expect(html("```sql\nSELECT 1\n```\n\nAssumptions: none")).toBe(
      '<div class="ans-text" aria-live="polite" aria-atomic="false"></div>',
    );
  });

  // D2 item 7: with a run on screen the SQL row owns the statement and the
  // fence never reaches the slot (the case above); with none it is the model's
  // own, and it takes the code block's box with the app's one read-only SQL
  // view inside it instead of plain mono. Every other tag keeps the <pre>
  test("a statement no run owns wears the SQL face; another language stays a plain <pre>", () => {
    const out = html("The join:\n\n```sql\nSELECT 1\n```", false);
    expect(out).toContain('<div class="ans-sql"><code data-variant="prose">SELECT 1</code></div>');
    expect(out).not.toContain("<pre");
    // untagged, opening on a statement: the same face, since the parser reads
    // the words and not the tag
    expect(html("```\nSELECT 1\n```", false)).toContain('class="ans-sql"');
    expect(html('```json\n{"a": 1}\n```', false)).toContain("<pre>{&quot;a&quot;: 1}</pre>");
  });

  // D1 item 5: the ordinal is drawn in the item's own gutter cell, which costs
  // `list-style: none`, and WebKit takes a list's semantics away with its
  // markers. Both list kinds carry the role back, and a list past nine items
  // (the case the fixed gutter exists for) is still one list of n items
  test("a list keeps its semantics past the marker: role on both kinds, every item present", () => {
    const numbered = html(steps(FOLD_AT));
    expect(numbered).toContain('<ol role="list">');
    expect(numbered.match(/<li/g)).toHaveLength(FOLD_AT);
    // the ordinals are the list's own, never text inside the item
    expect(numbered).not.toContain("10.");
    expect(html("- one\n- two")).toContain('<ul role="list">');
  });

  // ---- D2 item 6: the fold --------------------------------------------------

  test("the threshold: twelve items stand whole, the thirteenth folds the list", () => {
    const twelve = html(steps(FOLD_AT));
    expect(twelve.match(/<li/g)).toHaveLength(FOLD_AT);
    expect(twelve).not.toContain("ans-fold");
    expect(twelve).not.toContain("Show All");

    const thirteen = html(steps(FOLD_AT + 1));
    // the twelfth is the last one drawn: a folded list is honestly a list of
    // twelve with a line under it, never a thirteen that hides one
    expect(thirteen.match(/<li/g)).toHaveLength(FOLD_AT);
    expect(thirteen).toContain('Step <span class="fig">12</span>.');
    expect(thirteen).not.toContain('Step <span class="fig">13</span>.');
    expect(thirteen).toContain('<div class="ans-fold" data-ordered="">');
    expect(thirteen).toContain('<button type="button" class="linkish">Show All 13</button>');
  });

  test("the count names the whole list, not the tail it is hiding", () => {
    // the maintainer's own case: seventy ERP tables as an ordered list
    expect(html(steps(70))).toContain(">Show All 70</button>");
    // a bulleted list folds the same way, and its line takes the bullet's own
    // text column (no data-ordered)
    const bullets = html([...Array(70)].map((_, i) => `- erp_table_${i + 1}`).join("\n"));
    expect(bullets).toContain('<ul role="list">');
    expect(bullets).toContain('<div class="ans-fold">');
    expect(bullets).toContain(">Show All 70</button>");
    // Title Case, no terminal period, no ellipsis: the line acts at once
    // (WRITING rule 1). The count never needs a plural: a fold takes thirteen
    // items at least, and `1 turn / 3 turns` is footerStatus's, pinned in
    // display.test.ts
    expect(bullets).not.toContain("Show all");
    expect(bullets).not.toContain("Show All 70.");
    expect(bullets).not.toContain("Show All 70…");
  });

  test("the fold is a box round the list, and the list alone: the line is its sibling", () => {
    const out = html(steps(20));
    // the box is what the height spring travels; it draws nothing and holds
    // nothing but the list, so the line can leave at once while the box grows
    expect(out).toContain('<div class="ans-list"><ol role="list">');
    expect(out).toContain("</ol></div><div class=\"ans-fold\"");
  });

  // ---- D2 item 7: the lead-in's length --------------------------------------

  test("a marked lead-in of at most four words is a label; a longer one is a sentence", () => {
    // the four the parser already sees: short enough to set in small caps
    expect(html("**Across 2,763 orders:**\n\n- one")).toContain(
      '<div class="ans-lead">Across <span class="fig">2,763</span> orders:</div>',
    );
    expect(html("## Orders by payment state\n\nSomething.")).toContain(
      '<div class="ans-lead">Orders by payment state</div>',
    );
    // the maintainer's own screenshot: six words, a sentence, and a sentence
    // set in small caps shouts
    const long = html("## Here are the 70 ERP tables:\n\n- erp_fx_rate");
    expect(long).not.toContain("ans-lead");
    expect(long).toContain('<p class="ans-colon">Here are the <span class="fig">70</span> ERP tables:</p>');
  });

  test("a paragraph the model ended with a colon opens the group under it", () => {
    expect(html("The grain differs on every one of them:\n\n- a")).toContain(
      '<p class="ans-colon">The grain differs on every one of them:</p>',
    );
    expect(html("The grain differs on every one of them.")).toContain(
      "<p>The grain differs on every one of them.</p>",
    );
  });
});
