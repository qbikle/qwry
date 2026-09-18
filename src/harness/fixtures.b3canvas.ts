// B3 canvas fixtures for the design harness (the four "B3 · the canvas the
// model writes" canvas rows of ask-sketch-b3.html). The canvas is a MAIN-AREA
// face, so these states are framed through the harness's second root
// (`?harness=canvas&state=…&w=640|960|1280`) at the card's own three widths,
// with the card at 800 tall (A3's 760 held three blocks; a four-block answer
// with a chart among them needs the extra 40):
//
//   b3-canvas-analysis   one exchange's four blocks: the values row under the
//                        user's question with the exchange's `assumed`
//                        fragments, the chart under the model's own title
//                        (hot: Copy · Show SQL · Insert · Ask · More), the
//                        note the model wrote last, and the table
//   b3-canvas-streaming  the same answer mid-write: three blocks landed, the
//                        third held at panelIn's midpoint, the fourth not yet
//                        written. A still of the entrance, which is the only
//                        way a frame can hold it
//   b3-canvas-empty      the caret at the page's first line: 0 strings, 0
//                        controls, and the first glyph writes the note
//   b3-note-edit         the model's note in edit under two landed blocks:
//                        the same box, the ring alone, no fill, no border
//                        step, and the caret after the last glyph
//
// Every block is canned exactly as the store holds it, so a fixture can never
// draw a document the product cannot produce, and the four carry ONE
// exchange's `wroteBy` so the surface reads them as one answer: the user's
// question stands once, on the first block, and the model's own titles on its
// other results (fixtures.canvas.ts is A3's, and stays A3's).
//
// Two states hold something a still cannot: a caret (it blinks, and SETTLE_MS
// lands in whichever phase it lands in) and a block mid-entrance (panelIn is
// over long before the shot). The caret is ASSERTED rather than shot, the
// a3-note-edit precedent, and the entrance is held by writing panelIn's own
// initial pose onto the arriving block at its midpoint, read from the preset
// so the still can never drift from the motion it stands for.
//
// Self-contained, like fixtures.canvas.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add B3_CANVAS_STATES to the canvas harness's own state list, seed useCanvas
// with b3CanvasSeed(state) before the first render, and call
// b3CanvasAfterMount(state) in the post-mount frame, before the ready mark.

import { panelIn } from "../design/springs";
import type { WrittenBlock } from "../canvas/CanvasTab";
import type { Block, CanvasDoc, CanvasMeta } from "../stores/canvas";

export const B3_CANVAS_STATES = [
  "b3-canvas-analysis",
  "b3-canvas-streaming",
  "b3-canvas-empty",
  "b3-note-edit",
] as const;
export type B3CanvasState = (typeof B3_CANVAS_STATES)[number];

/** the card's own three widths, A3's (the canvas is not the pane) */
export const B3_CANVAS_WIDTHS = [640, 960, 1280] as const;

/** the card's height for these states: a four-block answer stands whole in
 * one frame at the 640 floor, where A3's 760 held three blocks */
export const B3_CANVAS_CARD_H = 800;

/** the fixture connection, the same id the pane's and A3's fixtures use, so a
 * harness page that seeds more than one of them agrees with itself */
export const B3_CANVAS_PROFILE_ID = "harness-staging";
const CANVAS_ID = "b3-canvas";

/** the exchange every block below was written by: one answer, so the user's
 * question stands once and the model's titles carry the rest */
const EXCHANGE = "b3-ex-1";

export interface B3CanvasSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDoc>;
  /** useCanvas.editing: the note that holds the caret, or null. Seeded rather
   * than pressed, so the note never draws its read face first */
  editing: string | null;
}

/** a block as the store holds it, plus B3's provenance (the model's own title
 * and the exchange that wrote it) */
type Written = Block & WrittenBlock;

// ---- the blocks ------------------------------------------------------------

const QUESTION = "what stood out in orders last month";

/** the figure row: ONE row of four columns, so the block stands on its values
 * face, each column a pair. The values are printed as the database returned
 * them, which is where the currency glyph and the per cents come from: the
 * model formats in SQL when it wants `₹4,266,056` rather than `4266056.00`
 * (canvas-agent.md section 4.5, the analyst's job in the analyst's language).
 * The exchange's assumptions ride here, on the FIRST result it wrote, and
 * nowhere else */
