// D2 canvas fixtures: the widget's own face, the strip above the grid, and the
// three places a widget grew a line of its own (the maintainer's answers 1, 2,
// 3, 4 and 5, drawn in `docs/ask-sketch-d2.html`). Framed through the harness's
// canvas root (`?harness=canvas&state=…&w=640|960|1280`), the same door C2a's,
// C2b's and D1's states use, and every block is canned exactly as the store
// holds it, so a fixture can never draw a document the product cannot produce.
//
//   d2-widgets     four widgets in reading order, the chart hot: every one
//                  wearing its 1px --border and 12px inside it, the hot one
//                  stepped to --border-strong, the table's own band bleeding
//                  to the widget's left and right lines and the drawing's
//                  paper filling the padding box, so no widget shows two
//                  lines anywhere. The strip stands above them: `Canvas 4` on
//                  the first cell's left edge and the `+` at the right
//   d2-add-menu    the same page with the `+` pressed and its menu under it:
//                  Note · Drawing · Chart…, each row wearing its own glyph
//                  (the amended menu rule), the first row hot
//   d2-diff-chips  a comparison in a 6x3 widget: the origin chip and the
//                  compared chip with its ×, each carrying its connection's
//                  dot and that side's own time, the A · B · Δ grid under
//                  them bleeding to the widget's lines, and the status line
//                  carrying the row count and the assumption ONLY (both names
//                  and both timings now live in the chips)
//   d2-chart-fit   a twelve-bar chart a hand shrank to 4x2, drawing the rows
//                  that fit over one `+ 4 more`, beside the same chart as the
//                  model wrote it, every bar in; the status line reads
//                  `12 rows · 241.6 ms` on both, D1's `8 of 12 bars` retired
//   d2-note-grown  a note that grew with its words (`autoH`, two rows of
//                  cells for the words it holds) beside one a HAND sized,
//                  whose words run past its span and scroll inside it under
//                  the 16px bottom fade
//
// Self-contained, like fixtures.d1canvas.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add D2_CANVAS_STATES to the canvas harness's own state list, seed useCanvas
// with d2CanvasSeed(state) before the first render, call d2CanvasAfterMount(
// state) in the post-mount frame before the ready mark, and give these states
// d2CanvasCardH(state).

import { buildDiff, useCanvas, type Block, type CanvasDoc, type CanvasMeta } from "../stores/canvas";
import { cellMetrics } from "../canvas/grid";

export const D2_CANVAS_STATES = [
  "d2-widgets",
  "d2-add-menu",
  "d2-diff-chips",
  "d2-chart-fit",
  "d2-note-grown",
] as const;
export type D2CanvasState = (typeof D2_CANVAS_STATES)[number];

/** the card's own three widths, A3's: the canvas is a face of the main card */
export const D2_CANVAS_WIDTHS = [640, 960, 1280] as const;

/** the widget page runs to four elements and twelve rows at the 640 floor,
 * where the drawing leaves the chart's side and the table takes the width:
 * 1428px of page, the strip above it and the tab bar above that, and the card
 * holds it whole rather than cropping the note off its foot. The other three
 * are six rows or fewer at the floor, where the chart pair stacks */
const D2_TALL_CARD_H = 1580;
const D2_CANVAS_CARD_H = 740;

export const d2CanvasCardH = (state: string): number =>
  state === "d2-widgets" || state === "d2-add-menu" ? D2_TALL_CARD_H : D2_CANVAS_CARD_H;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
export const D2_CANVAS_PROFILE_ID = "harness-staging";
const D2_PROD_PROFILE_ID = "harness-prod";
const CANVAS_ID = "d2-canvas";
const EXCHANGE = "d2-ex-1";

export interface D2CanvasSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDoc>;
  /** useCanvas.editing: no caret stands in any of these states */
  editing: string | null;
}

// ---- the four kinds, one page ----------------------------------------------

const CHANNELS: [string, string][] = [
  ["app", "3184"],
  ["web", "2471"],
  ["instagram", "684"],
  ["whatsapp", "412"],
  ["referral", "233"],
  ["affiliate", "118"],
];

