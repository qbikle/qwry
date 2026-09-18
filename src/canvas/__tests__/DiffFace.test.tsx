// The diff face's rendering (A3 item 5). What the store pairs is
// canvas.test's; this file checks what the face makes of a paired diff: both
// sides exactly as each database printed them, Δ the signed relative change
// at one decimal, a one-sided row in the warn tier with ∅ for the side it
// lacks and no Δ at all, and an over-cap comparison drawing NO grid, because
// the face is then its status line and nothing else.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffFace, triText } from "../DiffFace";
import type { Diff } from "../../stores/canvas";

const diff = (over: Partial<Diff> = {}): Diff => ({
  a: { profileId: "p-a", name: "staging", ms: 412.6 },
  b: { profileId: "p-b", name: "prod", ms: 388.1 },
  labelColumns: ["payment_status"],
  numericColumns: ["orders", "amount"],
  rows: [
    {
      labels: ["cod_delivered"],
      cells: [
        { a: "731", b: "748", delta: ((748 - 731) / 731) * 100 },
        { a: "1988640.00", b: "2011200.00", delta: 1.1345 },
      ],
      only: null,
    },
    {
      labels: ["partial_refund"],
      cells: [
        { a: null, b: "21", delta: null },
        { a: null, b: "61420.00", delta: null },
      ],
      only: "b",
    },
  ],
  capped: false,
  ...over,
});

const html = (d: Diff) => renderToStaticMarkup(<DiffFace diff={d} />);

describe("DiffFace", () => {
  test("every numeric cell reads A · B · Δ, the change signed at one decimal", () => {
    const out = html(diff());
    expect(out).toContain("731");
    expect(out).toContain("748");
    expect(out).toContain("+2.3%");
    expect(out).toContain("+1.1%");
  });

  test("a fall wears its own sign", () => {
    const d = diff();
    d.rows[0].cells[0] = { a: "482", b: "479", delta: ((479 - 482) / 482) * 100 };
    expect(html(d)).toContain("-0.6%");
  });

  test("both sides print exactly as the database gave them", () => {
    expect(html(diff())).toContain("1988640.00");
  });

  test("a row on one side only is warn, wears ∅ for the side it lacks, and has no Δ", () => {
    const out = html(diff());
    expect(out).toContain("∅");
    expect(out).toContain("dg-r warn");
    // a Δ per paired cell, in the marks and again in the tooltip that says the
    // same cell whole where it ellipsizes (D1 item 9); the one-sided row
    // carries none in either
    expect(out.match(/%/g)?.length).toBe(4);
    expect(out).toContain('title="∅ · 21"');
  });

  // D1 item 9: a cell narrow enough to ellipsize is a cell a reader cannot
  // finish, so its tooltip says the triple in full. A formatter, never the
  // object itself, which is what `[object Object]` in a tooltip is made of
  test("the tooltip is the triple as text, in the marks' own order and separator", () => {
    expect(triText({ a: "731", b: "748", delta: 2.3256 })).toBe("731 · 748 · +2.3%");
    expect(triText({ a: null, b: "21", delta: null })).toBe("∅ · 21");
    expect(triText({ a: "482", b: "479", delta: -0.6224 })).toBe("482 · 479 · -0.6%");
    expect(html(diff())).toContain('title="731 · 748 · +2.3%"');
  });

  test("the header names the label column and every numeric one, once each", () => {
    const out = html(diff());
    expect(out.match(/payment_status/g)?.length).toBe(1);
    expect(out).toContain("orders");
    expect(out).toContain("amount");
    // and every name rides the block that ellipsizes it, header and label
    // alike: `text-overflow` on a flex row says nothing about the items in it
    expect(out.match(/class="dg-t"/g)?.length).toBe(3 + diff().rows.length);
  });

  test("the face never names the two connections: that is the status line's", () => {
    const out = html(diff());
    expect(out).not.toContain("staging");
    expect(out).not.toContain("prod");
  });

  test("over the cap there is no grid at all", () => {
    expect(html(diff({ capped: true, rows: [] }))).toBe("");
  });
});
