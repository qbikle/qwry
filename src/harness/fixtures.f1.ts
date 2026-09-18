// F1 canvas fixture: the drawing with a stroke IN THE AIR (the maintainer's
// recording of 2026-09-18). Framed through the harness's canvas root
// (`?harness=canvas&state=f1-draw-inking&w=640|960|1280`), the same door C2b's
// own drawing states use, on the same document, so the pair reads as one
// element in two states and never as two fixtures:
//
//   f1-draw-inking  the pen is down and moving. The cluster and the corner
//                   handle are OFF the paper, because the block is wearing
//                   `data-inking` and drawing.css takes both with it; the live
//                   path stands under the hand, one stroke that is not in the
//                   document yet. Read beside `c2-draw`, whose cluster is the
//                   same seven standing hot, this is the whole of what F1
//                   changed: the chrome answers the hover every other kind
//                   answers, and gets out of the way for the one state that
//                   asked C2b for a carve-out
//
// PRESSED, not drawn (fixtures.d3.ts's rule): the pose dispatches the
// product's own pointerdown and two pointermoves on the sheet and leaves the
// gesture OPEN, with no pointerup. So the live path, the attribute and the two
// controls that left are the product's own answer to a press and cannot drift
// from the gesture they stand for. A release would commit the stroke and hand
// the cluster back, which is the state `c2-draw` already holds.
//
// The document is C2b's, seeded here rather than imported: the ink, the cells
// and the chart beside it are that fixture's subject, and a frame of a stroke
// mid-air wants the same page under it so the two can be read side by side.
//
// Self-contained, like fixtures.d3.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add F1_CANVAS_STATES to the canvas harness's own state list, seed useCanvas
// with f1CanvasSeed() before the first render, call f1CanvasAfterMount(state)
// in the post-mount frame before the ready mark, and give these states
// F1_CANVAS_CARD_H.

import { writeStrokes, type Stroke } from "../canvas/strokes";
import { useCanvas, type Block, type CanvasMeta } from "../stores/canvas";

export const F1_CANVAS_STATES = ["f1-draw-inking"] as const;
export type F1CanvasState = (typeof F1_CANVAS_STATES)[number];

/** the card's own three widths, A3's (the canvas is not the pane) */
export const F1_CANVAS_WIDTHS = [640, 960, 1280] as const;

/** C2b's own drawing card: at the 640 floor the five columns reflow the sheet
 * under the chart, which is three rows of each plus the canvas strip */
export const F1_CANVAS_CARD_H = 860;

export const F1_CANVAS_PROFILE_ID = "harness-staging";
const CANVAS_ID = "f1-draw-canvas";
const EXCHANGE = "f1-draw-ex-1";

export interface F1CanvasSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, { v: 2; blocks: Block[]; lastColumns: number }>;
  editing: string | null;
}

// ---- the page (C2b's own, so the two states read as one element) -----------

const channels: Block = {
  id: "f1d-channels",
  kind: "result",
  question: "",
  title: "Orders by channel",
  prose: "",
  sql: "SELECT channel, count(*) AS orders\nFROM order_v2\nGROUP BY channel\nORDER BY orders DESC",
  columns: ["channel", "orders"],
  rows: [
    ["app", "1602"],
    ["web", "486"],
    ["instagram", "318"],
    ["whatsapp", "247"],
    ["marketplace", "118"],
    ["referral", "58"],
  ],
  chips: [],
  status: "6 rows · 142.0 ms",
  ms: 142,
  face: "chart",
  wroteBy: EXCHANGE,
  cell: { x: 0, y: 0, w: 4, h: 3 },
};

/** the ink already on the paper: the ring and the arrow of C2b's annotation,
 * inside basePx(3) = 348 on both axes so the element's own floor stays the
 * span the document gave it. The words are left off, because what this frame
 * is evidence of is the top-right corner and a hand in the middle of it */
const ANNOTATION: Stroke[] = writeStrokes([
  { k: "ellipse", c: 0, t: 2, b: [16, 22, 168, 96] },
  { k: "arrow", c: 0, t: 2, b: [198, 170, 120, 104] },
  { k: "text", c: 0, s: 13, at: [180, 196], v: "Gateway change, 12th" },
]);

const sheetBlock: Block = {
  id: "f1d-sheet",
  kind: "drawing",
  strokes: ANNOTATION,
  ink: 0,
  weight: 2,
  tool: "pen",
  cell: { x: 4, y: 0, w: 3, h: 3 },
};

export function f1CanvasSeed(): F1CanvasSeed {
  return {
    canvasId: CANVAS_ID,
    profileId: F1_CANVAS_PROFILE_ID,
    canvases: {
      [F1_CANVAS_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: F1_CANVAS_PROFILE_ID,
          title: "Orders, last month",
          updatedAt: "2026-09-18T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: { v: 2, blocks: [channels, sheetBlock], lastColumns: 7 } },
    editing: null,
  };
}

// ---- the pose --------------------------------------------------------------

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** the page as it FINALLY stands: the document is stored at 7 columns and the
 * 640 floor affords 5, so the surface measures, tells the store, and the store
 * hands back a derived layout a frame or two later. A press against the
 * pre-reflow rect would put the stroke somewhere the sheet no longer is
 * (fixtures.c2draw.ts's own wait) */
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
  throw new Error(`f1: the page never settled around ${blockId}`);
}

/** the pointer a pose presses with. The capture the handler takes is stubbed
 * for the length of the press: a synthetic pointer owns no device, and
 * `setPointerCapture` throws on an id no device owns (fixtures.d3.ts) */
const POINTER_ID = 1;

function send(node: Element, type: string, x: number, y: number): void {
  node.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      pointerId: POINTER_ID,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
}

/** where the stroke starts, from the sheet's own top-left, and the two points
 * it has reached: a short curve across the middle of the paper, clear of the
 * ink already there and clear of the corner the frame is about */
const FROM = { x: 84, y: 250 };
const VIA = { x: 150, y: 214 };
const TO = { x: 214, y: 246 };

export async function f1CanvasAfterMount(state: string): Promise<void> {
  if (!(F1_CANVAS_STATES as readonly string[]).includes(state)) return;
  await frame();
  const el = await laidOut(sheetBlock.id);
  const sheet = el.querySelector(".dw-sheet");
  if (!sheet) throw new Error("f1-draw-inking: the sheet is not on the page");
  const box = sheet.getBoundingClientRect();
  const at = (p: { x: number; y: number }) => ({ x: box.left + p.x, y: box.top + p.y });
  // the capture belongs to a device this pose does not have; `Element` and not
  // `HTMLElement`, because the node the handler captures on is an <svg>
  const proto = Element.prototype;
  const capture = proto.setPointerCapture;
  proto.setPointerCapture = () => {};
  try {
    // left OPEN, with no pointerup: a still of a stroke is a stroke mid-air,
    // and the release is what would commit it and hand the cluster back
    const down = at(FROM);
    send(sheet, "pointerdown", down.x, down.y);
    const via = at(VIA);
    send(sheet, "pointermove", via.x, via.y);
    const to = at(TO);
    send(sheet, "pointermove", to.x, to.y);
  } finally {
    proto.setPointerCapture = capture;
  }
  await frame();
}
