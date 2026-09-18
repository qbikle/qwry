// F2 canvas fixtures: the New Chart dialog, the six states its sketch draws
// (docs/chart-sketch-f2.html, `?s=open|preview|date|running|error|added`).
// Framed through the harness's canvas root (`?harness=canvas&state=…&w=640|
// 960|1280`), the same door every other canvas wave's states use.
//
//   f2-chart-open      the dialog the moment it opens: nothing picked, the
//                      Table list standing with the caret in its search and
//                      `ord` typed, the three pickers under it disabled
//   f2-chart-preview   two picks and a chart: `public.order_v2` by `status`,
//                      counting rows, the bars lying down, the block's own
//                      `8 rows · 241.6 ms` and the statement on one mono line
//   f2-chart-date      a DATE group: `created_at` per Month, `avg amount`,
//                      `Last 12`, and the face draws a line instead of bars.
//                      The `Per` row stands only here, and only here does the
//                      row under it read `Last`
//   f2-chart-running   a pick made and the statement still on the wire: the
//                      widget's own cycle where the bars will be, the status
//                      slot empty, the statement already standing (LESSONS 16:
//                      the app answers in the frame, the network in the hold)
//   f2-chart-error     a group the snapshot still carries and the server does
//                      not: the preview gone, the picks standing, the server's
//                      own first line in the status slot in the danger register
//   f2-chart-added     Add pressed: the widget on the canvas at its default
//                      span, the dialog gone
//
// Every state is PRESSED, not drawn (fixtures.c2grid.ts's rule): the dialog is
// opened through the same store door the `+` menu's `Chart…` row takes, and
// every pick after that is a press on the product's own field and the product's
// own row, the words read off the rendered list. Add Chart is pressed too.
// Nothing here writes a document, a preview or a running flag by hand, so a
// fixture can never draw a dialog the product cannot produce.
//
// The one thing typed is the `ord` in the open state's search field, which is
// this surface's own React state and has no store door: the pose sets the
// input's value through the native setter and lets React read its own event.
//
// Self-contained, like fixtures.d3.ts: nothing here imports fixtures.ts.
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add F2_CANVAS_STATES to the canvas harness's state list, seed useCanvas and
// useSchema with f2Seed(state) before the first render, render <ChartDialog />
// beside <CanvasTab />, call f2AfterMount(state) in the post-mount frame
// before the ready mark, and give these states F2_CANVAS_CARD_H.

import { holdReadonlyRuns } from "./tauriShim";
import { useCanvas, type CanvasMeta } from "../stores/canvas";
import { useChartDialog } from "../stores/chartDialog";
import { useSchema, type ColumnInfo, type TableInfo } from "../stores/schema";

export const F2_CANVAS_STATES = [
  "f2-chart-open",
  "f2-chart-preview",
  "f2-chart-date",
  "f2-chart-running",
  "f2-chart-error",
  "f2-chart-added",
] as const;
export type F2CanvasState = (typeof F2_CANVAS_STATES)[number];

/** the card's own three widths, A3's: the canvas is a face of the main card */
export const F2_CANVAS_WIDTHS = [640, 960, 1280] as const;

/** The card is sized so the WINDOW the frame is shot in is the product's own
 * 800 x 600 minimum (the script adds 24px of margin top and bottom). That is
 * the whole point of the number: the dialog's own cap, the preview's 160px
 * ceiling and the card's `max-height` are all claims about this window, and a
 * frame shot on a taller card would prove none of them (DESIGN rule 13, floor
 * first). Every state reads on it, including `f2-chart-added`, whose widget
 * stands at the page's own top-left. */
export const F2_CANVAS_CARD_H = 552;

/** the fixture connection, the same id every other canvas fixture uses, so a
 * harness page that seeds more than one of them agrees with itself */
export const F2_PROFILE_ID = "harness-staging";
const CANVAS_ID = "f2-canvas";

const col = (name: string, type: string, attnum: number): ColumnInfo => ({
  name,
  attnum,
  type,
  type_oid: 0,
  not_null: false,
  default: null,
});

/** `order_v2`'s own columns. `statuss` is deliberately here and deliberately
 * NOT on the server: a snapshot may name a column an `ALTER` has since dropped,
 * and a picker that offered only what the server still has would have to ask
 * the server on every keystroke (LESSONS 5: cached metadata informs, never
 * refuses). It is what `f2-chart-error` picks */
const ORDER_COLUMNS: ColumnInfo[] = [
  col("id", "bigint", 1),
  col("status", "text", 2),
  col("statuss", "text", 3),
  col("amount", "numeric(10,2)", 4),
  col("currency", "character varying(3)", 5),
  col("created_at", "timestamp with time zone", 6),
];

const table = (
  schema: string,
  name: string,
  kind: TableInfo["kind"],
  reltuples: number | null,
  columns: ColumnInfo[] = ORDER_COLUMNS,
): TableInfo => ({
  table_oid: 0,
  schema,
  name,
  kind,
  columns,
  pk: ["id"],
  reltuples,
});

/** eight relations across two schemas, five of which answer `ord`: enough for
 * the list to run past its own box and for a second schema's head to show */
const TABLES: TableInfo[] = [
  table("public", "order_v2", "r", 1_200_000),
  table("public", "order_item_v2", "r", 3_400_000),
  table("public", "order_events_v2", "r", 9_800_000),
  table("public", "orders_legacy", "r", 41_000),
  table("public", "cart_product", "r", 812_000),
  table("public", "users", "r", 640_000),
  table("public", "wardrobe_products_v2", "r", 1_100_000),
  table("analytics", "order_daily_mv", "m", -1),
];

