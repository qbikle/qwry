// The select tool's math (F3). PURE: no React, no store, no DOM, no tokens,
// no CSS. What a hand does to a stroke it has already drawn, as arithmetic
// the element next door only dispatches to.
//
// It is its own file for the reason `strokes.ts` is: a gesture is easy to get
// wrong in ways a screenshot cannot show (a corner that drifts a pixel a
// frame, a rotated shape that resizes about the wrong point, a marquee that
// misses a turned ellipse), and every one of those is a number two lines of
// a test can hold still. `Drawing.tsx` holds the pointer, the snapshot and
// the undo stack; everything between a pointer's down and its up is here.
//
// Coordinates are the sheet's own pixels, 1:1, the same absolute pixels a
// stroke is stored in (strokes.ts). There is no second frame and no scale.
//
// TWO FRAMES ONLY, and the difference is the whole file. A stroke's LOCAL box
// is the box it was drawn in; its WORLD box is where that box stands once its
// own angle is applied. A hit test turns the POINTER backwards into the local
// frame rather than turning the shape forwards; a corner drag scales the local
// box and then puts the corner the hand is holding back where it stood in the
// world; a marquee and a group's own box read world boxes, because a group has
// no angle of its own to read them in.
//
// Every function here RETURNS a new stroke and mutates nothing, and returns
// the stroke it was handed, by identity, whenever it has nothing to do. That
// is what lets `changed` be an identity walk instead of a deep compare of two
// 4,000-point paths, what lets a refused drag hold its last good frame, and
// what keeps an untouched stroke's `Ink` memo (Drawing.tsx) from re-rendering
// because the stroke beside it moved.

import {
  centreOf,
  hullOf,
  normBox,
  rotatePt,
  segDist,
  textBox,
  type Box4,
  type Stroke,
} from "./strokes";

/** the selection's chrome stands this far outside the ink, so a 1px box never
 * sits ON the stroke it is describing */
export const PAD = 4;

/** a corner handle, square. The hover box is the SAME box the selection will
 * draw (`overlayOf` answers both), so a click never nudges it a pixel */
export const HANDLE = 8;

/** the knob's stem, and the knob. The knob's own centre stands `KNOB_GAP`
 * above the box's top edge: the stem's length, the knob's radius and the 1px
 * it stands off the stem's end */
export const STEM = 16;
export const KNOB = 5;
export const KNOB_GAP = 22;

/** a click lands on a line within this many pixels of it, plus half the
 * stroke's own width: a hairline is as easy to hit as a marker */
export const HIT_TOL = 6;

/** and within this far of a closed shape's or a label's own box */
export const BOX_TOL = 4;

/** the knob with a shift held: 15 degrees */
export const SNAP = Math.PI / 12;

/** a corner drag stops here rather than collapsing a shape to a line nobody
 * can grab a handle on again */
export const MIN_SCALE = 0.05;

/** a label never scales under this: at 8px it is no longer a label */
export const TEXT_MIN = 8;

export type Corner = "nw" | "ne" | "se" | "sw";
export type Handle = Corner | "rot";
export type Vec = readonly [number, number];

type Label = Extract<Stroke, { k: "text" }>;

/** the corner a drag holds STILL: the one across the box from the one it has
 * hold of */
const OPPOSITE: Record<Corner, Corner> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

/** draw order, and the order `overlayOf` hands the handles back in */
const CORNERS: readonly Corner[] = ["nw", "ne", "se", "sw"];

const cornerOf = (b: Box4, at: Corner): Vec => [
  at === "nw" || at === "sw" ? b[0] : b[2],
  at === "nw" || at === "ne" ? b[1] : b[3],
];

// ---- what a stroke covers ---------------------------------------------------

/** the angle a stroke carries, or none. A pen path, a line and an arrow bake
 * every turn into their own coordinates, so their answer is always 0 */
export const angleOf = (s: Stroke): number =>
  s.k === "rect" || s.k === "ellipse" || s.k === "text" ? (s.r ?? 0) : 0;

/** the stroke's OWN box, before its angle: the frame a corner drag works in
 * and the box a single selection draws (turned with it) */
export function localBox(s: Stroke): Box4 {
  if (s.k === "pen") {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < s.p.length; i += 2) {
      x0 = Math.min(x0, s.p[i]);
      x1 = Math.max(x1, s.p[i]);
      y0 = Math.min(y0, s.p[i + 1]);
      y1 = Math.max(y1, s.p[i + 1]);
    }
    // `doc_json` is opaque and a pen stroke with no readable point at all is
    // a shape a later version could hand us: a box of Infinities poisons
    // every number downstream of it, so the empty case is a point at the
    // origin and the drag that follows is a no-op (LESSONS 5)
    return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
  }
  if (s.k === "text") return textBox(s);
  return normBox(s.b);
}

