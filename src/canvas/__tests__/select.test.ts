// The select tool's math (F3, select.ts). Every function, and the two
// invariants a screenshot cannot show: the corner a hand is HOLDING never
// moves, at any angle, for any kind; and a stroke nothing happened to comes
// back by identity, which is what makes one gesture one undo step.
//
// No DOM, no store, no React: the engine is pure, so the whole of a drag is a
// sequence of calls here and the element next door only decides which one.

import { describe, expect, test } from "bun:test";
import {
  BOX_TOL,
  HANDLE,
  HIT_TOL,
  KNOB,
  KNOB_GAP,
  PAD,
  SNAP,
  STEM,
  TEXT_MIN,
  angleOf,
  changed,
  handleAt,
  hit,
  hitAt,
  localBox,
  marqueeHits,
  moveSel,
  overlayOf,
  resizeOne,
  resizeScale,
  resizeSel,
  rotateAbout,
  rotateSel,
  scaleAbout,
  translate,
  unionBox,
  worldBox,
  type Corner,
} from "../select";
import { centreOf, rotatePt, textBox, type Box4, type Stroke } from "../strokes";

const rect = (b: Box4, r?: number): Stroke => (r === undefined ? { k: "rect", c: 0, t: 2, b } : { k: "rect", c: 0, t: 2, b, r });
const oval = (b: Box4, r?: number): Stroke =>
  r === undefined ? { k: "ellipse", c: 0, t: 2, b } : { k: "ellipse", c: 0, t: 2, b, r };
const line = (b: Box4): Stroke => ({ k: "line", c: 0, t: 2, b });
const pen = (p: number[]): Stroke => ({ k: "pen", c: 0, t: 2, p });
const label = (at: [number, number], v = "hello", r?: number): Stroke =>
  r === undefined ? { k: "text", c: 0, s: 13, at, v } : { k: "text", c: 0, s: 13, at, v, r };

/** the test's OWN reading of a corner, so the invariant below is checked
 * against arithmetic this file wrote and not against the one it is testing */
const OPP: Record<Corner, Corner> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };
const corner = (b: Box4, at: Corner): [number, number] => [
  at === "nw" || at === "sw" ? b[0] : b[2],
  at === "nw" || at === "ne" ? b[1] : b[3],
];

/** where the corner a drag holds still actually stands on the page */
const fixedInWorld = (s: Stroke, at: Corner): [number, number] => {
  const b = localBox(s);
  const [cx, cy] = centreOf(b);
  const [x, y] = corner(b, OPP[at]);
  return rotatePt(x, y, cx, cy, angleOf(s));
};

/** all four, on the page. A drag dragged PAST its opposite corner flips the
 * shape, and the held point is then a different named corner of the same box:
 * still the same point on the page, which is the invariant */
const cornersInWorld = (s: Stroke): [number, number][] => {
  const b = localBox(s);
  const [cx, cy] = centreOf(b);
  return (["nw", "ne", "se", "sw"] as Corner[]).map((at) => rotatePt(...corner(b, at), cx, cy, angleOf(s)));
};

const holds = (s: Stroke, at: [number, number]): number =>
  Math.min(...cornersInWorld(s).map((c) => Math.hypot(c[0] - at[0], c[1] - at[1])));

const near = (a: readonly number[], b: readonly number[], digits = 6) =>
  a.forEach((n, i) => expect(n).toBeCloseTo(b[i], digits));

