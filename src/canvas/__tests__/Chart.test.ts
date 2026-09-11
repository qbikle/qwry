// The chart face's geometry (A3 item 2). The marks are pixels and belong to
// the frames; these are the rules the frames cannot check by eye: one scale
// across every series, the plot taking what the labels and the values leave,
// a legend only from two series, and nothing widening past the label cap at
// the 640 floor (DESIGN rule 13: growth feeds the bars, never the axis).

import { describe, expect, test } from "bun:test";
import { barLayout, lineLayout, standing } from "../Chart";
import type { ChartSpec } from "../../stores/canvas";

const bars = (labels: string[], series: { name: string; values: number[] }[]): ChartSpec => ({
  kind: "bars",
  label: "channel",
  labels,
  series,
});

const channels = bars(
  ["app", "web", "instagram", "whatsapp", "other", "referral"],
  [{ name: "orders", values: [1602, 486, 318, 247, 58, 52] }],
);

const cities = bars(
  ["Mumbai", "Delhi", "Bengaluru"],
  [
    { name: "cod_orders", values: [412, 388, 301] },
    { name: "returned", values: [61, 74, 29] },
  ],
);

describe("barLayout", () => {
  test("one series lies down in 24px rows with no legend above it", () => {
    const g = barLayout(channels, 640);
    expect(g.pitch).toBe(24);
    expect(g.barH).toBe(12);
    expect(g.legH).toBe(0);
    expect(g.h).toBe(6 * 24);
  });

  test("two series share ONE scale and take a legend row", () => {
    const g = barLayout(cities, 640);
    expect(g.legH).toBe(24);
    // the max is the widest bar of EITHER series: two scales in one plot lie
    expect(g.max).toBe(412);
    expect(g.pitch).toBe(2 * 8 + 3 + 12);
    expect(g.h).toBe(24 + 3 * g.pitch);
  });

  test("the plot takes what the labels and the values leave, and grows with the card", () => {
    const at640 = barLayout(channels, 640);
    const at1280 = barLayout(channels, 1280);
    expect(at640.x0).toBe(at640.labW + 8);
    expect(at640.plotW).toBe(640 - at640.x0 - at640.valW - 8);
    // growth feeds the bars: the label gutter is the same at every width
    expect(at1280.labW).toBe(at640.labW);
    expect(at1280.plotW - at640.plotW).toBe(640);
  });

  test("a very long label stops at the cap instead of eating the plot", () => {
    const long = bars(["a".repeat(120)], [{ name: "n", values: [10] }]);
    expect(barLayout(long, 640).labW).toBe(150);
    expect(barLayout(long, 640).plotW).toBeGreaterThan(24);
  });

  test("the plot never collapses to nothing, however narrow the box gets", () => {
    const wide = bars(["x".repeat(40)], [{ name: "n", values: [123456789012] }]);
    expect(barLayout(wide, 640).plotW).toBeGreaterThan(24);
    expect(barLayout(wide, 200).plotW).toBe(24);
  });

  test("an all-zero series still has a scale, so no bar divides by zero", () => {
    expect(barLayout(bars(["a", "b"], [{ name: "n", values: [0, 0] }]), 640).max).toBe(1);
  });
});

const months: ChartSpec = {
  kind: "line",
  label: "month",
  labels: ["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"],
  series: [{ name: "revenue", values: [1412880, 1338420, 1607350, 1794210, 1962540, 2277416] }],
};

describe("lineLayout", () => {
  test("three y ticks, top to bottom, on one scale", () => {
    const g = lineLayout(months, 640);
    expect(g.ticks).toEqual([2277416, 2277416 / 2, 0]);
    expect(g.yAt(2277416)).toBe(g.legH);
    expect(g.yAt(0)).toBe(g.legH + g.plotH);
  });

  test("the points sit at the dates: first at the axis, last at the right edge", () => {
    const g = lineLayout(months, 640);
    expect(g.xAt(0)).toBe(g.x0);
    expect(g.xAt(5)).toBe(g.x0 + g.plotW);
  });

  test("x labels are sparse: one in four, and always the last", () => {
    expect(lineLayout(months, 640).every).toBe(2);
    expect(lineLayout({ ...months, labels: months.labels.slice(0, 3) }, 640).every).toBe(1);
  });

  test("the tick before the last is dropped rather than collided into it", () => {
    const g = lineLayout(months, 640);
    const drawn = months.labels.filter((_, i) => i === 5 || (i % g.every === 0 && 5 - i >= g.every));
    expect(drawn).toEqual(["2026-03-01", "2026-05-01", "2026-08-01"]);
  });

  test("one point stands in the middle rather than dividing by zero", () => {
    const one = { ...months, labels: ["2026-08-01"], series: [{ name: "revenue", values: [10] }] };
    const g = lineLayout(one, 640);
    expect(g.xAt(0)).toBe(g.x0 + g.plotW / 2);
  });
});

// ---- C2a: the span decides which way the bars go -------------------------

describe("standing bars", () => {
  const days = bars(
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    [{ name: "orders", values: [402, 388, 431, 459, 512, 386] }],
  );

  test("a span three times wider than tall, with labels that fit, stands", () => {
    expect(standing(days, { w: 6, h: 2 })).toBe(true);
  });

  test("a span that is not half again as wide as it is tall lies down", () => {
    expect(standing(days, { w: 4, h: 3 })).toBe(false);
    expect(standing(channels, { w: 4, h: 3 })).toBe(false);
  });

  test("labels too wide for their own bars lie down, however wide the span", () => {
    const long = bars(
      ["instagram reels", "whatsapp business", "marketplace direct", "referral partners"],
      [{ name: "orders", values: [318, 247, 118, 58] }],
    );
    expect(standing(long, { w: 4, h: 2 })).toBe(false);
  });

  test("the SPAN decides and nothing else: the same chart stands at six cells and lies at four", () => {
    // the fit is measured against the BASE cell, so a window that stretches
    // the cells (at most a quarter) can never flip a chart on its side: only
    // a resize can, which is the reader's own act
    expect(standing(channels, { w: 6, h: 2 })).toBe(true);
    expect(standing(channels, { w: 4, h: 2 })).toBe(false);
  });

  test("a date label never stands: it is a line", () => {
    expect(standing(months, { w: 8, h: 2 })).toBe(false);
  });
});

describe("a face with a height of its own", () => {
  test("the rows spread over the face instead of stacking at 24", () => {
    const g = barLayout(channels, 640, 480);
    expect(g.pitch).toBe(40); // capped: six rows in 480 would be 80 each
    expect(g.h).toBe(6 * 40);
  });

  test("a squeezed face never puts the rows under the bars they hold", () => {
    const g = barLayout(channels, 640, 60);
    expect(g.pitch).toBe(16);
    expect(g.pitch).toBeGreaterThanOrEqual(g.barH);
  });

  test("the line's plot takes the face's height in place of its fixed 132", () => {
    expect(lineLayout(months, 640).plotH).toBe(132);
    const g = lineLayout(months, 640, 300);
    expect(g.plotH).toBe(300 - 18);
    expect(g.h).toBe(300);
  });
});
