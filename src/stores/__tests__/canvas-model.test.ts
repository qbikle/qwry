// The model's door into the canvas document (B3). What is pinned here is the
// store's half of the wave: that one tool call's blocks land contiguously and
// in one write, that `wroteBy` is on every one of them, that a cut and a
// re-run take away exactly the blocks their exchanges wrote and nothing the
// user made, and that both doors into a result block truncate to one number
// and SAY so. The tool's own text, its error sentences and its handle grammar
// are `src/agent/tools.ts`'s and are pinned there: this file asserts facts
// about the document, never sentences a model reads.
//
// The backend is Tauri's own mock transport, so every appdb write is counted
// in order: a batch of four blocks that fired four `canvas_upsert` calls would
// be four documents where DECISIONS (A3) says there is one.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

// canvas.ts pulls in tabs.ts and settings.ts, which paint the theme onto the
// document at import and read localStorage; bun has neither (canvas.test.ts's
// own shim, kept identical so one fix serves all three)
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
const canvas = await import("../canvas");
const { cancelCanvasSaves, capRun, defaultFace, facesOf, useCanvas } = canvas;
type Block = import("../canvas").Block;
type ModelBlockInput = import("../canvas").ModelBlockInput;
type ResultBlock = import("../canvas").ResultBlock;
const { useAgent } = await import("../agent");
const { useAsk } = await import("../ask");
const { useConnections } = await import("../connections");
const { cancelTabSaves, useTabs } = await import("../tabs");
const { CANVAS_BLOCK_ROWS } = await import("../../agent/tools");
type Profile = import("../../ipc/types").Profile;

afterEach(() => {
  cancelCanvasSaves();
  cancelTabSaves();
});
afterAll(() => {
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- the backend seam -----------------------------------------------------

let writes: string[] = [];

function seed() {
  writes = [];
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (cmd === "canvas_upsert") writes.push((args.row as { id: string }).id);
    if (cmd === "canvas_list") return [];
    return undefined;
  });
  useConnections.setState({
    profiles: [{ id: "staging", name: "staging" }] as unknown as Profile[],
    activeProfileId: "staging",
  });
  useTabs.setState({ tabs: [], activeId: null, loaded: true, closedStack: [] });
  useAgent.setState({ threads: {}, exchanges: {} });
  useAsk.setState({ blocks: {} });
  useCanvas.setState({
    canvases: { staging: [{ id: "cv", profileId: "staging", title: "Canvas 4", updatedAt: "" }] },
    docs: { cv: { blocks: [] } },
    loaded: { staging: true },
    recent: {},
    comparing: {},
    saveError: false,
    askedFrom: {},
  });
}

beforeEach(seed);

const blocksOf = (): Block[] => useCanvas.getState().docs.cv.blocks;
const store = () => useCanvas.getState();

// ---- fixtures -------------------------------------------------------------

let minted = 0;
const id = () => `${(++minted).toString(16).padStart(4, "0")}-block-${minted}`;

const note = (text: string, wroteBy = "ex-1"): ModelBlockInput => ({
  id: id(),
  kind: "note",
  text,
  wroteBy,
});

const result = (
  over: {
    title?: string;
    question?: string;
    wroteBy?: string;
    rows?: (string | null)[][];
    rowCount?: number;
    columns?: string[];
    face?: ResultBlock["face"];
  } = {},
): ModelBlockInput => {
  const rows = over.rows ?? [
    ["app", "1602"],
    ["instagram", "611"],
  ];
  return {
    id: id(),
    kind: "result",
    sql: "select channel, count(*) from order_v2 group by 1",
    run: {
      columns: over.columns ?? ["channel", "orders"],
      rows,
      rowCount: over.rowCount ?? rows.length,
      capped: false,
      ms: 208.3,
    },
    face: over.face ?? "chart",
    wroteBy: over.wroteBy ?? "ex-1",
    ...(over.title ? { title: over.title } : null),
    ...(over.question ? { question: over.question } : null),
  };
};

/** a note the USER wrote: no `wroteBy`, so no thread may take it away */
const userNote = (text: string) => store().addNote("cv", text);

