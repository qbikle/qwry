// The drawing (C2b): the canvas's third species and the only one made of ink.
// A note is what a person writes; a drawing is what they draw beside it, and
// a chart annotated with an arrow and three words is the thing this whole
// wave exists for.
//
// SVG, not <canvas>. The viewBox follows the box so a resize loses nothing,
// where resizing a backing store WIPES it and the ResizeObserver fires after
// the frame's rAF draw (the exact bug ZenScreen names); it is crisp at any DPR
// for free; `var(--ink-0)` resolves in the document, so a theme flip repaints
// the ink with no re-read; hit testing and a real element tree come with it.
// Its one cost is the live path's `d` string, and that cost is paid by
// appending ONE command per pointer event instead of rebuilding the string
// (strokes.ts penSegment), so a 4,000-point stroke costs the same per event as
// a three-point one.
//
// Strokes are ABSOLUTE element pixels at 1:1 and never normalized: a cell's
// width stretches and its height does not, so a fitted viewBox would hand back
// an ellipse where a circle was drawn. A resize therefore reveals or hides
// paper rather than stretching ink, which is what a drawing surface should do;
// the element's own floor grows with the ink (the store's `minSpanFor`), so a
// corner or an arrow key stops at the strokes' bounds and nothing is ever cut
// off, and a commit that outgrew the frame grows the frame through the SAME
// `resize` every gesture uses.
//
// Chrome at rest: 0 controls and 0 strings, like the two kinds beside it, and
// ONE surface, the sheet's own paper. C2b painted that paper only while the
// sheet was empty; D1 paints it always, because a stroke and a corner glyph
// standing on the page with nothing around them is an element whose edges a
// reader cannot find, which is what the ghost in the maintainer's screenshot
// was. The tools stand in the island at the paper's top-left (F3,
// ToolIsland.tsx): one button at rest, the armed tool, and the roster in
// reach; the cluster at the top-right is the same six actions every kind
// carries less what the others have no use for (Grip · Undo · Redo · Copy ·
// Ask · More). Both ride the block's own reveal register and both leave while
// a stroke is in the air (F1). C2b seated the tools in the cluster as one
// `Pen ▾` slot and its menu; the island is that menu standing where the tools
// are used (AGENT-UX 16x).
//
// A gesture commits ONCE, when the finger lifts: the pointer handler writes to
// a ref and to one path's `d` attribute, and the document hears about the
// stroke on pointerup, in one setDoc, on the 400 ms debounce every other write
// on this page takes. Undo and redo are the element's own and bounded at 100:
// a history that rode `doc_json` would be persisted for ever and would be the
// largest thing in the blob, so the stack dies with the unmount, which is
// stated here rather than discovered.
//
// A press ARMS the sheet (F1). `preventDefault` on pointerdown is what keeps a
// stroke from selecting the page, and it cancels the focus change with it, so
// the focus is taken by hand: without it the chords were dead after every
// stroke a pointer made, and the cluster, whose reveal C2b had carved down to
// `:focus-within`, was reachable only by pressing a button nothing had drawn.
// The two halves of that are one line each here and one rule each in
// drawing.css. While the stroke is in the air the block wears `data-inking`,
// written straight onto the node like the live path's own `d`: it is the
// element's only state between the down and the up, a render here would be the
// one thing this file promises not to do, and an attribute is what a
// stylesheet, a fixture and a probe can all read.
//
// The SELECT tool (F3, AGENT-UX 16jj) is the one gesture that DOES render
// between the down and the up, because what it moves is committed ink and the
// marks and the selection's own box have to travel together. Its math is
// select.ts's, pure and tested without this file; what stands here is the
// dispatch (a press on the knob rotates, on a corner resizes, on a stroke
// moves, on paper draws a marquee), the snapshot every frame re-applies its
// delta to, and the ONE commit on release. The overlay is drawn inside the
// sheet's own SVG with `pointer-events: none`, so the pointer always lands on
// the sheet and `handleAt` decides what it hit: a handle the eye cannot find
// never takes a press it should not (LESSONS 18).

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Copy, Ellipsis, Redo, Undo } from "lucide-react";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import { Kbd } from "../design/Kbd";
import { copyCue, copyCueShow } from "../lib/copyCue";
import { kindTools, toolForKey, type BlockTool, type DrawTool } from "./blockTools";
import {
  HANDLE,
  KNOB,
  changed,
  handleAt,
  hitAt,
  marqueeHits,
  moveSel,
  overlayOf,
  resizeSel,
  rotateSel,
  type Corner,
  type Vec,
} from "./select";
import {
  ELEMENT_BYTES_MAX,
  INK_VAR,
  PEN_POINTS_MAX,
  TEXT_LINE,
  TEXT_SIZE,
  WEIGHTS,
  inkFull,
  inkPalette,
  marksOf,
  penHead,
  penSegment,
  simplify,
  svgOf,
  textBox,
  textLines,
  textRows,
  type Box4,
  type Mark,
  type Stroke,
} from "./strokes";
import { SHAPES, ToolIsland, useIslandProximity, type Shape } from "./ToolIsland";
import { minSpanFor, useCanvas, type DrawingBlock } from "../stores/canvas";
import "../ask/ask.css";
import "./drawing.css";

/** the undo history, bounded. It lives in the ELEMENT and not in the document:
 * every entry is a whole stroke array, and a history in `doc_json` would be
 * persisted per element for ever and would be the largest thing in the blob */
