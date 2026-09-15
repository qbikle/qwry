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
const { move: moveCells } = await import("../grid");
type Drop = import("../CanvasGrid").Drop;
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
      hold: (kind) => r.holds.push(kind),
      offset: (x, y) => r.offsets.push([x, y]),
      travel: (x, y) => r.travels.push([x, y]),
      size: (w, h) => r.sizes.push([w, h]),
    };
    slots.set(it.id, r);
  }
  const commits: { kind: GestureKind; id: string; cell: Cell; landed: Map<string, Drop> }[] = [];
  const ghosts: { cell: Cell; instant: boolean }[] = [];
  const said: string[] = [];
  const shown: (GestureKind | null)[] = [];
  const labels: string[] = [];
  let metrics: () => Metrics = () => METRICS;
  const grab = createGrab({
    items: () => items,
    metrics: () => metrics(),
    slot: (id) => slots.get(id)?.slot,
    min: () => ({ w: 2, h: 1 }),
    name: (id) => id,
    ghost: {
      at: (cell, instant) => ghosts.push({ cell, instant }),
      say: (text) => labels.push(text),
      show: (kind) => shown.push(kind),
    },
    live: (text) => said.push(text),
    commit: (kind, id, cell, landed) => commits.push({ kind, id, cell, landed: new Map(landed) }),
  });
  // the LAYOUT, as the surface hands it over: a commit that lands mid-gesture
  // is this array changing, which is what the product does to it (D4)
  return {
    grab,
    items,
    slots,
    commits,
    ghosts,
    said,
    shown,
    labels,
    pitch: (read: () => Metrics) => {
      metrics = read;
    },
  };
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
    const travelled = s.slots.get("b")!.travels.length;
    expect(travelled).toBeGreaterThan(0);
    s.grab.up();
    // the release writes to NO handle (D3 rule 3): the landing rides the one
    // commit, so it lands in the same frame as the cell frame it lands on, and
    // a neighbour already standing in its pushed place has two zeroes to do
    expect(s.slots.get("b")?.travels).toHaveLength(travelled);
    expect(s.commits[0].landed.get("b")).toEqual({ dx: 0, dy: 0 });
  });

  test("the drop is ONE spring: the pointer's own last offset, and nothing else written", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 0, 0);
    // a cell and a half down: the drop snaps two rows, so 60px of the travel
    // is what the drag layer has left to spring away
    s.grab.move(0, PITCH + PITCH / 2 + 10);
    const wrote = s.slots.get("a")!;
    const offsets = wrote.offsets.length;
    const travels = wrote.travels.length;
    s.grab.up();
    expect(s.commits[0].cell.y).toBe(2);
    expect(s.commits[0].landed.get("a")).toEqual({ dx: 0, dy: PITCH / 2 + 10 - PITCH });
    expect(wrote.offsets).toHaveLength(offsets);
    expect(wrote.travels).toHaveLength(travels);
  });

  // D4: between the press and the release, the DOCUMENT may move the element
  // the hand is holding (a column-count commit, a note next door measuring its
  // own words, a model write). Three things then have to hold at once: the box
  // must not move, because the pointer did not; the drop must commit the cell
  // the box is over, not the one the frame was carried to; and the landing
  // must be the box against THAT cell. Measured from the pressed cell instead,
  // the widget stands cells from its own placeholder for the rest of the
  // gesture and springs home from there, which is what the maintainer filmed
  test("a commit that moves the held element leaves the box where the pointer put it", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "a", 0, 0);
    s.grab.move(0, 2 * PITCH + 10);
    expect(last(s.slots.get("a")!.offsets)).toEqual([0, 2 * PITCH + 10]);
    const target = last(s.ghosts)!.cell;
    // the page re-flowed under the hand: `a` is drawn two columns right and
    // one row down of where it was pressed
    s.items[0] = { id: "a", cell: { x: 2, y: 1, w: 2, h: 1 } };
    s.grab.rebase("a");
    // the frame moved by two columns and a row, so the drag layer gives them
    // straight back: the box has not moved a pixel
    expect(last(s.slots.get("a")!.offsets)).toEqual([-2 * PITCH, 2 * PITCH + 10 - PITCH]);
    // and the placeholder still stands where the box does
    expect(last(s.ghosts)!.cell).toEqual(target);
    s.grab.up();
    expect(s.commits[0].cell).toEqual(target);
    // the landing is what the box owes its own committed frame: the third of a
    // cell the pointer was let go past the snap, and nothing else
    expect(s.commits[0].landed.get("a")).toEqual({ dx: 0, dy: 10 });
  });

  test("a resize's landing reads the same cell, and its box the pressed span", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("resize", "b", 0, 0);
    s.grab.move(PITCH, PITCH);
    s.items[1] = { id: "b", cell: { x: 1, y: 3, w: 4, h: 2 } };
    s.grab.rebase("b");
    s.grab.up();
    const cell = s.commits[0].cell;
    // the corner did not move, so neither did the box: the offset is what the
    // drag layer owes the committed frame, and the BOX is the one the gesture
    // has been writing per frame, the pressed span plus the pointer's travel
    expect(s.commits[0].landed.get("b")).toEqual({
      dx: (2 - cell.x) * PITCH,
      dy: (0 - cell.y) * PITCH,
      from: { w: 4 * 108 + 3 * 12 + PITCH, h: 2 * 108 + 12 + PITCH },
    });
  });

  // and the commit does not have to touch the held element at all: the engine
  // answers for a LAYOUT, so a neighbour the document moved is a new question
  test("a commit that moves a neighbour is answered again, in the layout it moved into", async () => {
    const items = PAGE.map((i) => ({ ...i }));
    const s = stage(items);
    s.grab.down("move", "a", 0, 0);
    s.grab.move(2 * PITCH, 0); // `a` lands on `b`, so the engine pushes `b` down
    expect(last(s.slots.get("b")!.travels)).toEqual([0, PITCH]);
    // the document then moved `b` itself, while the hand still holds `a`
    items[1] = { id: "b", cell: { x: 2, y: 1, w: 4, h: 2 } };
    s.grab.rebase("b");
    // the answer is owed to the end of the React commit, not to this line
    await Promise.resolve();
    const cell = last(s.ghosts)!.cell;
    const answer = moveCells(items, "a", { x: cell.x, y: cell.y }, METRICS.columns).find((i) => i.id === "b")!
      .cell;
    const t = last(s.slots.get("b")!.travels)!;
    // where `b` is DRAWN is where the engine puts it in the layout that now
    // stands: un-answered, it stands a row below that, on the push it no
    // longer owes
    expect({ x: items[1]!.cell.x + t[0] / PITCH, y: items[1]!.cell.y + t[1] / PITCH }).toEqual({
      x: answer.x,
      y: answer.y,
    });
  });

  // the other half of the same rule: the PITCH can change without a single
  // cell changing (a window drag that crosses a column boundary writes --cw
  // before anything renders), and the frame moves then too
  test("a pitch change under the hand moves no box either", () => {
    const s = stage(PAGE.map((i) => ({ ...i })));
    s.grab.down("move", "b", 0, 0); // b stands at x 2, so its frame is 2 pitches in
    s.grab.move(0, PITCH);
    let pitch = { ...METRICS };
    s.pitch(() => pitch);
    pitch = { columns: 7, cellW: 88, gutter: 12 }; // a narrower page, same cells
    s.grab.rebase();
    // the frame moved left by two cells' worth of the difference; the box did
    // not move at all
    expect(last(s.slots.get("b")!.offsets)).toEqual([2 * (120 - 100), PITCH]);
  });

  // D3 rule 2: what the placeholder and the pushed neighbours SHOW during the
  // drag is byte for byte the layout the commit writes. The same pointer path
  // goes to both, and the two answers are compared cell by cell
  test("the preview IS the commit, over four pointer paths", () => {
    for (const [dx, dy] of [
      [2 * PITCH, 0],
      [0, 2 * PITCH],
      [-PITCH, 3 * PITCH],
      [3 * PITCH, PITCH],
    ]) {
      const items = PAGE.map((i) => ({ ...i }));
      const s = stage(items);
      s.grab.down("move", "a", 0, 0);
      for (let i = 1; i <= 8; i++) s.grab.move((dx! * i) / 8, (dy! * i) / 8);
      const shown = new Map<string, Cell>(items.map((i) => [i.id, i.cell]));
      shown.set("a", last(s.ghosts)!.cell);
      for (const [id, r] of s.slots) {
        const t = last(r.travels);
        if (id === "a" || !t) continue;
        const base = items.find((i) => i.id === id)!.cell;
        shown.set(id, { ...base, x: base.x + t[0] / PITCH, y: base.y + t[1] / PITCH });
      }
      s.grab.up();
      const cell = s.commits[0].cell;
      for (const it of moveCells(items, "a", { x: cell.x, y: cell.y }, METRICS.columns))
        expect(shown.get(it.id)).toEqual(it.cell);
    }
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
    // and the box the corner stopped at rides the commit, so it springs to the
    // span over the cell frame that same frame rather than snapping to it
    expect(s.commits[0].landed.get("b")).toEqual({
      dx: 0,
      dy: 0,
      from: { w: 4 * 108 + 3 * 12 + PITCH, h: 2 * 108 + 12 + PITCH },
    });
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