// ---- one call, one write --------------------------------------------------

describe("applyModelBlocks", () => {
  test("a call's blocks land in order, contiguously, in ONE document write", () => {
    userNote("the user's own opening line");
    const ids = store().applyModelBlocks("cv", [
      result({ question: "what stood out in orders last month" }),
      result({ title: "Failed payments by gateway" }),
      note("**Against July:**\n- COD is 43% of the month."),
    ]);
    expect(ids).toHaveLength(3);
    expect(blocksOf().map((b) => b.id)).toEqual([blocksOf()[0].id, ...ids]);
    // one setDoc per call: the user's note was its own write, the batch is one
    expect(writes).toEqual([]);
    return Promise.resolve();
  });

  test("`wroteBy` rides every block the model wrote and no block the user made", () => {
    const mine = userNote("mine");
    store().applyModelBlocks("cv", [result(), note("a reading")]);
    const byId = new Map(blocksOf().map((b) => [b.id, b]));
    expect(byId.get(mine)?.wroteBy).toBeUndefined();
    for (const b of blocksOf()) if (b.id !== mine) expect(b.wroteBy).toBe("ex-1");
  });

  test("`after` stands the batch under a named block, not at the end", () => {
    const first = userNote("first");
    const last = userNote("last");
    const ids = store().applyModelBlocks("cv", [result(), note("under it")], first);
    expect(blocksOf().map((b) => b.id)).toEqual([first, ...ids, last]);
  });

  test("two calls of one turn interleave at CALL granularity, never at block", () => {
    const a = store().applyModelBlocks("cv", [result(), result()]);
    const b = store().applyModelBlocks("cv", [note("one"), note("two")]);
    expect(blocksOf().map((b2) => b2.id)).toEqual([...a, ...b]);
  });

  test("an `after` no block answers falls to the document's end rather than nowhere", () => {
    const first = userNote("first");
    const ids = store().applyModelBlocks("cv", [note("orphan")], "no-such-id");
    expect(blocksOf().map((b) => b.id)).toEqual([first, ...ids]);
  });

  test("a canvas that is gone takes nothing and reports nothing", () => {
    expect(store().applyModelBlocks("gone", [note("nowhere")])).toEqual([]);
  });

  test("the question line takes the exchange's question, then the model's title", () => {
    store().applyModelBlocks("cv", [
      result({ question: "what stood out in orders last month" }),
      result({ title: "Failed payments by gateway" }),
    ]);
    const [one, two] = blocksOf() as ResultBlock[];
    expect(one.question).toBe("what stood out in orders last month");
    expect(one.title).toBeUndefined();
    // one slot, two fields: the user's words and the model's never share one,
    // so a reader can still tell which is which (LESSONS 4)
    expect(two.question).toBe("");
    expect(two.title).toBe("Failed payments by gateway");
  });

  test("a face the rows cannot wear lands on the one they can, never on nothing", () => {
    // three label columns and no numbers: `chartOf` returns no spec
    store().applyModelBlocks("cv", [
      result({ columns: ["a", "b"], rows: [["x", "y"], ["p", "q"]], face: "chart" }),
    ]);
    const one = blocksOf()[0] as ResultBlock;
    expect(one.face).toBe("table");
    expect(facesOf(one)).toContain("table");
    expect(facesOf(one)).not.toContain("chart");
  });

  test("a one-row result stands on its figures, and has no chart face to flip to", () => {
    store().applyModelBlocks("cv", [
      result({ columns: ["orders", "customers"], rows: [["2763", "1904"]], face: "values" }),
    ]);
    const one = blocksOf()[0] as ResultBlock;
    expect(one.face).toBe("values");
    expect(facesOf(one)).toEqual(["values", "sql"]);
    expect(defaultFace(one)).toBe("values");
  });
});

// ---- one number, both doors ------------------------------------------------

