// D4 canvas fixtures: the page at a column count BELOW the one its layout was
// authored at, and what a drop there leaves behind. Framed through the
// harness's canvas root (`?harness=canvas&state=…&w=640|960|1280`), the same
// door C2a's, C2b's, D1's, D2's and D3's states use. The DOCUMENT is canned
// exactly as the store holds it and the layout is the product's own answer to
// it, so a fixture can never draw a page the product cannot produce.
//
// The page is the maintainer's second recording, in the product's own words: a
// tall note at the top left and a one-row note beside it, a layout six columns
// wide in a document whose `lastColumns` says seven. The card's 640 floor
// holds five, so the page arrives NARROWER than the layout and the reflow is
// what the reader sees.
//
//   d4-derived       the authored document, seeded whole, as the page it
//                    arrives on draws it: at the 640 floor that is the flowed
//                    layout, the one-row note UNDER the tall one in the
//                    reading order it had, committed once and the document's
//                    own now (D4's one-layout rule). At 960 and 1280 the
//                    layout fits and nothing flows, which is the same state
//                    read on a page wide enough for it
//   d4-derived-drop  the moment after a drop at that count: the one-row note
//                    on the cells the placeholder stood on and the tall one
//                    pushed to the first row that clears it (D3 rule 1). The drop
//                    is the document's, and the next measure cannot take it
//                    back, which is the finding this wave answers
//
// Both are pages at REST: what each is evidence of has already happened, and
// the gesture that made it is the probe's subject rather than a still's
// (d4-probe.ts drives the product's own pointer handlers at 660, 960 and
// 1280).
//
// Self-contained, like fixtures.d3.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add D4_CANVAS_STATES to the canvas harness's own state list, seed useCanvas
// with d4CanvasSeed(state) before the first render, call d4CanvasAfterMount(
// state) in the post-mount frame before the ready mark, and give these states
// d4CanvasCardH(state).

import { useCanvas, type Block, type CanvasMeta } from "../stores/canvas";
import type { Cell } from "../canvas/grid";

export const D4_CANVAS_STATES = ["d4-derived", "d4-derived-drop"] as const;
export type D4CanvasState = (typeof D4_CANVAS_STATES)[number];

/** each state on the card its own page needs, MEASURED against the build and
 * never derived (the D2 rule): the reflowed page is five rows at the 640 floor
 * and the drop pushes the tall note three rows down for seven, and
 * each number is what a CDP read of `.cv-scroll` returned as zero overflow at
 * 640, 960 and 1280. They run 38 past D3's own pair, which are the same two
 * row counts on a page whose notes hold one line fewer */
const D4_REST_CARD_H = 738;
const D4_DROP_CARD_H = 978;

export const d4CanvasCardH = (state: string): number =>
  state === "d4-derived-drop" ? D4_DROP_CARD_H : D4_REST_CARD_H;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
const D4_CANVAS_PROFILE_ID = "harness-staging";
const CANVAS_ID = "d4-canvas";

export interface D4CanvasSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDocSeed>;
  /** useCanvas.editing: no caret stands in either of these states */
  editing: string | null;
}

type CanvasDocSeed = { v: 2; blocks: Block[]; lastColumns: number };

// ---- the two widgets -------------------------------------------------------

const LONG_ID = "d4-long";
const SHORT_ID = "d4-short";

/** the tall one, three cells wide and four down at the top left: the recording's
 * own first note, whose words fill its rows so what it stands on is legible in
 * the frame rather than inferred from its top edge (fixtures.d3.ts's rule) */
const long = (cell: Cell): Block => ({
  id: LONG_ID,
  kind: "note",
  text: [
    "Refunds are the only line that grew this week, and every one of them came through the app.",
    "",
    "The web checkout is flat, so it is the app build and not the gateway.",
    "",
    "Support see the same window every evening, 19:00 to 21:00, since the 12th.",
    "",
    "Payments hold the trace and answer on Monday. Nothing here moves until they do.",
  ].join("\n"),
  cell,
});

/** and the one beside it, three wide and one row tall. Together they claim six
 * columns of a page the floor holds five of, which is the whole setup */
const short = (cell: Cell): Block => ({
  id: SHORT_ID,
  kind: "note",
  text: "Ask again once the trace lands.",
  cell,
});

/** the document as it was AUTHORED: six columns of layout, `lastColumns` seven.
 * The fixture seeds this and the PRODUCT does the flow, because the flow is
 * the thing under test: a page that arrives narrower than its layout commits
 * one reflow and stands on it. At 640 that is the one-row note under the tall
 * one; at 960 and 1280 the layout fits and nothing flows */
const AUTHORED: Block[] = [long({ x: 0, y: 0, w: 3, h: 4 }), short({ x: 3, y: 0, w: 3, h: 1 })];

/** and the page a drop at that count leaves: the one-row note on the cells the
 * placeholder stood on (column 2, row 3) and the tall one pushed to the first
 * row that clears it, the hole at the top standing. This is
 * `move(reflow(AUTHORED, 5), d4-short, { x: 1, y: 2 }, 5)` written out, so the
 * fixture draws the engine's own answer and never a hand-typed one, and
 * `lastColumns` is 5 because 5 is the count the drop was committed at */
const DROPPED: Block[] = [long({ x: 0, y: 3, w: 3, h: 4 }), short({ x: 1, y: 2, w: 3, h: 1 })];

// ---- the seed --------------------------------------------------------------

export function d4CanvasSeed(state: string): D4CanvasSeed {
  const s = (D4_CANVAS_STATES as readonly string[]).includes(state)
    ? (state as D4CanvasState)
    : "d4-derived";
  const blocks = s === "d4-derived-drop" ? DROPPED : AUTHORED;
  return {
    canvasId: CANVAS_ID,
    profileId: D4_CANVAS_PROFILE_ID,
    canvases: {
      [D4_CANVAS_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: D4_CANVAS_PROFILE_ID,
          title: "Refunds, this week",
          updatedAt: "2026-09-15T09:00:00.000Z",
        },
      ],
    },
    docs: {
      [CANVAS_ID]: {
        v: 2,
        blocks: blocks.map((b) => ({ ...b })),
        lastColumns: s === "d4-derived-drop" ? 5 : 7,
      },
    },
    editing: null,
  };
}

// ---- the pose --------------------------------------------------------------

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** hold until the page stands where the document says it does: the column
 * count is measured in a layout effect and a narrower page commits its reflow
 * there, so a mark before that would be a mark on the authored layout
 * (fixtures.d3.ts's own wait) */
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
  throw new Error(`d4: the page never settled around ${blockId}`);
}

export async function d4CanvasAfterMount(state: string): Promise<void> {
  if (!(D4_CANVAS_STATES as readonly string[]).includes(state)) return;
  await laidOut(LONG_ID);
  await laidOut(SHORT_ID);
}
