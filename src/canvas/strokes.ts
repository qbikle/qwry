// The drawing's ink (C2b). Pure: no React, no store, no Tauri, and no DOM
// except inside `toPng`, which is the one function that needs a browser. The
// format, the geometry every renderer draws from, the pair that reads it back
// and the export. The element next door draws what this file describes.
//
// ABSOLUTE CSS PIXELS from the element's top-left, at one scale, always 1:1.
// Never normalized. A cell's width stretches with the container and its height
// does not (grid.ts), so a viewBox fitted to the box would come back 22% wider
// than tall at the floor and a circle drawn round would return an ellipse. At
// 1:1 there is no scale to get wrong: the pointer path is offsetX/offsetY with
// no transform, the export is a blit, and "a drawing never distorts" is free
// rather than tested. The cost is that a resize reveals or hides paper instead
// of stretching ink, which is what a drawing surface should do anyway; the
// element grows itself to hold what was drawn (`bboxOf`) and never shrinks
// under its own strokes.
//
// Flat number arrays, not {x,y} objects: a 240-point path is 480 numbers
// (~2.4 KB of JSON) against ~6 KB of objects, and the whole document is one
// debounced blob. Coordinates are rounded to 0.1px on the way out, which is
// ~40% smaller and invisible. LESSONS 2 is why the rounding is stated: these
// magnitudes round-trip float64 exactly, and NaN and Infinity are rejected at
// the door rather than stored.
//
// LESSONS 1: `writeStrokes` and `parseStrokes` were born together and are
// property-tested as a pair. `write` is the canonical form (rounded, clamped,
// capped); `parse` reads anything appdb can hold and drops only what it cannot
// read, so `parse(write(x))` is `write(x)` and both are idempotent.
//
// One geometry, one slot (DESIGN rule 14): `marksOf` turns strokes into SVG
// primitives, and the live element and the exported PNG both render THOSE.
// Everything but a text label is a path, so a rectangle, an ellipse and an
// arrow cannot drift into three renderers with three roundings.

/** a rect in the element's own pixels: [x1, y1, x2, y2], either corner first */
export type Box4 = [number, number, number, number];

/** one stroke. `c` is an index into the accent ladder and never a colour
 * literal, so a theme flip repaints a drawing and the chart beside it at once;
 * `t` is a step of the weight ladder */
export type Stroke =
  | { k: "pen"; c: number; t: number; p: number[] }
  | { k: "rect" | "ellipse" | "line" | "arrow"; c: number; t: number; b: Box4 }
  | { k: "text"; c: number; s: number; at: [number, number]; v: string };

/** the accent ladder, by name: three steps of one hue over the panel, defined
 * once in drawing.css so the values live in CSS and the export resolves them
 * off the live element rather than carrying a second copy of the numbers */
export const INK_VAR: readonly string[] = ["var(--ink-0)", "var(--ink-1)", "var(--ink-2)"];

/** stroke width: a hairline, a line and a marker. On the 4px grid's own
 * hairline allowance (DESIGN rule 4) */
export const WEIGHTS: readonly number[] = [1, 2, 4];

/** a text label's size: the body register, so a label reads as the app's own
 * words and not as a second typeface */
export const TEXT_SIZE = 13;

/** points in ONE pen stroke: about 40 KB of JSON at 0.1px rounding. Past it
 * the stroke seals itself and the cue says so; nothing is dropped */
export const PEN_POINTS_MAX = 4000;

/** serialized strokes per element. One element cannot dominate a document
 * that is written as one blob. Past it a NEW stroke is refused and the element
 * says so: the oldest strokes are never silently dropped */
export const ELEMENT_BYTES_MAX = 64 * 1024;

/** Ramer-Douglas-Peucker tolerance, under a CSS pixel: measured to cut a
 * freehand path 60-75% with no visible change */
export const RDP_EPS = 0.6;

/** the export's scale, and the long edge past which a larger image is thrown
 * away after being paid for (the vision tier resizes to 1568 and charges one
 * token per 28x28 patch) */
export const PNG_SCALE = 2;
export const PNG_LONG_EDGE = 1568;

/** the arrowhead, in multiples of the stroke's own width */
const HEAD_UNITS = 4;