describe("the row cap", () => {
  const many = (n: number): (string | null)[][] =>
    Array.from({ length: n }, (_, i) => [`c${i}`, String(i)]);

  test("a model block keeps 200 rows and its status line says so", () => {
    store().applyModelBlocks("cv", [result({ rows: many(1842), rowCount: 1842 })]);
    const one = blocksOf()[0] as ResultBlock;
    expect(one.rows).toHaveLength(CANVAS_BLOCK_ROWS);
    expect(one.status).toBe("200 of 1,842 rows · 208.3 ms");
  });

  test("a run already capped upstream still reports what the STATEMENT produced", () => {
    // the run itself stopped at 2,000 rows; the block keeps 200 of 4,812
    expect(capRun({ rows: many(2000), rowCount: 4812, ms: 96.4 }).status).toBe(
      "200 of 4,812 rows · 96.4 ms",
    );
  });

  test("under the cap nothing is said twice: the count is the count", () => {
    expect(capRun({ rows: many(6), rowCount: 6, ms: 208.3 }).status).toBe("6 rows · 208.3 ms");
    expect(capRun({ rows: many(1), rowCount: 1, ms: 96.4 }).status).toBe("1 row · 96.4 ms");
  });

  test("`Add to Canvas` goes through the same pair", () => {
    // the press's own block: the same cap, the same sentence (blockOf → capRun)
    const rows = many(1842);
    // the press lands on the connection's current canvas, which is the one
    // its tab shows (`currentFor`)
    useTabs.setState({
      tabs: [
        {
          id: "t-cv",
          name: "Canvas 4",
          sql: "",
          position: 0,
          saved_id: null,
          profile_id: "staging",
          canvas_id: "cv",
          kind: "canvas",
        },
      ] as unknown as ReturnType<typeof useTabs.getState>["tabs"],
      activeId: "t-cv",
    });
    useAgent.setState({
      threads: { staging: [{ id: "t1", profileId: "staging", title: "t", createdAt: "", sessionKey: "t1" }] },
      exchanges: {
        t1: [
          {
            id: "ex-add",
            turnId: null,
            question: "every order last month",
            text: "Most of them are app orders.",
            thinking: "",
            chips: [],
            streaming: false,
            provider: "claude-code",
            model: "claude-sonnet-5",
            error: null,
            answer: {
              verdict: { status: "answered", sql: "select 1", rowCount: 1842 },
              sql: "select 1",
              run: { columns: ["channel", "orders"], rows, rowCount: 1842, capped: false, ms: 311.8 },
              assumptions: [],
              sanity: [],
              trace: [],
              text: "Most of them are app orders.",
              turns: 1,
              ms: 1,
              usage: { input: 1, output: 1 },
              promptVersion: "v4",
              candidates: [],
              recall: null,
              risky: false,
            },
          },
        ],
      },
    });
    const out = store().addExchange("staging", useAgent.getState().exchanges.t1[0]);
    expect(out.ok).toBe(true);
    const added = blocksOf().find((b) => b.kind === "result") as ResultBlock;
    expect(added.rows).toHaveLength(CANVAS_BLOCK_ROWS);
    expect(added.status).toBe("200 of 1,842 rows · 311.8 ms");
    // a press keeps the face the reader was looking at; only the model's own
    // write composes a reading
    expect(added.face).toBe("table");
  });
});

// ---- replace ---------------------------------------------------------------

describe("replaceBlock", () => {
  test("the new block takes the old one's place and the old one's askedFrom", () => {
    const ids = store().applyModelBlocks("cv", [result(), note("keep me")]);
    useCanvas.setState((s) => ({
      docs: {
        ...s.docs,
        cv: { blocks: s.docs.cv.blocks.map((b) => (b.id === ids[0] ? { ...b, askedFrom: "src" } : b)) },
      },
    }));
    const made = store().replaceBlock("cv", ids[0], result({ title: "Orders by channel" }));
    expect(made).toBeString();
    expect(blocksOf()).toHaveLength(2);
    expect(blocksOf()[0].id).toBe(made ?? "");
    expect(blocksOf()[0].askedFrom).toBe("src");
    expect(blocksOf()[1].id).toBe(ids[1]);
  });

  test("a block the user deleted meanwhile is a refusal, never an append", () => {
    const ids = store().applyModelBlocks("cv", [result()]);
    store().remove("cv", ids[0]);
    expect(store().replaceBlock("cv", ids[0], note("in its place"))).toBeNull();
    expect(blocksOf()).toHaveLength(0);
  });
});

