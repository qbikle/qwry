// C2a canvas fixtures for the design harness (the "C1 · the grid" rows of
// ask-sketch-c1.html). The canvas is a MAIN-AREA face, so these states are
// framed through the harness's second root (`?harness=canvas&state=…&
// w=640|960|1280`) at the card's own three widths, on a card 800 tall except
// for the two layout states, which are read whole (c2GridCardH):
//
//   c2-grid        six elements on the layout the document was stored at
//                  (7 columns, the 960 frame): the values row 5x1 with two
//                  cells of air beside it, the bars chart 4x3 beside a note,
//                  a one-line note under it, the table 6x4 with a 1x4 hole at
//                  its right, and a wide result standing its bars. At 640 the
//                  five columns the width affords are fewer than the seven it
//                  was stored at, so the store derives a reflowed layout and
//                  the frame is the reflow's own picture; at 1280 the stored
//                  layout stands with three spare columns at the right (the
//                  spans-kept rule). The chart is hot: the grip at the head of
//                  its cluster and the corner glyph at its bottom-right
//   c2-grid-floor  the same six elements laid out AT the 5-column floor, where
//                  DESIGN rule 13 designs them: every default span fits, one
//                  hole beside the chart, and nothing clips
//   c2-drag        the one-line note lifted mid-drag into the page's first
//                  row, one cell in: the lattice on, the placeholder on the
//                  cells it will take, the values row and the chart pushed
//                  down under it and travelling, `3 × 1` at the placeholder's
//                  corner. The finger stands a little left of and below the
//                  snap, which is where a hand is mid-travel
//   c2-resize      the chart's corner held: the handle hot in the accent, the
//                  box following the pointer a few pixels off its snap, the
//                  placeholder on the snapped span and its size label showing
//   c2-migrated    a pre-C2 document, exactly as A3 wrote it (no cell on any
//                  block, no `v`): the surface lays it out through the store's
//                  own `laidOut`, so the upgrade's picture is evidence and not
//                  a promise. Every block full width in its stored order,
//                  capped at six cells, with its kind's own height
//   c2-dense       200 elements, the mount measurement's own state
//
// Every block is canned exactly as the store holds it, so a fixture can never
// draw a document the product cannot produce, and the cells are the document's
// own: what the surface draws is `laidOut(blocks, columns)` and nothing else.
//
// The two gesture states hold something no still can: a pointer mid-travel.
// They are PRESSED, not drawn: the pose dispatches the product's own
// pointerdown and pointermove on the grip and on the corner handle and leaves
// the gesture open, so the lift, the lattice, the placeholder, its size label
// and every neighbour the engine displaced are the product's own answer and
// cannot drift from the gesture they stand for. Writing those styles by hand
// is what left both states empty at 640: the drag layer and the placeholder
// ARE motion values, and the commit a derived layout makes after the pose
// re-applies every one of them.
//
// Self-contained, like fixtures.b3canvas.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add C2_GRID_STATES to the canvas harness's own state list, seed useCanvas
// with c2GridSeed(state) before the first render, call c2GridAfterMount(state)
// in the post-mount frame before the ready mark, and give these states
// c2GridCardH(state).

import { CELL_H, cellMetrics, place, type Cell, type GridItem } from "../canvas/grid";
import type { Block, CanvasDoc, CanvasMeta } from "../stores/canvas";

export const C2_GRID_STATES = [
  "c2-grid",
  "c2-grid-floor",
  "c2-drag",
  "c2-resize",
  "c2-migrated",
  "c2-dense",
] as const;
export type C2GridState = (typeof C2_GRID_STATES)[number];

/** the card's own three widths, A3's (the canvas is not the pane) */
export const C2_GRID_WIDTHS = [640, 960, 1280] as const;

/** the card's height for these states, B3's: a page of cells is taller than
 * one answer, and the frame is read from its top */
export const C2_GRID_CARD_H = 800;

/** the two LAYOUT states are read whole instead: the table (the one face that
 * scrolls inside its box, capped 6 → 5 at the floor) and the standing-bars
 * result both stand past row 6, where an 800 card stops, so neither was in
 * evidence at the width rule 13 designs for. The document is 13 rows at the
 * floor and 10 at 960, which is 1548px of page, and this is that plus the tab
 * bar and the page's own inset on both sides. The gesture states are read from
 * their top: what they are evidence of happens in the first three rows */
const C2_DOC_CARD_H = 1584;

export const c2GridCardH = (state: string): number =>
  state === "c2-grid" || state === "c2-grid-floor" ? C2_DOC_CARD_H : C2_GRID_CARD_H;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
export const C2_GRID_PROFILE_ID = "harness-staging";
const CANVAS_ID = "c2-canvas";

export interface C2GridSeed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, CanvasDoc>;
  /** useCanvas.editing: no caret stands in any of these states */
  editing: string | null;
}

