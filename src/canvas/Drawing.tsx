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
// Chrome at rest: 0, like the two kinds beside it. The picker is not a strip
// on the page and not a bar along the element's edge; it is the cluster the
// other kinds already have, with `Pen ▾` in its second slot (DESIGN rule 15:
// the tool, its ink and its weight are ONE control's menu, not seven buttons).
// Seven slots measure 170px against the 235px a two-cell drawing stands on at
// the 640 floor, which is why the kind's minimum is 2x2 and why no cluster
// changes shape under it (rule 13; the frame c2-draw-small is the evidence).
//
// A gesture commits ONCE, when the finger lifts: the pointer handler writes to
// a ref and to one path's `d` attribute, and the document hears about the
// stroke on pointerup, in one setDoc, on the 400 ms debounce every other write
// on this page takes. Undo and redo are the element's own and bounded at 100:
// a history that rode `doc_json` would be persisted for ever and would be the
// largest thing in the blob, so the stack dies with the unmount, which is
// stated here rather than discovered.

import {
  Fragment,
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowUpRight, Circle, Copy, Ellipsis, Minus, Pen, Redo, Square, Type, Undo } from "lucide-react";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import { Kbd } from "../design/Kbd";
import { copyCue, copyCueShow } from "../lib/copyCue";
import {
  DRAW_TOOLS,
  INK_STEPS,
  WEIGHT_STEPS,
  kindTools,
  toolForKey,
  type BlockTool,
  type DrawTool,
} from "./blockTools";
import {
  ELEMENT_BYTES_MAX,
  INK_VAR,
  PEN_POINTS_MAX,
  TEXT_SIZE,
  WEIGHTS,
  inkFull,
  inkPalette,
  marksOf,
  penHead,
  penSegment,
  simplify,
  svgOf,
  type Mark,
  type Stroke,
} from "./strokes";
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

/** the glyph each tool wears, in two places at once: the picker's BUTTON
 * shows the armed tool's, so what a press will make is legible without
 * opening the menu, and every ROW of the menu shows its own. The app's menu
 * rows carry a label, a hint and an arrow and no icon column (compareMenu's
 * reading); this one menu is the deliberate exception, because the glyph is
 * not decoration on an action's name, it is the shape the row hands you
 * (AGENT-UX 16x) */
const GLYPH: Record<DrawTool, typeof Pen> = {
  pen: Pen,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: ArrowUpRight,
  text: Type,
};

const labelOf = (tool: DrawTool): string => DRAW_TOOLS.find((t) => t.tool === tool)?.label ?? "Pen";

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

/** one committed stroke. Its own component so a page of them re-renders only
 * the one that changed, and memoised on the mark itself: the marks array is
 * rebuilt whenever the element renders, and the entries inside it are not */
const Ink = memo(function Ink({ mark, head }: { mark: Mark; head: string }) {
  if (mark.el === "text") {
    return (
      <text x={mark.x} y={mark.y} fontSize={mark.s} fill={INK_VAR[mark.c]}>
        {mark.v}
      </text>
    );
  }
  return (
    <path
      d={mark.d}
      fill="none"
      stroke={INK_VAR[mark.c]}
      strokeWidth={mark.t}
      strokeLinejoin="round"
      strokeLinecap={mark.round ? "round" : "butt"}
      markerEnd={mark.head ? `url(#${head}${mark.c})` : undefined}
    />
  );
});

/** the in-flight stroke, as the pointer handler holds it. A ref, never state:
 * this element renders nothing between pointerdown and pointerup */
interface Live {
  /** never `text`: a label is an input the page opens, not a stroke a drag
   * makes, so the in-flight stroke is the five that a drag can make */
  tool: Exclude<DrawTool, "text">;
  x0: number;
  y0: number;
  p: number[];
  d: string;
  moved: boolean;
  sealed: boolean;
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
  const sheet = useRef<SVGSVGElement>(null);
  const live = useRef<SVGPathElement>(null);
  const held = useRef<Live | null>(null);
  const past = useRef<Stroke[][]>([]);
  const future = useRef<Stroke[][]>([]);
  const [depth, setDepth] = useState({ past: 0, future: 0 });
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [penAt, setPenAt] = useState<{ x: number; y: number } | null>(null);
  const [label, setLabel] = useState<{ x: number; y: number; v: string } | null>(null);
  const heads = useId().replace(/:/g, "");

  const strokes = block.strokes;
  const tool = block.tool ?? "pen";
  const ink = block.ink ?? 0;
  const weight = block.weight ?? WEIGHTS[0];
  // both read the WHOLE stroke array, and this element re-renders on a menu
  // opening and on an undo stack changing depth: memoised on the strokes, so a
  // press on `More` does not re-serialize a 64 KB drawing to ask whether it is
  // full, and the marks the committed strokes render from keep their identity
  // so `Ink`'s memo bites (ARCHITECTURE ideology 1)
  const full = useMemo(() => inkFull(strokes), [strokes]);
  const marks = useMemo(() => marksOf(strokes), [strokes]);