// ---- the cut, the re-run and the hand delete -------------------------------

describe("what takes a model's blocks away", () => {
  test("removeByExchange takes exactly what those exchanges wrote", () => {
    const mine = userNote("the user's own");
    const one = store().applyModelBlocks("cv", [result(), note("a")]);
    const two = store().applyModelBlocks("cv", [note("b", "ex-2")]);
    store().removeByExchange(["ex-1"]);
    expect(blocksOf().map((b) => b.id)).toEqual([mine, ...two]);
    expect(one.every((x) => !blocksOf().some((b) => b.id === x))).toBe(true);
  });

  test("a cut across two canvases is one document write each, not one per block", () => {
    useCanvas.setState((s) => ({
      canvases: {
        staging: [...s.canvases.staging, { id: "cv2", profileId: "staging", title: "Canvas 5", updatedAt: "" }],
      },
      docs: { ...s.docs, cv2: { blocks: [] } },
    }));
    store().applyModelBlocks("cv", [result(), note("a")]);
    store().applyModelBlocks("cv2", [note("b"), note("c")]);
    cancelCanvasSaves();
    writes = [];
    store().removeByExchange(["ex-1"]);
    // two documents changed, so two writes are DUE; the debounce is what
    // decides when, and `flushCanvases` is what fires them
    expect(useCanvas.getState().docs.cv.blocks).toHaveLength(0);
    expect(useCanvas.getState().docs.cv2.blocks).toHaveLength(0);
    return canvas.flushCanvases().then(() => {
      expect(writes.sort()).toEqual(["cv", "cv2"]);
    });
  });

  test("removeByExchange leaves a block with no exchange behind it alone", () => {
    const mine = userNote("mine");
    store().removeByExchange(["ex-1", "ex-2"]);
    expect(blocksOf().map((b) => b.id)).toEqual([mine]);
  });

  test("a re-run's FIRST write clears the previous attempt's blocks", () => {
    const mine = userNote("mine");
    const first = store().applyModelBlocks("cv", [result(), note("the old reading")]);
    store().clearOnNextWrite("ex-1");
    const second = store().applyModelBlocks("cv", [result({ title: "Orders by channel" })]);
    expect(blocksOf().map((b) => b.id)).toEqual([mine, ...second]);
    expect(first.some((x) => blocksOf().some((b) => b.id === x))).toBe(false);
  });

  test("only the first write clears: the second call of the same run adds", () => {
    store().clearOnNextWrite("ex-1");
    const a = store().applyModelBlocks("cv", [result()]);
    const b = store().applyModelBlocks("cv", [note("and the reading")]);
    expect(blocksOf().map((x) => x.id)).toEqual([...a, ...b]);
  });

  test("a re-run that never writes leaves the standing blocks exactly there", () => {
    const first = store().applyModelBlocks("cv", [result(), note("still here")]);
    store().clearOnNextWrite("ex-1");
    // the attempt failed, was refused or was cancelled before any write
    expect(blocksOf().map((b) => b.id)).toEqual(first);
  });

  test("a re-run whose first act is a replace of a gone block still starts over", () => {
    const first = store().applyModelBlocks("cv", [result(), note("the old reading")]);
    store().clearOnNextWrite("ex-1");
    expect(store().replaceBlock("cv", "no-such-id", note("in its place"))).toBeNull();
    expect(blocksOf()).toHaveLength(0);
    expect(first).toHaveLength(2);
  });

  test("a cut of an exchange forgets the clear it was waiting for", () => {
    store().applyModelBlocks("cv", [result()]);
    store().clearOnNextWrite("ex-1");
    store().removeByExchange(["ex-1"]);
    const kept = store().applyModelBlocks("cv", [note("a new answer's")]);
    expect(blocksOf().map((b) => b.id)).toEqual(kept);
  });
});