const EXCHANGE = "c2-ex-1";

// ---- the six elements ------------------------------------------------------

const CITIES: [string, string, string, string][] = [
  ["Mumbai", "412", "61", "₹1,284,900"],
  ["Delhi", "388", "74", "₹1,102,400"],
  ["Bengaluru", "301", "29", "₹986,300"],
  ["Hyderabad", "266", "38", "₹742,100"],
  ["Chennai", "241", "31", "₹688,700"],
  ["Pune", "208", "26", "₹601,250"],
  ["Kolkata", "184", "44", "₹512,900"],
  ["Ahmedabad", "162", "19", "₹470,300"],
  ["Jaipur", "148", "22", "₹430,800"],
  ["Surat", "131", "17", "₹388,600"],
  ["Lucknow", "119", "28", "₹341,200"],
  ["Nagpur", "104", "12", "₹296,700"],
  ["Indore", "97", "14", "₹271,400"],
  ["Bhopal", "88", "11", "₹244,900"],
  ["Patna", "76", "21", "₹208,300"],
  ["Kochi", "64", "9", "₹186,500"],
];

const figures: Block = {
  id: "c2-figures",
  kind: "result",
  question: "what stood out in orders last month",
  prose: "",
  sql: "SELECT count(*) AS orders,\n       sum(total_amount) AS collected,\n       avg((payment_method = 'cod')::int) AS cod_share,\n       avg((payment_status = 'failed')::int) AS failed_share\nFROM order_v2\nWHERE created_at >= date_trunc('month', now()) - interval '1 month'\n  AND created_at < date_trunc('month', now())",
  columns: ["orders", "collected", "cod_share", "failed_share"],
  rows: [["2,763", "₹4,266,056", "43%", "22%"]],
  chips: ["Last Month = August 2026"],
  status: "1 row · 96.4 ms",
  ms: 96.4,
  face: "values",
  wroteBy: EXCHANGE,
};

const channels: Block = {
  id: "c2-channels",
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
    ["email", "52"],
    ["other", "41"],
  ],
  chips: [],
  status: "8 rows · 142.0 ms",
  ms: 142,
  face: "chart",
  wroteBy: EXCHANGE,
};

const cities: Block = {
  id: "c2-cities",
  kind: "result",
  question: "",
  title: "Cities by paid orders",
  prose: "",
  sql: "SELECT city, orders, returned, collected\nFROM order_city_last_month\nORDER BY orders DESC",
  columns: ["city", "orders", "returned", "collected"],
  rows: CITIES.map((r) => [...r]),
  chips: [],
  status: "16 rows · 268.3 ms",
  ms: 268.3,
  face: "table",
  wroteBy: EXCHANGE,
};

/** the wide result: six short labels in a span three times wider than it is
 * tall, which is the one shape bars STAND in (Chart.standing) */
const weekdays: Block = {
  id: "c2-weekdays",
  kind: "result",
  question: "",
  title: "Orders by weekday",
  prose: "",
  sql: "SELECT to_char(created_at, 'Dy') AS day, count(*) AS orders\nFROM order_v2\nGROUP BY 1",
  columns: ["day", "orders"],
  rows: [
    ["Mon", "402"],
    ["Tue", "388"],
    ["Wed", "431"],
    ["Thu", "459"],
    ["Fri", "512"],
    ["Sat", "386"],
  ],
  chips: [],
  status: "6 rows · 88.1 ms",
  ms: 88.1,
  face: "chart",
  wroteBy: EXCHANGE,
};

const finding: Block = {
  id: "c2-finding",
  kind: "note",
  text: [
    "**Two channels carry the month:**",
    "- `app` and `web` are three quarters of the orders and almost all of the collected amount.",
    "- Failed attempts are a fifth of checkouts, unchanged since the gateway change.",
  ].join("\n"),
  wroteBy: EXCHANGE,
  autoH: true,
};

const aside: Block = {
  id: "c2-aside",
  kind: "note",
  text: "Ask payments whether the August gateway change moved the failed share.",
  autoH: true,
};

const SIX: Block[] = [figures, channels, finding, aside, cities, weekdays];

/** the same six elements, with the cells one layout gives them. The layout is
 * the fixture's own fact: what the surface draws is the document */
function at(cells: Record<string, Cell>): Block[] {
  return SIX.map((b) => ({ ...b, cell: cells[b.id] }));
}

/** stored at seven columns, the 960 frame's own count: the values row leaves
 * two cells of air, the chart and the note fill a row between them, and the
 * table leaves a 1x4 hole at its right, which is a hole BESIDE an element and
 * therefore the user's own placement (canvas-grid 4.5) */
