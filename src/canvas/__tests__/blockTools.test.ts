// The cluster's membership, which is the one thing three kinds share (C2b).
// What is pinned here is the ORDER and the ROSTER, because the failure this
// table exists to stop is invisible: two kinds drifting into two orders, and a
// third arriving with a list of its own.

import { expect, test } from "bun:test";
import { DRAW_TOOLS, INK_STEPS, WEIGHT_STEPS, kindTools, toolForKey } from "../blockTools";
import { CELL_W_BASE, GUTTER, PAGE_INSET, cellMetrics } from "../grid";
import { INK_VAR, WEIGHTS } from "../strokes";

test("each kind's cluster, in the one order they stand in", () => {
  expect(kindTools("result")).toEqual(["grip", "copy", "flip", "insert", "ask", "more"]);
  expect(kindTools("note")).toEqual(["grip", "copy", "ask", "more"]);
  expect(kindTools("drawing")).toEqual(["grip", "pen", "undo", "redo", "copy", "ask", "more"]);
});

test("the grip is every cluster's first action, and `more` its last", () => {
  for (const kind of ["result", "note", "drawing"] as const) {
    const tools = kindTools(kind);
    expect(tools[0]).toBe("grip");
    expect(tools[tools.length - 1]).toBe("more");
    // a tool appears once: a cluster with two Copies is a cluster nobody read
    expect(new Set(tools).size).toBe(tools.length);
  }
});

test("the drawing's seven fit its floor of two cells at the 640 floor", () => {
  // the cluster's own numbers (ask.css .acts-float): 16 of left padding under
  // the fade, 18px buttons 4 apart, 4 of right padding. The FRAME is the real
  // evidence (c2-draw-small at 640); this is the arithmetic that predicts it,
  // and it is what holds the roster at seven (DESIGN rule 13)
  const px = (n: number) => 16 + n * 18 + (n - 1) * 4 + 4;
  // the card's floor is 640 (DESIGN rule 13's own width) and the grid gets it
  // less the page inset either side and the card's own hairline. Five cells
  // stand there at the base with room over, so they stretch into it: 111.6
  const CARD_FLOOR = 640;
  expect(5 * CELL_W_BASE + 4 * GUTTER + 2 * PAGE_INSET + 2).toBeLessThanOrEqual(CARD_FLOOR);
  const floor = cellMetrics(CARD_FLOOR - 2 * PAGE_INSET - 2);
  expect(floor.columns).toBe(5);
  // 2 x 111.6 + 12 = 235.2, the width the roster is designed against
  const twoCells = 2 * floor.cellW + floor.gutter;
  expect(Math.round(twoCells * 10) / 10).toBe(235.2);
  expect(px(kindTools("drawing").length)).toBeLessThan(twoCells);
  // and the result's six, which is what put a result's own floor at two
  expect(px(kindTools("result").length)).toBeLessThan(twoCells);
});

test("one key arms one tool, and every other key bubbles", () => {
  for (const row of DRAW_TOOLS) {
    expect(toolForKey(row.chord)).toBe(row.tool);
    expect(toolForKey(row.chord.toUpperCase())).toBe(row.tool);
  }
  for (const key of ["z", "Escape", "ArrowLeft", "1", " "]) expect(toolForKey(key)).toBeNull();
});

test("the six tools are the six a stroke can be, each with its own chord", () => {
  expect(DRAW_TOOLS.map((t) => t.tool)).toEqual(["pen", "rect", "ellipse", "line", "arrow", "text"]);
  expect(new Set(DRAW_TOOLS.map((t) => t.chord)).size).toBe(DRAW_TOOLS.length);
  // a chord is a SPEC for <Kbd> and never a glyph: one character, lower case
  for (const row of DRAW_TOOLS) expect(row.chord).toMatch(/^[a-z]$/);
});

test("the picker's ladders and the drawing's own are the same length", () => {
  expect(INK_STEPS.length).toBe(INK_VAR.length);
  expect(WEIGHT_STEPS.length).toBe(WEIGHTS.length);
});