/** where that box actually stands: axis-aligned, angle applied. What a group's
 * own box, a marquee and a hover all read */
export function worldBox(s: Stroke): Box4 {
  const b = localBox(s);
  const r = angleOf(s);
  return r === 0 ? b : hullOf(b, r);
}

/** the box a set of strokes stands in, or null when the set is empty */
export function unionBox(strokes: readonly Stroke[], ids: Iterable<number>): Box4 | null {
  let u: Box4 | null = null;
  for (const i of ids) {
    const s = strokes[i];
    if (!s) continue;
    const b = worldBox(s);
    u = u ? [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])] : b;
  }
  return u;
}

// ---- what a click lands on ---------------------------------------------------

/** is this point on this stroke? An open kind is measured to its own
 * SEGMENTS, so the inside of a big loose scribble is not a target the way its
 * line is; a closed kind and a label are measured to their box, because what
 * a hand means by clicking inside a rectangle is the rectangle.
 *
 * A turned stroke turns the POINT backwards instead of turning itself
 * forwards: one rotation of one point against four corners and a whole path */
export function hit(s: Stroke, x: number, y: number): boolean {
  const b = localBox(s);
  const r = angleOf(s);
  const [cx, cy] = centreOf(b);
  const [px, py] = r === 0 ? [x, y] : rotatePt(x, y, cx, cy, -r);
  if (s.k === "pen") {
    const tol = HIT_TOL + s.t / 2;
    for (let i = 0; i + 3 < s.p.length; i += 2)
      if (segDist(px, py, s.p[i], s.p[i + 1], s.p[i + 2], s.p[i + 3]) <= tol) return true;
    // a tap is a dot, and a dot has no segment to measure against
    return s.p.length === 2 && Math.hypot(px - s.p[0], py - s.p[1]) <= tol;
  }
  if (s.k === "line" || s.k === "arrow") {
    return segDist(px, py, s.b[0], s.b[1], s.b[2], s.b[3]) <= HIT_TOL + s.t / 2;
  }
  if (s.k === "ellipse") {
    const rx = (b[2] - b[0]) / 2 + BOX_TOL;
    const ry = (b[3] - b[1]) / 2 + BOX_TOL;
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return px >= b[0] - BOX_TOL && px <= b[2] + BOX_TOL && py >= b[1] - BOX_TOL && py <= b[3] + BOX_TOL;
}

/** the TOPMOST stroke under a point, or -1: the last one drawn is the one on
 * top, and the one a click means */
export function hitAt(strokes: readonly Stroke[], x: number, y: number): number {
  for (let i = strokes.length - 1; i >= 0; i--) if (hit(strokes[i], x, y)) return i;
  return -1;
}

/** every stroke a marquee crosses, in document order. A WORLD box, so a turned
 * ellipse is caught by where it stands and not by where it was drawn; boxes
 * that merely touch count, which is what a drag over the edge of something
 * reads as */
export function marqueeHits(strokes: readonly Stroke[], m: Box4): number[] {
  const q = normBox(m);
  const out: number[] = [];
  strokes.forEach((s, i) => {
    const b = worldBox(s);
    if (b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1]) out.push(i);
  });
  return out;
}

// ---- what a drag does to one stroke -------------------------------------------

export function translate(s: Stroke, dx: number, dy: number): Stroke {
  if (dx === 0 && dy === 0) return s;
  if (s.k === "pen") {
    const p = s.p.slice();
    for (let i = 0; i + 1 < p.length; i += 2) {
      p[i] += dx;
      p[i + 1] += dy;
    }
    return { ...s, p };
  }
  if (s.k === "text") {
    const at: [number, number] = [s.at[0] + dx, s.at[1] + dy];
    return { ...s, at };
  }
  const b: Box4 = [s.b[0] + dx, s.b[1] + dy, s.b[2] + dx, s.b[3] + dy];
  return { ...s, b };
}

/** a stroke turned about a point that is not its own centre. The three kinds
 * with a frame carry the angle and travel; the three made of coordinates BAKE
 * it, which is why a pen stroke rotated and rotated back is not quite the path
 * it started as and a rectangle is */
