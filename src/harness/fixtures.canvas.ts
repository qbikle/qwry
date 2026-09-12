// Canvas fixtures for the design harness (A3 items 2, 5 and 6, the "A3 ·
// canvas" rows of ask-sketch-a3.html). The canvas is a MAIN-AREA face, not a
// pane, so these states are framed through the harness's second root
// (`?harness=canvas&state=…&w=640|960|1280`) at the card's own three widths:
//
//   a3-canvas      the sketch's three blocks: a result hot (Copy · Flip ·
//                  Insert · Ask · More over its question line), a note, and a
//                  result already on its chart face
//   a3-chart       one result on the chart face with TWO series on one scale,
//                  hot: the legend inside the face, the flip's glyph now the
//                  SQL, and every value at its bar's end
//   a3-chart-line  a date label, so the same face draws a line instead (the
//                  designer's open note: the line was described and not drawn)
//   a3-diff        a comparison standing, at rest: staging vs prod in the
//                  status line, six rows, one of them on prod only in the
//                  warn tier
//   a3-empty       nothing at all: 0 strings, 0 controls, a text cursor over
//                  the card (DESIGN rule 11's deletion test, DECISIONS A3)
//   a3-menu        the same result block with `More` open: Compare With the
//                  connection's two siblings, Move Up held on the first
//                  block, Move Down, Delete ⌫
//   a3-note-edit   the note in edit under a result at rest: its source in the
//                  composer's box, no cluster. A caret, like a hover, cannot
//                  be held in a still (it blinks, and SETTLE_MS lands in
//                  whichever phase it lands in), so the still is not the
//                  caret's evidence; `canvasAfterMount` asserts it instead
//                  (activeElement is the note's textarea, selectionStart ===
//                  value.length) and logs the assertion to a3-probe.log
//
// The docs are canned exactly as the store would hold them, and the diff runs
// through the store's own `buildDiff`, so a fixture can never draw a document
// the product cannot produce. A hover cannot be held in a still, so
// `canvasAfterMount` stamps `data-hot` on the block the sketch shows hot
// (canvas.css reads `.blk[data-hot] > .acts-float` as that block's hover),
// the `result` states' own precedent. The two states that hold TRANSIENT
// chrome open reach it the way the product does: the caret through the
// store's own `editing` (seeded, so the note never renders read first), the
// menu through a press on `More` and then on `Compare With` (a menu has no
// store door, and pressing the buttons is the only reading that cannot
// drift from the product's, and the only one asserted-and-retried below: a
// one-shot parent-row rect (ContextMenu.tsx's SubPanel) can be read against
// a not-yet-settled anchor when the press follows the open by nothing more
// than a still frame, landing the submenu ON its parent instead of beside
// it — a synthetic-click race a real pointer's travel time never hits).
// The hook is therefore async, and the harness
// stamps its ready mark after it settles.
//
// Self-contained, like fixtures.result.ts: nothing here imports fixtures.ts,
// so there is no cycle to order. Wiring (fixtures.ts / AskHarness.tsx /
// ask-frames.ts are the integrator's): add CANVAS_STATES to the canvas
// harness's own state list, seed `useCanvas` with `canvasSeed(state)` before
// the first render, mount `<CanvasTab canvasId={seed.canvasId} />` inside a
// card of the chosen width, and call `canvasAfterMount(state)` in the
// post-mount frame, before the ready mark.

import { buildDiff, type Block, type CanvasDoc, type CanvasMeta } from "../stores/canvas";

export const CANVAS_STATES = [
  "a3-canvas",
  "a3-chart",
  "a3-chart-line",
  "a3-diff",
  "a3-empty",
  "a3-menu",
  "a3-note-edit",
] as const;
export type CanvasState = (typeof CANVAS_STATES)[number];

/** the widths the canvas is drawn at: the main card's floor, its default and
 * a wide window (the pane's 320 · 392 · 560 for the main area) */
export const CANVAS_WIDTHS = [640, 960, 1280] as const;

/** the fixture connection, the same id the pane's own fixtures use, so a
 * harness page that seeds both agrees with itself */
export const CANVAS_PROFILE_ID = "harness-staging";
const CANVAS_ID = "harness-canvas";

export interface CanvasSeed {
  canvasId: string;
  profileId: string;
  /** useCanvas.canvases */
  canvases: Record<string, CanvasMeta[]>;
  /** useCanvas.docs */
  docs: Record<string, CanvasDoc>;
  /** useCanvas.editing: the note that holds the caret, or null. Seeded
   * rather than pressed, so the note never draws its read face first */
  editing: string | null;
}

// ---- the blocks ------------------------------------------------------------

