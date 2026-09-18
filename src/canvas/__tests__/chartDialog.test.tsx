// F2: what the New Chart dialog DRAWS for a given set of picks. The store's
// own tests (stores/__tests__/chartDialog.test.ts) pin what a pick composes and
// runs; this file pins the four things the picks change on screen, each of them
// a rule a reader would otherwise have to check in a frame:
//
//   the disabled state   a picker with nothing to pick yet is disabled and
//                        still standing, never absent (DESIGN rule 8, rule 2's
//                        stable chrome)
//   the Per row          stands only over a date group, and only then does the
//                        row under it read `Last` instead of `Top`
//   the aggregate        the segmented control appears only beside a measure
//                        COLUMN; `Count rows` has nothing to aggregate
//   Add Chart            disabled until a chart exists and while a run is in
//                        flight, and the status slot carries the run's facts or
//                        the server's refusal, never both

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// canvas.ts reaches tabs.ts and settings.ts, which paint the theme and read
// localStorage at import: the canvas tests' own seam, kept identical
const mem = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => undefined,
});
const shimmed = ["window", "localStorage", "document"].filter((k) => !(k in globalThis));
for (const k of shimmed) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });
}

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC((cmd) => (cmd === "agent_connect" ? "session-f2" : undefined));

const { ChartDialogBody, PREVIEW_LINE_H } = await import("../ChartDialog");
const { lineLayout } = await import("../Chart");
const { addMenuFor } = await import("../CanvasTab");
const { cancelCanvasSaves, useCanvas } = await import("../../stores/canvas");
const { cancelTabSaves } = await import("../../stores/tabs");
const { useSchema } = await import("../../stores/schema");
const { useChartDialog } = await import("../../stores/chartDialog");
type AgentRun = import("../../agent/types").AgentRun;

afterAll(() => {
  cancelCanvasSaves();
  cancelTabSaves();
  clearMocks();
});

const PROFILE = "p-f2-draw";
const CANVAS = "c-f2-draw";

const RUN: AgentRun = {
  columns: ["status", "count"],
  rows: [
    ["delivered", "41238"],
    ["confirmed", "18804"],
  ],
  rowCount: 2,
  capped: false,
  ms: 241.6,
};

const column = (name: string, type: string, attnum: number) => ({
  name,
  attnum,
  type,
  type_oid: 0,
  not_null: false,
  default: null,
});

beforeEach(() => {
  useChartDialog.getState().close();
  useCanvas.setState({
    canvases: [
      { id: CANVAS, profileId: PROFILE, title: "Canvas 7", updatedAt: "2026-09-18T09:00:00.000Z" },
    ].reduce((acc, m) => ({ ...acc, [PROFILE]: [m] }), {}),
    docs: { [CANVAS]: { v: 2, blocks: [], lastColumns: 5 } },
    loaded: { [PROFILE]: true },
    recent: { [PROFILE]: CANVAS },
  });
  useSchema.setState({
    snapshots: {
      [PROFILE]: {
        tables: [
          {
            table_oid: 1,
            schema: "public",
            name: "order_v2",
            kind: "r",
            columns: [
              column("status", "text", 1),
              column("amount", "numeric(10,2)", 2),
              column("created_at", "timestamp with time zone", 3),
            ],
            pk: [],
            reltuples: 1_200_000,
          },
        ],
        foreign_keys: [],
        functions: [],
        schemas: ["public"],
        indexes: [],
        enums: [],
      },
    },
  });
  useChartDialog.getState().open(CANVAS);
});

/** the body drawn against the store AS IT STANDS. The card's own hook reads
 * zustand's initial state under server rendering, which is why the body takes
 * the state as a prop: a test that rendered the card would draw an empty dialog
 * whatever it had picked */
const drawn = () => renderToStaticMarkup(<ChartDialogBody s={useChartDialog.getState()} />);

/** the label of the row whose control is this field: the grid puts the label
 * immediately before the control it names */
const labelled = (html: string, label: string): boolean =>
  html.includes(`aria-label="${label}"`);

describe("the rows", () => {
  test("the dialog names itself and nothing else", () => {
    const html = drawn();
    expect(html).toContain("New Chart");
    expect(html).toContain(">Table<");
    expect(html).toContain(">Group by<");
    expect(html).toContain(">Measure<");
  });

  test("an empty field carries no placeholder: the row's own label names it", () => {
    expect(drawn()).toContain('<span class="field-v mono"></span>');
  });

  test("a picker with nothing to pick yet is disabled, and still standing", () => {
    const html = drawn();
    expect(labelled(html, "Group by")).toBe(true);
    expect(labelled(html, "Measure")).toBe(true);
    // three of the four fields are disabled before a table stands
    expect(html.split("disabled").length - 1).toBeGreaterThanOrEqual(3);
  });

  test("a table chosen enables the pickers under it", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    const html = drawn();
    expect(html).toContain("public.order_v2");
    expect(html).toContain("1.2M");
    expect(html.split("disabled").length - 1).toBe(1); // Add Chart alone
  });
});