const UNDO_MAX = 100;

/** a press travels this far before a shape exists, so a click on the sheet
 * that meant to arm a tool does not leave a zero-width rectangle behind (the
 * page's own click-versus-drag threshold) */
const THRESHOLD = 4;

/** points closer together than this add nothing a reader can see and cost the
 * document two numbers each */
const POINT_MIN = 1;

/** an arrow key moves the selection this far, and this far with shift held */
const NUDGE = 1;
const NUDGE_SHIFT = 10;

/** the block wears this for exactly as long as a stroke is in the air, and
 * drawing.css reads it to take the cluster, the corner handle and the island
 * off the paper (F1, F3). Named here because the handler that writes it and
 * the test that proves it must not spell it twice */
export const INKING = "data-inking";

/** what a press on the paper does before any ink: the sheet takes focus, so
 * the tool chords and ⌘Z answer a hand's stroke and not only a `↩` from the
 * keyboard, and the block goes into the stroke. `preventScroll` because this
 * page is a scroller and a programmatic focus that scrolls it moves the paper
 * out from under the pen (LESSONS 7) */
export function armSheet(
  sheet: { focus: (options?: { preventScroll?: boolean }) => void } | null,
  block: { toggleAttribute: (name: string, force?: boolean) => unknown } | null,
): void {
  sheet?.focus({ preventScroll: true });
  block?.toggleAttribute(INKING, true);
}

/** and the lift, the cancel and the Esc, which are one thing to the page: the
 * stroke is no longer in the air. Focus stays where it is, because the hand
 * that drew is the hand that will press `r` next */
export function restSheet(block: { toggleAttribute: (name: string, force?: boolean) => unknown } | null): void {
  block?.toggleAttribute(INKING, false);
}

/** what a screen reader hears on the sheet: a drawing is a graphic, and the
 * one honest thing to say about it is how much ink is on it */
export const inkSaid = (strokes: readonly Stroke[]): string =>
  strokes.length === 0
    ? "Empty sheet"
    : `Drawing, ${strokes.length} ${strokes.length === 1 ? "stroke" : "strokes"}`;

/** the cap, said on the element. A drawing that quietly stopped taking ink is
 * a drawing that reads as broken (LESSONS 9), so the number is printed rather
 * than implied, and the OLDEST strokes are never the ones that go */
export const fullSaid = (): string => `Full at ${Math.round(ELEMENT_BYTES_MAX / 1024)} KB`;

// ---- the select tool's seams (F3) --------------------------------------------
//
// Pure, exported, and tested without a DOM (f3drawing.test.ts): what a key or
// a press on the sheet MEANS, decided apart from the handler that acts on it,
// the same device `armSheet` is for the ink path.

/** what one key on the focused sheet asks for. `null` is a key the sheet does
 * not own, which bubbles whole (LESSONS 10) */
export type SheetKey =
  | { do: "leave" }
  | { do: "clear" }
  | { do: "undo" }
  | { do: "redo" }
  | { do: "selectAll" }
  | { do: "delete" }
  | { do: "nudge"; dx: number; dy: number }
  | { do: "arm"; tool: DrawTool }
  | null;

export function sheetKeyAction(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  ctx: { tool: DrawTool; selected: boolean },
): SheetKey {
  const chord = e.metaKey || e.ctrlKey;
  // Esc clears a standing selection first and stops there; pressed again, or
  // with nothing selected, it leaves the sheet (16jj)
  if (e.key === "Escape") return ctx.selected ? { do: "clear" } : { do: "leave" };
  if (chord && e.key.toLowerCase() === "z") return e.shiftKey ? { do: "redo" } : { do: "undo" };
  // ⌘A is the select tool's own: with a pen armed the chord is the window's
  if (chord && e.key.toLowerCase() === "a" && ctx.tool === "select") return { do: "selectAll" };
  if (chord || e.altKey) return null;
  if (e.key === "Backspace" || e.key === "Delete") return ctx.selected ? { do: "delete" } : null;
  if (ctx.selected && e.key.startsWith("Arrow")) {
    const d = e.shiftKey ? NUDGE_SHIFT : NUDGE;
    const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
    const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
    return dx === 0 && dy === 0 ? null : { do: "nudge", dx, dy };
  }
  const armed = toolForKey(e.key);
  return armed ? { do: "arm", tool: armed } : null;
}

/** one gesture of the select tool, held from the down to the up */
export type SelGesture =
  | { kind: "move"; from: Vec }
  | { kind: "rotate"; from: Vec; cx: number; cy: number; a0: number }
  | { kind: "resize"; from: Vec; handle: Corner }
  | { kind: "marquee"; from: Vec; keep: ReadonlySet<number> };

/** what a press on the sheet with `select` armed starts, and the selection it
 * leaves standing. The knob and the corners answer first, because they are the
 * one piece of chrome that stands outside the ink; then the topmost stroke
 * under the point; then paper, which starts a marquee and clears the selection
 * unless shift holds it (16jj) */
