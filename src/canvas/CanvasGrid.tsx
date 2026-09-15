// The canvas's grid (C2a): the surface the layout engine draws on. Cells of
// 108 with a 12 gutter, the column count read from the width (5 at the 640
// floor, 7 at 960, 10 at 1280), the cell stretching to fill and the row unit
// fixed, because a table row is 26px and a line of text 20px on every screen
// there is.
//
// Position is STATE, never the DOM (LESSONS 7). Every element is absolutely
// placed by one calc() over the container's --cw / --gut / --ch and its own
// --x / --y / --w / --h, so a window resize that does not cross a column
// boundary is two custom-property writes on one node and ZERO React renders,
// and a drag is one transform on one composited layer.
//
// A gesture commits ONCE, at its end. Between pointerdown and pointerup this
// file renders nothing: the pointer's offset is written to a motion value
// (unsprung: a spring between the finger and the thing is lag), the
// neighbours the engine displaced travel on spring.layout through motion
// values of their own, the placeholder moves on the same spring, and the
// document hears about it on the release, in one setDoc. That is why the
// gesture lives in `createGrab`, a machine with no React and no DOM in it: it
// writes to handles, and the handles are motion values here and recorders in
// the test, so the arithmetic of a drag is provable without a browser.
//
// The engine decides the layout, always: the preview a drag shows is the same
// `move()` the drop commits, so the placeholder can never stand where the
// element will not land (the results grid's own rule for its column drag,
// Grid.tsx). The preview runs when the snapped CELL changes and not once per
// pointer frame, which is what keeps a drag frame under 16ms with 200
// elements on the page.
//
// And the release writes to no handle at all (D3 rule 3). The landing rides
// the one commit and is applied where the new cell frame is applied, in the
// same frame: the held element is parked at the offset the pointer left it at
// and springs to nothing, the neighbours it pushed are already home. Written
// the other way round - handles on pointerup, cells one render later - the
// element painted once at the place it came from and then sprang, which is the
// jump back and forth the maintainer filmed.
//
// Chrome at rest stays at 0 per element and 0 per page. The grip is the first
// action of a cluster that is already revealed on hover; the corner handle is
// revealed with it; the lattice, the placeholder and the size label belong to
// a gesture and leave with it. The keyboard route is the element's own
// arrows, which is what lets the pointer affordances hide (DESIGN rule 8's
// reveal clause), and a polite live region says where an element landed, once
// per gesture end.

import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, animate, motion, useMotionValue } from "motion/react";
import { GripVertical } from "lucide-react";
import { spring } from "../design/springs";
import {
  CELL_H,
  CELL_W_BASE,
  GUTTER,
  bounds,
  cellMetrics,
  cellsForPx,
  move,
  resize,
  type Cell,
  type GridItem,
  type Metrics,
} from "./grid";
import { laidOut, minSpanFor, NOTE_ROWS_MAX, useCanvas, type Block } from "../stores/canvas";
import { Widget, type WidgetRef } from "./widget";
import "./grid.css";

/** the press travels this far before anything moves, so a click on a title
 * line stays a click (TabBar's own threshold, the app's click-versus-drag) */
const THRESHOLD = 4;

/** the column count the first render lays out at, before the page has been
 * measured. Nothing paints at it: the measure is a layout effect, so the real
 * count is in before the frame is (Chart.tsx's own precedent) */
const COLUMNS_FIRST = 8;

/** the gap between a block's own parts (canvas.css `.blk > * + *`), which the
 * note's measure has to add back: what it measures is the words */
const PART_GAP = 8;



export type GestureKind = "move" | "resize";

/** the document's layout at this column count. The store answers for both
 * halves of it: `laidOut` gives a rect to any block that has none (a whole
 * document with none is A3's list and migrates), and `reflowTo` is what
 * derives a narrower page, so the surface never holds a second opinion about
 * where anything stands (DESIGN rule 14: one fact, one slot). */
export function layoutOf(blocks: readonly Block[], columns: number): { blocks: Block[]; items: GridItem[] } {
  const laid = laidOut(blocks, columns);
  return { blocks: laid, items: laid.map((b) => ({ id: b.id, cell: b.cell as Cell })) };
}

/** `3 × 3`: the one transient string of a gesture (tabular numerals, the
 * status register). The multiplication sign, never a letter x */
export const sizeLabel = (cell: { w: number; h: number }): string => `${cell.w} × ${cell.h}`;

/** what the live region says, once, when a gesture ends. Sentence case, no
 * terminal period, and columns and rows counted from 1 the way a person
 * counts them (WRITING) */
export const movedSaid = (name: string, cell: Cell): string =>
  `${name} moved to column ${cell.x + 1}, row ${cell.y + 1}`;
export const resizedSaid = (name: string, cell: Cell): string =>
  `${name} resized to ${cell.w} by ${cell.h} cells`;

/** what a screen reader landing on the element reads: its name, its kind and
 * its geometry, so a Tab into the page knows where it is without waiting for
 * a gesture to tell it */
