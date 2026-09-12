// C2b's empty grid for the design harness (the "C1 · the grid" row c1-empty of
// ask-sketch-c1.html). The canvas is a MAIN-AREA face, so these states are
// framed through the harness's second root (`?harness=canvas&state=…&
// w=640|960|1280`) at the card's own three widths:
//
//   c2-empty        a canvas with nothing on it: 0 strings, 0 controls, and a
//                   caret in the page's FIRST cell. The count A3 set and B3
//                   kept, unmoved by a wave that added a species: what an
//                   empty page carries is a place to write and nothing that
//                   explains it (DESIGN rule 11)
//   c2-empty-place  the same page mid-press, four cells in and a row down: the
//                   lattice showing for the length of the press, and the caret
//                   standing in the cell the press landed in. The cells are
//                   invisible at rest and a placement is exactly when where
//                   they are matters, so they arrive with the press and leave
//                   with it (C2b call 6)
//
// The second state holds something no still can: a press. It is PRESSED, not
// drawn - the pose dispatches the product's own pointerdown and click on the
// page and never releases - so the lattice, the cell the caret lands in and
// the caret's own box are the product's answer and cannot drift from the
// gesture they stand for (fixtures.c2grid.ts's rule for the drag states).
//
// Self-contained, like fixtures.c2grid.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add C2_EMPTY_STATES to the canvas harness's own state list, seed useCanvas
// with c2EmptySeed() before the first render, call c2EmptyAfterMount(state) in
// the post-mount frame before the ready mark, and give these states
// C2_EMPTY_CARD_H.

import { CELL_H, cellMetrics } from "../canvas/grid";
import type { CanvasDoc, CanvasMeta } from "../stores/canvas";

export const C2_EMPTY_STATES = ["c2-empty", "c2-empty-place"] as const;
export type C2EmptyState = (typeof C2_EMPTY_STATES)[number];

/** the card's own three widths, A3's (the canvas is not the pane) */
export const C2_EMPTY_WIDTHS = [640, 960, 1280] as const;

/** an empty page is read whole at A3's own card height: what it is evidence of
 * is how little is on it */
export const C2_EMPTY_CARD_H = 560;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
export const C2_EMPTY_PROFILE_ID = "harness-staging";
const CANVAS_ID = "c2-empty-canvas";

export interface C2EmptySeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDoc>;
  /** useCanvas.editing: the caret on this page is the PAGE's own draft line,
   * which is not a block and never reaches the document, so the store's own
   * edit id stands empty in both states */
  editing: string | null;
}

export function c2EmptySeed(): C2EmptySeed {
  const doc: CanvasDoc = { v: 2, blocks: [] };
  return {
    canvasId: CANVAS_ID,
    profileId: C2_EMPTY_PROFILE_ID,
    canvases: {
      [C2_EMPTY_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: C2_EMPTY_PROFILE_ID,
          title: "Orders, last month",
          updatedAt: "2026-09-12T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: doc },
    editing: null,
  };
}

// ---- the pose --------------------------------------------------------------

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** the cell the press lands in: far enough in and down that the caret cannot
 * be mistaken for the page's own first line, and inside the five columns the
 * 640 floor affords so the frame is the same cell at all three widths */
const PLACE = { x: 3, y: 1 };

function send(node: HTMLElement, type: string, x: number, y: number): void {
  const init = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
  node.dispatchEvent(
    type === "click"
      ? new MouseEvent(type, init)
      : new PointerEvent(type, { ...init, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }),
  );
}

/** press the page where a person would, through the PRODUCT's own handlers:
 * the pointerdown is what shows the cells and the click is what puts the caret
 * in one. The press is left OPEN, with no pointerup, because the lattice
 * belongs to the press and a released one has none */
async function place(): Promise<void> {
  const host = document.querySelector<HTMLElement>(".cvg");
  const page = host?.parentElement;
  if (!host || !page) throw new Error("c2-empty-place: the grid is not on the page");
  const m = cellMetrics(host.clientWidth);
  const box = host.getBoundingClientRect();
  const x = box.left + PLACE.x * (m.cellW + m.gutter) + m.cellW / 2;
  const y = box.top + PLACE.y * (CELL_H + m.gutter) + CELL_H / 2;
  // the page under the grid takes the press: an empty grid is 0 rows tall, so
  // the point is over the scroller itself, which is where the click lands for
  // any cell below the last element
  send(page, "pointerdown", x, y);
  send(page, "click", x, y);
  await frame();
  // the caret itself cannot be SHOT (it blinks, and the settle lands in
  // whichever phase it lands in), so the frame asserts it instead: the draft
  // slot stands, it stands in the cell the press was in, and the words go into
  // it (b3-canvas-empty's own rule for a state whose subject is a caret)
  const draft = document.querySelector<HTMLElement>(".cvg-draft");
  if (!draft) throw new Error("c2-empty-place: the press left no caret line");
  const at = { x: Number(draft.style.getPropertyValue("--x")), y: Number(draft.style.getPropertyValue("--y")) };
  if (at.x !== PLACE.x || at.y !== PLACE.y) {
    throw new Error(`c2-empty-place: the caret landed at ${at.x},${at.y} and not at ${PLACE.x},${PLACE.y}`);
  }
  if (!draft.contains(document.activeElement)) {
    throw new Error("c2-empty-place: the caret line does not hold the caret");
  }
}

/** the post-mount hook: one state is the page at rest and the other is the
 * same page under a finger */
export async function c2EmptyAfterMount(state: string): Promise<void> {
  if (!(C2_EMPTY_STATES as readonly string[]).includes(state)) return;
  // the measure is a layout effect and the caret a render: the frame is posed
  // against the page as it finally stands, never as it first mounted
  await frame();
  if (state === "c2-empty-place") await place();
}