/** the W5 revenue answer: four currencies, the INR row carrying the month */
const revenue: Block = {
  id: "a3-blk-revenue",
  kind: "result",
  question: "can you check the revenue in last month",
  prose:
    "Nearly all of last month's paid revenue is INR; the USD, AUD and EUR rows are ten orders between them, kept in their own currency rather than converted.",
  sql: "SELECT sum(total_amount) AS revenue,\n       count(*) AS order_count,\n       currency\nFROM order_v2\nWHERE payment_status = 'paid'\n  AND created_at >= date_trunc('month', now()) - interval '1 month'\n  AND created_at < date_trunc('month', now())\nGROUP BY currency\nORDER BY revenue DESC",
  columns: ["revenue", "order_count", "currency"],
  rows: [
    ["2277416.00", "482", "INR"],
    ["1893.50", "7", "USD"],
    ["412.00", "2", "AUD"],
    ["260.00", "1", "EUR"],
  ],
  chips: ["Last Month = August 2026", "Revenue = Paid Orders"],
  status: "4 rows · 311.8 ms",
  ms: 311.8,
  face: "table",
};

/** the user's own note, written under the answer it reads */
const note: Block = {
  id: "a3-blk-note",
  kind: "note",
  text: [
    "**For Friday's finance call:**",
    "- The INR figure is the one to quote; the USD, AUD and EUR tails are ten orders and stay unconverted until `erp_fx_rate` is filled.",
    "- Failed attempts are still a fifth of checkouts; ask payments whether the August gateway change moved it.",
    "- COD in transit is 23% of what has been collected, so the month closes higher than the paid total shows.",
  ].join("\n"),
};

/** one label, one series: bars lying down, the value at every bar's end */
const channels: Block = {
  id: "a3-blk-channels",
  kind: "result",
  question: "how many orders came from each channel last month",
  prose:
    "The app took 58% of August's orders; Instagram and WhatsApp together are a fifth, and referral is under 2%.",
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
  chips: ["Last Month = August 2026"],
  status: "6 rows · 208.3 ms",
  ms: 208.3,
  face: "chart",
};

/** two series on ONE scale, the legend inside the face at its top-left */
const cities: Block = {
  id: "a3-blk-cities",
  kind: "result",
  question: "which cities return the most cod",
  prose:
    "Delhi returns 19% of its COD parcels and Kolkata 21%; Bengaluru, the third-largest COD city, returns under 10%.",
  sql: "SELECT city,\n       count(*) FILTER (WHERE payment_method = 'cod') AS cod_orders,\n       count(*) FILTER (WHERE payment_status = 'rto') AS returned\nFROM order_v2\nWHERE created_at >= date_trunc('month', now()) - interval '1 month'\n  AND created_at < date_trunc('month', now())\nGROUP BY city\nORDER BY cod_orders DESC",
  columns: ["city", "cod_orders", "returned"],
  rows: [
    ["Mumbai", "412", "61"],
    ["Delhi", "388", "74"],
    ["Bengaluru", "301", "29"],
    ["Hyderabad", "244", "38"],
    ["Pune", "187", "21"],
    ["Kolkata", "160", "33"],
    ["Jaipur", "121", "19"],
    ["Lucknow", "96", "17"],
  ],
  chips: ["Last Month = August 2026", "Returned = rto"],
  status: "8 rows · 356.2 ms",
  ms: 356.2,
  face: "chart",
};

/** a date label: the same face draws a line, three y ticks and sparse x ticks */
const months: Block = {
  id: "a3-blk-months",
  kind: "result",
  question: "how has paid revenue moved month by month",
  prose:
    "Paid revenue has climbed every month since April; August is the first month over ₹2.2M and the step from July is the largest of the six.",
  sql: "SELECT date_trunc('month', created_at)::date AS month,\n       sum(total_amount) AS revenue\nFROM order_v2\nWHERE payment_status = 'paid'\nGROUP BY 1\nORDER BY 1",
  columns: ["month", "revenue"],
  rows: [
    ["2026-03-01", "1412880.00"],
    ["2026-04-01", "1338420.00"],
    ["2026-05-01", "1607350.00"],
    ["2026-06-01", "1794210.00"],
    ["2026-07-01", "1962540.00"],
    ["2026-08-01", "2277416.00"],
  ],
  chips: ["Revenue = Paid Orders"],
  status: "6 rows · 268.4 ms",
  ms: 268.4,
  face: "chart",
};

// ---- the comparison --------------------------------------------------------

