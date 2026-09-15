// The drawing's ink (C2b, strokes.ts). Five things are under test and only
// five: the serialize/deserialize PAIR (LESSONS 1, property-tested both ways),
// the caps and what they refuse, the simplification's own contract, the
// geometry the live element and the export share, and the two budgets the law
// names by number (the pointer path under 4 ms an event, the PNG's long edge
// clamped to 1568).
//
// A deterministic PRNG, so a property failure reproduces: the precedent is
// src/ask/__tests__/fuzzy.test.ts, copied in shape. No fast-check (not a
// dependency, and this wave adds none).

import { describe, expect, test } from "bun:test";
import {
  ELEMENT_BYTES_MAX,
  PEN_POINTS_MAX,
  PNG_LONG_EDGE,
  PNG_SCALE,
  RDP_EPS,
  TEXT_SIZE,
  WEIGHTS,
  bboxOf,
  inkFull,
  marksOf,
  parseStrokes,
  penHead,
  penPath,
  penSegment,
  penTail,
  pngSize,
  simplify,
  strokeBytes,
  svgOf,
  writeStrokes,
  type Stroke,
} from "../strokes";
import { CELL_W_BASE, GUTTER, cellsForPx } from "../grid";

let seed = 0x5c1f3a7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
/** a coordinate a hand can actually make: inside a plausible element, and
 * sometimes outside it, because ink past the frame is a real state */
const coord = () => Math.round((rnd() * 900 - 100) * 10) / 10;

const KINDS = ["pen", "rect", "ellipse", "line", "arrow", "text"] as const;

function stroke(): Stroke {
  const k = pick(KINDS);
  const c = Math.floor(rnd() * 3);
  const t = pick(WEIGHTS);
  if (k === "pen") {
    const n = 1 + Math.floor(rnd() * 40);
    const p: number[] = [];
    for (let i = 0; i < n; i++) p.push(coord(), coord());
    return { k, c, t, p };
  }
  if (k === "text") return { k, c, s: TEXT_SIZE, at: [coord(), coord()], v: `label ${Math.floor(rnd() * 999)}` };
  return { k, c, t, b: [coord(), coord(), coord(), coord()] };
}

const drawing = (n = Math.floor(rnd() * 12)): Stroke[] => Array.from({ length: n }, stroke);

/** the hostile cases the spec names by hand, beside the random ones */
const HOSTILE: Stroke[][] = [
  [],
  [{ k: "pen", c: 0, t: 1, p: [4, 4] }],
  [{ k: "pen", c: 0, t: 1, p: Array.from({ length: 4000 * 2 + 40 }, (_, i) => (i % 7) * 3.14159) }],
  [{ k: "rect", c: 2, t: 4, b: [-120, -80, -20, -10] }],
  [{ k: "text", c: 1, s: TEXT_SIZE, at: [0, 0], v: "a <tag> & an \"ampersand\"" }],
];