/** a rect in element pixels */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---- the format on the wire (LESSONS 1: one pair, one test) ----------------

const r1 = (n: number): number => Math.round(n * 10) / 10;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  if (!finite(v)) return fallback;
  return Math.min(Math.max(Math.trunc(v), lo), hi);
};

/** the weight ladder's own step, never an arbitrary width: a hand-edited 3.7
 * becomes the nearest rung rather than a fourth weight nobody can draw again */
const rung = (v: unknown): number => {
  if (!finite(v)) return WEIGHTS[0];
  let best = WEIGHTS[0];
  for (const w of WEIGHTS) if (Math.abs(w - v) < Math.abs(best - v)) best = w;
  return best;
};

const ink = (v: unknown): number => clampInt(v, 0, INK_VAR.length - 1, 0);

const box4 = (v: unknown): Box4 | null => {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(finite)) return null;
  return [r1(v[0]), r1(v[1]), r1(v[2]), r1(v[3])];
};

/** the canonical form the document holds: rounded to 0.1px, every index on its
 * ladder, every pen stroke inside its point cap. Idempotent by construction */
export function writeStrokes(strokes: readonly Stroke[]): Stroke[] {
  const out: Stroke[] = [];
  for (const s of strokes) {
    if (s.k === "pen") {
      const p: number[] = [];
      const n = Math.min(s.p.length - (s.p.length % 2), PEN_POINTS_MAX * 2);
      for (let i = 0; i < n; i++) {
        if (!finite(s.p[i])) break;
        p.push(r1(s.p[i]));
      }
      const even = p.length - (p.length % 2);
      if (even >= 2) out.push({ k: "pen", c: ink(s.c), t: rung(s.t), p: p.slice(0, even) });
      continue;
    }
    if (s.k === "text") {
      const at = Array.isArray(s.at) && s.at.length === 2 && s.at.every(finite);
      const v = typeof s.v === "string" ? s.v : "";
      if (at && v.trim() !== "")
        out.push({ k: "text", c: ink(s.c), s: rung2(s.s), at: [r1(s.at[0]), r1(s.at[1])], v });
      continue;
    }
    const b = box4(s.b);
    if (b) out.push({ k: s.k, c: ink(s.c), t: rung(s.t), b });
  }
  return out;
}

/** a label's size: the body register, or a hand-edited number held to a range
 * that can still be read and still fits a 2-cell element */
const rung2 = (v: unknown): number => clampInt(v, 9, 32, TEXT_SIZE);

/** what appdb held, read back. Anything unreadable is DROPPED, never thrown:
 * `doc_json` is opaque and one bad stroke must not take a canvas down with it
 * (LESSONS 5). `parse(write(x))` deep-equals `write(x)` for every x */
export function parseStrokes(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return [];
  const out: Stroke[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Partial<Stroke> & { k?: string };
    if (s.k === "pen") {
      const src = (s as { p?: unknown }).p;
      if (!Array.isArray(src)) continue;
      const p: number[] = [];
      const n = Math.min(src.length - (src.length % 2), PEN_POINTS_MAX * 2);
      for (let i = 0; i < n; i++) {
        if (!finite(src[i])) break;
        p.push(r1(src[i]));
      }
      if (p.length >= 2) out.push({ k: "pen", c: ink(s.c), t: rung(s.t), p: p.slice(0, p.length - (p.length % 2)) });
      continue;
    }
    if (s.k === "text") {
      const at = (s as { at?: unknown }).at;
      const v = (s as { v?: unknown }).v;
      if (!Array.isArray(at) || at.length !== 2 || !at.every(finite)) continue;
      if (typeof v !== "string" || v.trim() === "") continue;
      out.push({ k: "text", c: ink(s.c), s: rung2((s as { s?: unknown }).s), at: [r1(at[0]), r1(at[1])], v });
      continue;
    }
    if (s.k === "rect" || s.k === "ellipse" || s.k === "line" || s.k === "arrow") {
      const b = box4((s as { b?: unknown }).b);
      if (b) out.push({ k: s.k, c: ink(s.c), t: rung(s.t), b });
    }
  }
  return out;
}

/** the bytes this ink costs the document. The cap is measured on what is
 * WRITTEN, so the number the element shows is the number appdb will hold */