const figures: Written = {
  id: "b3-blk-figures",
  kind: "result",
  question: QUESTION,
  prose: "",
  sql: "SELECT to_char(count(*), 'FM9,999') AS orders,\n       '₹' || to_char(sum(total_amount) FILTER (WHERE payment_status IN ('paid', 'cod_delivered')), 'FM9,999,999') AS collected,\n       round(100.0 * count(*) FILTER (WHERE payment_method = 'cod') / count(*)) || '%' AS cod_share,\n       round(100.0 * count(*) FILTER (WHERE payment_status = 'failed') / count(*)) || '%' AS failed_share\nFROM order_v2\nWHERE created_at >= date_trunc('month', now()) - interval '1 month'\n  AND created_at < date_trunc('month', now())",
  columns: ["orders", "collected", "cod_share", "failed_share"],
  rows: [["2,763", "₹4,266,056", "43%", "22%"]],
  chips: ["Last Month = August 2026", "Collected = Paid and Delivered COD"],
  status: "1 row · 96.4 ms",
  ms: 96.4,
  face: "table",
  wroteBy: EXCHANGE,
};

/** one label column, one numeric: the block stands on its chart, and the
 * model's own title stands where the question stood on the block above */
const channels: Written = {
  id: "b3-blk-channels",
  kind: "result",
  question: "",
  prose: "",
  sql: "SELECT channel, count(*) AS orders\nFROM order_v2\nWHERE created_at >= date_trunc('month', now()) - interval '1 month'\n  AND created_at < date_trunc('month', now())\nGROUP BY channel\nORDER BY orders DESC",
  columns: ["channel", "orders"],
  rows: [
    ["app", "1602"],
    ["web", "486"],
    ["instagram", "318"],
    ["whatsapp", "247"],
    ["other", "58"],
    ["referral", "52"],
  ],
  chips: [],
  status: "6 rows · 208.3 ms",
  ms: 208.3,
  face: "chart",
  title: "Orders by channel",
  wroteBy: EXCHANGE,
};

/** the reading, written last and from the shapes that came back: one lead-in
 * and three bullets, each a comparison the blocks above cannot make for
 * themselves, and no figure they already print. No title line: the question
 * above it is the section's (canvas-agent.md section 4.2) */
const note: Written = {
  id: "b3-blk-note",
  kind: "note",
  text: [
    "**Against July:**",
    "- COD is 43% of the month, six points up on July; the app's share held at 58%.",
    "- Failed attempts went from 15% of checkouts to 22%, all of it after the gateway change on the 12th.",
    "- Instagram grew 31% on July while web fell 9%, the only channel that shrank.",
  ].join("\n"),
  wroteBy: EXCHANGE,
};

/** two label columns and one numeric: no chart to be had, so the block stands
 * on its table and keeps the one frame the page still draws */
const gateways: Written = {
  id: "b3-blk-gateways",
  kind: "result",
  question: "",
  prose: "",
  sql: "SELECT gateway,\n       count(*) AS failed,\n       round(100.0 * count(*) / sum(count(*)) OVER ()) || '%' AS share\nFROM payment_attempt\nWHERE status = 'failed'\n  AND created_at >= date_trunc('month', now()) - interval '1 month'\n  AND created_at < date_trunc('month', now())\nGROUP BY gateway\nORDER BY failed DESC",
  columns: ["gateway", "failed", "share"],
  rows: [
    ["razorpay", "402", "66%"],
    ["payu", "134", "22%"],
    ["cod_verify", "58", "9%"],
    ["paypal", "17", "3%"],
  ],
  chips: [],
  status: "4 rows · 188.2 ms",
  ms: 188.2,
  face: "table",
  title: "Failed payments by gateway",
  wroteBy: EXCHANGE,
};

// ---- exports ---------------------------------------------------------------