describe("the pair (LESSONS 1)", () => {
  test("parse(write(x)) is write(x), over 2,000 documents", () => {
    for (let i = 0; i < 2000; i++) {
      const canonical = writeStrokes(drawing());
      expect(parseStrokes(canonical)).toEqual(canonical);
    }
  });

  test("and over the hostile ones the spec names", () => {
    for (const d of HOSTILE) {
      const canonical = writeStrokes(d);
      expect(parseStrokes(canonical)).toEqual(canonical);
    }
  });

  test("both halves are idempotent", () => {
    for (let i = 0; i < 500; i++) {
      const d = drawing();
      expect(writeStrokes(writeStrokes(d))).toEqual(writeStrokes(d));
      expect(parseStrokes(parseStrokes(d))).toEqual(parseStrokes(d));
    }
  });

  test("NaN and Infinity are rejected at the door, never stored", () => {
    const bad: unknown[] = [
      { k: "pen", c: 0, t: 1, p: [0, 0, Number.NaN, 4, 8, 8] },
      { k: "rect", c: 0, t: 1, b: [0, 0, Number.POSITIVE_INFINITY, 4] },
      { k: "line", c: 0, t: 1, b: [0, 0, 4, Number.NaN] },
      { k: "text", c: 0, s: 13, at: [Number.NaN, 0], v: "x" },
    ];
    const out = parseStrokes(bad);
    // the pen stroke keeps the points BEFORE the NaN and drops the rest; the
    // three whose whole geometry is unreadable drop entirely
    expect(out).toEqual([{ k: "pen", c: 0, t: 1, p: [0, 0] }]);
    expect(JSON.stringify(out)).not.toContain("null");
  });

  test("what appdb can hold that a stroke is not", () => {
    expect(parseStrokes(null)).toEqual([]);
    expect(parseStrokes("[]")).toEqual([]);
    expect(parseStrokes([null, 4, "pen", {}, { k: "spline" }])).toEqual([]);
    expect(parseStrokes([{ k: "text", c: 0, s: 13, at: [1, 2], v: "   " }])).toEqual([]);
  });

  test("a hand-edited colour, weight or size lands on its own ladder", () => {
    const out = parseStrokes([
      { k: "rect", c: 99, t: 3.7, b: [0, 0, 10, 10] },
      { k: "pen", c: -4, t: 0.2, p: [0, 0, 1, 1] },
      { k: "text", c: 1.9, s: 400, at: [0, 0], v: "x" },
    ]);
    expect(out.map((s) => s.c)).toEqual([2, 0, 1]);
    expect((out[0] as { t: number }).t).toBe(4);
    expect((out[1] as { t: number }).t).toBe(1);
    expect((out[2] as { s: number }).s).toBe(32);
  });
});

