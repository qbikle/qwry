// The grid surface's own rules (C2a), the ones a frame cannot check by eye.
//
// The subject is `createGrab`, the gesture machine: it holds no React and no
// DOM, it reads the layout through `items()` and writes through handles, so
// what a drag DOES is provable here without a browser. That is also how the
// wave's law is tested rather than asserted: a gesture writes nothing but
// handles until it ends, and the document hears about it exactly once, on the
// release. A handle write is a motion value in the product (no render); a
// `commit` is the one `setDoc`. Counting them is counting React commits.
//
// The rest is arithmetic: where the pointer snaps, what the transient string
// says, and what the live region and the element's label read.

import { afterAll, describe, expect, test } from "bun:test";

// the surface imports the document store, which reaches the theme and the
// Tauri bridge on the way in: the canvas tests' own seam (b3canvas.test.tsx)
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
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { createGrab, geometrySaid, movedSaid, resizedSaid, sizeLabel, snapCell, snapSpan } = await import(
  "../CanvasGrid"
);
type GestureKind = import("../CanvasGrid").GestureKind;
type SlotHandle = import("../CanvasGrid").SlotHandle;
type Cell = import("../grid").Cell;
type GridItem = import("../grid").GridItem;
type Metrics = import("../grid").Metrics;

/** a page of whole numbers: 108 + 12 makes the pitch 120 on both axes, so a
 * test can say "two cells right" and mean 240 pixels */
const METRICS: Metrics = { columns: 7, cellW: 108, gutter: 12 };
const PITCH = 120;

interface Recorder {
  slot: SlotHandle;
  offsets: [number, number][];
  travels: [number, number][];
  holds: (GestureKind | null)[];
  sizes: [number | null, number | null][];
}

function stage(items: GridItem[]) {
  const slots = new Map<string, Recorder>();
  for (const it of items) {
    const r: Recorder = { slot: null as unknown as SlotHandle, offsets: [], travels: [], holds: [], sizes: [] };
    r.slot = {
      cell: it.cell,
      hold: (kind) => r.holds.push(kind),
      offset: (x, y) => r.offsets.push([x, y]),
      travel: (x, y) => r.travels.push([x, y]),
      size: (w, h) => r.sizes.push([w, h]),
    };
    slots.set(it.id, r);
  }
  const commits: { kind: GestureKind; id: string; cell: Cell }[] = [];
  const ghosts: { cell: Cell; instant: boolean }[] = [];
  const said: string[] = [];
  const shown: (GestureKind | null)[] = [];
  const labels: string[] = [];
  const grab = createGrab({
    items: () => items,
    metrics: () => METRICS,
    slot: (id) => slots.get(id)?.slot,
    min: () => ({ w: 2, h: 1 }),
    name: (id) => id,
    ghost: {
      at: (cell, instant) => ghosts.push({ cell, instant }),
      say: (text) => labels.push(text),
      show: (kind) => shown.push(kind),
    },
    live: (text) => said.push(text),
    commit: (kind, id, cell) => commits.push({ kind, id, cell }),
  });
  return { grab, slots, commits, ghosts, said, shown, labels };
}

/** the last of a recorder's writes (the tsconfig's lib predates Array.at) */
const last = <T,>(a: readonly T[]): T | undefined => a[a.length - 1];

const PAGE: GridItem[] = [
  { id: "a", cell: { x: 0, y: 0, w: 2, h: 1 } },
  { id: "b", cell: { x: 2, y: 0, w: 4, h: 2 } },
  { id: "c", cell: { x: 0, y: 1, w: 2, h: 2 } },
];

afterAll(clearMocks);