export function rotateAbout(s: Stroke, cx: number, cy: number, da: number): Stroke {
  if (da === 0) return s;
  // the kinds that CARRY the angle first, by a positive test: a union member
  // whose own `k` is two literals cannot be narrowed away by a negative one,
  // so `rect | ellipse` has to be asked for rather than ruled out
  if (s.k === "rect" || s.k === "ellipse" || s.k === "text") {
    const [ox, oy] = centreOf(localBox(s));
    const [nx, ny] = rotatePt(ox, oy, cx, cy, da);
    const dx = nx - ox;
    const dy = ny - oy;
    const r = (s.r ?? 0) + da;
    if (s.k === "text") {
      const at: [number, number] = [s.at[0] + dx, s.at[1] + dy];
      return { ...s, at, r };
    }
    const b: Box4 = [s.b[0] + dx, s.b[1] + dy, s.b[2] + dx, s.b[3] + dy];
    return { ...s, b, r };
  }
  if (s.k === "pen") {
    const p = s.p.slice();
    for (let i = 0; i + 1 < p.length; i += 2) {
      const [x, y] = rotatePt(p[i], p[i + 1], cx, cy, da);
      p[i] = x;
      p[i + 1] = y;
    }
    return { ...s, p };
  }
  const [x0, y0] = rotatePt(s.b[0], s.b[1], cx, cy, da);
  const [x1, y1] = rotatePt(s.b[2], s.b[3], cx, cy, da);
  const b: Box4 = [x0, y0, x1, y1];
  return { ...s, b };
}

/** a stroke scaled about a fixed point, in whatever frame the caller is
 * working in. This is the GROUP's own resize: a turned member keeps its angle
 * and its centre travels, which is exact while the two factors agree and a
 * fair approximation when they do not (a rectangle turned 30 degrees and
 * stretched on one axis is no longer a rectangle, and nothing short of a
 * second shape kind can make it one) */
export function scaleAbout(s: Stroke, fx: number, fy: number, sx: number, sy: number): Stroke {
  if (sx === 1 && sy === 1) return s;
  const at = (x: number, y: number): [number, number] => [fx + (x - fx) * sx, fy + (y - fy) * sy];
  if (s.k === "pen") {
    const p = s.p.slice();
    for (let i = 0; i + 1 < p.length; i += 2) {
      const [x, y] = at(p[i], p[i + 1]);
      p[i] = x;
      p[i + 1] = y;
    }
    return { ...s, p };
  }
  if (s.k === "line" || s.k === "arrow") {
    const [x0, y0] = at(s.b[0], s.b[1]);
    const [x1, y1] = at(s.b[2], s.b[3]);
    const b: Box4 = [x0, y0, x1, y1];
    return { ...s, b };
  }
  if (s.k === "text") {
    // a label has one number for its size and two for its scale, so it takes
    // the geometric mean: a box dragged twice as wide and half as tall leaves
    // the words the size they were
    const seat = at(s.at[0], s.at[1]);
    return { ...s, at: seat, s: Math.max(TEXT_MIN, s.s * Math.sqrt(Math.abs(sx * sy))) };
  }
  const box = normBox(s.b);
  const [cx, cy] = centreOf(box);
  const [ncx, ncy] = at(cx, cy);
  const w = (box[2] - box[0]) * Math.abs(sx);
  const h = (box[3] - box[1]) * Math.abs(sy);
  const b: Box4 = [ncx - w / 2, ncy - h / 2, ncx + w / 2, ncy + h / 2];
  return { ...s, b };
}

// ---- a corner drag -------------------------------------------------------------

export interface Scale {
  /** the corner the drag holds still, in the BOX's own frame */
  fixed: Vec;
  sx: number;
  sy: number;
}

/** what a corner drag asks of a box, in that box's own frame. `r` turns the
 * pointer backwards first, so a turned shape's `se` handle pulls along the
 * shape's own diagonal and not the screen's.
 *
 * null when the drag would collapse the shape past `MIN_SCALE`: the caller
 * keeps its last good frame rather than watching a rectangle become a line it
 * can no longer grab. An axis the box has NO extent on (a perfectly flat line,
 * a one-point pen tap) is HELD at 1 rather than divided by: a fallback of 1
 * in that divisor reads the whole drag as the scale and throws the stroke off
 * the page by a factor of hundreds */