const CITIES: [string, string, string, string][] = [
  ["Mumbai", "412", "0.41", "0.19"],
  ["Delhi", "388", "0.47", "0.23"],
  ["Bengaluru", "301", "0.36", "0.16"],
  ["Hyderabad", "266", "0.44", "0.21"],
  ["Chennai", "241", "0.39", "0.18"],
  ["Pune", "198", "0.35", "0.14"],
  ["Kolkata", "181", "0.42", "0.20"],
  ["Ahmedabad", "164", "0.38", "0.17"],
];

const channelChart = (cell: Block["cell"]): Block => ({
  id: "d2-chart",
  kind: "result",
  question: "",
  title: "Orders by channel",
  prose: "",
  sql: "SELECT channel, count(*) AS orders\nFROM order_v2\nGROUP BY 1\nORDER BY 2 DESC",
  columns: ["channel", "orders"],
  rows: CHANNELS.map((r) => [...r]),
  chips: [],
  status: "6 rows · 208.3 ms",
  ms: 208.3,
  face: "chart",
  cell,
  wroteBy: EXCHANGE,
});

const cityTable = (cell: Block["cell"]): Block => ({
  id: "d2-table",
  kind: "result",
  question: "which cities ordered the most last month",
  prose: "",
  sql: "SELECT city, orders, cod_share, failed_share\nFROM order_city_last_month\nORDER BY orders DESC",
  columns: ["city", "orders", "cod_share", "failed_share"],
  rows: CITIES.map((r) => [...r]),
  chips: ["Last Month = August 2026"],
  status: "8 rows · 241.6 ms",
  ms: 241.6,
  face: "table",
  cell,
  wroteBy: EXCHANGE,
});

/** a sheet with ink on it: the paper has to reach the widget's own line, and a
 * stroke near the top-left is what says whether the ink moved with it */
const sketch = (cell: Block["cell"]): Block => ({
  id: "d2-draw",
  kind: "drawing",
  strokes: [
    { k: "rect", c: 0, t: 2, b: [24, 34, 132, 92] },
    { k: "arrow", c: 0, t: 2, b: [138, 63, 214, 63] },
    { k: "ellipse", c: 1, t: 2, b: [220, 34, 312, 92] },
    { k: "text", c: 0, s: 13, at: [24, 24], v: "sync" },
    { k: "pen", c: 2, t: 2, p: [30, 128, 92, 116, 152, 140, 214, 112, 276, 132] },
  ],
  cell,
});

const roundup = (cell: Block["cell"]): Block => ({
  id: "d2-note",
  kind: "note",
  text: "**August, in one line:** the app carries half the orders and the gateway swap took the failed share from 22% to 14%.",
  cell,
});

// ---- item 4: the chart a hand shrank ---------------------------------------

const TWELVE: [string, string][] = [
  ["Mumbai", "412"],
  ["Delhi", "388"],
  ["Bengaluru", "301"],
  ["Hyderabad", "266"],
  ["Chennai", "241"],
  ["Pune", "198"],
  ["Kolkata", "181"],
  ["Ahmedabad", "164"],
  ["Jaipur", "142"],
  ["Surat", "121"],
  ["Lucknow", "108"],
  ["Indore", "96"],
];

const cityChart = (id: string, cell: Block["cell"]): Block => ({
  id,
  kind: "result",
  question: "",
  title: "Orders by city",
  prose: "",
  sql: "SELECT city, count(*) AS orders\nFROM order_v2\nGROUP BY 1\nORDER BY 2 DESC",
  columns: ["city", "orders"],
  rows: TWELVE.map((r) => [...r]),
  chips: ["Last Month = August 2026"],
  status: "12 rows · 241.6 ms",
  ms: 241.6,
  face: "chart",
  cell,
  wroteBy: EXCHANGE,
});

// ---- item 5: the comparison -------------------------------------------------

