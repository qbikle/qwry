// The flight recorder (D5). Three things are under test and none of them is
// what the trace SAYS: the record's content is read by a person, and what a
// test can hold is the shape it is read in.
//
// The ring must drop the OLDEST entry and never the newest, because the frames
// that explain a bad drop are the last ones before it. The dump must be JSON
// lines, because that is what a paste into a diff can be read as. And the whole
// facility must be nothing at all outside a dev build: the gate is
// `import.meta.env.DEV`, which Vite folds to a literal at build time and Bun
// leaves as a plain property, so the flag is set here the way the bundler sets
// it there.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// Bun aliases `import.meta.env` to `process.env`, so the flag is a plain
// property here and the module reads it at the CALL: on for this file, off
// again for whatever runs after it
const env = import.meta.env as unknown as Record<string, unknown>;
env.DEV = true;

// the page every entry reads two facts off. The suite's other canvas files
// leave an inert proxy standing as `document`, and an entry has to be JSON, so
// this file stands its own up and hands the old one back at the end
const priorDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  value: { visibilityState: "visible", querySelector: () => null },
  configurable: true,
  writable: true,
});

const { cellsMoved, clear, dump, gestureId, gestureLive, ipx, trace, traceSize } = await import(
  "../trace"
);

// the flag is the PROCESS's (Bun aliases `import.meta.env` to `process.env`),
// so this file hands it back: a suite that turned tracing on for everything
// after it would be a test changing another test's subject
afterAll(() => {
  delete env.DEV;
  clear();
  if (priorDoc) Object.defineProperty(globalThis, "document", priorDoc);
  else delete (globalThis as unknown as Record<string, unknown>).document;
});

const lines = (): string[] => {
  const text = dump();
  return text === "" ? [] : text.split("\n");
};

beforeEach(() => {
  env.DEV = true;
  clear();
  gestureLive(null);
});

describe("the ring", () => {
  test("holds an entry per call", () => {
    trace("measure", { width: 960, columns: 7 });
    trace("gesture", { phase: "down" });
    expect(traceSize()).toBe(2);
    const [first, second] = lines().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first.kind).toBe("measure");
    expect(first.columns).toBe(7);
    expect(second.kind).toBe("gesture");
  });

  test("caps at 2000 and drops the oldest, never the newest", () => {
    for (let n = 0; n < 2400; n++) trace("gesture", { n });
    expect(traceSize()).toBe(2000);
    const read = lines().map((l) => (JSON.parse(l) as { n: number }).n);
    expect(read.length).toBe(2000);
    // oldest first, 400 gone off the front, and the last call is the last line
    expect(read[0]).toBe(400);
    expect(read[read.length - 1]).toBe(2399);
    // and the order in between is the order they were made in
    expect(read.every((n, i) => n === 400 + i)).toBe(true);
  });

  test("clear empties it", () => {
    trace("commit", { cause: "move" });
    clear();
    expect(traceSize()).toBe(0);
    expect(dump()).toBe("");
  });
});

describe("outside a dev build", () => {
  test("trace is a no-op", () => {
    env.DEV = false;
    trace("commit", { cause: "move" });
    trace("gesture", { phase: "up" });
    expect(traceSize()).toBe(0);
    expect(dump()).toBe("");
  });

  test("a gesture that no one records is not held either", () => {
    env.DEV = false;
    gestureLive("block-1");
    expect(gestureId()).toBe(null);
  });
});

describe("dump", () => {
  test("is one JSON object per line, each carrying its own time and kind", () => {
    trace("land", { id: "a" });
    trace("autoH", { id: "b", px: 217 });
    const read = lines();
    expect(read.length).toBe(2);
    for (const line of read) {
      expect(line.includes("\n")).toBe(false);
      const e = JSON.parse(line) as Record<string, unknown>;
      expect(typeof e.t).toBe("number");
      expect(typeof e.kind).toBe("string");
      // the two facts every entry carries, whether or not the seam knew them
      expect(e.vis).toBe("visible");
      expect(e.scroll).toBe(null);
    }
    expect((JSON.parse(read[1]) as { px: number }).px).toBe(217);
  });

  test("an empty ring dumps an empty string, not a blank line", () => {
    expect(dump()).toBe("");
  });
});

describe("what the seams hand it", () => {
  test("a gesture names itself until it is over", () => {
    gestureLive("block-1");
    expect(gestureId()).toBe("block-1");
    gestureLive(null);
    expect(gestureId()).toBe(null);
  });

  test("pixels are integers", () => {
    expect(ipx(107.6)).toBe(108);
    expect(ipx(107.4)).toBe(107);
    expect(ipx(-12.7)).toBe(-13);
  });

  test("cellsMoved reports only the blocks whose cell changed", () => {
    const was = [
      { id: "a", kind: "note", cell: { x: 0, y: 0, w: 3, h: 2 } },
      { id: "b", kind: "result", cell: { x: 3, y: 0, w: 4, h: 3 } },
      { id: "c", kind: "drawing", cell: { x: 0, y: 2, w: 3, h: 3 } },
    ];
    const now = [
      { id: "a", kind: "note", cell: { x: 0, y: 0, w: 3, h: 2 } },
      { id: "b", kind: "result", cell: { x: 3, y: 1, w: 4, h: 3 } },
    ];
    const moved = cellsMoved(was, now);
    expect(moved.map((m) => m.id)).toEqual(["b", "c"]);
    expect(moved[0].before).toEqual({ x: 3, y: 0, w: 4, h: 3 });
    expect(moved[0].after).toEqual({ x: 3, y: 1, w: 4, h: 3 });
    // a block the commit removed is a cell that changed to nothing
    expect(moved[1].after).toBe(null);
    expect(moved[1].kind).toBe("drawing");
  });

  test("a block that had no cell reads as a migration, before and after", () => {
    const moved = cellsMoved([{ id: "a", kind: "note" }], [
      { id: "a", kind: "note", cell: { x: 0, y: 0, w: 3, h: 2 } },
    ]);
    expect(moved.length).toBe(1);
    expect(moved[0].before).toBe(null);
    expect(moved[0].after).toEqual({ x: 0, y: 0, w: 3, h: 2 });
  });
});