function blocksFor(state: B3CanvasState): Block[] {
  switch (state) {
    case "b3-canvas-analysis":
      return [figures, channels, note, gateways];
    case "b3-canvas-streaming":
      return [figures, channels, note];
    case "b3-canvas-empty":
      return [];
    case "b3-note-edit":
      return [figures, channels, note];
  }
}

export function b3CanvasSeed(state: B3CanvasState): B3CanvasSeed {
  const meta: CanvasMeta = {
    id: CANVAS_ID,
    profileId: B3_CANVAS_PROFILE_ID,
    title: "Canvas 4",
    updatedAt: "2026-09-08T11:40:00Z",
  };
  return {
    canvasId: CANVAS_ID,
    profileId: B3_CANVAS_PROFILE_ID,
    canvases: { [B3_CANVAS_PROFILE_ID]: [meta] },
    docs: { [CANVAS_ID]: { blocks: blocksFor(state) } },
    editing: state === "b3-note-edit" ? note.id : null,
  };
}

/** the block whose cluster is hot, or null where the sketch draws the state at
 * rest (the empty canvas has nothing to hover, and a note in edit and a block
 * mid-arrival have no cluster at all) */
function hotBlock(state: B3CanvasState): string | null {
  return state === "b3-canvas-analysis" ? channels.id : null;
}

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** panelIn's own midpoint, written onto the arriving block. The entrance is
 * over long before the shot, so the still has to be posed; posing it from the
 * PRESET rather than from three numbers typed here is what stops the picture
 * drifting from the motion it stands for (springs.ts panelIn). Under forced
 * reduced motion the preset's initial IS the animate pose, and the block
 * stands at once, which is the honest still of that setting */
function poseArriving(el: HTMLElement): void {
  const from = panelIn.initial as { opacity: number; y: number; scale: number };
  const half = (a: number, b: number) => a + (b - a) / 2;
  el.style.opacity = String(half(from.opacity, 1));
  el.style.transform = `translateY(${half(from.y, 0)}px) scale(${half(from.scale, 1)})`;
}

/** the note's caret: a still cannot hold it (it blinks), so this asserts it
 * instead of shooting for it, and logs the assertion so a re-run's evidence is
 * on record. `selector` names the note in edit, which on the empty canvas is
 * the page's own caret line and nowhere in the document */
function assertCaret(state: string, selector: string): void {
  const el = document.querySelector<HTMLTextAreaElement>(selector);
  const ok = !!el && document.activeElement === el && el.selectionStart === el.value.length;
  // eslint-disable-next-line no-console -- the probe's own record, not app logging
  console.log(`${state}: caret at end of textarea = ${ok}`);
  if (!ok) throw new Error(`${state}: the caret is not at the end of the note's text`);
}

/** the post-mount hook: a hover cannot be held in a still, so the block the
 * sketch shows hot is stamped on the element the cluster floats over (the
 * `result` states' own precedent, canvas.css reads `.blk[data-hot]` as that
 * block's hover), the arriving block is posed at its entrance's midpoint, and
 * the two states whose subject is a caret assert it. The empty canvas's caret
 * line is the page's own, which the surface mints on the first render of a
 * document known to be empty, so nothing here presses for it */
export async function b3CanvasAfterMount(state: string): Promise<void> {
  if (!(B3_CANVAS_STATES as readonly string[]).includes(state)) return;
  const s = state as B3CanvasState;
  const id = hotBlock(s);
  if (id) {
    const el = document.querySelector<HTMLElement>(`[data-block="${id}"]`);
    if (el) el.dataset.hot = "";
  }
  if (s === "b3-canvas-streaming") {
    // the entrance has to have run before it can be posed, and the pose is
    // the last thing written to the element (the ready mark follows it)
    await frame();
    const el = document.querySelector<HTMLElement>(`[data-block="${note.id}"]`)?.parentElement;
    if (!el) throw new Error("b3-canvas-streaming: the arriving block is not on the page");
    poseArriving(el);
  }
  if (s === "b3-canvas-empty") {
    await frame();
    assertCaret(s, '[data-block="cv-draft"] textarea');
  }
  if (s === "b3-note-edit") assertCaret(s, `[data-block="${note.id}"] textarea`);
}
