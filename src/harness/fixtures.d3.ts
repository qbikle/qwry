// D3 canvas fixtures: what a drag does to the widgets it does NOT touch, and
// what the page looks like the instant after a drop. Framed through the
// harness's canvas root (`?harness=canvas&state=…&w=640|960|1280`), the same
// door C2a's, C2b's, D1's and D2's states use, and every block is canned
// exactly as the store holds it, so a fixture can never draw a document the
// product cannot produce.
//
// The page is the maintainer's screen recording, in the product's own words: a
// short note at the top left and a longer one below and to its right, with
// clear ground between them.
//
//   d3-drag-nonintersecting  the short note lifted and held over empty cells
//                            two rows down, where it touches nothing: the
//                            lattice on, the placeholder on the cells it will
//                            take, `2 × 2` at its corner, and the longer note
//                            standing EXACTLY where it stood. Before D3 it
//                            floated up into the vacated row, which is the
//                            finding this wave answers (D3 rule 1)
//   d3-drop-settled          the moment after a drop that DID land on
//                            something: the short note on the cells the
//                            placeholder stood on, the longer note in the one
//                            place the push put it, and the hole the lift left
//                            at the top left standing. No gesture chrome: the
//                            drop is over, and one frame later nothing has
//                            moved again (D3 rules 1 and 3)
//
// The drag state is PRESSED, not drawn (fixtures.c2grid.ts's rule): the pose
// dispatches the product's own pointerdown and pointermove on the grip and
// leaves the gesture open, so the lift, the placeholder, its size label and
// every neighbour the engine did or did not displace are the product's own
// answer and cannot drift from the gesture they stand for.
//
// Laid out at the 5-column FLOOR (DESIGN rule 13), so 960 and 1280 stand on
// the same layout with spare columns at the right.
//
// Self-contained, like fixtures.d2canvas.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add D3_CANVAS_STATES to the canvas harness's own state list, seed useCanvas
// with d3CanvasSeed(state) before the first render, call d3CanvasAfterMount(
// state) in the post-mount frame before the ready mark, and give these states
// d3CanvasCardH(state).

import { CELL_H, cellMetrics, type Cell } from "../canvas/grid";
import { useCanvas, type Block, type CanvasMeta } from "../stores/canvas";

export const D3_CANVAS_STATES = ["d3-drag-nonintersecting", "d3-drop-settled"] as const;
export type D3CanvasState = (typeof D3_CANVAS_STATES)[number];

/** the card's own three widths, A3's: the canvas is a face of the main card */
export const D3_CANVAS_WIDTHS = [640, 960, 1280] as const;

/** each state on the card its own page needs, measured and not derived (the D2
 * rule): the drag holds the page at five rows at the 640 floor, 588px, and the
 * drop pushes the longer note two rows further down for seven, 828px. Each is
 * that plus the 40px canvas strip, the tab bar and the scroller's own inset,
 * so neither is read on a card the other would leave two rows of air in */
const D3_DRAG_CARD_H = 700;
const D3_DROP_CARD_H = 940;

export const d3CanvasCardH = (state: string): number =>
  state === "d3-drop-settled" ? D3_DROP_CARD_H : D3_DRAG_CARD_H;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
export const D3_CANVAS_PROFILE_ID = "harness-staging";
const CANVAS_ID = "d3-canvas";

export interface D3CanvasSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDocSeed>;
  /** useCanvas.editing: no caret stands in either of these states */
  editing: string | null;
}

type CanvasDocSeed = { v: 2; blocks: Block[]; lastColumns: number };

// ---- the two widgets -------------------------------------------------------

/** the one a hand lifts: two cells by two, at the top left, the way the
 * recording's own short note stood */
const LIFTED_ID = "d3-lifted";
const STANDING_ID = "d3-standing";

const lifted = (cell: Cell): Block => ({
  id: LIFTED_ID,
  kind: "note",
  text: "Refunds are the only line that grew.",
  cell,
});

/** and the one below and to its right, which no part of the gesture reaches.
 * Its words fill three rows of cells at the floor, so what it is standing on
 * is legible in the frame rather than inferred from its top edge */
const standing = (cell: Cell): Block => ({
  id: STANDING_ID,
  kind: "note",
  text: [
    "Gateway timeouts cluster between 19:00 and 21:00, every evening since the 12th.",
    "",
    "Payments hold the trace and answer on Monday. Nothing here moves until they do.",
  ].join("\n"),
  cell,
});

/** the page at rest, at the 5-column floor: the short note on the first cells,
 * the longer one two rows down and three columns across, and clear ground
 * between them. The drag state is posed FROM this */
