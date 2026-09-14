// D1 canvas fixtures: the states the maintainer's findings name, each one a
// bug standing where a still can hold it (items 6, 8 and 9 of the D1 list,
// and the ring the fix for item 6 took with it). They are framed through the harness's canvas root
// (`?harness=canvas&state=…&w=640|960|1280`), the same door C2a's and C2b's
// states use, and every block is canned exactly as the store holds it, so a
// fixture can never draw a document the product cannot produce.
//
//   d1-chart-overflow  a twelve-bar chart of three series in a 4x3 widget with
//                      a note under it. Before the fix the bars' own floor
//                      pitch (34px a row at three series) drew 432px of plot
//                      into a 292px face, through the block's own status line
//                      and 128px into the note below it; after it the widget
//                      clips its content and the chart draws the rows that
//                      fit. D1 said so on the BLOCK's status line (`7 of 12
//                      bars · 214.7 ms`); D2 retired that fragment and the
//                      face carries its own `+ N more` instead, so the line
//                      is the run's `12 rows · 214.7 ms` again (AGENT-UX
//                      §16ee). The same
//                      twelve bars stand a second time with NO cell of their
//                      own, so the document opens them at its own default
//                      height: that is the item's other half, a chart whose
//                      default is read from its bars and its series and clips
//                      nothing
//   d1-note-fill       a note in a 6x3 widget beside a long note in 3x1. The
//                      first is the screenshot's own complaint (one line of
//                      words in a wide tall box); the second is what filling
//                      the box has to survive, words past the cells, which
//                      scroll inside the widget rather than standing outside
//                      it. Neither carries `autoH`: a hand gave both their
//                      cells, which is what clears it (AGENT-UX 16p)
//   d1-compare-mismatch  a compare that could not be made, standing on the
//                      face it was made from: the block keeps its own grid and
//                      the refusal is one fragment of its status line, in the
//                      grammar the line already speaks. Beside it a comparison
//                      that WAS made, of six columns in a four-cell widget, so
//                      the cells that ellipsize and the grid that scrolls
//                      inside its own box are in the same frame
//   d1-block-focus     the other thing the clip took: a block the KEYBOARD is
//                      holding. The arrows move it, the shift-arrows resize it
//                      and backspace deletes it, so the page has to say which
//                      block they will act on (AGENT-UX 16s), and the ring
//                      that said so stood outside the box the page now clips.
//                      One block focused, one beside it at rest, so the ring
//                      is read against a block that has none
//
// Self-contained, like fixtures.c2grid.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add D1_CANVAS_STATES to the canvas harness's own state list, seed useCanvas
// with d1CanvasSeed(state) before the first render, call d1CanvasAfterMount(
// state) in the post-mount frame before the ready mark, and give these states
// d1CanvasCardH(state).

import { buildDiff, type Block, type CanvasDoc, type CanvasMeta } from "../stores/canvas";

export const D1_CANVAS_STATES = [
  "d1-chart-overflow",
  "d1-note-fill",
  "d1-compare-mismatch",
  "d1-block-focus",
] as const;
export type D1CanvasState = (typeof D1_CANVAS_STATES)[number];

/** the card's own three widths, A3's: the canvas is a face of the main card */
export const D1_CANVAS_WIDTHS = [640, 960, 1280] as const;

/** the two documents that run past A3's 760: the chart state stands two charts
 * and a note (7 rows at the floor), the compare state a diff and a grid. The
 * note pair and the focused block are three rows each and stand on A3's own */
const D1_TALL_CARD_H = 1040;
const D1_CANVAS_CARD_H = 760;

export const d1CanvasCardH = (state: string): number =>
  state === "d1-note-fill" || state === "d1-block-focus" ? D1_CANVAS_CARD_H : D1_TALL_CARD_H;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
export const D1_CANVAS_PROFILE_ID = "harness-staging";
const D1_PROD_PROFILE_ID = "harness-prod";
const CANVAS_ID = "d1-canvas";
const EXCHANGE = "d1-ex-1";

export interface D1CanvasSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDoc>;
  /** useCanvas.editing: no caret stands in any of these states */
  editing: string | null;
}

// ---- item 6: the chart that outgrew its cells ------------------------------

/** twelve labels and three series, the chart's own ceiling (CHART_MAX_SERIES).
 * Three bars to a row is a floor of 34px a row under a 24px legend, so twelve
 * rows want 432px where a 4x3 widget's face has 292: before the fix the plot
 * drew all 432 of them, straight through its own status line and 128px into
 * the note below it */
