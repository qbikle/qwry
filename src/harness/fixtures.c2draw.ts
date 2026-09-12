// C2b drawing fixtures for the design harness (the "C1 · the grid" rows of
// ask-sketch-c1.html, c1-draw). The canvas is a MAIN-AREA face, so these
// states are framed through the harness's second root
// (`?harness=canvas&state=…&w=640|960|1280`) at the card's own three widths:
//
//   c2-draw        the wave's own picture: a bars chart and, BESIDE it, the
//                  drawing that annotates it. A ring around the two channels
//                  that carry the month, an arrow from the words to the ring,
//                  the words themselves and a freehand underline under them,
//                  every stroke in the accent ladder the chart is drawn in.
//                  The drawing is hot, so its cluster stands: the grip, then
//                  `Pen ▾` wearing the armed tool's own glyph, then Undo ·
//                  Redo, then Copy · Ask · More. Undo and Redo both stand
//                  DISABLED here, which is the truthful picture of a page just
//                  opened: the history is the element's and dies with its
//                  unmount, so a drawing read back from appdb has none. They
//                  hold their slots rather than vanishing, because a cluster
//                  that changes shape as a stack fills is a cluster whose
//                  width nobody can design for (DESIGN rule 13).
//                  At the 640 floor the five columns the width affords
//                  cannot hold a 4-wide chart beside a 3-wide sheet, so the
//                  store derives a reflow and the drawing stands under the
//                  chart, its ink unmoved: strokes are element pixels at 1:1,
//                  so a narrower page reveals or hides paper and never
//                  stretches a circle into an ellipse
//   c2-draw-small  the floor test (DESIGN rule 13): a 2x2 drawing, the kind's
//                  own minimum, at 640 with its cluster hot. Two cells are
//                  235px (2 x 111.6 + 12) and seven slots measure 170px, so
//                  the evidence that the cluster fits its smallest element is
//                  this frame and not a sentence
//   c2-draw-tools  the picker OPEN on the same document: the six tools, each
//                  wearing its own mark and its one-key chord, then the ink
//                  and the weight the next stroke takes. Pressed, not drawn
//                  (the A3 rule for transient chrome): the fixture clicks the
//                  product's own `Pen ▾` and the menu that opens is the
//                  product's. The press waits for the page to SETTLE first:
//                  at the floor the stored 7 columns reflow to 5 a frame or
//                  two after mount, and a menu anchored to the button's
//                  pre-reflow rect was clamped to the card's right edge,
//                  400px from the button it belongs to (the frame then being
//                  evidence of the race and not of the picker)
//   c2-draw-empty  a sheet from `New Drawing` with nothing on it, at REST: 0
//                  controls, 0 strings and one surface, the paper the caret's
//                  own empty note does not need because words arrive where
//                  they are typed and ink does not (AGENT-UX 16w)
//   c2-draw-novision  the same document as c2-draw with a model the registry
//                  documents WITHOUT vision. The cluster is six and not
//                  seven: `Ask` on a drawing is ABSENT where the chosen model
//                  cannot read a picture, never disabled and never explained
//                  (C2b call 4, DESIGN rule 2's matrix). The two frames read
//                  side by side are the whole of that enforcement
//
// Every block is canned exactly as the store holds it, and the strokes are
// canned as `writeStrokes` would leave them, so a fixture can never draw ink
// the product cannot produce. The cells are the document's own: what the
// surface draws is `laidOut(blocks, columns)` and nothing else.
//
// The ink lives inside the 3x3 sheet measured against the BASE cell
// (basePx(3) = 348), which is what keeps the element's own floor at the span
// it was given: a drawing's minimum grows with its strokes (the store's
// `minSpanFor`), so ink past 348 would silently widen the element and the
// frame would stop being evidence for the layout it claims.
//
// Self-contained, like fixtures.c2grid.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add C2_DRAW_STATES to the canvas harness's own state list, seed useCanvas
// with c2DrawSeed(state) before the first render, call c2DrawAfterMount(state)
// in the post-mount frame before the ready mark, and give these states
// c2DrawCardH(state).

import { cellMetrics } from "../canvas/grid";
import { writeStrokes, type Stroke } from "../canvas/strokes";
import { useCanvas, type Block, type CanvasDoc, type CanvasMeta } from "../stores/canvas";

export const C2_DRAW_STATES = [
  "c2-draw",
  "c2-draw-small",
  "c2-draw-tools",
  "c2-draw-empty",
  "c2-draw-novision",
] as const;
export type C2DrawState = (typeof C2_DRAW_STATES)[number];

/** the card's own three widths, A3's (the canvas is not the pane) */
export const C2_DRAW_WIDTHS = [640, 960, 1280] as const;

/** a card tall enough to read the whole document at the FLOOR, where the
 * reflow stacks the sheet under the chart: 3 rows of chart plus 3 of sheet is
 * 6 rows, 708px, and this is that plus the tab bar and the page's own inset */