export function selectPress(
  strokes: readonly Stroke[],
  sel: ReadonlySet<number>,
  x: number,
  y: number,
  shift: boolean,
): { gesture: SelGesture; sel: ReadonlySet<number> } {
  const from: Vec = [x, y];
  const ov = overlayOf(strokes, sel);
  const h = ov ? handleAt(ov, x, y) : null;
  if (ov && h === "rot") return { gesture: { kind: "rotate", from, cx: ov.cx, cy: ov.cy, a0: Math.atan2(y - ov.cy, x - ov.cx) }, sel };
  if (ov && h !== null && h !== "rot") return { gesture: { kind: "resize", from, handle: h }, sel };
  const i = hitAt(strokes, x, y);
  if (i >= 0) {
    // a press on something already selected keeps the whole selection, so a
    // group can be dragged by any of its members
    const next = sel.has(i) ? sel : shift ? new Set([...sel, i]) : new Set([i]);
    return { gesture: { kind: "move", from }, sel: next };
  }
  const keep: ReadonlySet<number> = shift ? sel : new Set();
  return { gesture: { kind: "marquee", from, keep }, sel: keep };
}

/** the selection under a gesture's current point, re-applied to the SNAPSHOT
 * the gesture started from (select.ts's own rule: one delta, never a chain of
 * increments). A marquee moves nothing and answers null */
export function selectDrag(
  g: SelGesture,
  snap: readonly Stroke[],
  sel: ReadonlySet<number>,
  x: number,
  y: number,
  shift: boolean,
): Stroke[] | null {
  if (g.kind === "move") return moveSel(snap, sel, x - g.from[0], y - g.from[1]);
  if (g.kind === "rotate") return rotateSel(snap, sel, g.cx, g.cy, Math.atan2(y - g.cy, x - g.cx) - g.a0, shift);
  if (g.kind === "resize") return resizeSel(snap, sel, g.handle, g.from, [x, y], shift);
  return null;
}

/** the selection restyled from the island's Ink or Weight arm: every selected
 * stroke whose kind carries the field takes it, and a label, which has a size
 * and no stroke width, is left alone by a weight (16jj) */
export function restyleSel(
  strokes: readonly Stroke[],
  sel: ReadonlySet<number>,
  patch: { c: number } | { t: number },
): Stroke[] {
  return strokes.map((s, i) => {
    if (!sel.has(i)) return s;
    if ("c" in patch) return s.c === patch.c ? s : { ...s, c: patch.c };
    if (s.k === "text") return s;
    return s.t === patch.t ? s : { ...s, t: patch.t };
  });
}

/** the label a double-click with `select` armed opens, or -1 */
export const labelAt = (strokes: readonly Stroke[], x: number, y: number): number => {
  const i = hitAt(strokes, x, y);
  return i >= 0 && strokes[i].k === "text" ? i : -1;
};

/** the cursor the sheet wears under a point with `select` armed: the knob's
 * grab, a corner's diagonal, `move` over a stroke, the sheet's own otherwise.
 * The overlay takes no pointer, so this is decided by the same math that
 * decides what a press would do (rule 14: one geometry) */
export type SheetCursor = "grab" | "grabbing" | "nwse" | "nesw" | "move" | null;

export function cursorAt(strokes: readonly Stroke[], sel: ReadonlySet<number>, x: number, y: number): SheetCursor {
  const ov = overlayOf(strokes, sel);
  const h = ov ? handleAt(ov, x, y) : null;
  if (h === "rot") return "grab";
  if (h === "nw" || h === "se") return "nwse";
  if (h) return "nesw";
  return hitAt(strokes, x, y) >= 0 ? "move" : null;
}

const EMPTY: ReadonlySet<number> = new Set();

/** what a landed mark leaves armed: Select, Excalidraw's own rule and the
 * maintainer's (2026-09-18). A shape, a line, an arrow or a label is ONE
 * thing a hand places and then wants to move; a pen stroke is one of many, so
 * the pen is the exception and stays armed, and so does the eraser. It rides
 * the commit's own write rather than a second one: a gesture is one setDoc */
const BACK = { tool: "select" } as const;

/** the editor's own width, off the one metric the committed label will be
 * measured by (strokes.ts textBox), so the words do not shift on ↩. A caret
 * needs somewhere to stand before the first letter is typed, which is the
 * floor */
const LABEL_MIN_W = 24;
const labelWidth = (label: { x: number; y: number; s: number; v: string }): number => {
  const box = textBox({ at: [label.x, label.y], s: label.s, v: label.v });
  return Math.max(LABEL_MIN_W, Math.ceil(box[2] - box[0]) + label.s);
};

const isShape = (tool: DrawTool): tool is Shape => (SHAPES as readonly string[]).includes(tool);

/** one committed stroke. Its own component so a page of them re-renders only
 * the one that changed, and memoised on the mark itself. A turned stroke's
 * angle rides `mark.rot`, the one `rotate()` string strokes.ts builds for the
 * live element and the export alike (rule 14) */
const Ink = memo(function Ink({ mark, head, doomed }: { mark: Mark; head: string; doomed?: boolean }) {
  const dim = doomed ? "dw-doomed" : undefined;
  if (mark.el === "text") {
    // one <tspan> per line, at the rows strokes.ts measures the box by, so the
    // words, their box and the editor's own textarea agree (rule 14)
    return (
      <text className={dim} fontSize={mark.s} fill={INK_VAR[mark.c]} transform={mark.rot}>
        {textRows(mark).map((row, i) => (
          <tspan key={i} x={row.x} y={row.y}>
            {row.v}
          </tspan>
        ))}
      </text>
    );
  }
  return (
    <path
      className={dim}
      d={mark.d}
      fill="none"
      stroke={INK_VAR[mark.c]}
      strokeWidth={mark.t}
      strokeLinejoin="round"
      strokeLinecap={mark.round ? "round" : "butt"}
      markerEnd={mark.head ? `url(#${head}${mark.c})` : undefined}
      transform={mark.rot}
    />
  );
});