describe("what a stroke covers", () => {
  test("a pen stroke's box is its points, either direction", () => {
    expect(localBox(pen([50, 10, 10, 40, 30, 70]))).toEqual([10, 10, 50, 70]);
  });

  test("a shape's box forgets which corner the drag started at", () => {
    expect(localBox(rect([90, 80, 10, 20]))).toEqual([10, 20, 90, 80]);
    expect(localBox(rect([10, 20, 90, 80]))).toEqual([10, 20, 90, 80]);
  });

  test("a label's box is the ONE estimate the ink's own bounds read", () => {
    const l = label([40, 60], "abcdef");
    expect(localBox(l)).toEqual(textBox({ at: [40, 60], s: 13, v: "abcdef" }));
  });

  test("a pen stroke with nothing readable in it is a point, never Infinity", () => {
    expect(localBox(pen([]))).toEqual([0, 0, 0, 0]);
    expect(localBox(pen([])).every(Number.isFinite)).toBe(true);
  });

  test("an angle is carried by the three kinds with a frame and by nobody else", () => {
    expect(angleOf(rect([0, 0, 10, 10], 0.4))).toBe(0.4);
    expect(angleOf(label([0, 0], "x", -1))).toBe(-1);
    expect(angleOf(line([0, 0, 10, 10]))).toBe(0);
    expect(angleOf(pen([0, 0, 4, 4]))).toBe(0);
    expect(angleOf(rect([0, 0, 10, 10]))).toBe(0);
  });

  test("a turned square stands in a wider box than the one it was drawn in", () => {
    const s = rect([0, 0, 40, 40], Math.PI / 4);
    expect(localBox(s)).toEqual([0, 0, 40, 40]);
    const w = worldBox(s);
    // a 40px square on its corner is 40 * root 2 across, about its own centre
    near(w, [20 - 28.284271, 20 - 28.284271, 20 + 28.284271, 20 + 28.284271], 4);
    // and an unturned one is its own box
    expect(worldBox(rect([0, 0, 40, 40]))).toEqual([0, 0, 40, 40]);
  });

  test("a group's box covers every member, and an empty set has none", () => {
    const strokes = [rect([0, 0, 20, 20]), rect([100, 60, 140, 90])];
    expect(unionBox(strokes, [0, 1])).toEqual([0, 0, 140, 90]);
    expect(unionBox(strokes, [1])).toEqual([100, 60, 140, 90]);
    expect(unionBox(strokes, [])).toBeNull();
    // an index the document no longer holds is skipped, never read as a hole
    expect(unionBox(strokes, [0, 99])).toEqual([0, 0, 20, 20]);
  });
});

describe("what a click lands on", () => {
  test("an open kind is measured to its segments, and the weight widens it", () => {
    const thin: Stroke = { k: "line", c: 0, t: 1, b: [0, 0, 100, 0] };
    const thick: Stroke = { k: "line", c: 0, t: 4, b: [0, 0, 100, 0] };
    expect(hit(thin, 50, 3)).toBe(true);
    expect(hit(thin, 50, HIT_TOL + 0.5 + 0.2)).toBe(false);
    // 6 + 4/2 = 8: the marker is easier to hit than the hairline
    expect(hit(thick, 50, 7.5)).toBe(true);
    expect(hit(thin, 50, 7.5)).toBe(false);
    // and past the ends it stops
    expect(hit(thin, 140, 0)).toBe(false);
  });

  test("a pen stroke answers along its path, and a tap answers as a dot", () => {
    const scribble = pen([0, 0, 40, 0, 40, 40]);
    expect(hit(scribble, 20, 2)).toBe(true);
    expect(hit(scribble, 40, 20)).toBe(true);
    // the INSIDE of a loose path is not the path
    expect(hit(scribble, 20, 30)).toBe(false);
    expect(hit(pen([30, 30]), 32, 31)).toBe(true);
    expect(hit(pen([30, 30]), 50, 31)).toBe(false);
  });

  test("a closed kind and a label answer to their box, inflated 4", () => {
    const r = rect([20, 20, 80, 60]);
    expect(hit(r, 50, 40)).toBe(true);
    expect(hit(r, 20 - BOX_TOL + 1, 40)).toBe(true);
    expect(hit(r, 20 - BOX_TOL - 1, 40)).toBe(false);
    const l = label([40, 60], "hello");
    const b = localBox(l);
    expect(hit(l, b[0] + 1, b[1] + 1)).toBe(true);
    expect(hit(l, b[2] + BOX_TOL + 2, b[1])).toBe(false);
  });

  test("an ellipse answers inside its own outline, not inside its box", () => {
    const e = oval([0, 0, 80, 40]);
    expect(hit(e, 40, 20)).toBe(true);
    expect(hit(e, 78, 20)).toBe(true);
    // the box's own corner stands outside the shape
    expect(hit(e, 2, 2)).toBe(false);
  });

  test("a turned shape is hit where it STANDS, not where it was drawn", () => {
    const s = rect([40, 90, 160, 110], Math.PI / 2);
    // upright, the same box is a tall bar through its own centre
    expect(hit(s, 100, 40)).toBe(true);
    expect(hit(s, 100, 160)).toBe(true);
    // and the ends it used to have are now empty paper
    expect(hit(s, 45, 100)).toBe(false);
  });

  test("the topmost stroke wins, and empty paper is -1", () => {
    const strokes = [rect([0, 0, 100, 100]), rect([20, 20, 60, 60])];
    expect(hitAt(strokes, 40, 40)).toBe(1);
    expect(hitAt(strokes, 90, 90)).toBe(0);
    expect(hitAt(strokes, 400, 400)).toBe(-1);
  });
});