describe("the caps", () => {
  test("one pen stroke stops at its point cap", () => {
    const huge = Array.from({ length: (PEN_POINTS_MAX + 500) * 2 }, (_, i) => i % 313);
    const out = writeStrokes([{ k: "pen", c: 0, t: 1, p: huge }]);
    expect((out[0] as { p: number[] }).p.length).toBe(PEN_POINTS_MAX * 2);
  });

  test("the OLDEST strokes are never dropped: writing keeps every readable one", () => {
    for (let i = 0; i < 200; i++) {
      const d = drawing(1 + Math.floor(rnd() * 20));
      expect(writeStrokes(d).length).toBe(d.length);
    }
  });

  test("the element's own cap is measured on what is WRITTEN", () => {
    const small: Stroke[] = [{ k: "pen", c: 0, t: 1, p: [0, 0, 4, 4] }];
    expect(inkFull(small)).toBe(false);
    expect(strokeBytes(small)).toBe(JSON.stringify(writeStrokes(small)).length);
    const many: Stroke[] = Array.from({ length: 40 }, () => ({
      k: "pen" as const,
      c: 0,
      t: 2,
      p: Array.from({ length: 400 }, (_, i) => i * 1.1),
    }));
    expect(strokeBytes(many)).toBeGreaterThan(ELEMENT_BYTES_MAX);
    expect(inkFull(many)).toBe(true);
  });

  test("rounding is 0.1px and it round-trips exactly", () => {
    const out = writeStrokes([{ k: "line", c: 0, t: 1, b: [1.04, 2.06, 3.14159, 4.999] }]);
    expect((out[0] as { b: number[] }).b).toEqual([1, 2.1, 3.1, 5]);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe("simplification", () => {
  test("a straight run collapses to its two ends", () => {
    const p: number[] = [];
    for (let i = 0; i <= 50; i++) p.push(i * 4, i * 4);
    expect(simplify(p)).toEqual([0, 0, 200, 200]);
  });

  test("the ends are always kept, and it never grows a stroke", () => {
    for (let i = 0; i < 500; i++) {
      const n = 2 + Math.floor(rnd() * 60);
      const p: number[] = [];
      for (let j = 0; j < n; j++) p.push(coord(), coord());
      const out = simplify(p);
      expect(out.length).toBeLessThanOrEqual(p.length);
      expect(out.slice(0, 2)).toEqual(p.slice(0, 2));
      expect(out.slice(-2)).toEqual(p.slice(-2));
    }
  });

  test("it is idempotent", () => {
    for (let i = 0; i < 300; i++) {
      const n = 3 + Math.floor(rnd() * 80);
      const p: number[] = [];
      for (let j = 0; j < n; j++) p.push(coord(), coord());
      const once = simplify(p);
      expect(simplify(once)).toEqual(once);
    }
  });

  test("nothing kept moves the line by more than the tolerance", () => {
    // the property RDP exists for: every point it DROPPED is within eps of the
    // polyline it kept, so the line a hand drew is the line it gets back
    for (let i = 0; i < 100; i++) {
      const p: number[] = [];
      let x = 0;
      let y = 0;
      for (let j = 0; j < 60; j++) {
        x += rnd() * 6;
        y += rnd() * 6 - 3;
        p.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
      }
      const out = simplify(p);
      for (let j = 0; j + 1 < p.length; j += 2) {
        let best = Infinity;
        for (let k = 0; k + 3 < out.length; k += 2) {
          best = Math.min(best, segDist(p[j], p[j + 1], out[k], out[k + 1], out[k + 2], out[k + 3]));
        }
        expect(best).toBeLessThanOrEqual(RDP_EPS + 1e-6);
      }
    }
  });

  test("a stroke of one or two points is left alone", () => {
    expect(simplify([4, 4])).toEqual([4, 4]);
    expect(simplify([4, 4, 8, 9])).toEqual([4, 4, 8, 9]);
  });
});

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

describe("the geometry, one slot", () => {
  test("the live walk and the committed path are the same string", () => {
    // the element appends ONE command per pointer event and `penPath` folds
    // the same three pieces over a finished array: if these ever disagree, a
    // stroke moves under the hand at the moment it is sealed
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(rnd() * 40);
      const p: number[] = [];
      for (let j = 0; j < n; j++) p.push(coord(), coord());
      let live = penHead(p[0], p[1]);
      for (let j = 1; j < n; j++) live += penSegment(p, j);
      expect(live + penTail(p)).toBe(penPath(p));
    }
  });

  test("a single point is a dot, not an empty path", () => {
    expect(penPath([12, 20])).toBe("M12 20l0 0");
    expect(penPath([])).toBe("");
  });

  test("every stroke is one mark, and only a label is not a path", () => {
    for (let i = 0; i < 200; i++) {
      const d = writeStrokes(drawing(1 + Math.floor(rnd() * 8)));
      const marks = marksOf(d);
      expect(marks.length).toBe(d.length);
      marks.forEach((m, j) => expect(m.el === "text").toBe(d[j].k === "text"));
    }
  });

  test("an arrow carries a head and nothing else does", () => {
    const marks = marksOf([
      { k: "arrow", c: 0, t: 2, b: [0, 0, 40, 40] },
      { k: "line", c: 0, t: 2, b: [0, 0, 40, 40] },
      { k: "rect", c: 0, t: 2, b: [0, 0, 40, 40] },
    ]);
    expect(marks.map((m) => m.el === "path" && m.head)).toEqual([true, false, false]);
    // and a round cap would poke through that head, so only the open,
    // headless kinds wear one
    expect(marks.map((m) => m.el === "path" && m.round)).toEqual([false, true, false]);
  });

  test("a rectangle and an ellipse close", () => {
    const [rect, oval] = marksOf([
      { k: "rect", c: 0, t: 1, b: [10, 20, 50, 60] },
      { k: "ellipse", c: 0, t: 1, b: [10, 20, 50, 60] },
    ]);
    expect(rect.el === "path" && rect.d.endsWith("Z")).toBe(true);
    expect(oval.el === "path" && oval.d.endsWith("Z")).toBe(true);
    // either corner first: dragging up-left describes the same rectangle
    expect(marksOf([{ k: "rect", c: 0, t: 1, b: [50, 60, 10, 20] }])[0]).toEqual(rect);
  });
});

describe("what the ink covers", () => {
  test("no ink is no box", () => {
    expect(bboxOf([])).toBeNull();
  });

  test("the box holds every point, and the stroke's own width", () => {
    const box = bboxOf([{ k: "pen", c: 0, t: 4, p: [10, 10, 50, 30] }]);
    expect(box).toEqual({ x: 8, y: 8, w: 44, h: 24 });
  });

  test("an arrowhead stands past the line's end and the box carries it", () => {
    const line = bboxOf([{ k: "line", c: 0, t: 2, b: [0, 0, 40, 0] }]);
    const arrow = bboxOf([{ k: "arrow", c: 0, t: 2, b: [0, 0, 40, 0] }]);
    expect((arrow as { w: number }).w).toBeGreaterThan((line as { w: number }).w);
  });

  test("a label's extent is read from its glyphs", () => {
    const one = bboxOf([{ k: "text", c: 0, s: TEXT_SIZE, at: [0, 20], v: "ab" }]);
    const many = bboxOf([{ k: "text", c: 0, s: TEXT_SIZE, at: [0, 20], v: "abcdefghij" }]);
    expect((many as { w: number }).w).toBeGreaterThan((one as { w: number }).w);
  });

  test("the box never falls short of the ink", () => {
    for (let i = 0; i < 500; i++) {
      const d = writeStrokes(drawing(1 + Math.floor(rnd() * 8)));
      const box = bboxOf(d);
      if (!box) continue;
      for (const s of d) {
        if (s.k === "pen") {
          for (let j = 0; j + 1 < s.p.length; j += 2) {
            expect(s.p[j]).toBeGreaterThanOrEqual(box.x);
            expect(s.p[j]).toBeLessThanOrEqual(box.x + box.w);
            expect(s.p[j + 1]).toBeGreaterThanOrEqual(box.y);
            expect(s.p[j + 1]).toBeLessThanOrEqual(box.y + box.h);
          }
        }
      }
    }
  });
});

describe("the export", () => {
  test("2x, and the long edge clamped where the vision tier stops paying", () => {
    // a 4-cell drawing at the 640 floor
    expect(pngSize({ w: 598, h: 192 })).toEqual({ w: 1196, h: 384, scale: PNG_SCALE });
    // the square worst case: clamped on both axes
    expect(pngSize({ w: 1000, h: 1000 })).toEqual({ w: PNG_LONG_EDGE, h: PNG_LONG_EDGE, scale: 1.568 });
    // a wide one clamps on its LONG edge and the short one follows
    const wide = pngSize({ w: 900, h: 100 });
    expect(wide.w).toBe(PNG_LONG_EDGE);
    expect(wide.h).toBe(174);
    expect(Math.max(wide.w, wide.h)).toBeLessThanOrEqual(PNG_LONG_EDGE);
  });

  test("no dimension is ever zero", () => {
    expect(pngSize({ w: 0, h: 0 })).toEqual({ w: 2, h: 2, scale: PNG_SCALE });
  });

  test("the exported SVG carries no custom property: they do not resolve in an image", () => {
    // the one gotcha that would otherwise cost a build round
    const svg = svgOf(writeStrokes(drawing(8)), { w: 300, h: 200 }, ["#112233", "#445566", "#778899"]);
    expect(svg).not.toContain("var(--");
    expect(svg).not.toContain("color-mix");
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
  });

  test("the head's marker is emitted only when something points", () => {
    const palette = ["#112233", "#445566", "#778899"];
    const plain = svgOf([{ k: "line", c: 0, t: 2, b: [0, 0, 9, 9] }], { w: 10, h: 10 }, palette);
    const pointed = svgOf([{ k: "arrow", c: 1, t: 2, b: [0, 0, 9, 9] }], { w: 10, h: 10 }, palette);
    expect(plain).not.toContain("<marker");
    expect(pointed).toContain("<marker");
    expect(pointed).toContain('marker-end="url(#h1)"');
    expect(pointed).toContain("#445566");
  });

  test("a label's own angle brackets stay a label", () => {
    const svg = svgOf([{ k: "text", c: 0, s: 13, at: [0, 10], v: '<script>&"' }], { w: 10, h: 10 }, ["#000"]);
    expect(svg).toContain("&lt;script&gt;&amp;&quot;");
    expect(svg).not.toContain("<script>");
  });
});

describe("the budget", () => {
  test("the pointer path is under 4 ms an event, over 1,000 of them", () => {
    // what the element actually does per pointermove: push two numbers and
    // append ONE command. Rebuilding the whole `d` string here would be
    // quadratic, which is the trap spec 6.5 names by number
    const p: number[] = [30, 30];
    let d = penHead(30, 30);
    let worst = 0;
    let total = 0;
    for (let i = 1; i <= 1000; i++) {
      const t0 = performance.now();
      p.push(30 + i * 0.7, 30 + Math.sin(i / 9) * 40);
      d += penSegment(p, p.length / 2 - 1);
      const dt = performance.now() - t0;
      total += dt;
      worst = Math.max(worst, dt);
    }
    expect(p.length).toBe(2002);
    expect(d.length).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(4);
    // the mean matters more than the worst on a loaded machine: a per-event
    // cost that GROWS with the stroke is the failure this test is here for
    expect(total / 1000).toBeLessThan(0.1);
  });

  test("the seal simplifies a 1,000-point stroke well under a frame", () => {
    const p: number[] = [];
    for (let i = 0; i < 1000; i++) p.push(i * 0.7, 30 + Math.sin(i / 9) * 40);
    const t0 = performance.now();
    const out = simplify(p);
    expect(performance.now() - t0).toBeLessThan(16);
    expect(out.length).toBeLessThan(p.length);
  });
});

// ---- the floor a sheet stands on -------------------------------------------
//
// The store turns these two into one rule (`minSpanFor`: a drawing's minimum
// is its strokes' bounds, so a corner or an arrow key stops at the ink and no
// stroke is ever cut off). What is asserted here is the composition, without
// a DOM: the store's own half is next door in canvas-grid.test.ts.

describe("the floor a sheet stands on", () => {
  const floorOf = (strokes: readonly Stroke[]) => {
    const box = bboxOf(strokes);
    return box ? { w: cellsForPx(box.x + box.w), h: cellsForPx(box.y + box.h) } : null;
  };

  test("no ink asks for no cells, and the kind's own 2 x 2 stands", () => {
    expect(floorOf([])).toBeNull();
  });

  test("ink inside three cells asks for three, and a pixel past asks for four", () => {
    // basePx(3) is 348 and basePx(4) is 468: the cells are counted against the
    // BASE cell, so a floor does not move when the window does
    const three = 3 * CELL_W_BASE + 2 * GUTTER;
    expect(floorOf([{ k: "line", c: 0, t: 0, b: [0, 0, three, three] }])).toEqual({ w: 3, h: 3 });
    expect(floorOf([{ k: "line", c: 0, t: 0, b: [0, 0, three + 1, three + 1] }])).toEqual({
      w: 4,
      h: 4,
    });
  });

  test("the floor counts the far edge of the ink, never its origin", () => {
    // a stroke drawn far right still needs the cells UNDER it: a shrink that
    // measured only the ink's width would cut the right of the sheet away
    const far = floorOf([{ k: "rect", c: 0, t: 2, b: [400, 20, 440, 60] }]);
    expect(far).toEqual({ w: 4, h: 1 });
  });
});