// ---- the exchange's assumptions -------------------------------------------

describe("assumeOn", () => {
  test("the FIRST result block the exchange wrote, and no other", () => {
    store().addNote("cv", "the user's own");
    const ids = store().applyModelBlocks("cv", [
      note("a reading first, oddly"),
      result({ question: "what stood out in orders last month" }),
      result({ title: "Failed payments by gateway" }),
    ]);
    store().assumeOn("ex-1", ["Last Month = August 2026", "Revenue = Paid Orders"]);
    const byId = new Map(blocksOf().map((b) => [b.id, b]));
    expect((byId.get(ids[1]) as ResultBlock).chips).toEqual([
      "Last Month = August 2026",
      "Revenue = Paid Orders",
    ]);
    expect((byId.get(ids[2]) as ResultBlock).chips).toEqual([]);
  });

  test("an exchange that wrote only notes has nowhere to put them, and says so by doing nothing", () => {
    const ids = store().applyModelBlocks("cv", [note("a reading")]);
    store().assumeOn("ex-1", ["Last Month = August 2026"]);
    expect(blocksOf().map((b) => b.id)).toEqual(ids);
  });

  test("a re-run's own answer replaces the labels rather than adding to them", () => {
    const ids = store().applyModelBlocks("cv", [result()]);
    store().assumeOn("ex-1", ["Last Month = August 2026"]);
    store().assumeOn("ex-1", []);
    expect((blocksOf()[0] as ResultBlock).chips).toEqual([]);
    expect(blocksOf().map((b) => b.id)).toEqual(ids);
  });
});

// ---- what the model reads back --------------------------------------------

describe("outline", () => {
  test("every block, in reading order, with its shape and whose it is", () => {
    const mine = userNote("the user's own opening line");
    const ids = store().applyModelBlocks("cv", [
      result({ question: "what stood out in orders last month" }),
      note("**Against July:**\n- COD is 43% of the month."),
    ]);
    // C2: every line carries the cell the block stands on, read straight off
    // the document, so `at` is a place the model can name and not a guess
    expect(store().outline("cv")).toEqual([
      {
        id: mine,
        kind: "note",
        line: "the user's own opening line",
        modelWritten: false,
        cell: { x: 0, y: 0, w: 3, h: 1 },
      },
      {
        id: ids[0],
        kind: "result",
        line: "what stood out in orders last month",
        modelWritten: true,
        rows: 2,
        columns: ["channel", "orders"],
        face: "chart",
        cell: { x: 3, y: 0, w: 4, h: 2 },
      },
      {
        id: ids[1],
        kind: "note",
        line: "**Against July:**",
        modelWritten: true,
        cell: { x: 0, y: 1, w: 3, h: 1 },
      },
    ]);
  });

  test("a canvas with nothing on it, and one that is gone, are both empty", () => {
    expect(store().outline("cv")).toEqual([]);
    expect(store().outline("gone")).toEqual([]);
  });
});

// ---- the one canvas a question can cause ----------------------------------

describe("openForQuestion", () => {
  test("the document is made, its tab opens BESIDE the user's, and focus stays", () => {
    useTabs.setState({
      tabs: [
        {
          id: "q1",
          name: "scratch",
          sql: "",
          position: 0,
          saved_id: null,
          profile_id: "staging",
          canvas_id: null,
          kind: "query",
        },
      ] as unknown as ReturnType<typeof useTabs.getState>["tabs"],
      activeId: "q1",
    });
    const made = store().openForQuestion("staging");
    // `Canvas N`, the connection's own numbering: `Canvas` is free here
    // because the seeded document is called `Canvas 4`
    expect(made.title).toBe("Canvas");
    const tabs = useTabs.getState();
    expect(tabs.tabs.some((t) => t.canvas_id === made.canvasId)).toBe(true);
    expect(tabs.activeId).toBe("q1");
  });

  test("the number climbs past the names already taken", () => {
    const first = store().openForQuestion("staging");
    const second = store().openForQuestion("staging");
    expect([first.title, second.title]).toEqual(["Canvas", "Canvas 2"]);
  });
});