describe("the marquee", () => {
  const strokes = [rect([0, 0, 20, 20]), rect([100, 100, 140, 140]), line([300, 10, 340, 40])];

  test("it takes every box it crosses, in document order", () => {
    expect(marqueeHits(strokes, [-10, -10, 150, 150])).toEqual([0, 1]);
    expect(marqueeHits(strokes, [110, 110, 120, 120])).toEqual([1]);
    expect(marqueeHits(strokes, [200, 200, 260, 260])).toEqual([]);
  });

  test("either corner first is the same marquee", () => {
    expect(marqueeHits(strokes, [150, 150, -10, -10])).toEqual([0, 1]);
  });

  test("a box that merely touches counts", () => {
    expect(marqueeHits(strokes, [20, 20, 30, 30])).toEqual([0]);
  });

  test("a turned shape is caught by where it stands", () => {
    const turned = [oval([40, 95, 160, 105], Math.PI / 2)];
    // nothing of it is left at x 40 and it now reaches y 40
    expect(marqueeHits(turned, [30, 90, 45, 110])).toEqual([]);
    expect(marqueeHits(turned, [95, 30, 105, 50])).toEqual([0]);
  });
});

describe("a stroke under a hand", () => {
  test("everything moves, and a move of nothing is the stroke itself", () => {
    expect(translate(pen([0, 0, 10, 10]), 5, -5)).toEqual(pen([5, -5, 15, 5]));
    expect(translate(rect([0, 0, 10, 10]), 5, 5)).toEqual(rect([5, 5, 15, 15]));
    expect(translate(label([10, 20]), 5, 5)).toEqual(label([15, 25]));
    const s = rect([0, 0, 10, 10]);
    expect(translate(s, 0, 0)).toBe(s);
  });

  test("a shape turns by carrying the angle; its box never moves under it", () => {
    const s = rect([0, 0, 40, 20]);
    const turned = rotateAbout(s, 20, 10, Math.PI / 6);
    expect(localBox(turned)).toEqual([0, 0, 40, 20]);
    expect(angleOf(turned)).toBeCloseTo(Math.PI / 6, 9);
    // about a point that is not its own centre, the centre travels too
    const off = rotateAbout(s, 0, 0, Math.PI / 2);
    near(centreOf(localBox(off)), [-10, 20]);
    expect(angleOf(off)).toBeCloseTo(Math.PI / 2, 9);
  });

  test("a label turns the same way and a rotation of nothing changes nothing", () => {
    const l = rotateAbout(label([10, 20]), 10, 20, 0.5);
    expect(angleOf(l)).toBeCloseTo(0.5, 9);
    const s = rect([0, 0, 10, 10]);
    expect(rotateAbout(s, 0, 0, 0)).toBe(s);
  });

  test("the three made of coordinates BAKE the turn instead", () => {
    const p = rotateAbout(pen([10, 0, 20, 0]), 0, 0, Math.PI / 2);
    expect(p.k).toBe("pen");
    expect(angleOf(p)).toBe(0);
    near((p as { p: number[] }).p, [0, 10, 0, 20]);
    const l = rotateAbout(line([10, 0, 20, 0]), 0, 0, Math.PI / 2);
    near((l as { b: Box4 }).b, [0, 10, 0, 20]);
  });

  test("a turn and its opposite bring a shape back", () => {
    const s = rect([12, 30, 90, 44], 0.2);
    const there = rotateAbout(s, 5, 5, 0.9);
    const back = rotateAbout(there, 5, 5, -0.9);
    near(localBox(back), localBox(s));
    expect(angleOf(back)).toBeCloseTo(0.2, 9);
  });

  test("a scale holds its fixed point, whatever the kind", () => {
    expect(scaleAbout(pen([0, 0, 10, 10]), 0, 0, 2, 3)).toEqual(pen([0, 0, 20, 30]));
    expect(scaleAbout(line([4, 4, 8, 8]), 4, 4, 2, 2)).toEqual(line([4, 4, 12, 12]));
    const r = scaleAbout(rect([10, 10, 30, 20]), 10, 10, 2, 2);
    near((r as { b: Box4 }).b, [10, 10, 50, 30]);
    const s = rect([0, 0, 10, 10]);
    expect(scaleAbout(s, 0, 0, 1, 1)).toBe(s);
  });

  test("a label scales by the geometric mean and never reads under its floor", () => {
    const wide = scaleAbout(label([0, 20]), 0, 20, 4, 1);
    expect((wide as { s: number }).s).toBeCloseTo(13 * 2, 9);
    const tiny = scaleAbout(label([0, 20]), 0, 20, 0.1, 0.1);
    expect((tiny as { s: number }).s).toBe(TEXT_MIN);
  });
});