const C2_DRAW_CARD_H = 820;
/** the small state is two rows and nothing else */
const C2_SMALL_CARD_H = 420;
/** and the empty sheet is three: a card taller than the page would be
 * evidence of nothing but the card (the empty grid's own rule) */
const C2_EMPTY_CARD_H = 480;

export const c2DrawCardH = (state: string): number =>
  state === "c2-draw-small" ? C2_SMALL_CARD_H : state === "c2-draw-empty" ? C2_EMPTY_CARD_H : C2_DRAW_CARD_H;

/** the model each state runs under. Every state but one takes the harness's
 * own (`claude -p` on a Claude row, which reads images); `c2-draw-novision`
 * takes a local gguf the registry documents WITHOUT a vision tower, because
 * the frame's whole subject is the button that is then not there. The choice
 * is the FIXTURE's, not the harness's, for the same reason the document is:
 * what a frame is evidence of is the state it names */
export const c2DrawChoice = (state: string): { provider: string; model: string } | null =>
  state === "c2-draw-novision" ? { provider: "llama-server", model: "Qwen3-4B-Q4_K_M" } : null;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
export const C2_DRAW_PROFILE_ID = "harness-staging";
const CANVAS_ID = "c2-draw-canvas";

export interface C2DrawSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDoc>;
  /** useCanvas.editing: no caret stands in any of these states */
  editing: string | null;
}

const EXCHANGE = "c2-draw-ex-1";

// ---- the chart the drawing annotates ---------------------------------------