const DIFF_COLUMNS = ["payment_status", "orders", "amount"];
const DIFF_A: (string | null)[][] = [
  ["cod_delivered", "731", "1988640.00"],
  ["failed", "611", "1402315.00"],
  ["paid", "482", "2277416.00"],
  ["cod_pending", "418", "982300.00"],
  ["cancelled", "207", "498115.00"],
];
const DIFF_B: (string | null)[][] = [
  ["cod_delivered", "748", "2011200.00"],
  ["failed", "640", "1466980.00"],
  ["paid", "479", "2263890.00"],
  ["cod_pending", "402", "947610.00"],
  ["cancelled", "211", "505990.00"],
  ["partial_refund", "21", "61420.00"],
];

/** the store's own pairing, never a hand-written diff: a fixture that built
 * its rows by hand could draw a face the product cannot produce */
function comparison() {
  const built = buildDiff({
    columns: DIFF_COLUMNS,
    aRows: DIFF_A,
    bColumns: DIFF_COLUMNS,
    bRows: DIFF_B,
    aTotal: DIFF_A.length,
    bTotal: DIFF_B.length,
    a: { profileId: CANVAS_PROFILE_ID, name: "staging", ms: 412.6 },
    b: { profileId: "harness-prod", name: "prod", ms: 388.1 },
  });
  if (!built.ok) throw new Error(`canvas fixture: ${built.message}`);
  return built.diff;
}

const compared: Block = {
  id: "a3-blk-diff",
  kind: "result",
  question: "what stood out in orders last month",
  prose:
    "Across 2,763 orders:\n\n- A prepaid basket averages ₹4,725, a COD basket ₹2,564.\n- Failed payments are 22% of attempts, more than every refund and return combined.\n- Collected ₹4,266,056 so far, and the COD still in transit would add another 23%.",
  sql: "SELECT payment_status,\n       count(*) AS orders,\n       sum(total_amount) AS amount\nFROM order_v2\nWHERE created_at >= date_trunc('month', now()) - interval '1 month'\n  AND created_at < date_trunc('month', now())\nGROUP BY payment_status\nORDER BY orders DESC",
  columns: DIFF_COLUMNS,
  rows: DIFF_A,
  chips: ["Last Month = August 2026", "Orders = created_at"],
  status: "5 rows · 412.6 ms",
  ms: 412.6,
  face: "diff",
  diff: comparison(),
};

// ---- exports ---------------------------------------------------------------

function blocksFor(state: CanvasState): Block[] {
  switch (state) {
    case "a3-canvas":
      return [revenue, note, channels];
    case "a3-chart":
      return [cities];
    case "a3-chart-line":
      return [months];
    case "a3-diff":
      return [compared];
    case "a3-empty":
      return [];
    case "a3-menu":
    case "a3-note-edit":
      return [revenue, note];
  }
}

export function canvasSeed(state: CanvasState): CanvasSeed {
  const meta: CanvasMeta = {
    id: CANVAS_ID,
    profileId: CANVAS_PROFILE_ID,
    title: "Canvas",
    updatedAt: "2026-09-06T09:12:00Z",
  };
  return {
    canvasId: CANVAS_ID,
    profileId: CANVAS_PROFILE_ID,
    canvases: { [CANVAS_PROFILE_ID]: [meta] },
    docs: { [CANVAS_ID]: { blocks: blocksFor(state) } },
    editing: state === "a3-note-edit" ? note.id : null,
  };
}

/** the block whose cluster is hot, or null where the sketch draws the state
 * at rest (the diff names its two connections in the status line, the empty
 * canvas has nothing to hover, and the note in edit has no cluster at all) */
function hotBlock(state: CanvasState): string | null {
  switch (state) {
    case "a3-canvas":
      return revenue.id;
    case "a3-chart":
      return cities.id;
    case "a3-chart-line":
      return months.id;
    case "a3-menu":
      return revenue.id;
    default:
      return null;
  }
}

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** a panel whose PAINTED width has caught up with its layout width. Under
 * the forced `prefers-reduced-motion` every frame runs under (springs.ts:
 * `menuIn` is `{opacity:1,scale:1}` there, tokens.css zeroes the transition),
 * this settles on frame one — it is not what guards the submenu below */
async function settled(selector: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const el = document.querySelector<HTMLElement>(selector);
    const w = el?.getBoundingClientRect().width ?? 0;
    if (el && w > 0 && Math.abs(w - el.offsetWidth) < 1) return frame();
    await frame();
  }
}

function rect(selector: string): DOMRect | null {
  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
}

/** the parent menu's own positioned box (AnchoredOverlay's `.ov-anchor-pos`)
 * unchanged across two consecutive frames, with its submenu row at the
 * menu's own full inner width. SubPanel (ContextMenu.tsx) anchors to a
 * ONE-SHOT rect of that row, read the instant it is clicked; a synthetic
 * click has no travel time for the anchor's own clamp (Overlay.tsx's
 * `useClampedPosition`) to have caught up first, where a real pointer's
 * hover always does. Waiting on this closes the gap without guessing at
 * why a given run drifted */