const MONTHS: [string, string, string, string][] = [
  ["September", "1284", "96", "41"],
  ["October", "1412", "104", "52"],
  ["November", "1688", "131", "63"],
  ["December", "2104", "168", "88"],
  ["January", "1342", "88", "37"],
  ["February", "1197", "76", "31"],
  ["March", "1455", "92", "44"],
  ["April", "1521", "101", "49"],
  ["May", "1608", "118", "55"],
  ["June", "1744", "126", "58"],
  ["July", "1812", "133", "61"],
  ["August", "1903", "147", "72"],
];

const chartBlock = (id: string, title: string, cell: Block["cell"]): Block => ({
  id,
  kind: "result",
  question: "",
  title,
  prose: "",
  sql: "SELECT to_char(created_at, 'Month') AS month,\n       count(*) AS orders,\n       count(*) FILTER (WHERE status = 'returned') AS returned,\n       count(*) FILTER (WHERE status = 'refunded') AS refunded\nFROM order_v2\nGROUP BY 1\nORDER BY min(created_at)",
  columns: ["month", "orders", "returned", "refunded"],
  rows: MONTHS.map((r) => [...r]),
  chips: [],
  status: "12 rows · 214.7 ms",
  ms: 214.7,
  face: "chart",
  cell,
  wroteBy: EXCHANGE,
});

/** the note the plot drew over. One line, so what is on top of it is the
 * chart's ink and never the note's own words */
const under: Block = {
  id: "d1-under",
  kind: "note",
  text: "December is the month to staff for: a fifth more orders than November and the returns to match.",
  cell: { x: 0, y: 3, w: 4, h: 1 },
  wroteBy: EXCHANGE,
};

// ---- item 8: the note in a widget a hand made bigger ------------------------

const roomy: Block = {
  id: "d1-roomy",
  kind: "note",
  text: "Two channels carry the month. `app` and `web` are three quarters of the orders and almost all of the collected amount.",
  cell: { x: 0, y: 0, w: 6, h: 3 },
};

const crowded: Block = {
  id: "d1-crowded",
  kind: "note",
  text: [
    "**What August changed:**",
    "- The gateway swap landed on the 4th and the failed share fell from 22% to 14% inside a week.",
    "- COD is still 43% of orders and 31% of the amount, which is the gap the collections team is working.",
    "- Returns are flat at 7%, so nothing the swap did moved them either way.",
    "- The instagram channel doubled off a small base and is now the fourth biggest.",
  ].join("\n"),
  cell: { x: 6, y: 0, w: 3, h: 1 },
};

// ---- item 9: the compare that could not be made -----------------------------

const CITY_COLUMNS = ["city", "orders", "returned", "collected", "cod_share", "failed_share"];
const CITY_A: (string | null)[][] = [
  ["Mumbai", "412", "61", "1284900.00", "0.41", "0.19"],
  ["Delhi", "388", "74", "1102400.00", "0.47", "0.23"],
  ["Bengaluru", "301", "29", "986300.00", "0.36", "0.16"],
  ["Hyderabad", "266", "38", "742100.00", "0.44", "0.21"],
  ["Chennai", "241", "31", "688700.00", "0.39", "0.18"],
];
const CITY_B: (string | null)[][] = [
  ["Mumbai", "428", "58", "1311250.00", "0.40", "0.17"],
  ["Delhi", "401", "79", "1140880.00", "0.48", "0.22"],
  ["Bengaluru", "296", "33", "971440.00", "0.37", "0.15"],
  ["Hyderabad", "271", "36", "759300.00", "0.43", "0.20"],
  ["Chennai", "238", "34", "676110.00", "0.40", "0.19"],
];

/** the store's own pairing, never a hand-written diff: a fixture that built
 * its rows by hand could draw a face the product cannot produce */
function comparison() {
  const built = buildDiff({
    columns: CITY_COLUMNS,
    aRows: CITY_A,
    bColumns: CITY_COLUMNS,
    bRows: CITY_B,
    aTotal: CITY_A.length,
    bTotal: CITY_B.length,
    a: { profileId: D1_CANVAS_PROFILE_ID, name: "staging", ms: 268.3 },
    b: { profileId: D1_PROD_PROFILE_ID, name: "prod-crawler", ms: 344.9 },
  });
  if (!built.ok) throw new Error(`d1 fixture: ${built.message}`);
  return built.diff;
}

/** the compare that could not be made: the block stands on the face it was
 * made from, its own grid, and the refusal is the last fragment of its status
 * line (canvas.ts `statusOf`) */
