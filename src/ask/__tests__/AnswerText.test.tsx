// The answer slot's renderer (W5): each block kind lands in its register,
// figures wear .fig whether or not the model bolded them, links open in the
// browser for http(s) only and stay text for anything else, and the live
// region holds (polite on the newest exchange, :empty when nothing renders).
// The parser's own rules are display.test's; this file checks what the
// renderer makes of the blocks it is handed. The grid species and the
// statement shape are stubbed: both reach the stores, which touch `document`
// at load, and neither is what this file tests (the stub records what the
// table block handed it).

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../grid/Grid", () => ({
  Grid: ({ statement, readOnly, maxRows }: { statement: { columns: { name: string }[]; rows: unknown[][] }; readOnly?: boolean; maxRows?: number }) => (
    <table data-readonly={readOnly ? "" : undefined} data-max-rows={maxRows} data-cols={statement.columns.map((c) => c.name).join(",")} data-rows={statement.rows.length} />
  ),
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
    expect(out).toContain("<ul>");
    expect(out).not.toContain("<ol>");
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
      "<ol><li>Drop the <code>failed</code> rows.</li><li>Bucket the rest by <code>created_at</code>.</li></ol>",
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
});
