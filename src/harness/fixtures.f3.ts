// F3 canvas fixtures: the tool island and the select tool (AGENT-UX 16x,
// 16jj). Framed through the harness's canvas root
// (`?harness=canvas&state=…&w=640|960|1280`), the same door C2b's and F1's
// drawing states use, on one document with ink of every kind on it, so the
// eight read as one sheet in eight states and never as eight fixtures:
//
//   f3-island-rest     a hot widget, the pen armed: the island is ONE 24px
//                      button at the top-left wearing the pen and its `P`,
//                      the six-slot cluster at the top-right (Grip · Undo ·
//                      Redo · Copy · Ask · More; `Pen ▾` has left it)
//   f3-island-open     the product's own pointermove dispatched on the block
//                      within reach of the island and left there: the seven
//                      slots at their y, the hairline between the tools and
//                      the two properties, every chord letter legible
//   f3-island-arm      the same, then a click on the Shapes slot with Ellipse
//                      armed: the arm open at that row, Ellipse at its own
//                      ordinal wearing `.active`, the slot's glyph handed over
//   f3-island-floor    a 2x2 drawing at the 640 floor with the island open:
//                      205 inside the 211 a two-row block stands on, nothing
//                      clipped (DESIGN rule 13's own evidence)
//   f3-erase-doomed    the eraser armed and a press dragged across two
//                      strokes, left OPEN: both dimmed, waiting for the lift,
//                      the chrome gone the way it goes for any stroke
//   f3-select-one      `select` armed, the ellipse clicked: the box 4 outside
//                      its bounds, four corner handles, the stem and the knob
//   f3-select-rotated  the turned ellipse clicked: box and handles turned
//                      with it, the knob riding its own top
//   f3-select-multi    the ellipse clicked, the arrow shift-clicked: one
//                      upright group box around both
//   f3-select-marquee  a press on empty paper dragged across the lower
//                      strokes and left OPEN: the dashed marquee and, inside
//                      it, the group box of what it has already caught
//
// PRESSED, not drawn (fixtures.d3.ts's rule): every pose dispatches the
// product's own pointer events (a pointermove on the block for the island, a
// click on its slot for the arm, pointerdown and pointerup on the sheet for a
// selection) and reads nothing back, so what stands in the frame is the
// product's own answer to a hand and cannot drift from the gesture it stands
// for. The marquee is left with no pointerup: a still of a drag is a drag
// mid-air.
//
// Self-contained, like fixtures.f1.ts: nothing here imports fixtures.ts.
// Wiring (AskHarness.tsx / ask-frames.ts are the integrator's): add
// F3_CANVAS_STATES to the canvas harness's own state list, seed useCanvas
// with f3Seed(state) before the first render, call f3AfterMount(state) in the
// post-mount frame before the ready mark, and give these states
// f3CanvasCardH(state).

import { writeStrokes, type Stroke } from "../canvas/strokes";
import { useCanvas, type Block, type CanvasMeta } from "../stores/canvas";

export const F3_CANVAS_STATES = [
  "f3-island-rest",
  "f3-island-open",
  "f3-island-arm",
  "f3-island-floor",
  "f3-select-one",
  "f3-select-rotated",
  "f3-select-multi",
  "f3-select-marquee",
  "f3-erase-doomed",
] as const;
export type F3CanvasState = (typeof F3_CANVAS_STATES)[number];

/** the card's own three widths, A3's (the canvas is not the pane) */
export const F3_CANVAS_WIDTHS = [640, 960, 1280] as const;

/** the sheet is three rows and the floor state two: each card is that plus
 * the canvas strip, the tab bar and the scroller's own inset, C2b's own two
 * numbers for the same two page heights (c2-draw-empty, c2-draw-small) */
const F3_SHEET_CARD_H = 500;
const F3_FLOOR_CARD_H = 420;

export const f3CanvasCardH = (state: string): number =>
  state === "f3-island-floor" ? F3_FLOOR_CARD_H : F3_SHEET_CARD_H;

export const F3_CANVAS_PROFILE_ID = "harness-staging";
const CANVAS_ID = "f3-canvas";

export interface F3Seed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, { v: 2; blocks: Block[]; lastColumns: number }>;
  editing: string | null;
}

// ---- the ink ---------------------------------------------------------------
//
// Element pixels from the sheet's top-left, at 1:1, inside basePx(4) = 456 by
// basePx(3) = 348 so the element's own floor stays the span the document gave
// it. One of every kind, and the one thing this wave adds to the document: a
// turned ellipse carrying `r`. The poses below aim at these numbers, so they
// are named once here and read by the poses rather than retyped.

type Boxed = Extract<Stroke, { b: unknown }>;