export function resizeScale(
  box: Box4,
  at: Corner,
  from: Vec,
  to: Vec,
  ratio: boolean,
  r = 0,
): Scale | null {
  const [cx, cy] = centreOf(box);
  const now = r === 0 ? to : rotatePt(to[0], to[1], cx, cy, -r);
  const then = r === 0 ? from : rotatePt(from[0], from[1], cx, cy, -r);
  const fixed = cornerOf(box, OPPOSITE[at]);
  const held = cornerOf(box, at);
  const dx = held[0] - fixed[0];
  const dy = held[1] - fixed[1];
  let sx = dx === 0 ? 1 : (held[0] + (now[0] - then[0]) - fixed[0]) / dx;
  let sy = dy === 0 ? 1 : (held[1] + (now[1] - then[1]) - fixed[1]) / dy;
  if (ratio) {
    const u = Math.max(dx === 0 ? 0 : Math.abs(sx), dy === 0 ? 0 : Math.abs(sy));
    if (u > 0) {
      if (dx !== 0) sx = sx < 0 ? -u : u;
      if (dy !== 0) sy = sy < 0 ? -u : u;
    }
  }
  if (Math.abs(sx) < MIN_SCALE || Math.abs(sy) < MIN_SCALE) return null;
  return { fixed, sx, sy };
}

/** a label under a corner drag. Its extent is a function of its SIZE and its
 * glyph count, never of the box a hand drew, so the size takes the drag's
 * geometric mean and the box is then rebuilt AROUND the corner being held.
 * Without that the label's own box would grow by the font's ratio while the
 * hand pulled at the drag's, and the corner under the finger would crawl */
function labelResize(s: Label, lb: Box4, sc: Scale): Stroke {
  const size = Math.max(TEXT_MIN, s.s * Math.sqrt(Math.abs(sc.sx * sc.sy)));
  const grown: Label = { ...s, s: size };
  const nb = localBox(grown);
  // which side of the fixed corner the box stands on now: the far edge under
  // the drag's own factors, which flips when the factor does
  const far = (lo: number, hi: number, f: number, k: number): number => {
    const a = f + (lo - f) * k;
    const b = f + (hi - f) * k;
    return Math.abs(a - f) >= Math.abs(b - f) ? a : b;
  };
  const x0 = far(lb[0], lb[2], sc.fixed[0], sc.sx) < sc.fixed[0] ? sc.fixed[0] - (nb[2] - nb[0]) : sc.fixed[0];
  const y0 = far(lb[1], lb[3], sc.fixed[1], sc.sy) < sc.fixed[1] ? sc.fixed[1] - (nb[3] - nb[1]) : sc.fixed[1];
  const at: [number, number] = [x0, y0 + grown.at[1] - nb[1]];
  return { ...grown, at };
}

/** ONE stroke under a corner drag, turned or not, in its own frame.
 *
 * The local box scales about the fixed corner, and then the whole stroke moves
 * so that corner sits exactly where it stood in the WORLD. That second step is
 * the difference between a turned shape growing out of the corner a hand is
 * holding and a turned shape swinging around its own drifting centre; with no
 * angle it is arithmetic that cancels, which is why there is one path here and
 * not two.
 *
 * Returns the stroke ITSELF when the drag would collapse it */
export function resizeOne(s: Stroke, at: Corner, from: Vec, to: Vec, ratio: boolean): Stroke {
  const lb = localBox(s);
  const r = angleOf(s);
  const sc = resizeScale(lb, at, from, to, ratio, r);
  if (!sc) return s;
  const next =
    s.k === "text" ? labelResize(s, lb, sc) : scaleAbout(s, sc.fixed[0], sc.fixed[1], sc.sx, sc.sy);
  if (r === 0) return next;
  const [ocx, ocy] = centreOf(lb);
  const [ncx, ncy] = centreOf(localBox(next));
  const was = rotatePt(sc.fixed[0], sc.fixed[1], ocx, ocy, r);
  const drifted = rotatePt(sc.fixed[0], sc.fixed[1], ncx, ncy, r);
  return translate(next, was[0] - drifted[0], was[1] - drifted[1]);
}

// ---- a gesture over the whole selection ----------------------------------------
//
// Three calls, one per gesture, each taking the SNAPSHOT the gesture started
// from: the element re-applies the whole gesture from that snapshot on every
// pointer event, so a drag of 300 frames is 300 pure applications and one
// commit, never 300 increments compounding their own rounding.

const overSel = (
  strokes: readonly Stroke[],
  ids: ReadonlySet<number>,
  fn: (s: Stroke) => Stroke,
): Stroke[] => strokes.map((s, i) => (ids.has(i) ? fn(s) : s));

/** the selection dragged by a hand, or nudged by an arrow key */
export const moveSel = (
  strokes: readonly Stroke[],
  ids: ReadonlySet<number>,
  dx: number,
  dy: number,
): Stroke[] => overSel(strokes, ids, (s) => translate(s, dx, dy));