describe("the gesture's own law", () => {
  test("a gesture writes nothing but handles until it ends, and then once", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 100, 100);
    for (let i = 1; i <= 40; i++) s.grab.move(100 + i * 6, 100 + i * 3);
    // forty pointer frames, one document write: none of them
    expect(s.commits).toHaveLength(0);
    expect(s.said).toHaveLength(0);
    s.grab.up();
    expect(s.commits).toHaveLength(1);
    expect(s.commits[0].kind).toBe("move");
    expect(s.said).toHaveLength(1);
  });

  test("a press that does not travel is a click: nothing moves and nothing is written", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 100, 100);
    s.grab.move(102, 101); // inside the 4px threshold
    s.grab.up();
    expect(s.commits).toHaveLength(0);
    expect(s.slots.get("a")?.offsets).toHaveLength(0);
    expect(last(s.shown)).toBe(null);
  });

  test("the element follows the pointer un-sprung, one write a frame", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 0, 0);
    s.grab.move(30, 12);
    s.grab.move(60, 24);
    expect(s.slots.get("a")?.offsets).toEqual([
      [30, 12],
      [60, 24],
    ]);
    expect(s.slots.get("a")?.travels).toHaveLength(0);
  });

  test("the drop commits the cell the placeholder stood on", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 0, 0);
    s.grab.move(2 * PITCH + 3, 6);
    s.grab.up();
    expect(s.commits[0].cell.x).toBe(2);
    expect(last(s.ghosts)?.cell.x).toBe(2);
    expect(s.said[0]).toBe(movedSaid("a", s.commits[0].cell));
  });

  test("what the engine displaces travels, and lands with the document", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    // `a` is dropped onto `b`: the engine pushes b down, so b travels
    s.grab.down("move", "a", 0, 0);
    s.grab.move(2 * PITCH, 0);
    expect(s.slots.get("b")?.travels.length).toBeGreaterThan(0);
    s.grab.up();
    // on the release the neighbours are already standing where the document
    // now puts them, so their offset goes to zero rather than travelling twice
    expect(last(s.slots.get("b")?.offsets ?? [])).toEqual([0, 0]);
  });

  test("Escape writes nothing and everything travels back", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 0, 0);
    s.grab.move(2 * PITCH, PITCH);
    s.grab.cancel();
    expect(s.commits).toHaveLength(0);
    expect(s.said).toHaveLength(0);
    expect(last(s.slots.get("a")?.travels ?? [])).toEqual([0, 0]);
    expect(last(s.shown)).toBe(null);
  });

  test("a resize writes the box per frame and commits one span", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("resize", "b", 0, 0);
    s.grab.move(PITCH, PITCH);
    expect(s.slots.get("b")?.sizes.length).toBeGreaterThan(0);
    expect(s.commits).toHaveLength(0);
    s.grab.up();
    expect(s.commits).toHaveLength(1);
    expect(s.commits[0].kind).toBe("resize");
    expect(s.commits[0].cell.w).toBe(5);
    expect(s.commits[0].cell.h).toBe(3);
    // the box goes back to the cell frame on the release
    expect(last(s.slots.get("b")?.sizes ?? [])).toEqual([null, null]);
    expect(s.said[0]).toBe(resizedSaid("b", s.commits[0].cell));
  });

  test("the lattice and the placeholder belong to the gesture and leave with it", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 0, 0);
    expect(s.shown).toHaveLength(0); // a press alone shows nothing
    s.grab.move(PITCH, 0);
    expect(s.shown).toEqual(["move"]);
    expect(s.ghosts[0].instant).toBe(true); // it appears where the element is
    s.grab.up();
    expect(last(s.shown)).toBe(null);
  });
});

describe("where the pointer snaps", () => {
  const base: Cell = { x: 1, y: 1, w: 2, h: 2 };

  test("half a cell of travel rounds to the nearer one", () => {
    expect(snapCell(base, 59, 0, METRICS, 7).x).toBe(1);
    expect(snapCell(base, 61, 0, METRICS, 7).x).toBe(2);
    expect(snapCell(base, -PITCH, -PITCH, METRICS, 7)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });

  test("the page's own edges hold it: never off the left, never past the last column", () => {
    expect(snapCell(base, -9999, -9999, METRICS, 7)).toMatchObject({ x: 0, y: 0 });
    expect(snapCell(base, 9999, 9999, METRICS, 7).x).toBe(5);
  });

  test("a resize stops at the kind's floor and at the page's edge", () => {
    const min = { w: 2, h: 2 };
    expect(snapSpan(base, -9999, -9999, METRICS, 7, min)).toMatchObject({ w: 2, h: 2 });
    expect(snapSpan(base, 9999, 0, METRICS, 7, min).w).toBe(6);
    expect(snapSpan(base, PITCH, PITCH, METRICS, 7, min)).toMatchObject({ w: 3, h: 3 });
  });
});

describe("what the gesture says", () => {
  test("the size label is the span, with the multiplication sign", () => {
    expect(sizeLabel({ w: 3, h: 3 })).toBe("3 × 3");
  });

  test("the live region counts columns and rows the way a person does", () => {
    expect(movedSaid("Orders by channel", { x: 3, y: 0, w: 4, h: 3 })).toBe(
      "Orders by channel moved to column 4, row 1",
    );
    expect(resizedSaid("Orders by channel", { x: 0, y: 0, w: 6, h: 4 })).toBe(
      "Orders by channel resized to 6 by 4 cells",
    );
  });

  test("the element's own label carries its kind and its geometry", () => {
    expect(geometrySaid("Orders by channel", "chart", { x: 0, y: 1, w: 4, h: 3 })).toBe(
      "Orders by channel · chart · 4 by 3 at column 1, row 2",
    );
  });
});
