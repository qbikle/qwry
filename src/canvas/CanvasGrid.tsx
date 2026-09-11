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
import { laidOut, minSpanFor, useCanvas, type Block } from "../stores/canvas";
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

export interface GrabConfig {
  items: () => readonly GridItem[];
  metrics: () => Metrics;
  slot: (id: string) => SlotHandle | undefined;
  min: (id: string) => { w: number; h: number };
  name: (id: string) => string;
  ghost: GhostHandle;
  live: (text: string) => void;
  /** the ONE write of a gesture, at its end */
  commit: (kind: GestureKind, id: string, cell: Cell) => void;
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
      const slot = cfg.slot(g.id);
      if (!g.moved) {
        // it was a click, and it belongs to whatever was pressed
        clear();
        return;
      }
      const m = cfg.metrics();
      // the document takes the new place and every displaced neighbour takes
      // the preview's, in this one write; the elements are already standing
      // there, so their offsets go to zero in the same frame and nothing
      // travels twice
      cfg.commit(g.kind, g.id, g.target);
      for (const id of g.shifted) cfg.slot(id)?.offset(0, 0);
      if (g.kind === "move") {
        // the drop settles from wherever the finger left it onto the cells
        // the placeholder stood on
        slot?.offset(
          g.dx - (g.target.x - g.base.x) * (m.cellW + m.gutter),
          g.dy - (g.target.y - g.base.y) * (CELL_H + m.gutter),
        );
        slot?.travel(0, 0);
      } else {
        slot?.size(null, null);
      }
      cfg.live(g.kind === "move" ? movedSaid(cfg.name(g.id), g.target) : resizedSaid(cfg.name(g.id), g.target));
      clear();
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

interface SlotProps {
  block: Block;
  cell: Cell;
  label: string;
  register: (id: string, handle: SlotHandle) => () => void;
  /** the note's own height, measured: the document follows its words until a
   * hand takes the corner (the store clears `autoH` then, and this stops) */
  onAuto: (id: string, span: { w: number; h: number }) => void;
  onDown: (kind: GestureKind, id: string, e: ReactPointerEvent<HTMLElement>) => void;
  onKey: (id: string, e: ReactKeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}

/** one element's cell frame and its gesture layer. The frame is React's (it
 * changes when the document does); the layer is the gesture's, written from
 * motion values that never pass through a render */
const GridSlot = memo(function GridSlot({ block, cell, label, register, onAuto, onDown, onKey, children }: SlotProps) {
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
      offset: (x, y) => {
        dx.stop();
        dy.stop();
        dx.set(x);
        dy.set(y);
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

  // a note never clips and never scrolls: its cells follow its words. The
  // words are measured where they are RENDERED (the store's own estimate is
  // made of the markdown and the base cell, and this element may be wider),
  // and the height goes back through the one `resize` every gesture uses, so
  // what it displaces is displaced by the same rule
  const autoH = block.kind === "note" && block.autoH === true;
  useLayoutEffect(() => {
    if (!autoH) return;
    const words = el.current?.querySelector<HTMLElement>(".note-body");
    if (!words) return;
    let frame = 0;
    const measure = () => {
      const h = handle.current;
      if (!h) return;
      const title = el.current?.querySelector<HTMLElement>(".blk-q");
      const px = words.offsetHeight + (title ? title.offsetHeight + PART_GAP : 0);
      const cells = cellsForPx(px);
      if (cells !== h.cell.h) onAuto(block.id, { w: h.cell.w, h: cells });
    };
    measure();
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    });
    ro.observe(words);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [autoH, block.id, onAuto]);

  const vars = {
    "--x": String(cell.x),
    "--y": String(cell.y),
    "--w": String(cell.w),
    "--h": String(cell.h),
  } as CSSProperties;

  return (
    <motion.div
      ref={el}
      className="cvg-slot"
      style={vars}
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
        {children}
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

export function CanvasGrid({ canvasId, blocks, columnsHint, renderBlock, keyOf, nameOf, kindOf }: CanvasGridProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const size = useRef<HTMLSpanElement>(null);
  const [columns, setColumns] = useState(columnsHint ?? COLUMNS_FIRST);
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
      const n = apply(width);
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

  const onAuto = useCallback(
    (id: string, span: { w: number; h: number }) => {
      useCanvas.getState().resizeTo(canvasId, id, span, metrics.current.columns, { auto: true });
    },
    [canvasId],
  );

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
      commit: (kind, id, cell) => {
        const store = useCanvas.getState();
        const n = metrics.current.columns;
        if (kind === "move") store.moveTo(canvasId, id, { x: cell.x, y: cell.y }, n);
        else store.resizeTo(canvasId, id, { w: cell.w, h: cell.h }, n);
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
              register={register}
              onAuto={onAuto}
              onDown={onDown}
              onKey={onKey}
            >
              {renderBlock(b, it.cell)}
            </GridSlot>
          );
        })}
      </AnimatePresence>
      <div className="cvg-live" aria-live="polite" aria-atomic="true" ref={live} />
    </div>
  );
}