describe("the date group's two rows", () => {
  test("Per is absent over a text group, and the cap reads Top", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    const html = drawn();
    expect(html).not.toContain(">Per<");
    expect(html).toContain(">Top<");
    expect(html).not.toContain(">Last<");
  });

  test("Per stands over a date group, and the cap reads Last", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("created_at");
    const html = drawn();
    expect(html).toContain(">Per<");
    expect(html).toContain(">Month<");
    expect(html).toContain(">Last<");
    expect(html).not.toContain(">Top<");
  });

  test("the aggregate stands only beside a measure column", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    expect(drawn()).not.toContain('aria-label="Aggregate"');
    useChartDialog.getState().pickMeasure("amount");
    const html = drawn();
    expect(html).toContain('aria-label="Aggregate"');
    expect(html).toContain(">Sum<");
    expect(html).toContain(">Max<");
  });
});

describe("the preview and the actions", () => {
  test("no picks: no preview box, no status, no statement", () => {
    const html = drawn();
    expect(html).not.toContain("cd-preview");
    expect(html).not.toContain("cd-status");
    expect(html).not.toContain("cd-sql");
  });

  test("a run in flight: the widget's own cycle, the statement, an empty status", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    const html = drawn();
    expect(html).toContain("cd-skel");
    expect(html).toContain("select status, count(*) as count from public.order_v2");
    expect(html).toContain('<div class="cd-status"></div>');
  });

  test("Add Chart is disabled while the run is in flight", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    expect(drawn()).toContain("Add Chart");
    expect(drawn()).toContain('class="btnish primary" disabled=""');
  });

  test("a run that landed: the chart, the block's own status line, Add enabled", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    useChartDialog.setState({ running: false, run: RUN });
    const html = drawn();
    expect(html).toContain("cv-chart");
    expect(html).not.toContain("cd-skel");
    expect(html).toContain("2 rows · 241.6 ms");
    expect(html).not.toContain('class="btnish primary" disabled=""');
  });

  test("a failed run: the server's line in the danger register, no preview, the picks standing", () => {
    useChartDialog.getState().pickTable("public", "order_v2");
    useChartDialog.getState().pickGroup("status");
    useChartDialog.setState({ running: false, run: null, error: 'column "statuss" does not exist' });
    const html = drawn();
    expect(html).toContain('class="cd-status err"');
    // the server's own words, escaped by the renderer and not by the dialog
    expect(html).toContain("column &quot;statuss&quot; does not exist");
    expect(html).not.toContain("cd-preview");
    expect(html).toContain("public.order_v2");
    expect(html).toContain('class="btnish primary" disabled=""');
  });

  test("the two other routes out are always there", () => {
    const html = drawn();
    expect(html).toContain("Ask instead");
    expect(html).toContain("Cancel");
  });
});

describe("the box clears the face it holds", () => {
  // The date preview used to draw a 132px plot and hang its month labels 18px
  // below it, inside a box capped at 156: the dates were scrolled out at rest
  // in every date frame, and overlay scrollbars left no cue that they existed
  // (DESIGN rule 13, LESSONS 9). The face and the cap are now one number apart.
  const months = {
    kind: "line" as const,
    label: "created_at",
    labels: ["2025-10", "2025-11", "2025-12", "2026-01"],
    series: [{ name: "avg_amount", values: [1840, 2010, 2260, 1990] }],
  };

  test("a line takes the whole height the preview gives it, its dates inside", () => {
    const g = lineLayout(months, 560, PREVIEW_LINE_H);
    expect(g.h).toBe(PREVIEW_LINE_H);
    // where `line()` sets the label baseline, plus the descenders under it
    expect(g.legH + g.plotH + 14 + 4).toBeLessThanOrEqual(PREVIEW_LINE_H);
  });

  test("the box's own cap clears that face, padding and hairline and all", () => {
    const css = readFileSync(join(import.meta.dir, "../chartDialog.css"), "utf8");
    const cap = /\.cd-preview\s*\{[^}]*max-height:\s*(\d+)px/.exec(css);
    const pad = /\.cd-preview\s*\{[^}]*padding:\s*var\(--sp-3\)/.test(css);
    expect(cap).not.toBeNull();
    expect(pad).toBe(true);
    // --sp-3 either side of the face, and the hairline either side of that
    expect(Number(cap?.[1])).toBeGreaterThanOrEqual(PREVIEW_LINE_H + 12 * 2 + 2);
    // that arithmetic holds only if cv-chart's own 4px top+bottom (meant for
    // a chart beside a title and a status line on the canvas) is zeroed here:
    // the box above already gives the face 12; both would double the gap
    // the cap does not have and a line would scroll 8px it should not
    const zeroed = /\.cd-preview\s+\.cv-chart\s*\{[^}]*padding(-block)?:\s*0/.test(css);
    expect(zeroed).toBe(true);
  });
});

describe("the doors", () => {
  test("the + menu's Chart… row opens the dialog on the canvas it stands on", () => {
    useChartDialog.getState().close();
    const row = addMenuFor(CANVAS).find((n) => n.kind === "item" && n.label === "Chart…");
    expect(row).toBeDefined();
    if (row?.kind !== "item") throw new Error("Chart… is not an item row");
    row.onSelect?.();
    expect(useChartDialog.getState().canvasId).toBe(CANVAS);
  });

  test("the ellipsis stays: the row asks before it acts, where the other two do not", () => {
    const labels = addMenuFor(CANVAS).map((n) => (n.kind === "item" ? n.label : ""));
    expect(labels).toEqual(["Note", "Drawing", "Chart…"]);
  });
});
