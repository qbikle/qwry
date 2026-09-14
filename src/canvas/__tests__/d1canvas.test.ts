// D1's own canvas rules, the ones two files have to agree about and no frame
// can check by eye.
//
// Item 6: a chart's default height is read from its bars AND its series, so a
// chart that OPENS at it draws every bar it has. The formula lives in the
// document (canvas.ts `chartPx`) and the drawing lives in the face (Chart.tsx
// `barLayout`); what pins them together is not a shared constant but the
// drawing itself, asked here across the whole range a reading can produce.
//
// Item 9: a comparison that could not be made says so in the status line's own
// grammar, names the connection that refused it, stands on the block whose
// face is still showing, and never reaches the document.

import { describe, expect, test } from "bun:test";

// the store reaches the theme and the Tauri bridge on the way in: the canvas
// tests' own seam (CanvasGrid.test.tsx, b3canvas.test.tsx)
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
for (const [k, value] of Object.entries({ window: globalThis, localStorage: storage, document: inert })) {
  if (k in globalThis) continue;
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}
const { mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { barLayout } = await import("../Chart");
const { CELL_H, CELL_W_BASE, GUTTER } = await import("../grid");
const { barsShown, chartOf, compareMismatch, defaultSpanFor, statusOf, writeDoc } = await import("../../stores/canvas");
type Block = import("../../stores/canvas").Block;
type ResultBlock = import("../../stores/canvas").ResultBlock;

/** the block's own parts around the face: a 24px title line, a 16px status
 * line and the 8px between the block's parts (canvas.css `.blk > * + *`) */
const BLOCK_CHROME = 56;

function chartBlock(n: number, ns: number, prose = ""): ResultBlock {
  const labels = Array.from({ length: n }, (_, i) => `label ${i}`);
  const series = Array.from({ length: ns }, (_, s) => `series ${s}`);
  return {
    id: "b",
    kind: "result",
    question: "",
    prose,
    sql: null,
    columns: ["label", ...series],
    rows: labels.map((l, i) => [l, ...series.map((_, s) => String((i + 1) * (s + 1)))]),
    chips: [],
    status: "",
    ms: 0,
    face: "chart",
  };
}

describe("a chart opens at a height its own bars fit in", () => {
  test("every bar of every reading that fits under the page's tallest default", () => {
    for (const n of [1, 3, 6, 8, 12, 15]) {
      for (const ns of [1, 2, 3]) {
        const block = chartBlock(n, ns);
        const spec = chartOf(block);
        expect(spec).not.toBeNull();
        const span = defaultSpanFor(block);
        const faceH = span.h * CELL_H + (span.h - 1) * GUTTER - BLOCK_CHROME;
        const w = span.w * CELL_W_BASE + (span.w - 1) * GUTTER;
        const g = barLayout(spec!, w, faceH);
        expect(`${n} bars x ${ns}: ${g.shown} shown`).toBe(`${n} bars x ${ns}: ${n} shown`);
        // and the plot stands inside the face it was given
        expect(g.h).toBeLessThanOrEqual(faceH);
      }
    }
  });

  test("the model's own sentence above the plot counts toward the height", () => {
    const bare = defaultSpanFor(chartBlock(12, 1));
    const wordy = defaultSpanFor(
      chartBlock(
        12,
        1,
        [
          "Orders held steady through the quarter, with December the one month that moved,",
          "and the returns moved with it rather than against it. The gateway change in August",
          "is visible in the failed share and nowhere else, so nothing here argues for a",
          "second look at the checkout itself; the COD basket is the one still worth a",
          "reading of its own, and it is the one this chart cannot answer.",
        ].join(" "),
      ),
    );
    expect(wordy.h).toBeGreaterThan(bare.h);
  });

  test("a chart past the tallest default on the page stops there, and says so on the block", () => {
    const block = chartBlock(60, 3);
    const span = defaultSpanFor(block);
    expect(span.h).toBe(6);
    const faceH = span.h * CELL_H + (span.h - 1) * GUTTER - BLOCK_CHROME;
    const g = barLayout(chartOf(block)!, span.w * CELL_W_BASE + (span.w - 1) * GUTTER, faceH);
    expect(g.shown).toBeLessThan(g.total);
    expect(g.h).toBeLessThanOrEqual(faceH);
  });
});

// D1 item 6, the count's own slot: the face measures and the BLOCK says it,
// on the one status line it already had. A row of a bar chart IS a bar, so
// `12 rows · 7 of 12 bars` would be the same twelve twice (DESIGN rule 14) and
// a line of the face's own was one more line standing always (rule 15).
describe("a squeezed chart's count rides the block's own status line", () => {
  const squeezed: Block = {
    ...chartBlock(12, 3),
    status: "12 rows · 214.7 ms",
    ms: 214.7,
    cell: { x: 0, y: 0, w: 4, h: 3 },
  };

  test("the bars take the rows fragment's place, and the run keeps its milliseconds", () => {
    expect(barsShown({ shown: 7, total: 12 })).toBe("7 of 12 bars");
    expect(statusOf(squeezed, { shown: 7, total: 12 })?.facts).toBe("7 of 12 bars · 214.7 ms");
  });

  test("a face with room for every row says the plain line", () => {
    expect(statusOf(squeezed, null)?.facts).toBe("12 rows · 214.7 ms");
    expect(statusOf(squeezed)?.facts).toBe("12 rows · 214.7 ms");
  });

  test("a refused compare is still the line's last fragment, after the bars", () => {
    const line = statusOf({ ...squeezed, mismatch: "table order_v2 is not on prod-crawler" }, {
      shown: 7,
      total: 12,
    });
    expect(line?.facts).toBe("7 of 12 bars · 214.7 ms · table order_v2 is not on prod-crawler");
  });
});

describe("a comparison that could not be made", () => {
  test("names the table and the connection, in the line's own grammar", () => {
    expect(compareMismatch("prod-crawler", 'relation "public.order_v2" does not exist')).toBe(
      "table order_v2 is not on prod-crawler",
    );
    expect(compareMismatch("prod-crawler", 'column "refunded_at" does not exist\nLINE 2: …')).toBe(
      "column refunded_at is not on prod-crawler",
    );
  });

  test("keeps a driver's own words where it has no reading of them, and still names the side", () => {
    expect(compareMismatch("prod-crawler", "permission denied for table order_v2")).toBe(
      "permission denied for table order_v2 on prod-crawler",
    );
    expect(compareMismatch("prod-crawler", "")).toBe("prod-crawler could not run this query");
  });

  test("stands as the last fact of the status line, before the assumptions", () => {
    const block: Block = {
      ...chartBlock(3, 1),
      face: "table",
      status: "5 rows · 268.3 ms",
      chips: ["Last Month = August 2026"],
      mismatch: "table order_city is not on prod-crawler",
    };
    const line = statusOf(block);
    expect(line?.facts).toBe("5 rows · 268.3 ms · table order_city is not on prod-crawler");
    expect(line?.assumed).toEqual(["Last Month = August 2026"]);
  });

  test("never reaches the document", () => {
    const block: Block = {
      ...chartBlock(3, 1),
      cell: { x: 0, y: 0, w: 4, h: 3 },
      mismatch: "table order_city is not on prod-crawler",
    };
    const json = writeDoc({ v: 2, blocks: [block], lastColumns: 5 });
    expect(json).not.toContain("mismatch");
    expect(json).not.toContain("prod-crawler");
  });
});