export function strokeBytes(strokes: readonly Stroke[] | undefined): number {
  return JSON.stringify(writeStrokes(Array.isArray(strokes) ? strokes : [])).length;
}

/** no more ink fits. The refusal is on the NEXT stroke, never on the oldest
 * ones: a drawing that quietly forgot its first mark is a drawing nobody can
 * trust (LESSONS 9) */
export const inkFull = (strokes: readonly Stroke[] | undefined): boolean =>
  strokeBytes(strokes) >= ELEMENT_BYTES_MAX;

// ---- the pen's path, one segment at a time ---------------------------------
//
// A quadratic through the midpoints: each recorded point becomes a control
// point and the curve passes through the midpoint between it and the next, so
// a hand's jitter is smoothed without moving the line off the paper.
//
// Appending point n needs only points n-1 and n, so the live path is built
// segment by segment and a 4,000-point stroke costs the same per pointer event
// as a 3-point one (spec 6.5's budget). `penPath` is the same walk over a
// finished array, and a test asserts the two agree.

const n1 = (v: number): string => String(r1(v));

/** the first point: `M x y`, plus a zero-length line so a tap under the move
 * threshold is a dot and not nothing at all (round caps draw it) */
export const penHead = (x: number, y: number): string => `M${n1(x)} ${n1(y)}l0 0`;

/** the command point `i` adds, i >= 1. The first one runs to the midpoint, so
 * the curve that follows has somewhere to start */
export function penSegment(p: readonly number[], i: number): string {
  const x = p[i * 2];
  const y = p[i * 2 + 1];
  const px = p[i * 2 - 2];
  const py = p[i * 2 - 1];
  const mx = (px + x) / 2;
  const my = (py + y) / 2;
  if (i === 1) return `L${n1(mx)} ${n1(my)}`;
  return `Q${n1(px)} ${n1(py)} ${n1(mx)} ${n1(my)}`;
}

/** the seal: the last point itself, so a stroke ends where the finger left */
export function penTail(p: readonly number[]): string {
  const n = p.length / 2;
  if (n < 2) return "";
  return `L${n1(p[p.length - 2])} ${n1(p[p.length - 1])}`;
}

/** a finished pen stroke, the same walk `penHead` + `penSegment` + `penTail`
 * builds live */
export function penPath(p: readonly number[]): string {
  const n = Math.floor(p.length / 2);
  if (n === 0) return "";
  let d = penHead(p[0], p[1]);
  for (let i = 1; i < n; i++) d += penSegment(p, i);
  return d + penTail(p);
}

// ---- the shapes ------------------------------------------------------------

const rectOf = (b: Box4): Box => ({
  x: Math.min(b[0], b[2]),
  y: Math.min(b[1], b[3]),
  w: Math.abs(b[2] - b[0]),
  h: Math.abs(b[3] - b[1]),
});

/** a rectangle as a path, so every mark but a label is one primitive */
function rectPath(b: Box4): string {
  const r = rectOf(b);
  return `M${n1(r.x)} ${n1(r.y)}h${n1(r.w)}v${n1(r.h)}h${n1(-r.w)}Z`;
}

/** an ellipse as two arcs: the same primitive, and the same rounding */
function ellipsePath(b: Box4): string {
  const r = rectOf(b);
  const rx = r.w / 2;
  const ry = r.h / 2;
  const cy = r.y + ry;
  const left = r.x;
  const right = r.x + r.w;
  return `M${n1(left)} ${n1(cy)}A${n1(rx)} ${n1(ry)} 0 1 0 ${n1(right)} ${n1(cy)}A${n1(rx)} ${n1(ry)} 0 1 0 ${n1(left)} ${n1(cy)}Z`;
}

const linePath = (b: Box4): string => `M${n1(b[0])} ${n1(b[1])}L${n1(b[2])} ${n1(b[3])}`;

/** one SVG primitive. The live element renders these and so does the export,
 * so the picture on the page and the picture the model reads are one geometry
 * (DESIGN rule 14) */
export type Mark =
  | { el: "path"; d: string; c: number; t: number; round: boolean; head: boolean }
  | { el: "text"; x: number; y: number; c: number; s: number; v: string };