/** the in-flight stroke, as the pointer handler holds it. A ref, never state:
 * this element renders nothing between pointerdown and pointerup */
/** the tools a drag MAKES a stroke with: not `text` (a label is an editor the
 * page opens), not `select` and not `eraser` (those two act on ink that is
 * already there) */
type MarkTool = Exclude<DrawTool, "text" | "select" | "eraser">;

interface Live {
  tool: MarkTool;
  x0: number;
  y0: number;
  p: number[];
  d: string;
  moved: boolean;
  sealed: boolean;
}

/** a label being typed: a fresh one at the press, or, from a double-click
 * with `select` armed, the words an existing stroke already carries
 * (`existing` is its index, -1 for a new one) */
interface Label {
  x: number;
  y: number;
  v: string;
  s: number;
  existing: number;
}

export interface DrawingProps {
  block: DrawingBlock;
  canvasId: string;
  /** the cells the element stands on: a commit that outgrew them grows them */
  cell: { w: number; h: number };
  /** the cluster's first action, handed in by the surface that can move this
   * block. Absent anywhere the drawing cannot be moved */
  lead?: ReactNode;
  /** Ask, handed in ONLY when the chosen model reads images. Absent is the
   * whole enforcement: a capability that does not exist has no button
   * (DESIGN rule 2's matrix), and no sentence explains the gap */
  ask?: ReactNode;
  /** the confirm, when there was one, has already been answered */
  onDelete: () => void;
}