/** the ellipse a click selects: its centre is the pose's own aim */
const RING: Boxed = { k: "ellipse", c: 0, t: 2, b: [60, 60, 180, 140] };
/** the same ring turned a little over 28 degrees, the `r` case */
const TURNED: Boxed = { k: "ellipse", c: 1, t: 2, b: [220, 44, 340, 116], r: 0.5 };
/** the arrow a shift-click adds to the selection */
const ARROW: Boxed = { k: "arrow", c: 0, t: 2, b: [60, 210, 180, 150] };

const INK: Stroke[] = writeStrokes([
  RING,
  TURNED,
  ARROW,
  { k: "text", c: 0, s: 13, at: [200, 200], v: "Gateway change, 12th" },
  {
    k: "pen",
    c: 1,
    t: 2,
    p: [200, 210, 216, 213, 234, 209, 252, 214, 270, 211, 288, 215, 306, 210, 322, 213],
  },
  { k: "line", c: 2, t: 1, b: [40, 280, 300, 280] },
]);

const SHEET_ID = "f3-sheet";

const sheetWith = (tool: "pen" | "ellipse" | "select" | "eraser"): Block => ({
  id: SHEET_ID,
  kind: "drawing",
  strokes: INK,
  ink: 0,
  weight: 2,
  tool,
  cell: { x: 0, y: 0, w: 4, h: 3 },
});

/** the floor state's page: c2-draw-small's own shape, a 2x2 sheet with the
 * kind's own minimum of ink inside basePx(2) = 228 and a note filling the
 * three columns beside it, so the frame reads as a page and not as one
 * element alone */
const SMALL_ID = "f3-small";

const small: Block = {
  id: SMALL_ID,
  kind: "drawing",
  strokes: writeStrokes([
    { k: "ellipse", c: 0, t: 2, b: [60, 60, 170, 150] },
    { k: "arrow", c: 0, t: 2, b: [200, 190, 150, 140] },
    { k: "pen", c: 1, t: 2, p: [40, 190, 70, 175, 100, 195, 130, 180] },
  ]),
  ink: 0,
  weight: 2,
  tool: "pen",
  cell: { x: 0, y: 0, w: 2, h: 2 },
};

const aside: Block = {
  id: "f3-aside",
  kind: "note",
  text: "Two channels carry the month; the failed share has not moved since the gateway change.",
  autoH: true,
  cell: { x: 2, y: 0, w: 3, h: 2 },
};

const toolFor = (state: F3CanvasState): "pen" | "ellipse" | "select" | "eraser" =>
  state === "f3-island-arm"
    ? "ellipse"
    : state === "f3-erase-doomed"
      ? "eraser"
      : state.startsWith("f3-select")
        ? "select"
        : "pen";

export function f3Seed(state: string): F3Seed {
  const s = (F3_CANVAS_STATES as readonly string[]).includes(state) ? (state as F3CanvasState) : "f3-island-rest";
  const blocks = s === "f3-island-floor" ? [small, aside] : [sheetWith(toolFor(s))];
  return {
    canvasId: CANVAS_ID,
    profileId: F3_CANVAS_PROFILE_ID,
    canvases: {
      [F3_CANVAS_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: F3_CANVAS_PROFILE_ID,
          title: "Orders, last month",
          updatedAt: "2026-09-18T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: { v: 2, blocks, lastColumns: 5 } },
    editing: null,
  };
}

// ---- the poses --------------------------------------------------------------

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** the page as it FINALLY stands: the column count is measured in a layout
 * effect, so a pose against the first render would press on a sheet that has
 * since moved (fixtures.f1.ts's own wait) */
async function laidOut(blockId: string, tries = 60): Promise<HTMLElement> {
  for (let i = 0; i < tries; i++) {
    const el = document.querySelector<HTMLElement>(`[data-block="${blockId}"]`);
    const cell = useCanvas.getState().docs[CANVAS_ID]?.blocks.find((b) => b.id === blockId)?.cell;
    const slot = el?.closest(".cvg-slot");
    if (el && slot instanceof HTMLElement && cell) {
      const at = {
        x: Number(slot.style.getPropertyValue("--x")),
        y: Number(slot.style.getPropertyValue("--y")),
      };
      if (at.x === cell.x && at.y === cell.y) return el;
    }
    await frame();
  }
  throw new Error(`f3: the page never settled around ${blockId}`);
}

/** the pointer a pose presses with. The capture the handler takes is stubbed
 * for the length of the press: a synthetic pointer owns no device, and
 * `setPointerCapture` throws on an id no device owns (fixtures.d3.ts) */
const POINTER_ID = 1;

function send(node: Element, type: string, x: number, y: number, init: PointerEventInit = {}): void {
  node.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "pointermove" && !init.buttons ? 0 : 1,
      clientX: x,
      clientY: y,
      pointerId: POINTER_ID,
      pointerType: "mouse",
      isPrimary: true,
      ...init,
    }),
  );
}

/** where a hand reaching for the island stands: inside the reach of its open
 * footprint (ToolIsland.tsx openFootprint, REACH), off the block's own origin */