const channels: Block = {
  id: "c2d-channels",
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

// ---- the ink ---------------------------------------------------------------
//
// Element pixels from the sheet's top-left, at 1:1. A 3x3 sheet is 348px of
// base cell on both axes, so every number below is inside that and the
// element's own floor stays the span the document gave it.

const ANNOTATION: Stroke[] = writeStrokes([
  // the ring, around the two bars that carry the month
  { k: "ellipse", c: 0, t: 2, b: [16, 22, 168, 96] },
  // the arrow, from the words up to the ring
  { k: "arrow", c: 0, t: 2, b: [198, 170, 120, 104] },
  // the words
  { k: "text", c: 0, s: 13, at: [180, 196], v: "Gateway change, 12th" },
  // one label per step of the ink ladder, and a hairline in the lowest step:
  // the legibility of a step is a thing a frame proves and a sentence only
  // asserts, and the light theme is where it is decided (DESIGN rule 3)
  { k: "text", c: 0, s: 13, at: [16, 258], v: "Accent" },
  { k: "text", c: 1, s: 13, at: [16, 282], v: "Accent 78%" },
  { k: "text", c: 2, s: 13, at: [16, 306], v: "Accent 56%" },
  { k: "line", c: 2, t: 1, b: [110, 302, 330, 302] },
  // and the freehand underline a hand actually makes: not a straight line,
  // and simplified on commit the way the element commits one
  {
    k: "pen",
    c: 1,
    t: 2,
    p: [
      180, 206, 196, 209, 214, 205, 232, 210, 250, 207, 268, 211, 286, 206, 304, 210, 318, 207,
    ],
  },
]);

/** the same hand, smaller: what a two-cell sheet holds. Inside basePx(2) =
 * 228 on both axes, so the floor state's element is genuinely 2x2 */
const SMALL: Stroke[] = writeStrokes([
  { k: "ellipse", c: 0, t: 2, b: [18, 20, 132, 86] },
  { k: "arrow", c: 0, t: 2, b: [150, 150, 96, 94] },
  { k: "text", c: 1, s: 13, at: [16, 186], v: "check this" },
]);

const sheet: Block = {
  id: "c2d-sheet",
  kind: "drawing",
  strokes: ANNOTATION,
  ink: 0,
  weight: 2,
  tool: "pen",
  cell: { x: 4, y: 0, w: 3, h: 3 },
};

const small: Block = {
  id: "c2d-small",
  kind: "drawing",
  strokes: SMALL,
  ink: 0,
  weight: 2,
  tool: "pen",
  cell: { x: 0, y: 0, w: 2, h: 2 },
};

/** the note beside the small drawing, so the floor frame reads as a page and
 * not as one element alone: 2 + 3 is the five columns 640 affords exactly */
const aside: Block = {
  id: "c2d-aside",
  kind: "note",
  text: "Two channels carry the month; the failed share has not moved since the gateway change.",
  autoH: true,
  cell: { x: 2, y: 0, w: 3, h: 2 },
};

// ---- the seed --------------------------------------------------------------

/** the sheet `New Drawing` leaves: the kind's own default span, no ink, no
 * tool memory. What it is evidence of is how little is on it */
const fresh: Block = {
  id: "c2d-fresh",
  kind: "drawing",
  strokes: [],
  cell: { x: 0, y: 0, w: 3, h: 3 },
};

function blocksFor(state: C2DrawState): { blocks: Block[]; lastColumns: number } {
  if (state === "c2-draw-small") return { blocks: [small, aside], lastColumns: 5 };
  if (state === "c2-draw-empty") return { blocks: [fresh], lastColumns: 5 };
  return { blocks: [channels, sheet], lastColumns: 7 };
}

export function c2DrawSeed(state: string): C2DrawSeed {
  const s = (C2_DRAW_STATES as readonly string[]).includes(state) ? (state as C2DrawState) : "c2-draw";
  const { blocks, lastColumns } = blocksFor(s);
  return {
    canvasId: CANVAS_ID,
    profileId: C2_DRAW_PROFILE_ID,
    canvases: {
      [C2_DRAW_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: C2_DRAW_PROFILE_ID,
          title: "Orders, last month",
          updatedAt: "2026-09-12T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: { v: 2, blocks, lastColumns } },
    editing: null,
  };
}

// ---- the poses -------------------------------------------------------------

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** the block the sketch shows hot. A hover cannot be held in a still, so the
 * cluster is revealed the way every canvas state reveals one: `data-hot` on
 * the element it floats over (canvas.css reads it as that block's hover) */
const hotBlock = (state: C2DrawState): string | null =>
  // the empty sheet is read at REST: its whole subject is what an element
  // with no ink carries, and a cluster stamped hot would be the frame
  // answering its own question
  state === "c2-draw-empty" ? null : state === "c2-draw-small" ? small.id : sheet.id;

/** wait for a node to appear, a frame at a time, so a pose never races the
 * commit that renders what it is posing (the canvas states' own shape) */
async function settled(selector: string, tries = 12): Promise<HTMLElement | null> {
  for (let i = 0; i < tries; i++) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    await frame();
  }
  return null;
}

/** the page as it FINALLY stands, not as it first mounted. The document is
 * stored at 7 columns and the 640 floor affords 5, so the surface measures,
 * tells the store, and the store hands back a derived layout a frame or two
 * later; a menu anchored to a button's pre-reflow rect is clamped to the
 * card's edge and lands hundreds of pixels from the control it belongs to.
 * So the pose waits for two things to agree — the LAYOUT fits the page it
 * stands on, and the DOM slot stands where the store says the block does —
 * which is the same pair `fixtures.c2empty.ts place()` reads off the live
 * metrics before it asserts a caret's cell. */
async function laidOut(blockId: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const host = document.querySelector<HTMLElement>(".cvg");
    const slot = document.querySelector<HTMLElement>(`[data-block="${blockId}"]`)?.closest(".cvg-slot");
    const blocks = useCanvas.getState().docs[CANVAS_ID]?.blocks ?? [];
    const cell = blocks.find((b) => b.id === blockId)?.cell;
    if (host && slot instanceof HTMLElement && cell) {
      const edge = blocks.reduce((w, b) => Math.max(w, (b.cell?.x ?? 0) + (b.cell?.w ?? 1)), 0);
      const at = {
        x: Number(slot.style.getPropertyValue("--x")),
        y: Number(slot.style.getPropertyValue("--y")),
      };
      if (edge <= cellMetrics(host.clientWidth).columns && at.x === cell.x && at.y === cell.y) return;
    }
    await frame();
  }
  throw new Error(`c2-draw: the page never settled around ${blockId}`);
}

/** the picker, opened by pressing the button that opens it. A menu is
 * transient chrome with no store door, and a fixture that drew its rows itself
 * would be evidence for a menu the product never builds */
async function openPicker(blockId: string): Promise<void> {
  // the press is worth nothing until the page has stopped moving under it:
  // the menu anchors to the button's rect at the instant of the click
  await laidOut(blockId);
  // `.dw-pick` and not "the first button with a menu": `More` opens one too,
  // and a pose that counted buttons would shoot the wrong menu the day the
  // roster changes
  const button = await settled(`[data-block="${blockId}"] .dw-pick`);
  if (!button) throw new Error("c2-draw-tools: the picker's button is not on the page");
  button.click();
  const menu = await settled(".ov-anchor-layer .ctx-menu");
  if (!menu) throw new Error("c2-draw-tools: the picker did not open");
  await frame();
}

/** the post-mount hook. A hover cannot be held in a still, so the block the
 * sketch shows hot is stamped on the element the cluster floats over, and the
 * one state whose subject is a menu presses it open */
export async function c2DrawAfterMount(state: string): Promise<void> {
  if (!(C2_DRAW_STATES as readonly string[]).includes(state)) return;
  const s = state as C2DrawState;
  // the measure is a layout effect and the reflow a render: the frame is posed
  // against the page as it finally stands, never as it first mounted
  await frame();
  const hot = hotBlock(s);
  if (hot) {
    await laidOut(hot);
    const el = document.querySelector<HTMLElement>(`[data-block="${hot}"]`);
    if (el) el.dataset.hot = "";
  } else {
    await laidOut(fresh.id);
  }
  if (s === "c2-draw-tools") await openPicker(sheet.id);
}