/** the strokes, as the two things a renderer can draw */
export function marksOf(strokes: readonly Stroke[] | undefined): Mark[] {
  const out: Mark[] = [];
  if (!Array.isArray(strokes)) return out;
  for (const s of strokes) {
    if (s.k === "pen") {
      out.push({ el: "path", d: penPath(s.p), c: s.c, t: s.t, round: true, head: false });
      continue;
    }
    if (s.k === "text") {
      out.push({ el: "text", x: s.at[0], y: s.at[1], c: s.c, s: s.s, v: s.v });
      continue;
    }
    const d = s.k === "rect" ? rectPath(s.b) : s.k === "ellipse" ? ellipsePath(s.b) : linePath(s.b);
    // a round cap on an arrow would poke through its own head, and a closed
    // shape has no cap to speak of: the round one is the pen's and the line's
    out.push({ el: "path", d, c: s.c, t: s.t, round: s.k === "line", head: s.k === "arrow" });
  }
  return out;
}

// ---- what the ink covers ---------------------------------------------------

/** a label's own extent, estimated from its glyph count: the store has no DOM
 * and a measured string would re-measure on every width for a two-pixel gain
 * (the chart's own rule for its labels) */
const TEXT_ADV = 0.55;
const TEXT_ASCENT = 0.8;
const TEXT_DESCENT = 0.25;

/** the box the ink stands in, or null when there is none. What an element
 * cannot shrink under, and what the export draws */
export function bboxOf(strokes: readonly Stroke[] | undefined): Box | null {
  // `doc_json` is opaque and a block a later version wrote may carry no
  // strokes at all: empty is the honest reading, and a throw here took a
  // whole connection's canvas list down with it (the store's own rowsOf rule,
  // LESSONS 5)
  if (!Array.isArray(strokes)) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number, pad: number) => {
    x0 = Math.min(x0, x - pad);
    y0 = Math.min(y0, y - pad);
    x1 = Math.max(x1, x + pad);
    y1 = Math.max(y1, y + pad);
  };
  for (const s of strokes) {
    if (s.k === "pen") {
      const pad = s.t / 2;
      for (let i = 0; i + 1 < s.p.length; i += 2) grow(s.p[i], s.p[i + 1], pad);
      continue;
    }
    if (s.k === "text") {
      const w = s.v.length * s.s * TEXT_ADV;
      grow(s.at[0], s.at[1] - s.s * TEXT_ASCENT, 0);
      grow(s.at[0] + w, s.at[1] + s.s * TEXT_DESCENT, 0);
      continue;
    }
    // an arrowhead stands past the line's own end, so the pad carries it
    const pad = s.k === "arrow" ? (s.t * HEAD_UNITS) / 2 + s.t / 2 : s.t / 2;
    grow(s.b[0], s.b[1], pad);
    grow(s.b[2], s.b[3], pad);
  }
  if (x0 === Infinity) return null;
  return { x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0) };
}

// ---- the export ------------------------------------------------------------

/** the PNG's pixels: 2x, with the long edge clamped so nothing is paid for and
 * thrown away. A 4-cell drawing at the floor (598 x 192) exports 1196 x 384,
 * which is 43 x 14 patches; the square worst case at the clamp is 56 x 56 */