const REACHING = { x: 18, y: 120 };

/** the fold as it FINALLY stands. The island's slots and an open arm's members
 * are revealed by the body's own spring passing them (ToolIsland.tsx
 * `coversSlot`), so a still shot two frames after the gesture catches a box
 * mid-growth with its last member still unseen: what a frame is FOR here is
 * the pose, and the pose is the settled one. Polls the live opacities rather
 * than sleeping a guessed number of milliseconds */
async function settled(el: HTMLElement, tries = 90): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const parts = [
      ...el.querySelectorAll<HTMLElement>(".dw-island > .dw-slot"),
      ...el.querySelectorAll<HTMLElement>(".dw-arm[data-open] .dw-slot"),
    ];
    if (parts.length > 0 && parts.every((p) => Number(getComputedStyle(p).opacity) === 1)) return;
    await frame();
  }
}

/** the island opened the way a hand opens it: the block's own pointermove,
 * which the proximity hook reads, and the pointer left there */
async function openIsland(el: HTMLElement): Promise<void> {
  const box = el.getBoundingClientRect();
  send(el, "pointermove", box.left + REACHING.x, box.top + REACHING.y);
  await frame();
  await settled(el);
}

/** the centre of a stroke's own box, in sheet pixels: where a click on it
 * lands. The turned ellipse's centre is its own centre whatever its angle */
const centreOf = (s: Boxed) => ({
  x: (s.b[0] + s.b[2]) / 2,
  y: (s.b[1] + s.b[3]) / 2,
});

/** a click on the sheet: the product's own pointerdown and pointerup with
 * nothing between them */
function click(sheet: Element, x: number, y: number, init: PointerEventInit = {}): void {
  send(sheet, "pointerdown", x, y, init);
  send(sheet, "pointerup", x, y, init);
}

export async function f3AfterMount(state: string): Promise<void> {
  if (!(F3_CANVAS_STATES as readonly string[]).includes(state)) return;
  const s = state as F3CanvasState;
  await frame();
  const el = await laidOut(s === "f3-island-floor" ? SMALL_ID : SHEET_ID);
  // a hover cannot be held in a still: the block wears the harness's own
  // stamp, which canvas.css and toolIsland.css read as this block's hover
  el.dataset.hot = "";
  await frame();

  if (s === "f3-island-rest") return;
  if (s === "f3-island-open" || s === "f3-island-floor") {
    await openIsland(el);
    return;
  }
  if (s === "f3-island-arm") {
    await openIsland(el);
    const slot = el.querySelector<HTMLElement>('.dw-island [data-slot="shapes"] .dw-tool');
    if (!slot) throw new Error("f3-island-arm: the Shapes slot is not on the page");
    slot.click();
    await frame();
    await settled(el);
    return;
  }

  const sheet = el.querySelector(".dw-sheet");
  if (!sheet) throw new Error(`${s}: the sheet is not on the page`);
  const box = sheet.getBoundingClientRect();
  const at = (p: { x: number; y: number }) => ({ x: box.left + p.x, y: box.top + p.y });
  // the capture belongs to a device this pose does not have; `Element` and not
  // `HTMLElement`, because the node the handler captures on is an <svg>
  const proto = Element.prototype;
  const capture = proto.setPointerCapture;
  proto.setPointerCapture = () => {};
  try {
    if (s === "f3-select-one") {
      const p = at(centreOf(RING));
      click(sheet, p.x, p.y);
    } else if (s === "f3-select-rotated") {
      const p = at(centreOf(TURNED));
      click(sheet, p.x, p.y);
    } else if (s === "f3-select-multi") {
      const p = at(centreOf(RING));
      click(sheet, p.x, p.y);
      await frame();
      // the arrow's own midpoint, which the hit test reads by distance
      const q = at(centreOf(ARROW));
      click(sheet, q.x, q.y, { shiftKey: true });
    } else if (s === "f3-erase-doomed") {
      // the ring, then the arrow: a press dragged across both and left down,
      // so the frame holds what the lift is about to take
      const p = at(centreOf(RING));
      const q = at(centreOf(ARROW));
      send(sheet, "pointerdown", p.x, p.y);
      send(sheet, "pointermove", q.x, q.y, { buttons: 1 });
    } else if (s === "f3-select-marquee") {
      // from clear paper below the line, up and across the line, the arrow,
      // the words and the underline (the turned ring's own world box ends 10
      // above the top edge): left OPEN, with no pointerup, so the dashed box
      // and the live group inside it are the product's own mid-drag answer
      const from = at({ x: 30, y: 300 });
      const to = at({ x: 240, y: 150 });
      send(sheet, "pointerdown", from.x, from.y);
      send(sheet, "pointermove", to.x, to.y, { buttons: 1 });
    }
  } finally {
    proto.setPointerCapture = capture;
  }
  await frame();
  await frame();
}