const SEVEN: Record<string, Cell> = {
  "c2-figures": { x: 0, y: 0, w: 5, h: 1 },
  "c2-channels": { x: 0, y: 1, w: 4, h: 3 },
  "c2-finding": { x: 4, y: 1, w: 3, h: 2 },
  "c2-aside": { x: 4, y: 3, w: 3, h: 1 },
  "c2-cities": { x: 0, y: 4, w: 6, h: 4 },
  "c2-weekdays": { x: 0, y: 8, w: 6, h: 2 },
};

/** and at the FLOOR, five columns, where rule 13 designs it: every default
 * span fits, the chart keeps one cell of air beside it, and nothing clips */
const FIVE: Record<string, Cell> = {
  "c2-figures": { x: 0, y: 0, w: 5, h: 1 },
  "c2-channels": { x: 0, y: 1, w: 4, h: 3 },
  "c2-finding": { x: 0, y: 4, w: 3, h: 2 },
  "c2-aside": { x: 3, y: 4, w: 2, h: 1 },
  "c2-cities": { x: 0, y: 6, w: 5, h: 4 },
  "c2-weekdays": { x: 0, y: 10, w: 5, h: 2 },
};

// ---- the pre-C2 document, and the dense one --------------------------------

/** A3's own document, exactly as it was written: an ordered list, every block
 * full width, and not one cell anywhere. `laidOut` migrates it on the way to
 * the surface and nothing is written back until the reader's first change */
const V1: Block[] = [figures, channels, finding].map((b) => {
  const { cell: _cell, autoH: _autoH, wroteBy: _wroteBy, ...bare } = b;
  return bare as Block;
});

/** 200 elements, the perf state: mostly notes (the cheap kind) with a figure
 * row every fifth, placed by the ENGINE so the layout is one the product could
 * have produced and the same on every machine */
function dense(): Block[] {
  const items: GridItem[] = [];
  const blocks: Block[] = [];
  for (let i = 0; i < 200; i++) {
    const values = i % 5 === 0;
    const span = values ? { w: 2, h: 1 } : { w: i % 3 === 0 ? 3 : 2, h: i % 7 === 0 ? 2 : 1 };
    const id = `c2-dense-${i}`;
    // the engine's own first fit, row by row: no overlap, by construction
    const cell = place(items, span, 10);
    items.push({ id, cell });
    blocks.push(
      values
        ? ({
            ...figures,
            id,
            question: "",
            title: `Run ${i + 1}`,
            columns: ["orders"],
            rows: [[`${1000 + i * 7}`]],
            chips: [],
            status: "1 row · 12.0 ms",
            ms: 12,
            face: "values",
            cell,
          } as Block)
        : ({ id, kind: "note", text: `Element ${i + 1} of the dense page.`, cell, autoH: true } as Block),
    );
  }
  return blocks;
}

// ---- the seed --------------------------------------------------------------

function blocksFor(state: C2GridState): { blocks: Block[]; lastColumns: number } {
  if (state === "c2-migrated") return { blocks: V1, lastColumns: 0 };
  if (state === "c2-dense") return { blocks: dense(), lastColumns: 10 };
  if (state === "c2-grid-floor") return { blocks: at(FIVE), lastColumns: 5 };
  return { blocks: at(SEVEN), lastColumns: 7 };
}