  /** every write the element makes. ONE setDoc, at the end of a gesture, and
   * the frame grows through the same `resize` a corner drag uses, so what a
   * commit displaces is displaced by the one rule (grid.ts) */
  const commit = useCallback(
    (next: Stroke[], remember: boolean) => {
      const store = useCanvas.getState();
      if (remember) {
        past.current = [...past.current, strokes].slice(-UNDO_MAX);
        future.current = [];
        setDepth({ past: past.current.length, future: 0 });
      }
      store.updateDrawing(canvasId, block.id, { strokes: next });
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

  // ---- the pointer -------------------------------------------------------

  const point = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = sheet.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  const paint = (d: string) => live.current?.setAttribute("d", d);

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const at = point(e);
    if (tool === "text") {
      e.preventDefault();
      setLabel({ x: at.x, y: at.y, v: "" });
      return;
    }
    if (full) {
      copyCueShow(fullSaid());
      return;
    }
    const node = e.currentTarget;
    e.preventDefault();
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
    commit([...strokes, { k: g.tool, c: ink, t: weight, b: [g.p[0], g.p[1], g.p[2], g.p[3]] }], true);
  };

  // ---- the keyboard ------------------------------------------------------

  const onSheetKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      (sheet.current?.closest(".blk") as HTMLElement | null)?.focus();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    // the element swallows only the keys it owns (LESSONS 10): a letter that
    // arms no tool, and every modifier chord but the two above, bubble whole
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const armed = toolForKey(e.key);
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    setMemory({ tool: armed });
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
    if (await confirmDanger("Clear Drawing?", `${n} ${n === 1 ? "stroke" : "strokes"}`, "Clear"))
      commit([], true);
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

  const Armed = GLYPH[tool];
  const tools: Partial<Record<BlockTool, ReactNode>> = {
    grip: lead,
    pen: (
      <button
        type="button"
        className={`iconbtn iconbtn-sm dw-pick${penAt ? " active" : ""}`}
        title={labelOf(tool)}
        aria-label={labelOf(tool)}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPenAt({ x: r.right, y: r.bottom + 4 });
        }}
      >
        <Armed size={12} />
      </button>
    ),
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

  /** the picker, as ONE menu: the six tools, each wearing its own mark and
   * its one-key chord, then the ink and the weight the next stroke takes. The
   * armed tool wears no check, because the button that opened this menu is
   * already wearing its glyph (DESIGN rule 14: one fact, one slot) */
  const penMenu: MenuNode[] = [
    ...DRAW_TOOLS.map((row) => {
      const Mark = GLYPH[row.tool];
      return {
        kind: "item" as const,
        glyph: <Mark size={12} />,
        label: row.label,
        hint: <Kbd chord={row.chord} />,
        onSelect: () => setMemory({ tool: row.tool }),
      };
    }),
    { kind: "sep" },
    {
      kind: "submenu",
      label: "Ink",
      items: INK_STEPS.map((step, i) => ({
        kind: "item" as const,
        label: step.label,
        hint: <span className="dw-swatch" style={{ background: INK_VAR[i] }} />,
        onSelect: () => setMemory({ ink: i }),
      })),
    },
    {
      kind: "submenu",
      label: "Weight",
      items: WEIGHT_STEPS.map((step, i) => ({
        kind: "item" as const,
        label: step.label,
        hint: <span className="dw-rule" style={{ height: `${WEIGHTS[i]}px` } as CSSProperties} />,
        onSelect: () => setMemory({ weight: WEIGHTS[i] }),
      })),
    },
  ];

  const commitLabel = () => {
    const at = label;
    setLabel(null);
    if (!at || at.v.trim() === "") return;
    if (full) {
      copyCueShow(fullSaid());
      return;
    }
    commit([...strokes, { k: "text", c: ink, s: TEXT_SIZE, at: [at.x, at.y], v: at.v.trim() }], true);
  };

  return (
    <div
      className="blk blk-draw noq"
      data-block={block.id}
      data-empty={strokes.length === 0 ? "" : undefined}
      tabIndex={0}
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
        onPointerDown={onDown}
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
          <Ink key={i} mark={mark} head={heads} />
        ))}
        <path ref={live} className="dw-live" stroke={INK_VAR[ink]} strokeWidth={weight} strokeLinecap="round" />
      </svg>
      {label && (
        <input
          className="dw-label"
          autoFocus
          aria-label="Label"
          value={label.v}
          style={{ left: label.x, top: label.y - TEXT_SIZE, fontSize: TEXT_SIZE }}
          onChange={(e) => setLabel({ ...label, v: e.target.value })}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
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
      <div className="acts-float">
        {kindTools("drawing").map((tool) => (
          <Fragment key={tool}>{tools[tool]}</Fragment>
        ))}
      </div>
      {penAt && <ContextMenu point={penAt} items={penMenu} onClose={() => setPenAt(null)} />}
      {menuAt && <ContextMenu point={menuAt} items={menu} onClose={() => setMenuAt(null)} />}
    </div>
  );
}

/** the shape a drag describes, as the same path a committed stroke draws: the
 * preview and the commit can never disagree about a corner, which is the rule
 * the grid's own placeholder follows */
function shapePath(tool: Exclude<DrawTool, "text">, p: readonly number[]): string {
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

