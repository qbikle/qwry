// `canvas_read({ block_id })` and the image it can carry (C2b, canvas-grid-spec
// 5.4). Two halves of one seam: what the TOOL answers for one named block, and
// what reaches `agent_canvas_result` when the `claude -p` child is the caller.
//
// The store is injected, so a drawing's PNG is a fixture here rather than a
// renderer: what is under test is which answer a block_id gets, and whether the
// picture survives the bridge. The pixels themselves are strokes.test.ts's.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// the canvas store paints the theme and reads localStorage at import; bun has
// neither (canvasTools.test.ts's shim, kept identical so one fix serves all)
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
const STANDINS: Record<string, unknown> = {
  window: globalThis,
  localStorage: storage,
  document: inert,
};
function shim() {
  for (const [k, value] of Object.entries(STANDINS)) {
    if (k in globalThis) continue;
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  }
}
shim();

const { mockIPC } = await import("@tauri-apps/api/mocks");

type Handler = (ev: { payload: Record<string, string> }) => void;
const handlers = new Set<Handler>();
mock.module("@tauri-apps/api/event", () => ({
  listen: async (_name: string, cb: Handler) => {
    handlers.add(cb);
    return () => handlers.delete(cb);
  },
}));

interface Answer {
  callId: string;
  text: string;
  isError: boolean;
  image: { b64: string; mime: string } | null;
}
const answers: Answer[] = [];
mockIPC((cmd, payload) => {
  if (cmd !== "agent_canvas_result") throw new Error(`unexpected command ${cmd}`);
  answers.push((payload ?? {}) as unknown as Answer);
  return undefined;
});

const { createCanvasTools } = await import("../canvas.tauri");
const { outlineLine } = await import("../tools");
type CanvasStore = import("../canvas.tauri").CanvasStore;
type CanvasOutlineEntry = import("../tools").CanvasOutlineEntry;

beforeEach(() => {
  shim();
  answers.length = 0;
});

const PNG = { b64: "iVBORw0KGgo=", mime: "image/png" };

const DOC: CanvasOutlineEntry[] = [
  {
    id: "a3f1e7c2-0000-4000-8000-000000000001",
    kind: "result",
    line: "Monthly revenue by channel",
    rows: 12,
    columns: ["month", "channel", "revenue"],
    face: "chart",
    modelWritten: true,
    cell: { x: 0, y: 0, w: 6, h: 4 },
  },
  {
    id: "7c02b1aa-0000-4000-8000-000000000002",
    kind: "drawing",
    line: "Sketch",
    modelWritten: false,
    cell: { x: 6, y: 0, w: 3, h: 3 },
  },
  {
    id: "7c02b1bb-0000-4000-8000-000000000003",
    kind: "note",
    line: "**Revenue concentrated in two channels:** COD took 22%.",
    modelWritten: true,
    cell: { x: 0, y: 4, w: 4, h: 1 },
  },
];

/** the document, with a drawing renderer the test decides. `undefined` is the
 * build whose canvas cannot draw at all, which is a state and not a failure. */
function fake(ink?: CanvasStore["drawingImage"], doc: CanvasOutlineEntry[] = DOC) {
  const store: CanvasStore = {
    applyModelBlocks: () => [],
    replaceBlock: () => null,
    outline: () => doc,
    columns: () => 10,
    ...(ink ? { drawingImage: ink } : null),
  };
  return createCanvasTools({
    sessionId: "s-read",
    canvasId: "cv-1",
    title: "Q3 revenue",
    exchangeId: "ex-1",
    question: "what stood out in orders last month",
    store,
  });
}

describe("canvas_read with no block_id", () => {
  test("is the whole outline, head and every line, as it has always been", async () => {
    const out = await fake().read({});
    expect(out.textForModel.split("\n")).toEqual([
      'Canvas "Q3 revenue", 3 blocks, 10 columns wide.',
      ...DOC.map(outlineLine),
    ]);
    expect(out.result?.blocks).toHaveLength(3);
    expect(out.image).toBeUndefined();
  });

  test("an empty object, no argument, and a null block_id all read the same", async () => {
    const said = await Promise.all(
      [{}, undefined, { block_id: null }].map((a) => fake().read(a).then((o) => o.textForModel)),
    );
    expect(new Set(said).size).toBe(1);
  });
});