export function pngSize(box: { w: number; h: number }): { w: number; h: number; scale: number } {
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const scale = Math.min(PNG_SCALE, PNG_LONG_EDGE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** one standalone SVG document, every colour a literal. CSS custom properties
 * do NOT resolve inside an SVG loaded as an image (`var(--accent)` renders as
 * nothing), which is the one gotcha that would otherwise cost a build round,
 * so the ladder is resolved off the live element before this is called and no
 * external reference of any kind is emitted: the canvas is never tainted */
export function svgOf(
  strokes: readonly Stroke[],
  box: { w: number; h: number },
  palette: readonly string[],
  background?: string,
): string {
  const colour = (c: number) => palette[Math.min(c, palette.length - 1)] ?? palette[0] ?? "#000";
  const marks = marksOf(strokes);
  const heads = new Set(marks.filter((m) => m.el === "path" && m.head).map((m) => (m as { c: number }).c));
  const defs =
    heads.size === 0
      ? ""
      : `<defs>${[...heads]
          .map(
            (c) =>
              `<marker id="h${c}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="${HEAD_UNITS}" markerHeight="${HEAD_UNITS}" markerUnits="strokeWidth" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="${esc(colour(c))}"/></marker>`,
          )
          .join("")}</defs>`;
  const body = marks
    .map((m) =>
      m.el === "text"
        ? `<text x="${m.x}" y="${m.y}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="${m.s}" fill="${esc(colour(m.c))}">${esc(m.v)}</text>`
        : `<path d="${m.d}" fill="none" stroke="${esc(colour(m.c))}" stroke-width="${m.t}" stroke-linejoin="round"${m.round ? ' stroke-linecap="round"' : ""}${m.head ? ` marker-end="url(#h${m.c})"` : ""}/>`,
    )
    .join("");
  const fill = background ? `<rect width="${box.w}" height="${box.h}" fill="${esc(background)}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}">${defs}${fill}${body}</svg>`;
}

/** the node a probe can stand in and inherit the ladder: the ladder is defined
 * on the element's own box, and a probe appended INSIDE an `<svg>` is a
 * foreign node the browser lays out nowhere. So the walk goes up to the first
 * HTML element, which is that box whether the caller handed us the sheet or
 * the block around it */
function probeHost(host: Element): HTMLElement | null {
  const view = host.ownerDocument.defaultView;
  if (!view) return null;
  let node: Element | null = host;
  while (node && !(node instanceof view.HTMLElement)) node = node.parentElement;
  return (node as HTMLElement | null) ?? host.ownerDocument.body;
}

/** one resolved colour, read the only way a custom property can be read: a
 * custom property reads BACK as its own text (`color-mix(in srgb, …)`), and
 * what an exported SVG needs is the literal, so the value goes through a
 * probe's COMPUTED colour */
function resolve(node: HTMLElement, value: string, fallback: string): string {
  const doc = node.ownerDocument;
  const probe = doc.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.color = value;
  node.appendChild(probe);
  const out = doc.defaultView?.getComputedStyle(probe).color ?? fallback;
  probe.remove();
  return out;
}

/** the accent ladder as literal colours, resolved off a live node */
export function inkPalette(host: Element): string[] {
  const node = probeHost(host);
  if (!node) return INK_VAR.map(() => "#000");
  return INK_VAR.map((v) => resolve(node, v, "#000"));
}

/** and the paper under it, for an export that has to stand somewhere: the
 * sheet itself is TRANSPARENT wherever there is ink (nothing frames an element
 * at rest), so a PNG made from its computed background would be ink on
 * nothing, which half the themes render invisible */
export function paperColour(host: Element): string {
  const node = probeHost(host);
  return node ? resolve(node, "var(--bg-panel)", "#fff") : "#fff";
}

/** the element's ink as a PNG: an offscreen SVG drawn into a canvas at 2x,
 * clamped. No external reference, so nothing taints it */
export async function toPng(
  strokes: readonly Stroke[],
  box: { w: number; h: number },
  palette: readonly string[],
  background?: string,
): Promise<Blob> {
  const size = pngSize(box);
  const svg = svgOf(strokes, box, palette, background);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  img.width = size.w;
  img.height = size.h;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("the drawing could not be rendered"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("the drawing could not be rendered");
  ctx.drawImage(img, 0, 0, size.w, size.h);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the drawing could not be rendered"))), "image/png");
  });
}

// ---- simplification --------------------------------------------------------

const distSq = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len;
  t = Math.min(1, Math.max(0, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
};

/** Ramer-Douglas-Peucker over a flat array, iteratively: a 4,000-point stroke
 * must not recurse 4,000 deep. Idempotent, so a stroke simplified twice is the
 * stroke simplified once */
export function simplify(p: readonly number[], eps = RDP_EPS): number[] {
  const n = Math.floor(p.length / 2);
  if (n < 3) return [...p].slice(0, n * 2);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol = eps * eps;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distSq(p[i * 2], p[i * 2 + 1], p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at !== -1 && worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    if (keep[i] === 1) {
      out.push(p[i * 2], p[i * 2 + 1]);
    }
  return out;
}