const refused: Block = {
  id: "d1-refused",
  kind: "result",
  question: "which cities returned the most last month",
  prose: "",
  sql: "SELECT city, orders, returned, collected\nFROM order_city_last_month\nORDER BY returned DESC",
  columns: ["city", "orders", "returned", "collected"],
  rows: CITY_A.map((r) => r.slice(0, 4)),
  chips: ["Last Month = August 2026"],
  status: "5 rows · 268.3 ms",
  ms: 268.3,
  face: "table",
  mismatch: "table order_city_last_month is not on prod-crawler",
  cell: { x: 0, y: 0, w: 5, h: 3 },
};

/** and one that WAS made, six columns wide in four cells: every cell holds a
 * triple, so what the widget cannot show ellipsizes and the grid scrolls
 * inside its own box rather than reaching past it */
const compared: Block = {
  id: "d1-compared",
  kind: "result",
  question: "",
  title: "Cities, staging against prod",
  prose: "",
  sql: "SELECT city, orders, returned, collected, cod_share, failed_share\nFROM order_city_last_month\nORDER BY orders DESC",
  columns: CITY_COLUMNS,
  rows: CITY_A.map((r) => [...r]),
  chips: [],
  status: "5 rows · 268.3 ms",
  ms: 268.3,
  face: "diff",
  diff: comparison(),
  cell: { x: 0, y: 3, w: 4, h: 3 },
};

// ---- the block the keyboard is holding --------------------------------------

/** the focused block: a grid face, so the ring is read against a box whose own
 * edges are straight, and a question line, so the cluster the focus reveals
 * stands where a hover would have put it */
const held: Block = {
  id: "d1-held",
  kind: "result",
  question: "which cities returned the most last month",
  prose: "",
  sql: "SELECT city, orders, returned, collected\nFROM order_city_last_month\nORDER BY returned DESC",
  columns: ["city", "orders", "returned", "collected"],
  rows: CITY_A.map((r) => r.slice(0, 4)),
  chips: [],
  status: "5 rows · 268.3 ms",
  ms: 268.3,
  face: "table",
  cell: { x: 0, y: 0, w: 5, h: 3 },
};

/** and the block beside it, which the keyboard is not holding */
const beside: Block = {
  id: "d1-beside",
  kind: "note",
  text: "Delhi returns one order in five, the worst of the five and the only city whose returns grew with its orders.",
  cell: { x: 5, y: 0, w: 4, h: 3 },
};

// ---- the seed ---------------------------------------------------------------

function blocksFor(state: D1CanvasState): { blocks: Block[]; lastColumns: number } {
  switch (state) {
    case "d1-chart-overflow":
      return {
        blocks: [
          chartBlock("d1-squeezed", "Orders by month", { x: 0, y: 0, w: 4, h: 3 }),
          under,
          chartBlock("d1-opened", "Orders by month, as opened", undefined),
        ],
        lastColumns: 5,
      };
    case "d1-note-fill":
      return { blocks: [roomy, crowded], lastColumns: 9 };
    case "d1-block-focus":
      return { blocks: [held, beside], lastColumns: 9 };
    default:
      return { blocks: [refused, compared], lastColumns: 5 };
  }
}

export function d1CanvasSeed(state: string): D1CanvasSeed {
  const s = (D1_CANVAS_STATES as readonly string[]).includes(state)
    ? (state as D1CanvasState)
    : "d1-chart-overflow";
  const { blocks, lastColumns } = blocksFor(s);
  return {
    canvasId: CANVAS_ID,
    profileId: D1_CANVAS_PROFILE_ID,
    canvases: {
      [D1_CANVAS_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: D1_CANVAS_PROFILE_ID,
          title: "Orders, last month",
          updatedAt: "2026-09-14T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: { v: 2, blocks, lastColumns } },
    editing: null,
  };
}

/** a hover cannot be held in a still, so the element whose chrome the frame is
 * evidence of is stamped hot, the canvas states' own precedent. Nothing here
 * poses a pointer: three of the four are pages at rest, and the fourth is held
 * by the keyboard, which is a pose the page really holds */
export async function d1CanvasAfterMount(state: string): Promise<void> {
  if (!(D1_CANVAS_STATES as readonly string[]).includes(state)) return;
  // the focused state poses no hover at all: the focus is the pose, and the
  // cluster and the corner handle it reveals are the product's own answer to
  // it (canvas.css `.blk:focus-within`, grid.css `.cvg-slot:focus-within`)
  if (state === "d1-block-focus") {
    document.querySelector<HTMLElement>(`[data-block="${held.id}"]`)?.focus();
    return;
  }
  const id = state === "d1-note-fill" ? roomy.id : state === "d1-compare-mismatch" ? refused.id : "d1-squeezed";
  const el = document.querySelector<HTMLElement>(`[data-block="${id}"]`);
  if (el) el.dataset.hot = "";
}