export function Drawing({ block, canvasId, cell, lead, ask, onDelete }: DrawingProps) {
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<SVGSVGElement>(null);
  const live = useRef<SVGPathElement>(null);
  const held = useRef<Live | null>(null);
  const past = useRef<Stroke[][]>([]);
  const future = useRef<Stroke[][]>([]);
  const [depth, setDepth] = useState({ past: 0, future: 0 });
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState<Label | null>(null);
  const heads = useId().replace(/:/g, "");

  const strokes = block.strokes;
  const tool = block.tool ?? "pen";
  const ink = block.ink ?? 0;
  const weight = block.weight ?? WEIGHTS[0];

  // ---- the select tool's state ---------------------------------------------
  //
  // The selection is a transient Set of indexes, never a saved entity (16jj);
  // `preview` is the strokes as the gesture in flight has displaced them, so
  // the marks and the overlay move together and the document hears nothing
  // until the release
  const [sel, setSel] = useState<ReadonlySet<number>>(EMPTY);
  const [hover, setHover] = useState(-1);
  const [preview, setPreview] = useState<Stroke[] | null>(null);
  const [marquee, setMarquee] = useState<Box4 | null>(null);
  // what the eraser has touched and has not yet taken: dimmed while the
  // finger is down, gone on the lift (F3)
  const [doomed, setDoomed] = useState<ReadonlySet<number>>(EMPTY);
  const [cursor, setCursor] = useState<SheetCursor>(null);
  const gesture = useRef<{ g: SelGesture; snap: Stroke[]; sel: ReadonlySet<number>; last: Stroke[] | null } | null>(null);

  // ---- the island's ---------------------------------------------------------
  const islandRef = useRef<HTMLDivElement>(null);
  const [islandOpen, setIslandOpen] = useState(false);
  const [shape, setShape] = useState<Shape>(() => (isShape(tool) ? tool : "rect"));
  const prox = useIslandProximity(islandRef, islandOpen, setIslandOpen, () => root.current?.hasAttribute(INKING) ?? false);

  const shown = preview ?? strokes;
  // both read the WHOLE stroke array, and this element re-renders on a menu
  // opening and on an undo stack changing depth: memoised on the strokes, so a
  // press on `More` does not re-serialize a 64 KB drawing to ask whether it is
  // full. The marks are cached PER STROKE by identity, so a drag that moves two
  // of forty rebuilds two marks and `Ink`'s memo holds the other thirty-eight
  const full = useMemo(() => inkFull(strokes), [strokes]);
  const markOf = useRef(new WeakMap<Stroke, Mark>());
  const marks = useMemo(
    () =>
      shown.map((s) => {
        const hit = markOf.current.get(s);
        if (hit) return hit;
        const mark = marksOf([s])[0];
        markOf.current.set(s, mark);
        return mark;
      }),
    [shown],
  );

  // a selection outlives the strokes it named only as far as they still
  // exist: an undo, a model's write or a clear may shorten the array under it
  useEffect(() => {
    if ([...sel].some((i) => i >= strokes.length)) setSel(new Set([...sel].filter((i) => i < strokes.length)));
    if (hover >= strokes.length) setHover(-1);
  }, [strokes.length, sel, hover]);

  /** every write the element makes. ONE setDoc, at the end of a gesture, and
   * the frame grows through the same `resize` a corner drag uses, so what a
   * commit displaces is displaced by the one rule (grid.ts) */
  const commit = useCallback(
    (next: Stroke[], remember: boolean, also?: { tool?: DrawTool }) => {
      const store = useCanvas.getState();
      if (remember) {
        past.current = [...past.current, strokes].slice(-UNDO_MAX);
        future.current = [];
        setDepth({ past: past.current.length, future: 0 });
      }
      store.updateDrawing(canvasId, block.id, { strokes: next, ...also });
      // the ink may have outgrown the frame. What it needs is the store's own
      // floor for this block (a drawing's floor IS its strokes' bounds), so
      // the arithmetic is not restated here, and the second write happens only
      // when the element actually grew: a stroke inside the frame is one
      // setDoc, exactly like every other gesture on this page
      const grown = minSpanFor({ id: block.id, kind: "drawing", strokes: next });
      if (grown.w > cell.w || grown.h > cell.h)
        store.resizeTo(canvasId, block.id, grown, store.columnsOf(canvasId), { auto: true });
    },
    [block.id, canvasId, cell.h, cell.w, strokes],
  );

  const setMemory = useCallback(
    (next: { ink?: number; weight?: number; tool?: DrawTool }) =>
      useCanvas.getState().updateDrawing(canvasId, block.id, next),
    [block.id, canvasId],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [...future.current, strokes].slice(-UNDO_MAX);
    setDepth({ past: past.current.length, future: future.current.length });
    commit(prev, false);
  }, [commit, strokes]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current = [...past.current, strokes].slice(-UNDO_MAX);
    setDepth({ past: past.current.length, future: future.current.length });
    commit(next, false);
  }, [commit, strokes]);

  const clearSelection = () => {
    setSel(EMPTY);
    setHover(-1);
  };

  /** arming a tool, from the island or a chord: a shape is remembered for the
   * Shapes slot's face, and every tool but `select` drops the selection, since
   * the next press is a mark and not a hold */
  const arm = (next: DrawTool) => {
    if (isShape(next)) setShape(next);
    setMemory({ tool: next });
    if (next !== "select") clearSelection();
    setCursor(null);
  };

  // ---- the pointer -------------------------------------------------------

  const point = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = sheet.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  const paint = (d: string) => live.current?.setAttribute("d", d);

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    // the island folds the instant a press lands on paper, no grace (16x)
    prox.close();
    const at = point(e);
    if (tool === "text") {
      e.preventDefault();
      setLabel({ x: at.x, y: at.y, v: "", s: TEXT_SIZE, existing: -1 });
      return;
    }
    if (tool === "select") {
      onSelectDown(e, at);
      return;
    }
    if (tool === "eraser") {
      onEraseDown(e, at);
      return;
    }
    if (full) {
      copyCueShow(fullSaid());
      // no stroke to hold, and the press still arms the sheet: what a hand
      // does next on paper that is full is ⌘Z, and that chord lives here
      armSheet(e.currentTarget, null);
      return;
    }
    const node = e.currentTarget;
    e.preventDefault();
    armSheet(node, root.current);
    node.setPointerCapture(e.pointerId);
    held.current = { tool, x0: at.x, y0: at.y, p: [at.x, at.y], d: penHead(at.x, at.y), moved: false, sealed: false };
    // the in-flight stroke is the stroke it will become: an arrow grows its
    // head as it is drawn and wears no round cap to poke through it
    const path = live.current;
    if (path) {
      path.setAttribute("stroke-linecap", tool === "arrow" ? "butt" : "round");
      if (tool === "arrow") path.setAttribute("marker-end", `url(#${heads}${ink})`);
      else path.removeAttribute("marker-end");
    }
    paint(held.current.d);

    const onMove = (ev: PointerEvent) => {
      const g = held.current;
      if (!g || g.sealed) return;
      const to = point(ev);
      if (!g.moved && Math.hypot(to.x - g.x0, to.y - g.y0) > THRESHOLD) g.moved = true;
      if (g.tool === "pen") {
        const lx = g.p[g.p.length - 2];
        const ly = g.p[g.p.length - 1];
        if (Math.hypot(to.x - lx, to.y - ly) < POINT_MIN) return;
        g.p.push(to.x, to.y);
        g.d += penSegment(g.p, g.p.length / 2 - 1);
        paint(g.d);
        // a stroke that reached its cap SEALS rather than dropping its head:
        // the finger keeps moving, the ink stops, and the cue says which
        if (g.p.length >= PEN_POINTS_MAX * 2) {
          g.sealed = true;
          copyCueShow(`Stroke full at ${PEN_POINTS_MAX.toLocaleString("en-US")} points`);
        }
        return;
      }
      g.p = [g.x0, g.y0, to.x, to.y];
      g.d = shapePath(g.tool, g.p);
      paint(g.d);
    };
    const done = (cancel: boolean) => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
      node.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("keydown", onKey, true);
      const g = held.current;
      held.current = null;
      paint("");
      restSheet(root.current);
      if (cancel || !g) return;
      seal(g);
    };
    const onUp = () => done(false);
    const onCancel = () => done(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      done(true);
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onCancel);
    node.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  /** the stroke, as the document takes it. A pen path is RDP-simplified here
   * and nowhere else, so the live path is never the simplified one and a hand
   * never sees its own line move under it */
  const seal = (g: Live) => {
    if (g.tool === "pen") {
      const p = simplify(g.p);
      if (p.length < 2) return;
      commit([...strokes, { k: "pen", c: ink, t: weight, p }], true);
      return;
    }
    if (!g.moved) return;
    commit([...strokes, { k: g.tool, c: ink, t: weight, b: [g.p[0], g.p[1], g.p[2], g.p[3]] }], true, BACK);
  };

  // ---- the eraser's gesture (F3) -------------------------------------------

  /** a press and a drag that takes ink away: every stroke the pointer touches
   * dims as it is touched and goes on release, as ONE step of the element's
   * own history. The dimming is state and not an attribute, because what it
   * changes is the marks themselves; the block wears `data-inking` for the
   * length of it exactly as an ink stroke does, so the chrome leaves the way
   * it leaves for a pen */
  const onEraseDown = (e: ReactPointerEvent<SVGSVGElement>, at: { x: number; y: number }) => {
    const node = e.currentTarget;
    e.preventDefault();
    armSheet(node, root.current);
    node.setPointerCapture(e.pointerId);
    const hits = new Set<number>();
    const touch = (x: number, y: number) => {
      const i = hitAt(strokes, x, y);
      if (i < 0 || hits.has(i)) return;
      hits.add(i);
      setDoomed(new Set(hits));
    };
    touch(at.x, at.y);

    const onMove = (ev: PointerEvent) => {
      const to = point(ev);
      touch(to.x, to.y);
    };
    const done = (cancel: boolean) => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
      node.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("keydown", onKey, true);
      restSheet(root.current);
      setDoomed(EMPTY);
      if (cancel || hits.size === 0) return;
      commit(strokes.filter((_, i) => !hits.has(i)), true);
    };
    const onUp = () => done(false);
    const onCancel = () => done(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      done(true);
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onCancel);
    node.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  // ---- the select tool's gesture (F3) ---------------------------------------

  const onSelectDown = (e: ReactPointerEvent<SVGSVGElement>, at: { x: number; y: number }) => {
    const node = e.currentTarget;
    // the same preventDefault the ink path needs (a drag must not select the
    // page) with the same focus taken by hand behind it (LESSONS 18), but no
    // `data-inking`: nothing is in the air, the chrome stays
    e.preventDefault();
    armSheet(node, null);
    node.setPointerCapture(e.pointerId);
    const press = selectPress(strokes, sel, at.x, at.y, e.shiftKey);
    if (press.sel !== sel) setSel(press.sel);
    setHover(-1);
    if (press.gesture.kind === "marquee") setMarquee([at.x, at.y, at.x, at.y]);
    setCursor(press.gesture.kind === "rotate" ? "grabbing" : press.gesture.kind === "marquee" ? null : cursor);
    gesture.current = { g: press.gesture, snap: strokes, sel: press.sel, last: null };

    const onMove = (ev: PointerEvent) => {
      const held = gesture.current;
      if (!held) return;
      const to = point(ev);
      if (held.g.kind === "marquee") {
        const m: Box4 = [held.g.from[0], held.g.from[1], to.x, to.y];
        setMarquee(m);
        // live, as the drag continues, never only on release (16jj)
        setSel(new Set([...held.g.keep, ...marqueeHits(strokes, m)]));
        return;
      }
      const next = selectDrag(held.g, held.snap, held.sel, to.x, to.y, ev.shiftKey);
      if (!next) return;
      held.last = next;
      setPreview(next);
    };
    const done = (cancel: boolean) => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
      node.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("keydown", onKey, true);
      const held = gesture.current;
      gesture.current = null;
      setMarquee(null);
      setPreview(null);
      setCursor(null);
      if (!held || cancel || held.g.kind === "marquee") return;
      // ONE commit per gesture, and none for a press that moved nothing:
      // `changed` is an identity walk, since every helper hands back the
      // stroke it was given when it had nothing to do
      const next = held.last;
      if (next && changed(held.snap, next)) commit(next, true);
    };
    const onUp = () => done(false);
    const onCancel = () => done(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      done(true);
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onCancel);
    node.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  /** a pointer over the sheet with nothing held: the hover box and the cursor
   * are the answer to "what would a press here do", read off the same math
   * that will answer the press */
  const onSheetMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (tool !== "select" || gesture.current) return;
    const at = point(e);
    const over = hitAt(strokes, at.x, at.y);
    const under = over >= 0 && !sel.has(over) ? over : -1;
    if (under !== hover) setHover(under);
    const next = cursorAt(strokes, sel, at.x, at.y);
    if (next !== cursor) setCursor(next);
  };

  const onSheetLeave = () => {
    if (gesture.current) return;
    if (hover !== -1) setHover(-1);
    if (cursor !== null) setCursor(null);
  };

  /** a double-click on a label with `select` armed opens it for editing in
   * place, seeded with its own words and committing back into its own index
   * rather than appending (16jj) */
  const onSheetDouble = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (tool !== "select") return;
    const at = point(e);
    const i = labelAt(strokes, at.x, at.y);
    if (i < 0) return;
    const s = strokes[i];
    if (s.k !== "text") return;
    e.preventDefault();
    clearSelection();
    setLabel({ x: s.at[0], y: s.at[1], v: s.v, s: s.s, existing: i });
  };

  // ---- the keyboard ------------------------------------------------------

  const onSheetKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const act = sheetKeyAction(e, { tool, selected: sel.size > 0 });
    // the element swallows only the keys it owns (LESSONS 10): a letter that
    // arms no tool, ⌫ with nothing selected, and every modifier chord but the
    // ones above, bubble whole
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    switch (act.do) {
      case "leave":
        (sheet.current?.closest(".blk") as HTMLElement | null)?.focus();
        return;
      case "clear":
        clearSelection();
        return;
      case "undo":
        undo();
        return;
      case "redo":
        redo();
        return;
      case "selectAll":
        setSel(new Set(strokes.map((_, i) => i)));
        setHover(-1);
        return;
      case "delete":
        commit(strokes.filter((_, i) => !sel.has(i)), true);
        clearSelection();
        return;
      case "nudge":
        // one commit per press, never per pixel (16jj): a held key is many
        // presses and many steps, which is what a hand tapping it expects
        commit(moveSel(strokes, sel, act.dx, act.dy), true);
        return;
      case "arm":
        arm(act.tool);
        return;
    }
  };

  // ---- what the island carries (F3) ----------------------------------------

  /** the first selected stroke's ink and weight, which the island's two
   * property slots wear while a selection stands (a pick then restyles it
   * rather than arming the next stroke); a label carries no weight */
  const first = [...sel].map((i) => strokes[i]).filter(Boolean);
  const selectionInk = first[0]?.c;
  const selectionWeight = first.find((s) => s.k !== "text")?.t;

  const onInk = (next: number) => {
    if (sel.size === 0) {
      setMemory({ ink: next });
      return;
    }
    const restyled = restyleSel(strokes, sel, { c: next });
    if (changed(strokes, restyled)) commit(restyled, true);
  };

  const onWeight = (next: number) => {
    if (sel.size === 0) {
      setMemory({ weight: next });
      return;
    }
    const restyled = restyleSel(strokes, sel, { t: next });
    if (changed(strokes, restyled)) commit(restyled, true);
  };

  // ---- what the cluster carries -------------------------------------------

  /** the SVG the clipboard takes and the menu's own copy: the element's ink at
   * its own size, every colour resolved to a literal, which is what makes it
   * legible outside a document that defines `--accent` */
  const markup = () => {
    const node = sheet.current;
    if (!node) return "";
    return svgOf(strokes, { w: node.clientWidth, h: node.clientHeight }, inkPalette(node));
  };

  const clear = async () => {
    const { confirmDanger } = await import("../stores/danger");
    const n = strokes.length;
    if (await confirmDanger("Clear Drawing?", `${n} ${n === 1 ? "stroke" : "strokes"}`, "Clear")) {
      clearSelection();
      commit([], true);
    }
  };

  const remove = async () => {
    if (strokes.length === 0) {
      onDelete();
      return;
    }
    const { confirmDanger } = await import("../stores/danger");
    const name = drawnName(block);
    if (await confirmDanger("Delete Drawing?", name, "Delete Drawing")) onDelete();
  };

  const menu: MenuNode[] = [
    // strokes have no way back, so the ellipsis and the confirm (WRITING rule
    // 2). With nothing on the sheet there is nothing to clear: the row stands
    // disabled rather than absent, so the action stays discoverable
    { kind: "item", label: "Clear…", disabled: strokes.length === 0, onSelect: () => void clear() },
    { kind: "sep" },
    {
      kind: "item",
      label: "Delete…",
      hint: <Kbd chord="delete" />,
      danger: true,
      onSelect: () => void remove(),
    },
  ];

  const tools: Partial<Record<BlockTool, ReactNode>> = {
    grip: lead,
    // Undo and Redo hold their slots whether or not there is anything to take
    // back: a cluster that changes shape as a stack fills is a cluster whose
    // width nobody can design for (DESIGN rule 13)
    undo: (
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Undo"
        aria-label="Undo"
        disabled={depth.past === 0}
        onClick={undo}
      >
        <Undo size={12} />
      </button>
    ),
    redo: (
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Redo"
        aria-label="Redo"
        disabled={depth.future === 0}
        onClick={redo}
      >
        <Redo size={12} />
      </button>
    ),
    copy: (
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Copy"
        aria-label="Copy"
        onClick={() => void copyCue(markup(), "Copied drawing")}
      >
        <Copy size={12} />
      </button>
    ),
    ask,
    more: (
      <button
        type="button"
        className={`iconbtn iconbtn-sm${menuAt ? " active" : ""}`}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.right, y: r.bottom + 4 });
        }}
      >
        <Ellipsis size={12} />
      </button>
    ),
  };

  const commitLabel = () => {
    const at = label;
    setLabel(null);
    if (!at) return;
    const v = at.v.trim();
    if (at.existing >= 0) {
      const was = strokes[at.existing];
      if (!was || was.k !== "text") return;
      // words taken away are a label taken away, said as one step the hand
      // can take back rather than a stroke the writer would drop unseen
      if (v === "") {
        commit(strokes.filter((_, i) => i !== at.existing), true);
        return;
      }
      if (v !== was.v) commit(strokes.map((s, i) => (i === at.existing ? { ...s, v } : s)), true);
      return;
    }
    if (v === "") return;
    if (full) {
      copyCueShow(fullSaid());
      return;
    }
    commit([...strokes, { k: "text", c: ink, s: TEXT_SIZE, at: [at.x, at.y], v }], true, BACK);
  };

  // the selection's chrome, from the strokes as the gesture has them: a single
  // stroke's own box turned with it, a group's union box upright (16jj)
  const overlay = sel.size > 0 ? overlayOf(shown, sel) : null;
  const hovered = hover >= 0 && !gesture.current && !sel.has(hover) ? overlayOf(strokes, [hover]) : null;
  const turned = (r: number, cx: number, cy: number) => (r === 0 ? undefined : `rotate(${(r * 180) / Math.PI} ${cx} ${cy})`);

  return (
    <div
      ref={root}
      className="blk blk-draw noq"
      data-block={block.id}
      tabIndex={0}
      onPointerMove={prox.move}
      onPointerLeave={prox.leave}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          // the element's own door: ↩ arms the sheet, Esc leaves it again,
          // and the arrows go on moving the element until it is armed
          e.preventDefault();
          sheet.current?.focus();
          return;
        }
        if (e.key !== "Backspace" && e.key !== "Delete") return;
        e.preventDefault();
        void remove();
      }}
    >
      <svg
        ref={sheet}
        className="dw-sheet"
        tabIndex={-1}
        aria-label={inkSaid(strokes)}
        data-tool={tool}
        data-cursor={cursor ?? undefined}
        onPointerDown={onDown}
        onPointerMove={tool === "select" ? onSheetMove : undefined}
        onPointerLeave={tool === "select" ? onSheetLeave : undefined}
        onDoubleClick={tool === "select" ? onSheetDouble : undefined}
        onKeyDown={onSheetKey}
      >
        {/* one head per ink step, always in the sheet: the head an arrow wears
            while it is still being DRAWN cannot wait for a committed arrow to
            have put its marker there first. markerUnits is the stroke's own
            width, so a head is 4t long at every weight (spec 4.3) */}
        <defs>
          {INK_VAR.map((colour, i) => (
            <marker
              key={i}
              id={`${heads}${i}`}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              markerUnits="strokeWidth"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10Z" fill={colour} />
            </marker>
          ))}
        </defs>
        {marks.map((mark, i) => (
          <Ink key={i} mark={mark} head={heads} doomed={doomed.has(i)} />
        ))}
        <path ref={live} className="dw-live" stroke={INK_VAR[ink]} strokeWidth={weight} strokeLinecap="round" />
        {hovered && (
          <g className="dw-hover" transform={turned(hovered.r, hovered.cx, hovered.cy)}>
            <rect
              x={hovered.box[0]}
              y={hovered.box[1]}
              width={hovered.box[2] - hovered.box[0]}
              height={hovered.box[3] - hovered.box[1]}
            />
          </g>
        )}
        {overlay && (
          <g className="dw-sel" transform={turned(overlay.r, overlay.cx, overlay.cy)}>
            <rect
              className="dw-box"
              x={overlay.box[0]}
              y={overlay.box[1]}
              width={overlay.box[2] - overlay.box[0]}
              height={overlay.box[3] - overlay.box[1]}
            />
            <line className="dw-stem" x1={overlay.stem.x} y1={overlay.stem.y0} x2={overlay.stem.x} y2={overlay.stem.y1} />
            <circle className="dw-knob" cx={overlay.knob.x} cy={overlay.knob.y} r={KNOB} />
            {overlay.handles.map((h) => (
              <rect
                key={h.at}
                className="dw-handle"
                data-at={h.at}
                x={h.x - HANDLE / 2}
                y={h.y - HANDLE / 2}
                width={HANDLE}
                height={HANDLE}
                rx={1.5}
              />
            ))}
          </g>
        )}
        {marquee && (
          <rect
            className="dw-marquee"
            x={Math.min(marquee[0], marquee[2])}
            y={Math.min(marquee[1], marquee[3])}
            width={Math.abs(marquee[2] - marquee[0])}
            height={Math.abs(marquee[3] - marquee[1])}
          />
        )}
      </svg>
      {label && (
        <textarea
          className="dw-label"
          autoFocus
          aria-label="Label"
          rows={textLines(label.v).length}
          value={label.v}
          style={{ left: label.x, top: label.y - label.s, fontSize: label.s, lineHeight: TEXT_LINE, width: labelWidth(label) }}
          onChange={(e) => setLabel({ ...label, v: e.target.value })}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            e.stopPropagation();
            // ↩ commits and ⇧↩ breaks the line: the words a hand types on a
            // sheet are a caption, and a caption is one press from done
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitLabel();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setLabel(null);
            }
          }}
        />
      )}
      {full && <div className="dw-full">{fullSaid()}</div>}
      <ToolIsland
        ref={islandRef}
        tool={tool}
        shape={shape}
        ink={ink}
        weight={weight}
        selectionInk={selectionInk}
        selectionWeight={selectionWeight}
        onArm={arm}
        onInk={onInk}
        onWeight={onWeight}
        open={islandOpen}
        onOpenChange={setIslandOpen}
        inking={false}
      />
      <div className="acts-float">
        {kindTools("drawing").map((tool) => (
          <Fragment key={tool}>{tools[tool]}</Fragment>
        ))}
      </div>
      {menuAt && <ContextMenu point={menuAt} items={menu} onClose={() => setMenuAt(null)} />}
    </div>
  );
}

/** the shape a drag describes, as the same path a committed stroke draws: the
 * preview and the commit can never disagree about a corner, which is the rule
 * the grid's own placeholder follows */
function shapePath(tool: MarkTool, p: readonly number[]): string {
  const [x0, y0, x1, y1] = p;
  const mark: Stroke =
    tool === "pen"
      ? { k: "pen", c: 0, t: 1, p: [...p] }
      : { k: tool, c: 0, t: 1, b: [x0, y0, x1, y1] };
  const marks = marksOf([mark]);
  const first = marks[0];
  return first && first.el === "path" ? first.d : "";
}

/** what the delete confirm names: the drawing's first label, in data's
 * clothes, or its stroke count when it carries no words (WRITING, identifiers
 * inside chrome, form 3) */
function drawnName(block: DrawingBlock): string {
  for (const s of block.strokes) if (s.k === "text") return `“${s.v}”`;
  const n = block.strokes.length;
  return `${n} ${n === 1 ? "stroke" : "strokes"}`;
}