describe("canvas_read with a block_id", () => {
  test("answers that block's line ALONE: no head over one line it already has", async () => {
    const out = await fake().read({ block_id: "a3f1" });
    expect(out.textForModel).toBe(outlineLine(DOC[0]));
    expect(out.textForModel).not.toContain("Canvas ");
    expect(out.result?.blocks).toEqual([DOC[0]]);
    expect(out.result?.columns).toBe(10);
  });

  test("a note reads exactly as it reads inside the whole outline", async () => {
    const out = await fake().read({ block_id: DOC[2].id });
    expect(out.textForModel).toBe(outlineLine(DOC[2]));
    expect(out.image).toBeUndefined();
  });

  test("a drawing brings its picture, and its line is untouched by it", async () => {
    const out = await fake(async () => PNG).read({ block_id: "7c02b1aa" });
    expect(out.textForModel).toBe(outlineLine(DOC[1]));
    expect(out.image).toEqual(PNG);
  });

  test("the renderer is asked for THIS canvas and THIS block, never another", async () => {
    const asked: string[][] = [];
    const tools = fake(async (canvasId, blockId) => {
      asked.push([canvasId, blockId]);
      return PNG;
    });
    await tools.read({ block_id: "7c02b1aa" });
    expect(asked).toEqual([["cv-1", DOC[1].id]]);
  });

  test("a drawing with no ink is its line, and says nothing about the absence", async () => {
    const out = await fake(async () => null).read({ block_id: "7c02b1aa" });
    expect(out.textForModel).toBe(outlineLine(DOC[1]));
    expect(out.image).toBeUndefined();
  });

  test("a build whose canvas cannot draw answers the line, never an error", async () => {
    const out = await fake().read({ block_id: "7c02b1aa" });
    expect(out.textForModel).toBe(outlineLine(DOC[1]));
    expect(out.error).toBeUndefined();
    expect(out.image).toBeUndefined();
  });

  test("a renderer that throws costs the picture and not the answer, and says so", async () => {
    const tools = fake(async () => {
      throw new Error("OffscreenCanvas is not defined");
    });
    // the cause reaches a person too, never only the model (LESSONS 9)
    const said: unknown[][] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => void said.push(a);
    try {
      const out = await tools.read({ block_id: "7c02b1aa" });
      expect(out.textForModel.split("\n")).toEqual([
        outlineLine(DOC[1]),
        "the drawing could not be rendered, so this reply carries the text alone",
      ]);
      expect(out.image).toBeUndefined();
      expect(out.error).toBeUndefined();
    } finally {
      console.error = real;
    }
    expect(said).toHaveLength(1);
    expect(said[0][0]).toBe("drawingImage failed");
  });
});

describe("a block_id the canvas cannot resolve names the way out", () => {
  test("an id no block wears", async () => {
    const out = await fake().read({ block_id: "zzzz" });
    expect(out.textForModel).toBe(
      "ERROR: no block 'zzzz' on this canvas. Call canvas_read for the block ids",
    );
    expect(out.error).toBeTruthy();
    expect(out.image).toBeUndefined();
  });

  test("a handle too short to be one block", async () => {
    const out = await fake().read({ block_id: "7c" });
    expect(out.textForModel).toBe(
      "ERROR: '7c' is too short. Use at least 4 characters of the id",
    );
  });

  test("a handle two blocks answer to", async () => {
    const out = await fake().read({ block_id: "7c02b1" });
    expect(out.textForModel).toBe(
      "ERROR: '7c02b1' matches 2 blocks. Use at least 4 characters of the id",
    );
  });

  test("a block_id that is not a string at all", async () => {
    const out = await fake().read({ block_id: 7 });
    expect(out.error).toBeTruthy();
    expect(out.textForModel).toStartWith("ERROR: `block_id` is the id");
  });
});

describe("the picture over the claude -p bridge", () => {
  const settle = () => new Promise<void>((done) => setTimeout(done, 0));

  const emit = (args: string) => {
    for (const h of [...handlers])
      h({
        payload: {
          call_id: `c-${answers.length}`,
          token: "t",
          session_id: "s-read",
          name: "canvas_read",
          args_json: args,
        },
      });
  };

  async function serving(ink?: CanvasStore["drawingImage"]) {
    const tools = fake(ink);
    const stop = tools.serve?.(() => {}) ?? (() => {});
    await settle();
    return stop;
  }

  test("a drawing's PNG reaches agent_canvas_result beside its line", async () => {
    const stop = await serving(async () => PNG);
    emit(JSON.stringify({ block_id: "7c02b1aa" }));
    await settle();
    expect(answers).toEqual([
      { callId: "c-0", text: outlineLine(DOC[1]), isError: false, image: PNG },
    ]);
    stop();
  });

  test("every other answer sends a null image, so the Rust door sees one shape", async () => {
    const stop = await serving(async () => PNG);
    emit("{}");
    await settle();
    emit(JSON.stringify({ block_id: "a3f1" }));
    await settle();
    expect(answers.map((a) => a.image)).toEqual([null, null]);
    expect(answers[1].text).toBe(outlineLine(DOC[0]));
    stop();
  });

  test("a refusal carries no picture, whatever the model asked for", async () => {
    const stop = await serving(async () => PNG);
    emit(JSON.stringify({ block_id: "zzzz" }));
    await settle();
    expect(answers[0].isError).toBe(true);
    expect(answers[0].image).toBeNull();
    stop();
  });
});