export const geometrySaid = (name: string, kind: string, cell: Cell): string =>
  `${name} · ${kind} · ${cell.w} by ${cell.h} at column ${cell.x + 1}, row ${cell.y + 1}`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** What the page around the grid is handed (C2b call 6): the cell a point
 * lands in, the count it lands in, and the lattice for the length of a press.
 * The scroller's own click belongs to CanvasTab (the page under the elements
 * and the tail below them are where a person writes), and the PITCH belongs to
 * the grid, so the two meet at one function instead of in a second copy of the
 * arithmetic (DESIGN rule 14). */
export interface GridPage {
  /** the cell under a point, in the page's own coordinates. Held inside the
   * columns; a point below the last row is the row it is in, because the
   * canvas grows DOWN and a click in the tail is a click on a cell */
  cellAt: (clientX: number, clientY: number) => { x: number; y: number };
  columns: () => number;
  /** the cells, shown while a press is being made and gone with it: the same
   * lattice a drag shows, for the same reason (nothing says where a cell is
   * at rest, and a placement is a moment when that matters) */
  lattice: (on: boolean) => void;
}

/** the cell the pointer is over: the grab offset is kept, so the element does
 * not jump under the finger, and the target is arithmetic on the pointer and
 * the pitch, never a DOM read per frame */
export function snapCell(base: Cell, dx: number, dy: number, m: Metrics, columns: number): Cell {
  const px = m.cellW + m.gutter;
  const py = CELL_H + m.gutter;
  return {
    x: clamp(base.x + Math.round(dx / px), 0, Math.max(0, columns - base.w)),
    y: Math.max(0, base.y + Math.round(dy / py)),
    w: base.w,
    h: base.h,
  };
}

/** the span the corner is at: the kind's floor and the page's own edge hold
 * it, so a drag past either simply stops */
export function snapSpan(
  base: Cell,
  dx: number,
  dy: number,
  m: Metrics,
  columns: number,
  min: { w: number; h: number },
): Cell {
  const px = m.cellW + m.gutter;
  const py = CELL_H + m.gutter;
  return {
    x: base.x,
    y: base.y,
    w: clamp(base.w + Math.round(dx / px), min.w, Math.max(min.w, columns - base.x)),
    h: Math.max(min.h, base.h + Math.round(dy / py)),
  };
}

// ---- the gesture machine ---------------------------------------------------

/** one element, as the gesture writes to it. The surface backs these with
 * motion values (no React render); a test backs them with a recorder */
export interface SlotHandle {
  cell: Cell;
  /** the gesture's own mark on the element: the lift on a move, the accent on
   * the resize handle, and nothing at all when it is over */
  hold: (kind: GestureKind | null) => void;
  /** the pointer's offset in px, written per frame and never sprung */
  offset: (dx: number, dy: number) => void;
  /** travel to an offset on spring.layout: the displaced neighbours, and the
   * dragged element settling onto its placeholder */
  travel: (dx: number, dy: number) => void;
  /** the resized element's box in px, per frame; null gives it back to the
   * cell frame */
  size: (w: number | null, h: number | null) => void;
}

/** the placeholder, and the size label riding its corner */
export interface GhostHandle {
  at: (cell: Cell, instant: boolean) => void;
  say: (text: string) => void;
  show: (kind: GestureKind | null) => void;
}

/** what one element has left to do when the commit's cells come back through
 * React (D3 rule 3). A neighbour the preview already pushed is HOME and this
 * is two zeroes: it does not move at all. The held one carries where the
 * pointer let go, against the cell it was given: a move as the drag layer's
 * own offset, which springs to nothing, and a resize as the box the corner was
 * left at, which springs to the span. */
export interface Drop {
  dx: number;
  dy: number;
  /** a resize only: the px box the corner stopped at */
  from?: { w: number; h: number };
}

export interface GrabConfig {
  items: () => readonly GridItem[];
  metrics: () => Metrics;
  slot: (id: string) => SlotHandle | undefined;
  min: (id: string) => { w: number; h: number };
  name: (id: string) => string;
  ghost: GhostHandle;
  live: (text: string) => void;
  /** the ONE write of a gesture, at its end, carrying every element this
   * gesture moved and what that element has left to do. Nothing is written to
   * a handle after this: the cell frame and the landing go in one frame, so a
   * drop is one spring and never a jump followed by one */
  commit: (kind: GestureKind, id: string, cell: Cell, landed: ReadonlyMap<string, Drop>) => void;
}