export interface F2Seed {
  canvasId: string;
  profileId: string;
  canvases: Record<string, CanvasMeta[]>;
  docs: Record<string, { v: 2; blocks: never[]; lastColumns: number }>;
  editing: null;
}

/** every F2 state opens on the SAME empty canvas: what the frame is evidence
 * of is the dialog, and a page with widgets already on it would be evidence of
 * the page */
export function f2Seed(): F2Seed {
  useSchema.setState((s) => ({
    snapshots: {
      ...s.snapshots,
      [F2_PROFILE_ID]: {
        tables: TABLES,
        foreign_keys: [],
        functions: [],
        schemas: ["public", "analytics"],
        indexes: [],
        enums: [],
      },
    },
  }));
  return {
    canvasId: CANVAS_ID,
    profileId: F2_PROFILE_ID,
    canvases: {
      [F2_PROFILE_ID]: [
        {
          id: CANVAS_ID,
          profileId: F2_PROFILE_ID,
          title: "Canvas 7",
          updatedAt: "2026-09-18T09:00:00.000Z",
        },
      ],
    },
    docs: { [CANVAS_ID]: { v: 2, blocks: [], lastColumns: 5 } },
    editing: null,
  };
}

// ---- the pose --------------------------------------------------------------
//
// Every pick is a PRESS on the product's own control, never a call to the
// store behind it (fixtures.c2grid.ts's rule): a store call would set the pick
// and leave the popover the row's own press closes standing over the frame,
// which is exactly the drift a fixture that "draws" a state ships.

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

async function found<T extends Element>(selector: string, tries = 90): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const el = document.querySelector<T>(selector);
    if (el) return el;
    await frame();
  }
  throw new Error(`f2: ${selector} never appeared`);
}

/** open a field's own list, by pressing the field */
async function pressField(label: string): Promise<void> {
  const el = await found<HTMLButtonElement>(`.field[aria-label="${label}"]`);
  el.click();
  await frame();
}

/** take a row of the standing list, by its own words */
async function pressRow(label: string): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const hit = Array.from(document.querySelectorAll<HTMLElement>(".field-pop .picker-item")).find(
      (r) => r.querySelector(".field-name, .picker-label")?.textContent === label,
    );
    if (hit) {
      hit.click();
      await frame();
      return;
    }
    await frame();
  }
  throw new Error(`f2: no row reads ${label}`);
}

/** one face of a segmented control, by its own words */
async function pressSeg(group: string, option: string): Promise<void> {
  const seg = await found<HTMLElement>(`[role="group"][aria-label="${group}"]`);
  const hit = Array.from(seg.querySelectorAll("button")).find((b) => b.textContent === option);
  if (!hit) throw new Error(`f2: ${group} has no ${option}`);
  hit.click();
  await frame();
}

/** hold until the preview has an answer of its own, whichever answer it is */
async function answered(tries = 150): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const s = useChartDialog.getState();
    if (!s.running && (s.run !== null || s.error !== null)) return;
    await frame();
  }
  throw new Error("f2: the preview never answered");
}

/** React owns the input's value, so a pose writes through the native setter and
 * lets React's own change handler read the event it would have read from a
 * keypress (the product's state, never a second copy of it) */
async function type(text: string): Promise<void> {
  const input = await found<HTMLInputElement>(".field-search input");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await frame();
}

export async function f2AfterMount(state: string): Promise<void> {
  if (!(F2_CANVAS_STATES as readonly string[]).includes(state)) return;
  const s = state as F2CanvasState;
  // the same door the `+` menu's `Chart…` row presses
  useChartDialog.getState().open(CANVAS_ID);
  // the card and its Table popover mount a frame later, and the popover's own
  // anchor settles over the card's entrance (ChartDialog `useFieldPoint`)
  await found(".chart-modal");
  await found(".field-search input");

  if (s === "f2-chart-open") {
    await type("ord");
    // the box is measured, clamped and painted before the ready mark
    await frame();
    await frame();
    return;
  }

  // the statement of the running state never comes back, so the frame catches
  // the hold and not a race with it: the cycle it shows is the one the product
  // put up in the pick's own frame (LESSONS 16's harness clause, read the other
  // way: a rig that answers instantly can never show what a wait looks like)
  if (s === "f2-chart-running") holdReadonlyRuns(true);

  await pressRow("order_v2");
  await pressField("Group by");

  if (s === "f2-chart-error") {
    // a column the SNAPSHOT still carries and the server does not
    await pressRow("statuss");
    await answered();
    await frame();
    return;
  }

  if (s === "f2-chart-date") {
    await pressRow("created_at");
    await pressField("Measure");
    await pressRow("amount");
    await pressSeg("Aggregate", "Avg");
    await answered();
    await frame();
    return;
  }

  await pressRow("status");

  if (s === "f2-chart-running") {
    for (let i = 0; i < 30; i++) await frame();
    return;
  }

  await answered();
  await frame();
  if (s === "f2-chart-preview") return;

  // f2-chart-added: the dialog's own Add Chart, so the widget on the page is
  // the one the product lands and not one this file wrote
  const add = await found<HTMLButtonElement>(".cd-actions .btnish.primary");
  add.click();
  await found(".cv-scroll [data-block]");
  // the page settles around the widget's own cells before the mark
  for (let i = 0; i < 6; i++) await frame();
  if (useCanvas.getState().docs[CANVAS_ID]?.blocks.length !== 1)
    throw new Error("f2-chart-added: Add landed nothing");
}