async function menuAnchorReady(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const anchor = document.querySelector<HTMLElement>(".ov-anchor-layer .ov-anchor-pos");
    const menu = anchor?.querySelector<HTMLElement>(".ctx-menu") ?? null;
    const row = menu?.querySelector<HTMLElement>('[aria-haspopup="true"]') ?? null;
    if (anchor && menu && row) {
      const r1 = anchor.getBoundingClientRect();
      await frame();
      if (!document.contains(anchor) || !document.contains(row)) continue;
      const r2 = anchor.getBoundingClientRect();
      const stable =
        r1.left === r2.left && r1.top === r2.top && r1.width === r2.width && r1.height === r2.height;
      const cs = getComputedStyle(menu);
      const innerW = menu.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const rowW = row.getBoundingClientRect().width;
      if (stable && Math.abs(rowW - innerW) < 1) return true;
    } else {
      await frame();
    }
  }
  return false;
}

/** the submenu beside its parent, never on it. ContextMenu's SubPanel
 * deliberately tucks into whichever edge it attaches to (`r.right - 3` /
 * `leftEdge - w + 3`, read off the ROW, which itself sits `.ctx-menu`'s own
 * ~5px border+padding inside the menu box) — an ~8px overlap by design on
 * both branches, measured live (960-dark: anchor 769-959, subpanel 587-777,
 * an 8px overlap on the flip-left branch). The race this guards against
 * overlapped by ~150-190px (a whole extra column), so a tolerance well
 * clear of the design's own 8px still catches it without flagging the seam */
function submenuBeside(): boolean {
  const anchor = rect(".ov-anchor-layer .ov-anchor-pos");
  const sub = rect(".ctx-subpanel");
  if (!anchor || !sub) return false;
  const TUCK = 16;
  return sub.left >= anchor.right - TUCK || sub.right <= anchor.left + TUCK;
}

async function pressEscape(): Promise<void> {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await frame();
}

/** the block's menu, opened by pressing the buttons that open it. A menu is
 * transient chrome with no store door, and a fixture that drew its rows
 * itself would be evidence for a menu the product never builds. The press
 * on `Compare With` waits for `menuAnchorReady`, and the submenu it opens is
 * checked with `submenuBeside`, not just waited for: a miss closes the whole
 * menu (Escape, which is the topmost overlay's own onClose) and tries again,
 * capped at 5, else throws — the ready mark then never lands, and
 * ask-frames exits 1 on the missing frame rather than writing a still that
 * libels the product */
async function openBlockMenu(blockId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    document.querySelector<HTMLElement>(`[data-block="${blockId}"] button[aria-label="More"]`)?.click();
    await settled(".ov-anchor-layer .ctx-menu");
    if (await menuAnchorReady()) {
      document.querySelector<HTMLElement>('.ctx-menu [aria-haspopup="true"]')?.click();
      await settled(".ctx-subpanel");
      if (submenuBeside()) return;
    }
    await pressEscape();
  }
  throw new Error("a3-menu: the submenu kept landing on its parent after 5 attempts");
}

/** the note's caret: a still cannot hold it (it blinks, and SETTLE_MS lands
 * in whichever phase it lands in), so this asserts it instead of shooting
 * for it, and logs the assertion so a re-run's evidence is on record */
function assertNoteCaret(noteId: string): void {
  const el = document.querySelector<HTMLTextAreaElement>(`[data-block="${noteId}"] textarea`);
  const ok = !!el && document.activeElement === el && el.selectionStart === el.value.length;
  // eslint-disable-next-line no-console -- the probe's own record, not app logging
  console.log(`a3-note-edit: caret at end of textarea = ${ok}`);
  if (!ok) throw new Error("a3-note-edit: the note's caret is not at the end of its text");
}

/** the post-mount hook: a hover cannot be held in a still, so the block the
 * sketch shows hot is stamped on the element the cluster floats over, the
 * one state whose subject is a menu presses it open (asserting the geometry
 * as it goes, not just waiting), and the one state whose subject is a caret
 * asserts it rather than trusting a still to hold it */
export async function canvasAfterMount(state: string): Promise<void> {
  if (!(CANVAS_STATES as readonly string[]).includes(state)) return;
  const s = state as CanvasState;
  const id = hotBlock(s);
  if (id) {
    const el = document.querySelector<HTMLElement>(`[data-block="${id}"]`);
    if (el) el.dataset.hot = "";
  }
  if (s === "a3-menu") await openBlockMenu(revenue.id);
  if (s === "a3-note-edit") assertNoteCaret(note.id);
}