describe("a corner drag", () => {
  const box: Box4 = [0, 0, 100, 50];

  test("it scales away from the corner across the box", () => {
    const sc = resizeScale(box, "se", [100, 50], [150, 100], false);
    expect(sc).not.toBeNull();
    expect(sc?.fixed).toEqual([0, 0]);
    expect(sc?.sx).toBeCloseTo(1.5, 9);
    expect(sc?.sy).toBeCloseTo(2, 9);
    expect(resizeScale(box, "nw", [0, 0], [0, 0], false)?.fixed).toEqual([100, 50]);
  });

  test("shift makes one factor of two", () => {
    const sc = resizeScale(box, "se", [100, 50], [150, 100], true);
    expect(sc?.sx).toBeCloseTo(2, 9);
    expect(sc?.sy).toBeCloseTo(2, 9);
  });

  test("an axis the box has no extent on is HELD, never divided by", () => {
    const flat: Box4 = [0, 40, 100, 40];
    const sc = resizeScale(flat, "se", [100, 40], [150, 90], false);
    expect(sc?.sy).toBe(1);
    expect(sc?.sx).toBeCloseTo(1.5, 9);
    // and with shift, the flat axis still does not join in
    expect(resizeScale(flat, "se", [100, 40], [150, 90], true)?.sy).toBe(1);
  });

  test("a drag that would collapse the shape is refused", () => {
    expect(resizeScale(box, "se", [100, 50], [1, 50], false)).toBeNull();
    expect(resizeScale(box, "se", [100, 50], [150, 0.1], false)).toBeNull();
  });

  test("a turned shape reads the drag in ITS OWN frame", () => {
    const r = Math.PI / 6;
    // a drag along the shape's own x axis, expressed on the page
    const [dx, dy] = rotatePt(20, 0, 0, 0, r);
    const s = rect([0, 0, 100, 50], r);
    const grown = resizeOne(s, "se", [100, 50], [100 + dx, 50 + dy], false);
    const b = localBox(grown);
    expect(b[2] - b[0]).toBeCloseTo(120, 6);
    expect(b[3] - b[1]).toBeCloseTo(50, 6);
  });

  test("an unturned shape grows by exactly the drag", () => {
    const grown = resizeOne(rect([10, 10, 110, 60]), "se", [110, 60], [130, 80], false);
    near(localBox(grown), [10, 10, 130, 80]);
  });

  test("a drag past the opposite corner FLIPS, and the held point still stands", () => {
    const s = rect([20, 30, 120, 90]);
    const at = fixedInWorld(s, "se");
    // se dragged far up and left of nw: the shape turns inside out about the
    // corner the hand is not holding, which stays exactly where it was
    const flipped = resizeOne(s, "se", [120, 90], [-80, -50], false);
    const b = localBox(flipped);
    expect(b[2]).toBeLessThanOrEqual(20);
    expect(b[3]).toBeLessThanOrEqual(30);
    expect(holds(flipped, at)).toBeLessThan(1e-6);
    // and with an angle on it, under shift, the same point holds
    const base = rect([20, 30, 120, 90], 0.8);
    const turned = resizeOne(base, "nw", [20, 30], [260, 220], true);
    expect(holds(turned, fixedInWorld(base, "nw"))).toBeLessThan(1e-6);
  });

  test("a drag that collapses hands back the stroke itself, so the last frame holds", () => {
    const s = rect([0, 0, 100, 50]);
    expect(resizeOne(s, "se", [100, 50], [0, 50], false)).toBe(s);
  });

  test("a one-point pen stroke survives a drag with no NaN in it", () => {
    const dot = pen([30, 30]);
    const after = resizeOne(dot, "se", [30, 30], [80, 80], false);
    expect((after as { p: number[] }).p.every(Number.isFinite)).toBe(true);
  });

  test("a label takes the geometric mean and keeps reading", () => {
    const grown = resizeOne(label([20, 40], "hello"), "se", [55, 45], [200, 300], false);
    expect((grown as { s: number }).s).toBeGreaterThan(13);
    const shrunk = resizeOne(label([20, 40], "hello"), "se", [55, 45], [22, 36], false);
    expect((shrunk as { s: number }).s).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  // the invariant the whole file exists for
  test("THE FIXED CORNER NEVER MOVES, at any angle, for any kind", () => {
    const kinds: Stroke[][] = [
      [rect([20, 30, 120, 90]), rect([20, 30, 120, 90], 0.3), rect([20, 30, 120, 90], -1.2), rect([20, 30, 120, 90], Math.PI / 2)],
      [oval([0, 0, 60, 40]), oval([0, 0, 60, 40], 0.9)],
      [label([40, 80], "a label"), label([40, 80], "a label", 0.6), label([40, 80], "a label", -2.4)],
      [pen([10, 10, 60, 30, 40, 80])],
      [line([10, 10, 90, 70])],
    ];
    const drags: Array<[number, number]> = [
      [18, 12],
      [-9, 24],
      [40, -16],
      [7, 7],
    ];
    for (const family of kinds) {
      for (const s of family) {
        for (const at of ["nw", "ne", "se", "sw"] as Corner[]) {
          const b = localBox(s);
          const [cx, cy] = centreOf(b);
          const held = rotatePt(...corner(b, at), cx, cy, angleOf(s));
          for (const [dx, dy] of drags) {
            for (const ratio of [false, true]) {
              const next = resizeOne(s, at, held, [held[0] + dx, held[1] + dy], ratio);
              if (next === s) continue;
              expect(holds(next, fixedInWorld(s, at))).toBeLessThan(1e-6);
            }
          }
        }
      }
    }
  });
});

describe("a gesture over the whole selection", () => {
  const strokes = [rect([0, 0, 20, 20]), rect([100, 100, 140, 140]), line([300, 10, 340, 40])];
  const sel = new Set([0, 1]);

  test("only the selection moves, and the rest keeps its identity", () => {
    const next = moveSel(strokes, sel, 10, 5);
    expect(localBox(next[0])).toEqual([10, 5, 30, 25]);
    expect(next[2]).toBe(strokes[2]);
    expect(changed(strokes, next)).toBe(true);
    expect(changed(strokes, moveSel(strokes, sel, 0, 0))).toBe(false);
  });

  test("shift on the knob lands the turn on 15 degrees", () => {
    const [cx, cy] = centreOf(unionBox(strokes, sel) as Box4);
    const free = rotateSel(strokes, sel, cx, cy, 0.31, false);
    const snapped = rotateSel(strokes, sel, cx, cy, 0.31, true);
    expect(angleOf(free[0])).toBeCloseTo(0.31, 9);
    expect(angleOf(snapped[0])).toBeCloseTo(SNAP, 9);
    expect((angleOf(snapped[0]) / SNAP) % 1).toBeCloseTo(0, 9);
  });

  test("one stroke resizes in its own frame; a group scales about the union's corner", () => {
    const one = resizeSel(strokes, new Set([0]), "se", [20, 20], [40, 40], false);
    near(localBox(one[0]), [0, 0, 40, 40]);
    expect(one[1]).toBe(strokes[1]);

    const both = resizeSel(strokes, sel, "se", [140, 140], [280, 280], false);
    // the union box is 140 across and the drag doubles it about its nw corner
    near(localBox(both[0]), [0, 0, 40, 40]);
    near(localBox(both[1]), [200, 200, 280, 280]);
    expect(both[2]).toBe(strokes[2]);
  });

  test("a refused group drag changes nothing", () => {
    const next = resizeSel(strokes, sel, "se", [140, 140], [0, 140], false);
    expect(changed(strokes, next)).toBe(false);
    expect(changed(strokes, resizeSel(strokes, new Set(), "se", [1, 1], [2, 2], false))).toBe(false);
  });
});

describe("what the sheet draws over it", () => {
  const strokes = [rect([20, 20, 120, 70]), rect([200, 200, 240, 260]), oval([20, 20, 120, 70], 0.7)];

  test("an empty selection has no overlay", () => {
    expect(overlayOf(strokes, [])).toBeNull();
    expect(overlayOf(strokes, [42])).toBeNull();
  });

  test("one stroke: its own box, PAD outside it, turned with it", () => {
    const ov = overlayOf(strokes, [0]);
    expect(ov?.box).toEqual([20 - PAD, 20 - PAD, 120 + PAD, 70 + PAD]);
    expect(ov?.r).toBe(0);
    expect(ov?.cx).toBe(70);
    expect(ov?.cy).toBe(45);
    expect(ov?.handles.map((h) => h.at)).toEqual(["nw", "ne", "se", "sw"]);
    expect(ov?.handles[0]).toEqual({ at: "nw", x: 16, y: 16 });
    expect(ov?.handles[2]).toEqual({ at: "se", x: 124, y: 74 });
    expect(ov?.stem).toEqual({ x: 70, y0: 16, y1: 16 - STEM });
    expect(ov?.knob).toEqual({ x: 70, y: 16 - KNOB_GAP });
    // the turned one carries its angle, and its box is the box it was DRAWN in
    const turned = overlayOf(strokes, [2]);
    expect(turned?.r).toBeCloseTo(0.7, 9);
    expect(turned?.box).toEqual([16, 16, 124, 74]);
  });

  test("a group: the union box, and never an angle of its own", () => {
    const ov = overlayOf(strokes, [0, 1]);
    expect(ov?.r).toBe(0);
    expect(ov?.box).toEqual([20 - PAD, 20 - PAD, 240 + PAD, 260 + PAD]);
    const withTurned = overlayOf(strokes, [1, 2]);
    expect(withTurned?.r).toBe(0);
  });

  test("a handle answers where it is drawn, and the middle answers nothing", () => {
    const ov = overlayOf(strokes, [0]) as NonNullable<ReturnType<typeof overlayOf>>;
    expect(handleAt(ov, 16, 16)).toBe("nw");
    expect(handleAt(ov, 124 - HANDLE / 2 + 1, 74)).toBe("se");
    expect(handleAt(ov, 124, 16)).toBe("ne");
    expect(handleAt(ov, 16, 74)).toBe("sw");
    expect(handleAt(ov, 70, 16 - KNOB_GAP)).toBe("rot");
    expect(handleAt(ov, 70, 45)).toBeNull();
    expect(handleAt(ov, 16 - HANDLE, 16)).toBeNull();
  });

  test("a turned overlay answers in PAGE pixels", () => {
    const ov = overlayOf(strokes, [2]) as NonNullable<ReturnType<typeof overlayOf>>;
    const nw = rotatePt(ov.box[0], ov.box[1], ov.cx, ov.cy, ov.r);
    expect(handleAt(ov, nw[0], nw[1])).toBe("nw");
    // and the place that handle would have stood UNTURNED is now empty
    expect(handleAt(ov, ov.box[0], ov.box[1])).toBeNull();
    const knob = rotatePt(ov.knob.x, ov.knob.y, ov.cx, ov.cy, ov.r);
    expect(handleAt(ov, knob[0], knob[1])).toBe("rot");
    expect(Math.hypot(knob[0] - ov.knob.x, knob[1] - ov.knob.y)).toBeGreaterThan(KNOB);
  });

  test("the box a hover raises is the box a click will land", () => {
    const hovered = overlayOf(strokes, [2]);
    const picked = overlayOf(strokes, [2]);
    expect(hovered?.box).toEqual(picked?.box as Box4);
    expect(hovered?.r).toBe(picked?.r as number);
  });
});