/** the selection turned about a point, the knob's own gesture. `snap` is the
 * shift key: the DELTA lands on 15 degrees, so a group and a single shape
 * answer the key the same way and a shape already standing at an angle turns
 * by a round amount rather than jumping to one */
export function rotateSel(
  strokes: readonly Stroke[],
  ids: ReadonlySet<number>,
  cx: number,
  cy: number,
  da: number,
  snap: boolean,
): Stroke[] {
  const turn = snap ? Math.round(da / SNAP) * SNAP : da;
  return overSel(strokes, ids, (s) => rotateAbout(s, cx, cy, turn));
}

/** the selection under a corner drag: ONE stroke resizes in its own frame, a
 * group scales about the fixed corner of its union box. The box the drag works
 * against is read from the snapshot, so it is the box as it stood when the
 * finger went down and not as it stands mid-drag */
export function resizeSel(
  strokes: readonly Stroke[],
  ids: ReadonlySet<number>,
  at: Corner,
  from: Vec,
  to: Vec,
  ratio: boolean,
): Stroke[] {
  const list = [...ids].filter((i) => strokes[i]);
  if (list.length === 1) {
    const only = list[0];
    return strokes.map((s, i) => (i === only ? resizeOne(s, at, from, to, ratio) : s));
  }
  const box = unionBox(strokes, list);
  if (!box) return strokes.slice();
  const sc = resizeScale(box, at, from, to, ratio, 0);
  if (!sc) return strokes.slice();
  return overSel(strokes, new Set(list), (s) => scaleAbout(s, sc.fixed[0], sc.fixed[1], sc.sx, sc.sy));
}

/** did a gesture actually move anything? Every helper above hands back the
 * stroke it was given when it has nothing to do, so this is an identity walk
 * and not a deep compare of two 4,000-point paths */
export const changed = (a: readonly Stroke[], b: readonly Stroke[]): boolean =>
  a.length !== b.length || a.some((s, i) => s !== b[i]);

// ---- what the sheet draws over it ------------------------------------------------

export interface Overlay {
  /** the box the chrome stands on, already PAD outside the selection's own
   * bounds: a single stroke's own box, which TURNS with it, or a group's union
   * box, which never does */
  box: Box4;
  /** radians, and the point every part of this overlay turns about. A group is
   * always 0: a set of strokes at three angles has no angle of its own */
  r: number;
  cx: number;
  cy: number;
  /** centres, in draw order. The sheet draws each as a HANDLE-wide square */
  handles: readonly { at: Corner; x: number; y: number }[];
  stem: { x: number; y0: number; y1: number };
  knob: { x: number; y: number };
}

/** the selection's chrome as data. The sheet renders it inside one `<g>`
 * carrying `rotate(r cx cy)`, so the handles turn with the shape and every
 * number below stays in the box's own frame.
 *
 * The same call answers a HOVER, rendered as the box alone: the faint box a
 * pointer raises is exactly the box a click will land, so nothing shifts under
 * the finger at the moment of selecting (rule 14, one geometry) */
export function overlayOf(strokes: readonly Stroke[], ids: Iterable<number>): Overlay | null {
  const list = [...ids].filter((i) => strokes[i]);
  if (list.length === 0) return null;
  const one = list.length === 1 ? strokes[list[0]] : null;
  const inner = one ? localBox(one) : (unionBox(strokes, list) as Box4);
  const box: Box4 = [inner[0] - PAD, inner[1] - PAD, inner[2] + PAD, inner[3] + PAD];
  const [cx, cy] = centreOf(box);
  return {
    box,
    r: one ? angleOf(one) : 0,
    cx,
    cy,
    handles: CORNERS.map((at) => {
      const [x, y] = cornerOf(box, at);
      return { at, x, y };
    }),
    stem: { x: cx, y0: box[1], y1: box[1] - STEM },
    knob: { x: cx, y: box[1] - KNOB_GAP },
  };
}

/** which handle a point is on, or null. The point is in the SHEET's own pixels
 * and the overlay may be turned, so it is turned back first; the knob answers
 * before the corners, because it is the one piece of chrome that stands
 * outside the box */
export function handleAt(ov: Overlay, x: number, y: number): Handle | null {
  const [px, py] = ov.r === 0 ? [x, y] : rotatePt(x, y, ov.cx, ov.cy, -ov.r);
  if (Math.hypot(px - ov.knob.x, py - ov.knob.y) <= KNOB) return "rot";
  for (const h of ov.handles)
    if (Math.abs(px - h.x) <= HANDLE / 2 && Math.abs(py - h.y) <= HANDLE / 2) return h.at;
  return null;
}