const REVENUE_COLUMNS = ["payment_status", "orders", "amount"];
const REVENUE_A: (string | null)[][] = [
  ["cod_delivered", "731", "1988640.00"],
  ["paid", "479", "1264310.00"],
  ["cod_pending", "216", "588200.00"],
  ["refunded", "88", "214870.00"],
  ["partial_refund", "31", "74120.00"],
  ["failed", "24", "0.00"],
];
const REVENUE_B: (string | null)[][] = [
  ["cod_delivered", "748", "2011200.00"],
  ["paid", "466", "1241880.00"],
  ["cod_pending", "224", "601440.00"],
  ["refunded", "91", "221340.00"],
  ["partial_refund", "21", "61420.00"],
  ["failed", "29", "0.00"],
];

/** the store's own pairing, never a hand-written diff: a fixture that built
 * its rows by hand could draw a face the product cannot produce */
function comparison() {
  const built = buildDiff({
    columns: REVENUE_COLUMNS,
    aRows: REVENUE_A,
    bColumns: REVENUE_COLUMNS,
    bRows: REVENUE_B,
    aTotal: REVENUE_A.length,
    bTotal: REVENUE_B.length,
    a: { profileId: D2_CANVAS_PROFILE_ID, name: "staging", ms: 412.6 },
    b: { profileId: D2_PROD_PROFILE_ID, name: "prod", ms: 388.1 },
  });
  if (!built.ok) throw new Error(`d2 fixture: ${built.message}`);
  return built.diff;
}

const compared: Block = {
  id: "d2-diff",
  kind: "result",
  question: "can you check the revenue in last month",
  prose: "",
  sql: "SELECT payment_status, count(*) AS orders, sum(total) AS amount\nFROM order_v2\nGROUP BY 1",
  columns: REVENUE_COLUMNS,
  rows: REVENUE_A.map((r) => [...r]),
  chips: ["Last Month = August 2026"],
  status: "6 rows · 412.6 ms",
  ms: 412.6,
  face: "diff",
  diff: comparison(),
  cell: { x: 0, y: 0, w: 6, h: 3 },
};

// ---- item 3: the note that grew, and the note a hand sized -----------------

const GROWN_WORDS = [
  "**What August changed:**",
  "The gateway swap landed on the 4th and the failed share fell from 22% to 14% inside a week.",
  "COD is still 43% of orders and 31% of the amount, which is the gap collections are working.",
].join("\n\n");

/** the note whose words set its cells: `autoH` stands, so the box is exactly
 * as tall as what is in it and nothing scrolls. The stored height is the one
 * the WORDS measure to at this width, not a rounder number: a seed a row too
 * tall is shrunk by the at-rest measure the moment the widget mounts, and a
 * frame shot before that lands draws an empty row the page does not have
 * (DESIGN rule 9). `settledHeight` below holds the shot until the measure has
 * had its say at every width */
const grown: Block = {
  id: "d2-grown",
  kind: "note",
  text: GROWN_WORDS,
  autoH: true,
  cell: { x: 0, y: 0, w: 3, h: 2 },
};

/** and the note a HAND sized: `autoH` is gone, the words run past the span,
 * and the foot fades while the end is out of view. One cell row, D1's own
 * 3x1 note: at two the words fit at every width and the fade the state is
 * evidence for never stands */
const handed: Block = {
  id: "d2-handed",
  kind: "note",
  text: [
    "**The month's other half:**",
    "Returns are flat at 7%, so nothing the swap did moved them either way.",
    "The instagram channel doubled off a small base and is now the fourth biggest.",
    "Refunds lag the order by 2 days at the median and 11 at the tail.",
  ].join("\n\n"),
  cell: { x: 3, y: 0, w: 3, h: 1 },
};

// ---- the seed ---------------------------------------------------------------

/** the sketch's own two layouts: one document stored at 7 columns and derived
 * at 5 in reading order, so the four widgets read the same at every width */
function widgetPage(): Block[] {
  return [
    channelChart({ x: 0, y: 0, w: 4, h: 3 }),
    sketch({ x: 4, y: 0, w: 3, h: 3 }),
    cityTable({ x: 0, y: 3, w: 6, h: 4 }),
    roundup({ x: 0, y: 7, w: 3, h: 2 }),
  ];
}