export function c2GridSeed(state: string): C2GridSeed {
  const s = (C2_GRID_STATES as readonly string[]).includes(state) ? (state as C2GridState) : "c2-grid";
  const { blocks, lastColumns } = blocksFor(s);
  const doc: CanvasDoc =
    s === "c2-migrated" ? { blocks } : { v: 2, blocks, lastColumns };
  return {
    canvasId: CANVAS_ID,
    profileId: C2_GRID_PROFILE_ID,
    canvases: {
      [C2_GRID_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: C2_GRID_PROFILE_ID,
          title: "Orders, last month",
          updatedAt: "2026-09-11T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: doc },
    editing: null,
  };
}

// ---- the poses -------------------------------------------------------------

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

interface Stage {
  columns: number;
  /** the pitch on either axis: the column stretches, the row never does */
  px: number;
  py: number;
  slot: (id: string) => HTMLElement | null;
}

/** the page as the gesture reads it: the same metrics the surface wrote into
 * --cw and --gut, so a posed frame measures what the product measured */
function stageOf(): Stage {
  const host = document.querySelector<HTMLElement>(".cvg");
  if (!host) throw new Error("c2: the grid is not on the page");
  const m = cellMetrics(host.clientWidth);
  return {
    columns: m.columns,
    px: m.cellW + m.gutter,
    py: CELL_H + m.gutter,
    slot: (id) =>
      document.querySelector<HTMLElement>(`[data-block="${id}"]`)?.closest<HTMLElement>(".cvg-slot") ??
      null,
  };
}

/** what the page is standing on right now, read off the slots: the cells the
 * surface drew, whether they are the stored layout or a derived one */
function itemsOf(): GridItem[] {
  return [...document.querySelectorAll<HTMLElement>(".cvg-slot")].map((el) => {
    const read = (n: string) => Number(el.style.getPropertyValue(n) || "0");
    return {
      id: el.querySelector<HTMLElement>("[data-block]")?.dataset.block ?? "",
      cell: { x: read("--x"), y: read("--y"), w: read("--w"), h: read("--h") },
    };
  });
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

/** press a gesture's own surface and travel, through the PRODUCT's pointer
 * handler: the same `createGrab`, the same motion values, the same engine
 * preview, so everything a still can hold (the lift, the placeholder, the
 * neighbours' travel, the one size label) is the product's own answer.
 * Writing those styles by hand is what left the two states empty at 640: the
 * drag layer and the placeholder ARE motion values, and the React commit a
 * derived layout makes after the pose re-applies every one of them.
 *
 * The press is left OPEN, with no pointerup: a still of a drag is a drag
 * mid-air, and the release is what would commit it */
function press(on: HTMLElement, dx: number, dy: number): void {
  const box = on.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const proto = HTMLElement.prototype;
  const capture = proto.setPointerCapture;
  proto.setPointerCapture = () => {};
  try {
    send(on, "pointerdown", x, y);
    send(on, "pointermove", x + dx, y + dy);
  } finally {
    proto.setPointerCapture = capture;
  }
}

/** how far off its snap a held element stands, in px. Under half a cell on
 * either axis, so the cell a pose names is the cell the gesture snaps to; the
 * SIGN is the point. The held element stands left of its placeholder and the
 * resized box short of its span, which is what leaves the placeholder's own
 * bottom-right corner - and the one size label riding it - in view instead of
 * under the element it belongs to (9 and 14 left a 5px sliver and no label).
 * 52 is the widest that still rounds to the named cell at every width: half
 * the 640 pitch is 61.8 */
const OFF_X = 52;
const OFF_Y = 36;

/** the drag: the one-line note lifted into the page's first row, the engine
 * deciding what it pushes down and how far, exactly as the pointer handler
 * asks it frame by frame */
function poseDrag(stage: Stage): void {
  const id = aside.id;
  const from = itemsOf().find((i) => i.id === id);
  const grip = stage.slot(id)?.querySelector<HTMLElement>(".cvg-grip");
  if (!from || !grip) throw new Error("c2-drag: the element is not on the page");
  // the first row, one cell in: the element travels the whole page and what it
  // lands on travels down under it. One cell in and not column 0, because the
  // element stands LEFT of its placeholder and an element held over the page's
  // own edge is an element the scroller cuts; below it for the same reason,
  // since the row it is travelling to is the top one
  const to = { x: 1, y: 0 };
  press(grip, (to.x - from.cell.x) * stage.px - OFF_X, (to.y - from.cell.y) * stage.py + OFF_Y);
}

/** the resize: the chart's corner held one cell wider and one row shorter, the
 * box following the pointer and the placeholder already on the snapped span */
function poseResize(stage: Stage): void {
  const id = channels.id;
  const from = itemsOf().find((i) => i.id === id);
  const slot = stage.slot(id);
  const handle = slot?.querySelector<HTMLElement>(".cvg-handle");
  if (!from || !slot || !handle) throw new Error("c2-resize: the element is not on the page");
  const w = Math.min(stage.columns - from.cell.x, from.cell.w + 1);
  // the box is a corner's travel short of the span it has snapped to, which is
  // what leaves the placeholder standing past its right and bottom edges
  press(handle, (w - from.cell.w) * stage.px - OFF_X, -stage.py - OFF_Y);
  // a hover cannot be held in a still: the cluster the handle belongs to is
  // stamped hot, the canvas states' own precedent
  const hot = slot.querySelector<HTMLElement>("[data-block]");
  if (hot) hot.dataset.hot = "";
}

/** the post-mount hook. A hover cannot be held in a still, so the block the
 * sketch shows hot is stamped on the element the cluster floats over (the
 * canvas states' own precedent), and the two gesture states are PRESSED: the
 * product's own pointer handler, held open */
export async function c2GridAfterMount(state: string): Promise<void> {
  if (!(C2_GRID_STATES as readonly string[]).includes(state)) return;
  const s = state as C2GridState;
  if (s === "c2-grid") {
    const el = document.querySelector<HTMLElement>(`[data-block="${channels.id}"]`);
    if (el) el.dataset.hot = "";
  }
  if (s !== "c2-drag" && s !== "c2-resize") return;
  // the measure is a layout effect and the reflow a render: the gesture is
  // posed against the page as it finally stands, never as it first mounted
  await frame();
  const stage = stageOf();
  if (s === "c2-drag") poseDrag(stage);
  else poseResize(stage);
}