export interface Grab {
  down: (kind: GestureKind, id: string, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  up: () => void;
  cancel: () => void;
  /** the gesture that is live, if one is */
  at: () => { kind: GestureKind; id: string } | null;
}

interface Held {
  kind: GestureKind;
  id: string;
  startX: number;
  startY: number;
  base: Cell;
  dx: number;
  dy: number;
  moved: boolean;
  /** the engine's answer for the last snapped target: what the drop commits */
  target: Cell;
  /** every element this gesture has displaced, so the drop can clear them */
  shifted: string[];
}

/** where the pointer left the held element, measured against the cell the drop
 * is committing it to. A move is an OFFSET on the drag layer, which is the one
 * property the settle animates; a resize is the BOX the corner stopped at,
 * which springs to the span, and its offset is whatever the clamped x owes */
function dropOf(g: Held, m: Metrics): Drop {
  const px = m.cellW + m.gutter;
  const py = CELL_H + m.gutter;
  if (g.kind === "move")
    return { dx: g.dx - (g.target.x - g.base.x) * px, dy: g.dy - (g.target.y - g.base.y) * py };
  return {
    dx: (g.base.x - g.target.x) * px,
    dy: (g.base.y - g.target.y) * py,
    from: {
      w: g.base.w * m.cellW + (g.base.w - 1) * m.gutter + g.dx,
      h: g.base.h * CELL_H + (g.base.h - 1) * m.gutter + g.dy,
    },
  };
}

/** the drag and the resize, as one machine with two targets. No React, no
 * DOM, no store: it reads the layout through `items()` and writes through
 * handles, so what a gesture does is testable without a browser and what it
 * costs is one engine call per changed cell. */
export function createGrab(cfg: GrabConfig): Grab {
  let held: Held | null = null;

  const clear = (): void => {
    if (!held) return;
    cfg.slot(held.id)?.hold(null);
    cfg.ghost.show(null);
    held = null;
  };

  return {
    at: () => (held && held.moved ? { kind: held.kind, id: held.id } : null),

    down(kind, id, x, y) {
      const it = cfg.items().find((i) => i.id === id);
      if (!it) return;
      held = {
        kind,
        id,
        startX: x,
        startY: y,
        base: it.cell,
        dx: 0,
        dy: 0,
        moved: false,
        target: it.cell,
        shifted: [],
      };
      cfg.slot(id)?.hold(kind);
    },

    move(x, y) {
      const g = held;
      if (!g) return;
      g.dx = x - g.startX;
      g.dy = y - g.startY;
      if (!g.moved) {
        if (Math.hypot(g.dx, g.dy) <= THRESHOLD) return;
        g.moved = true;
        cfg.ghost.at(g.base, true);
        cfg.ghost.say(sizeLabel(g.base));
        cfg.ghost.show(g.kind);
      }
      const m = cfg.metrics();
      const slot = cfg.slot(g.id);
      const want =
        g.kind === "move"
          ? snapCell(g.base, g.dx, g.dy, m, m.columns)
          : snapSpan(g.base, g.dx, g.dy, m, m.columns, cfg.min(g.id));
      // the element itself answers the pointer every frame: a move follows it
      // un-sprung, a resize writes its box
      if (g.kind === "move") slot?.offset(g.dx, g.dy);
      else
        slot?.size(
          g.base.w * m.cellW + (g.base.w - 1) * m.gutter + g.dx,
          g.base.h * CELL_H + (g.base.h - 1) * m.gutter + g.dy,
        );
      if (want.x === g.target.x && want.y === g.target.y && want.w === g.target.w && want.h === g.target.h) {
        return;
      }
      // the preview is the engine's, so the placeholder can never stand where
      // the element will not land. It runs on a CHANGED cell, a few times in
      // a gesture, never once a frame
      const items = cfg.items();
      const next =
        g.kind === "move"
          ? move(items, g.id, { x: want.x, y: want.y }, m.columns)
          : resize(items, g.id, { w: want.w, h: want.h }, m.columns);
      const px = m.cellW + m.gutter;
      const py = CELL_H + m.gutter;
      const shifted: string[] = [];
      for (const p of next) {
        if (p.id === g.id) continue;
        const s = cfg.slot(p.id);
        if (!s) continue;
        const ox = (p.cell.x - s.cell.x) * px;
        const oy = (p.cell.y - s.cell.y) * py;
        if (ox === 0 && oy === 0 && !g.shifted.includes(p.id)) continue;
        s.travel(ox, oy);
        if (ox !== 0 || oy !== 0) shifted.push(p.id);
      }
      g.shifted = shifted;
      g.target = next.find((p) => p.id === g.id)?.cell ?? want;
      cfg.ghost.at(g.target, false);
      cfg.ghost.say(sizeLabel(g.target));
    },

    up() {
      const g = held;
      if (!g) return;
      if (!g.moved) {
        // it was a click, and it belongs to whatever was pressed
        clear();
        return;
      }
      // the document takes the new place and every displaced neighbour takes
      // the preview's, in this ONE write, which also carries what each of them
      // has left to do. Nothing is written to a handle here: the landing rides
      // the same frame as the cell frame it lands on, so the drop is one
      // spring and never a jump back followed by one (D3 rule 3)
      const landed = new Map<string, Drop>([[g.id, dropOf(g, cfg.metrics())]]);
      for (const id of g.shifted) landed.set(id, { dx: 0, dy: 0 });
      // the gesture is OVER before the document hears about it: the commit can
      // render synchronously, and a surface that still wore the gesture's mark
      // read the render as one made mid-drag and threw the landing away
      const said = g.kind === "move" ? movedSaid(cfg.name(g.id), g.target) : resizedSaid(cfg.name(g.id), g.target);
      clear();
      cfg.commit(g.kind, g.id, g.target, landed);
      cfg.live(said);
    },

    cancel() {
      const g = held;
      if (!g) return;
      // nothing is written: every element travels back to where it stands
      for (const id of g.shifted) cfg.slot(id)?.travel(0, 0);
      const slot = cfg.slot(g.id);
      if (g.kind === "move") slot?.travel(0, 0);
      else slot?.size(null, null);
      clear();
    },
  };
}

// ---- the surface -----------------------------------------------------------

/** the grip: the first action of every cluster, and the surface every kind
 * drags by. It answers a press and not a click, so it is out of the tab order
 * and the element's own arrows are the keyboard route (DESIGN rule 8) */
export function Grip() {
  return (
    <button type="button" className="iconbtn iconbtn-sm cvg-grip" title="Move" tabIndex={-1} aria-hidden>
      <GripVertical size={12} />
    </button>
  );
}

/** a slot's own cell, in the four custom properties the calc() reads. One
 * element's frame and the page's caret line are placed by the same four */
const cellVars = (cell: Cell): CSSProperties =>
  ({
    "--x": String(cell.x),
    "--y": String(cell.y),
    "--w": String(cell.w),
    "--h": String(cell.h),
  }) as CSSProperties;

interface SlotProps {
  block: Block;
  cell: Cell;
  label: string;
  canvasId: string;
  /** the page's pitch, read when it is used and never closed over: a window
   * drag between a render and an act must not commit a stale layout */
  metrics: () => Metrics;
  /** what a gesture that just committed left this element to do, read exactly
   * once per commit: the held one's park-and-spring, or two zeroes for a
   * neighbour the preview already pushed. Null is a document change, which
   * travels from the box it just left (D2 item 12) */
  landed: (id: string) => Drop | null;
  /** whether THIS render is a column-count reflow, which is the page's own
   * fact and read here rather than counted per slot */
  reflowing: () => boolean;
  /** this widget holds the caret: the note's measure reads the TEXTAREA then,
   * and never shrinks under it (D2 item 3) */
  editing: boolean;
  register: (id: string, handle: SlotHandle) => () => void;
  /** the note's own height, measured: the document follows its words until a
   * hand takes the corner (the store clears `autoH` then, and this stops) */
  onGrow: (id: string, rows: number) => void;
  onDown: (kind: GestureKind, id: string, e: ReactPointerEvent<HTMLElement>) => void;
  onKey: (id: string, e: ReactKeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}

/** one element's cell frame and its gesture layer. The frame is React's (it
 * changes when the document does); the layer is the gesture's, written from
 * motion values that never pass through a render */
const GridSlot = memo(function GridSlot({
  block,
  cell,
  label,
  canvasId,
  metrics,
  landed,
  reflowing,
  editing,
  register,
  onGrow,
  onDown,
  onKey,
  children,
}: SlotProps) {
  const el = useRef<HTMLDivElement>(null);
  const dx = useMotionValue(0);
  const dy = useMotionValue(0);
  const scale = useMotionValue(1);
  const handle = useRef<SlotHandle | null>(null);
  if (handle.current === null) {
    handle.current = {
      cell,
      hold: (kind) => {
        const node = el.current;
        if (!node) return;
        if (kind === null) {
          delete node.dataset.gesture;
          delete node.dataset.lift;
        } else {
          node.dataset.gesture = kind;
          if (kind === "move") node.dataset.lift = "";
        }
        animate(scale, kind === "move" ? 1.02 : 1, spring.pop);
      },
      // `jump`, never `set`: an offset is a PLACE and carries no momentum, and
      // a pointer's own frames are the fastest momentum there is. Written with
      // `set`, the last two frames of a drag (the finger, then the drop's
      // residual) handed the settle below a velocity of the whole travel, so
      // the element shot past its cell by more than a row and came back — one
      // spring reading as a jump back and forth (D3 rule 3, the maintainer's
      // second finding)
      offset: (x, y) => {
        dx.jump(x);
        dy.jump(y);
      },
      travel: (x, y) => {
        animate(dx, x, spring.layout);
        animate(dy, y, spring.layout);
      },
      size: (w, h) => {
        const node = el.current;
        if (!node) return;
        node.style.width = w === null ? "" : `${w}px`;
        node.style.height = h === null ? "" : `${h}px`;
      },
    };
  }
  // the handle mirrors the cell the element is RENDERED at, so a gesture's
  // arithmetic is against what is on the page and not against a stale close
  useLayoutEffect(() => {
    const h = handle.current;
    if (h) h.cell = cell;
  }, [cell]);
  useLayoutEffect(() => register(block.id, handle.current as SlotHandle), [block.id, register]);

  // a note's cells follow its words until a hand takes the corner. The words
  // are measured where they are RENDERED (the store's own estimate is made of
  // the markdown and the base cell, and this element may be wider), and the
  // height goes back through the one `resize` every gesture uses, so what it
  // displaces is displaced by the same rule.
  //
  // What is measured is the WORDS and never the box they stand in (D1 item 8):
  // the box fills the cells now, so measuring it would answer with the height
  // it was just given and no note would ever grow or shrink again. The box's
  // own padding and hairline are read off it rather than retyped, so the two
  // cannot drift (note.css owns those numbers).
  //
  // D2 item 3 gives the rule its other half: while the caret is IN it the
  // words are the textarea's, whose `scrollHeight` is the height the source
  // wants and is not lowered by the `max-height` the cells impose. So a note
  // grows a whole row at a time AS IT IS TYPED, capped at NOTE_ROWS_MAX, past
  // which the box scrolls. It never shrinks mid-edit: the page must not jump
  // under the caret, and the commit re-measures once and takes any shrink then
  const autoH = block.kind === "note" && block.autoH === true;
  useLayoutEffect(() => {
    const host = el.current;
    if (!autoH || !host) return;
    // the caret's box, or the rendered prose's: one of the two stands, and
    // which one is what the edit swap changes under this effect (hence
    // `editing` in the deps: the node it observes leaves with the swap)
    const ta = host.querySelector<HTMLTextAreaElement>(".note-box .ask-ta");
    const words = host.querySelector<HTMLElement>(".note-body");
    const box = ta ? ta.parentElement : words;
    const inner = ta ?? ((words?.firstElementChild as HTMLElement | null) ?? words);
    if (!box || !inner) return;
    let frame = 0;
    const measure = () => {
      const h = handle.current;
      if (!h) return;
      const title = host.querySelector<HTMLElement>(".blk-q");
      const face = getComputedStyle(box);
      const chrome =
        parseFloat(face.paddingTop) +
        parseFloat(face.paddingBottom) +
        parseFloat(face.borderTopWidth) +
        parseFloat(face.borderBottomWidth);
      const px = (ta ? ta.scrollHeight : inner.offsetHeight) + chrome + (title ? title.offsetHeight + PART_GAP : 0);
      const cells = Math.min(NOTE_ROWS_MAX, cellsForPx(px));
      if (cells === h.cell.h) return;
      if (cells < h.cell.h && editing) return;
      onGrow(block.id, cells);
    };
    measure();
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [autoH, editing, block.id, onGrow]);

  /** what this widget's own faces may act on (D2 items 4 and 5): the cells
   * they stand in, named once so a face can resize or clear without a prop
   * threaded through a block that has none */
  const widget = useMemo<WidgetRef>(
    () => ({ canvasId, blockId: block.id, columns: () => metrics().columns }),
    [canvasId, block.id, metrics],
  );

  // one frame, one animation: the cell frame is React's, written once with no
  // transition of its own, and what travels over it is the drag layer, always
  // through these same two handles. A DROP lands here rather than in the
  // pointer handler (D3 rule 3) because that is what puts the landing and the
  // cell frame in the SAME frame: the held one is parked at the offset the
  // pointer left it at and springs to nothing, a neighbour the preview already
  // pushed is home and writes one zero, and neither jumps back first. A change
  // the DOCUMENT made — a note growing a row with its words, `+ 4 more` giving
  // a chart the rows its bars need, a keyboard resize — only wrote new cells,
  // so the element is parked at the box it just left instead (D2 item 12).
  // Reduced motion collapses the preset and it simply stands there.
  const was = useRef<Cell>(cell);
  const sizing = useRef<{ stop: () => void } | null>(null);
  useLayoutEffect(() => {
    const prev = was.current;
    was.current = cell;
    const node = el.current;
    const h = handle.current;
    if (!node || !h) return;
    const m = metrics();
    // a narrower window is a REFLOW, not a document change: the page derives a
    // new layout for every element at once and chrome does not animate under a
    // window drag (DESIGN rule 2's stable-chrome clause), and it is also what
    // makes the first render's guess (COLUMNS_FIRST) silent. The page answers
    // for it, never a count kept here: a slot the reflow gave the same cell
    // does not re-render, kept a stale count, and read the NEXT change as a
    // reflow — which is how a DROP came to be swallowed (DESIGN rule 14). The
    // drop wins over the mark in any case: it is the gesture's own instruction
    // for this one element, where the mark is about the whole page
    const drop = landed(block.id);
    if (node.dataset.gesture !== undefined) return;
    if (!drop && reflowing()) return;
    const px = (c: Cell) => ({
      w: c.w * m.cellW + (c.w - 1) * m.gutter,
      h: c.h * CELL_H + (c.h - 1) * m.gutter,
    });
    const dx = drop ? drop.dx : (prev.x - cell.x) * (m.cellW + m.gutter);
    const dy = drop ? drop.dy : (prev.y - cell.y) * (CELL_H + m.gutter);
    if (dx !== 0 || dy !== 0) {
      h.offset(dx, dy);
      h.travel(0, 0);
    } else if (drop) h.offset(0, 0);
    const from = drop ? drop.from : prev.w === cell.w && prev.h === cell.h ? null : px(prev);
    if (!from) {
      if (drop) h.size(null, null);
      return;
    }
    const to = px(cell);
    sizing.current?.stop();
    h.size(from.w, from.h);
    const run = animate(node, { width: `${to.w}px`, height: `${to.h}px` }, spring.layout);
    sizing.current = run;
    void run.finished
      .then(() => {
        if (sizing.current === run) {
          sizing.current = null;
          h.size(null, null);
        }
      })
      .catch(() => {});
  }, [cell, block.id, landed, reflowing, metrics]);

  return (
    <motion.div
      ref={el}
      className="cvg-slot"
      style={cellVars(cell)}
      role="group"
      aria-label={label}
      exit={{ opacity: 0 }}
      transition={spring.layout}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement;
        const kind: GestureKind | null = t.closest(".cvg-handle")
          ? "resize"
          : t.closest(".cvg-grip") || t.closest(".blk-q")
            ? "move"
            : null;
        if (kind === null) return;
        onDown(kind, block.id, e);
      }}
      onKeyDown={(e) => onKey(block.id, e)}
    >
      <motion.div className="cvg-drag" style={{ x: dx, y: dy, scale }}>
        <Widget.Provider value={widget}>{children}</Widget.Provider>
        <button type="button" className="cvg-handle" title="Resize" tabIndex={-1} aria-hidden />
      </motion.div>
    </motion.div>
  );
});

export interface CanvasGridProps {
  canvasId: string;
  blocks: Block[];
  /** the column count the document was last laid out at, if it knows one: the
   * first render's guess, and never painted at (LESSONS 5: it informs) */
  columnsHint?: number;
  /** the block itself, drawn by the surface that owns the kinds, and the cells
   * it stands on: the faces read their size from them */
  renderBlock: (block: Block, cell: Cell) => ReactNode;
  /** its key, so a replaced block still crossfades where it stood */
  keyOf: (block: Block) => string;
  /** the page's own caret line, standing in the cell a click landed in and in
   * the document nowhere until its first words (C2b call 6). It rides a slot
   * like every other element so the one pitch places it */
  draft?: { cell: Cell; node: ReactNode } | null;
  /** the surface takes the page's handle on mount and gives it back on
   * unmount: the register shape every handle here uses */
  page?: (api: GridPage | null) => void;
  /** what the live region and the label call it, and what kind it is */
  nameOf: (block: Block) => string;
  kindOf: (block: Block) => string;
}

const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

export function CanvasGrid({
  canvasId,
  blocks,
  columnsHint,
  renderBlock,
  keyOf,
  nameOf,
  kindOf,
  draft,
  page,
}: CanvasGridProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const size = useRef<HTMLSpanElement>(null);
  const [columns, setColumns] = useState(columnsHint ?? COLUMNS_FIRST);
  // which widget holds the caret, so the note's measure knows to read the
  // textarea and to refuse a shrink under it (D2 item 3). The store's, not a
  // prop: one caret on the document, and the palette's `New Note` writes it
  // from outside this tree
  const editingId = useCanvas((s) => s.editing);
  const metrics = useRef<Metrics>(cellMetrics(columns * (CELL_W_BASE + GUTTER)));
  const slots = useRef(new Map<string, SlotHandle>());

  const gx = useMotionValue(0);
  const gy = useMotionValue(0);
  const gw = useMotionValue(0);
  const gh = useMotionValue(0);

  const layout = useMemo(() => layoutOf(blocks, columns), [blocks, columns]);
  const items = useRef<GridItem[]>(layout.items);
  items.current = layout.items;
  const byId = useMemo(() => new Map(layout.blocks.map((b) => [b.id, b])), [layout]);
  const book = useRef(byId);
  book.current = byId;
  // the namer is read through a ref for the same reason the layout is: the
  // gesture machine is built once and must never close over a stale render
  const naming = useRef(nameOf);
  naming.current = nameOf;

  // the page re-flowed for THIS render: one fact in one place, cleared after
  // every render (this effect carries no dependency list on purpose) and read
  // by the slots on their way past. It is declared before the measure below so
  // the order inside one commit is clear-then-measure: a count the measure
  // changes is still standing when the render it causes reaches the slots
  const flowing = useRef(false);
  const reflowing = useCallback(() => flowing.current, []);
  useLayoutEffect(() => {
    flowing.current = false;
  });

  // one measure a frame, and React only at a column boundary: the cell width
  // and the gutter are two custom properties on this one node, so a window
  // drag that adds no column renders nothing at all (spec 6.3)
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const apply = (width: number): number => {
      const m = cellMetrics(width);
      metrics.current = m;
      node.style.setProperty("--cw", `${m.cellW}px`);
      node.style.setProperty("--gut", `${m.gutter}px`);
      node.style.setProperty("--ch", `${CELL_H}px`);
      return m.columns;
    };
    // the page is this many columns wide now: the store keeps the stored
    // layout and hands back a derived one while it is narrower, so the
    // surface never holds a layout of its own (canvas.ts reflowTo)
    const widthChanged = (width: number) => {
      const before = metrics.current.columns;
      const n = apply(width);
      if (n !== before) flowing.current = true;
      setColumns(n);
      useCanvas.getState().reflowTo(canvasId, n);
    };
    widthChanged(node.clientWidth);
    let width = node.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        widthChanged(width);
      });
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [canvasId]);

  // the page's handle: the pitch is here, so the click that writes a note is
  // placed by the same arithmetic a drag snaps to (DESIGN rule 14). The rect
  // is read on the press and not per frame - one placement is one read
  useLayoutEffect(() => {
    if (!page) return;
    page({
      cellAt: (clientX, clientY) => {
        const node = host.current;
        const m = metrics.current;
        if (!node) return { x: 0, y: 0 };
        const r = node.getBoundingClientRect();
        return {
          x: clamp(Math.floor((clientX - r.left) / (m.cellW + m.gutter)), 0, Math.max(0, m.columns - 1)),
          y: Math.max(0, Math.floor((clientY - r.top) / (CELL_H + m.gutter))),
        };
      },
      columns: () => metrics.current.columns,
      lattice: (on) => {
        const node = host.current;
        if (!node) return;
        if (!on) {
          delete node.dataset.place;
          return;
        }
        // the page's own remaining height, read once on the press: an empty
        // grid is 0 rows tall, and the cells a press is about are the ones
        // under the pointer rather than the ones under the last element
        const scroller = node.parentElement;
        const deep = scroller ? scroller.clientHeight + scroller.scrollTop - node.offsetTop : 0;
        node.style.setProperty("--lattice-h", `${Math.max(node.clientHeight, deep)}px`);
        node.dataset.place = "";
      },
    });
    return () => page(null);
  }, [page]);

  const onGrow = useCallback(
    (id: string, rows: number) => {
      useCanvas.getState().growTo(canvasId, id, rows, metrics.current.columns, { shrink: true });
    },
    [canvasId],
  );

  /** the page's pitch, handed to the slots as a reader rather than a number: a
   * face that acts on its cells, and a travel that has to know what a cell is
   * worth in px, both read it at the moment they act */
  const pitchNow = useCallback(() => metrics.current, []);

  /** what the gesture that just committed left each element it moved to do,
   * read once as that element's new cell comes back through React: the surface
   * animates a document change one way and a drop the other (D2 item 12, D3
   * rule 3) */
  const drops = useRef(new Map<string, Drop>());
  const landed = useCallback((id: string) => {
    const drop = drops.current.get(id);
    if (drop) drops.current.delete(id);
    return drop ?? null;
  }, []);

  const register = useCallback((id: string, handle: SlotHandle) => {
    slots.current.set(id, handle);
    return () => {
      if (slots.current.get(id) === handle) slots.current.delete(id);
    };
  }, []);

  const grab = useRef<Grab | null>(null);
  if (grab.current === null) {
    grab.current = createGrab({
      items: () => items.current,
      metrics: () => metrics.current,
      slot: (id) => slots.current.get(id),
      min: (id) => {
        const b = book.current.get(id);
        return b ? minSpanFor(b) : { w: 1, h: 1 };
      },
      name: (id) => {
        const b = book.current.get(id);
        return b ? naming.current(b) : "";
      },
      ghost: {
        at: (cell, instant) => {
          const m = metrics.current;
          const to = {
            x: cell.x * (m.cellW + m.gutter),
            y: cell.y * (CELL_H + m.gutter),
            width: cell.w * m.cellW + (cell.w - 1) * m.gutter,
            height: cell.h * CELL_H + (cell.h - 1) * m.gutter,
          };
          if (instant) {
            gx.set(to.x);
            gy.set(to.y);
            gw.set(to.width);
            gh.set(to.height);
            return;
          }
          animate(gx, to.x, spring.layout);
          animate(gy, to.y, spring.layout);
          animate(gw, to.width, spring.layout);
          animate(gh, to.height, spring.layout);
        },
        say: (text) => {
          const node = size.current;
          if (node) node.textContent = text;
        },
        show: (kind) => {
          const node = host.current;
          if (!node) return;
          if (kind === null) delete node.dataset.gesture;
          else node.dataset.gesture = kind;
        },
      },
      live: (text) => {
        const node = live.current;
        if (node) node.textContent = text;
      },
      commit: (kind, id, cell, landing) => {
        for (const [at, drop] of landing) drops.current.set(at, drop);
        const store = useCanvas.getState();
        const n = metrics.current.columns;
        const doc = store.docs[canvasId];
        if (kind === "move") store.moveTo(canvasId, id, { x: cell.x, y: cell.y }, n);
        else store.resizeTo(canvasId, id, { w: cell.w, h: cell.h }, n);
        // a gesture that ended on the cells it began on writes no document, so
        // no render comes to carry the landing: it happens here instead, on
        // the same handles and the same one spring
        if (useCanvas.getState().docs[canvasId] !== doc) return;
        for (const [at, drop] of drops.current) {
          const s = slots.current.get(at);
          if (!s) continue;
          s.offset(drop.dx, drop.dy);
          if (drop.dx !== 0 || drop.dy !== 0) s.travel(0, 0);
          if (drop.from) s.size(null, null);
        }
        drops.current.clear();
      },
    });
  }

  // the pointer's own stream, off React: the listeners live for the length of
  // one gesture on the element that captured it, so a canvas at rest pays
  // nothing for a hover and a gesture pays no synthetic event
  const onDown = useCallback((kind: GestureKind, id: string, e: ReactPointerEvent<HTMLElement>) => {
    const node = e.currentTarget;
    const machine = grab.current;
    if (!machine) return;
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    machine.down(kind, id, e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => machine.move(ev.clientX, ev.clientY);
    const done = (cancel: boolean) => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
      node.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      if (cancel) machine.cancel();
      else machine.up();
    };
    const onUp = () => done(false);
    const onCancel = () => done(true);
    const onKeyDown = (ev: KeyboardEvent) => {
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
    window.addEventListener("keydown", onKeyDown, true);
  }, []);

  // the keyboard's own route to the same two operations, on the element
  // itself and never on its content: arrows move a cell, shift-arrows resize
  // by one, and the live region says where it landed
  const onKey = useCallback(
    (id: string, e: ReactKeyboardEvent<HTMLElement>) => {
      const step = ARROWS[e.key];
      if (!step || !(e.target as HTMLElement).classList.contains("blk")) return;
      const it = items.current.find((i) => i.id === id);
      const b = book.current.get(id);
      if (!it || !b) return;
      e.preventDefault();
      const m = metrics.current;
      const store = useCanvas.getState();
      const name = nameOf(b);
      if (e.shiftKey) {
        const min = minSpanFor(b);
        const cell = {
          ...it.cell,
          w: clamp(it.cell.w + step.x, min.w, Math.max(min.w, m.columns - it.cell.x)),
          h: Math.max(min.h, it.cell.h + step.y),
        };
        store.resizeTo(canvasId, id, { w: cell.w, h: cell.h }, m.columns);
        if (live.current) live.current.textContent = resizedSaid(name, cell);
        return;
      }
      const cell = {
        ...it.cell,
        x: clamp(it.cell.x + step.x, 0, Math.max(0, m.columns - it.cell.w)),
        y: Math.max(0, it.cell.y + step.y),
      };
      store.moveTo(canvasId, id, { x: cell.x, y: cell.y }, m.columns);
      if (live.current) live.current.textContent = movedSaid(name, cell);
    },
    [canvasId, nameOf],
  );

  const rows = bounds(layout.items, columns).rows;
  // the pitch stands in the style prop as well as in the imperative write, so
  // the FIRST render already lays out at cells (an element measuring itself in
  // its own layout effect runs before this component's, and a slot with no
  // --cw is a slot of no width). React's own diff is prop against prop, so a
  // window drag that wrote --cw imperatively is never undone by a later render
  const vars = {
    "--rows": String(rows),
    "--cw": `${metrics.current.cellW}px`,
    "--gut": `${metrics.current.gutter}px`,
    "--ch": `${CELL_H}px`,
  } as CSSProperties;

  return (
    <div className="cvg" ref={host} style={vars}>
      <div className="cvg-lattice" aria-hidden />
      <motion.div className="cvg-ghost" style={{ x: gx, y: gy, width: gw, height: gh }} aria-hidden>
        <span className="cvg-size" ref={size} />
      </motion.div>
      <AnimatePresence initial={false}>
        {layout.items.map((it) => {
          const b = byId.get(it.id);
          if (!b) return null;
          return (
            <GridSlot
              key={keyOf(b)}
              block={b}
              cell={it.cell}
              label={geometrySaid(nameOf(b), kindOf(b), it.cell)}
              canvasId={canvasId}
              metrics={pitchNow}
              landed={landed}
              reflowing={reflowing}
              editing={editingId === it.id}
              register={register}
              onGrow={onGrow}
              onDown={onDown}
              onKey={onKey}
            >
              {renderBlock(b, it.cell)}
            </GridSlot>
          );
        })}
      </AnimatePresence>
      {draft && (
        // the caret line: a slot like any other, so the cell a click landed in
        // is where the words start. It is the PAGE's and not the document's
        // until its first words, so it stands outside the presence list and
        // outside the engine's items: nothing moves for a caret
        <div className="cvg-slot cvg-draft" style={cellVars(draft.cell)}>
          {draft.node}
        </div>
      )}
      <div className="cvg-live" aria-live="polite" aria-atomic="true" ref={live} />
    </div>
  );
}