function blocksFor(state: D2CanvasState): { blocks: Block[]; lastColumns: number } {
  switch (state) {
    case "d2-diff-chips":
      return { blocks: [compared], lastColumns: 7 };
    case "d2-chart-fit":
      return {
        blocks: [cityChart("d2-squeezed", { x: 0, y: 0, w: 4, h: 2 }), cityChart("d2-opened", { x: 4, y: 0, w: 3, h: 3 })],
        lastColumns: 7,
      };
    case "d2-note-grown":
      return { blocks: [grown, handed], lastColumns: 7 };
    default:
      return { blocks: widgetPage(), lastColumns: 7 };
  }
}

export function d2CanvasSeed(state: string): D2CanvasSeed {
  const s = (D2_CANVAS_STATES as readonly string[]).includes(state)
    ? (state as D2CanvasState)
    : "d2-widgets";
  const { blocks, lastColumns } = blocksFor(s);
  return {
    canvasId: CANVAS_ID,
    profileId: D2_CANVAS_PROFILE_ID,
    canvases: {
      [D2_CANVAS_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: D2_CANVAS_PROFILE_ID,
          // the name as the reader typed it, never Title Cased: the header
          // draws data, and the sketch's own strip says `Canvas 4`
          title: "Canvas 4",
          updatedAt: "2026-09-14T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: { v: 2, blocks, lastColumns } },
    editing: null,
  };
}

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** wait for a node, a frame at a time, so a pose never races the commit that
 * renders what it is posing (the canvas states' own shape) */
async function settled(selector: string, tries = 12): Promise<HTMLElement | null> {
  for (let i = 0; i < tries; i++) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    await frame();
  }
  return null;
}

/** and for the page to stand where the document says it does: the column count
 * is measured in a layout effect and a narrower page is a reflow, so a still
 * shot before either lands would be a picture of the first render */
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
  throw new Error(`d2: the page never settled around ${blockId}`);
}

/** and for a note that sets its own cells to have set them: `autoH` measures
 * the words in a layout effect and every column count is a different wrap, so
 * the height the seed carries is a guess until the page has run. Hold until
 * the store's own cell stops moving, then let the layout settle around it */
async function settledHeight(blockId: string, tries = 60): Promise<void> {
  const cellsOf = () => useCanvas.getState().docs[CANVAS_ID]?.blocks.find((b) => b.id === blockId)?.cell?.h;
  let last = cellsOf();
  let still = 0;
  for (let i = 0; i < tries; i++) {
    await frame();
    const now = cellsOf();
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 4) return;
  }
}

/** the widget the sketch draws hot. A hover cannot be held in a still, so the
 * cluster and the stepped line are revealed the way every canvas state reveals
 * them: `data-hot` on the element the cluster floats over (canvas.css and
 * grid.css both read it as that widget's hover) */
const hotBlock = (state: D2CanvasState): string =>
  state === "d2-diff-chips"
    ? compared.id
    : state === "d2-chart-fit"
      ? "d2-squeezed"
      : state === "d2-note-grown"
        ? grown.id
        : "d2-chart";

export async function d2CanvasAfterMount(state: string): Promise<void> {
  if (!(D2_CANVAS_STATES as readonly string[]).includes(state)) return;
  const s = state as D2CanvasState;
  // the measure is a layout effect and the reflow a render: the frame is posed
  // against the page as it finally stands, never as it first mounted
  await frame();
  const hot = hotBlock(s);
  await laidOut(hot);
  if (s === "d2-note-grown") {
    await settledHeight(grown.id);
    await laidOut(hot);
  }
  // the add-menu state is about the STRIP, so nothing on the grid is posed:
  // a hot widget beside an open menu would be two subjects in one frame
  if (s === "d2-add-menu") {
    const button = await settled(".cv-head .iconbtn");
    if (!button) throw new Error("d2-add-menu: the + is not on the page");
    button.click();
    const menu = await settled(".ov-anchor-layer .ctx-menu");
    if (!menu) throw new Error("d2-add-menu: the + menu did not open");
    await frame();
    return;
  }
  const el = document.querySelector<HTMLElement>(`[data-block="${hot}"]`);
  if (el) el.dataset.hot = "";
}