const AT_REST: Block[] = [lifted({ x: 0, y: 0, w: 2, h: 2 }), standing({ x: 3, y: 2, w: 2, h: 3 })];

/** and the page a drop that landed ON something leaves: the short note where
 * the placeholder stood (column 3, row 3), the longer one pushed down by the
 * two rows that clear it, and the hole at the top left standing. This is
 * `move(AT_REST, d3-lifted, { x: 2, y: 2 }, 5)` written out, so the fixture
 * draws the engine's own answer and never a hand-typed one */
const SETTLED: Block[] = [lifted({ x: 2, y: 2, w: 2, h: 2 }), standing({ x: 3, y: 4, w: 2, h: 3 })];

// ---- the seed --------------------------------------------------------------

export function d3CanvasSeed(state: string): D3CanvasSeed {
  const s = (D3_CANVAS_STATES as readonly string[]).includes(state)
    ? (state as D3CanvasState)
    : "d3-drag-nonintersecting";
  const blocks = s === "d3-drop-settled" ? SETTLED : AT_REST;
  return {
    canvasId: CANVAS_ID,
    profileId: D3_CANVAS_PROFILE_ID,
    canvases: {
      [D3_CANVAS_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: D3_CANVAS_PROFILE_ID,
          title: "Checkout, this week",
          updatedAt: "2026-09-15T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: { v: 2, blocks: blocks.map((b) => ({ ...b })), lastColumns: 5 } },
    editing: null,
  };
}

// ---- the pose --------------------------------------------------------------

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** hold until the page stands where the document says it does: the column
 * count is measured in a layout effect, so a pose before it lands would be a
 * pose against the first render (fixtures.d2canvas.ts's own wait) */
async function laidOut(blockId: string, tries = 60): Promise<HTMLElement> {
  for (let i = 0; i < tries; i++) {
    const slot = document.querySelector<HTMLElement>(`[data-block="${blockId}"]`)?.closest(".cvg-slot");
    const cell = useCanvas.getState().docs[CANVAS_ID]?.blocks.find((b) => b.id === blockId)?.cell;
    if (slot instanceof HTMLElement && cell) {
      const at = {
        x: Number(slot.style.getPropertyValue("--x")),
        y: Number(slot.style.getPropertyValue("--y")),
      };
      if (at.x === cell.x && at.y === cell.y) return slot;
    }
    await frame();
  }
  throw new Error(`d3: the page never settled around ${blockId}`);
}

/** the pointer a pose presses with. The capture the handler takes is stubbed
 * for the length of the press: a synthetic pointer owns no device, and
 * `setPointerCapture` throws on an id no device owns */
const POINTER_ID = 1;

function send(node: HTMLElement, type: string, x: number, y: number): void {
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

/** how far off its snap the held element stands, in px: under half a cell on
 * either axis, so the cell the pose names is the cell the gesture snaps to,
 * and the SIGN is the point. The element stands left of and below its
 * placeholder, which leaves the placeholder's own bottom-right corner and the
 * one size label riding it in view (fixtures.c2grid.ts's own two numbers) */
const OFF_X = 52;
const OFF_Y = 36;

export async function d3CanvasAfterMount(state: string): Promise<void> {
  if (!(D3_CANVAS_STATES as readonly string[]).includes(state)) return;
  // the drop state is a page at rest: what it is evidence of already happened
  if (state === "d3-drop-settled") {
    await laidOut(LIFTED_ID);
    return;
  }
  const slot = await laidOut(LIFTED_ID);
  await laidOut(STANDING_ID);
  const host = document.querySelector<HTMLElement>(".cvg");
  const grip = slot.querySelector<HTMLElement>(".cvg-grip");
  if (!host || !grip) throw new Error("d3-drag-nonintersecting: the element is not on the page");
  const m = cellMetrics(host.clientWidth);
  const px = m.cellW + m.gutter;
  const py = CELL_H + m.gutter;
  // one column in and two rows down: empty cells the whole way, and one column
  // in rather than the page's own edge because the element stands LEFT of its
  // placeholder and an element held over the edge is one the scroller cuts. It
  // comes to rest BESIDE the longer note and clears its columns, which is what
  // the state is evidence of: before D3 the longer note rose two rows into the
  // ground the lift had just left
  const to = { x: 1, y: 2 };
  const box = grip.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const proto = HTMLElement.prototype;
  const capture = proto.setPointerCapture;
  proto.setPointerCapture = () => {};
  try {
    // the press is left OPEN, with no pointerup: a still of a drag is a drag
    // mid-air, and the release is what would commit it
    send(grip, "pointerdown", x, y);
    send(grip, "pointermove", x + to.x * px - OFF_X, y + to.y * py + OFF_Y);
  } finally {
    proto.setPointerCapture = capture;
  }
}
