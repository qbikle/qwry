// The chart face's geometry (A3 item 2). The marks are pixels and belong to
// the frames; these are the rules the frames cannot check by eye: one scale
// across every series, the plot taking what the labels and the values leave,
// a legend only from two series, and nothing widening past the label cap at
// the 640 floor (DESIGN rule 13: growth feeds the bars, never the axis).

import { describe, expect, test } from "bun:test";
import { barLayout, lineLayout } from "../Chart";
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
