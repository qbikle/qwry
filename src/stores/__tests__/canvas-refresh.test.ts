// E2: the canvas's half of the refresh act (R3, R4). What is pinned here is
// what the document does when the sweep's front crosses it: which widgets
// refetch at all, in what order they are sent, and what a widget is left
// holding when its statement does not come back. The skeletons are the
// surface's; this is the half that can quietly lose a reader's page.
//
// The backend is Tauri's own mock transport, so every `execute` the store
// sends is recorded in order and the arguments read back exactly.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

// canvas.ts pulls in tabs.ts and settings.ts, which paint the theme onto the
// document at import and read localStorage; bun has neither (canvas.test.ts's
// own shim, kept identical so one fix serves both)
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
const shimmed = ["window", "localStorage"].filter((k) => !(k in globalThis));
for (const k of shimmed) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : storage,
    configurable: true,
    writable: true,
  });
}

/** nothing in a refresh measures an element any more (E3 rule 2 deleted the
 * band's front), so the stub answers nothing and only has to exist */
const docStub: Record<string, unknown> = { querySelector: () => null };
/** `document` is REPLACED rather than filled in, refresh.test.ts's own rule: a
 * sibling suite that ran first leaves a wholly inert one behind, and this
 * suite measures elements. Everything but querySelector stays inert */
Object.defineProperty(globalThis, "document", {
  value: new Proxy(docStub, { get: (t, k) => (k in t ? t[k as string] : inert) }),
  configurable: true,
  writable: true,
});

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { cancelCanvasSaves, useCanvas } = await import("../canvas");
type Block = import("../canvas").Block;
type CanvasDoc = import("../canvas").CanvasDoc;
type CanvasMeta = import("../canvas").CanvasMeta;
type ResultBlock = import("../canvas").ResultBlock;
type AgentRun = import("../../agent/types").AgentRun;
type Profile = import("../../ipc/types").Profile;
const { cancelTabSaves, useTabs } = await import("../tabs");
const { useConnections } = await import("../connections");
const { refreshCanvas, useRefresh } = await import("../refresh");
// canvas.ts hands its widget refetch to the refresh store through a dynamic
// import; let that land before a test asks the store to refresh a document
await new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  cancelCanvasSaves();
  cancelTabSaves();
});

afterAll(() => {
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- the backend seam -----------------------------------------------------

interface Ran {
  sessionId: string;
  sql: string;
}
let ran: Ran[] = [];
/** by SQL: the rows that statement comes back with, or the driver's refusal */
let answers: Record<string, { columns: string[]; rows: (string | null)[][]; ms: number }> = {};
let fails: Record<string, string> = {};

function installIpc() {
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (cmd === "execute") {
      const sql = args.sql as string;
      ran.push({ sessionId: args.sessionId as string, sql });
      if (fails[sql]) throw new Error(fails[sql]);
      const a = answers[sql] ?? { columns: ["n"], rows: [["1"]], ms: 12 };
      return {
        statements: [
          {
            index: 0,
            sql,
            columns: a.columns.map((name, i) => ({ name, type_oid: 23, table_oid: 0, attnum: i + 1 })),
            rows: a.rows,
            affected: null,
            ms: a.ms,
          },
        ],
      };
    }
    return undefined;
  });
}

// ---- the document ---------------------------------------------------------

const CANVAS = "cv-1";
const PROFILE = "staging";

const widget = (id: string, over: Partial<ResultBlock> = {}): ResultBlock => ({
  id,
  kind: "result",
  cell: { x: 0, y: 0, w: 4, h: 4 },
  question: `question ${id}`,
  prose: "",
  sql: `select ${id}`,
  columns: ["a"],
  rows: [["old"]],
  chips: ["Last Month = August 2026"],
  status: "1 row · 10.0 ms",
  ms: 10,
  face: "table",
  ...over,
});

function seed(blocks: Block[]) {
  ran = [];
  answers = {};
  fails = {};
  useRefresh.setState({ tier: null, startedAt: null, cycling: {} });
  installIpc();
  useConnections.setState({
    profiles: [{ id: PROFILE, name: "staging" }] as unknown as Profile[],
    activeProfileId: PROFILE,
    sessions: { [PROFILE]: "session-a" },
    tabSessions: {},
  });
  useTabs.setState({ tabs: [], activeId: null, loaded: true, closedStack: [] });
  const meta: CanvasMeta = {
    id: CANVAS,
    profileId: PROFILE,
    title: "Canvas",
    updatedAt: "2026-09-16",
  };
  const doc: CanvasDoc = { v: 2, blocks, lastColumns: 12 };
  useCanvas.setState({
    canvases: { [PROFILE]: [meta] },
    docs: { [CANVAS]: doc },
    loaded: { [PROFILE]: true },
    recent: {},
    comparing: {},
    saveError: false,
    askedFrom: {},
  });
}

const blockAt = (id: string): ResultBlock =>
  useCanvas.getState().docs[CANVAS].blocks.find((b) => b.id === id) as ResultBlock;

beforeEach(() => seed([]));

// ---- which widgets refetch, and what a failure leaves standing ------------

/** what stores/refresh does with a canvas: every result widget's refetch,
 * started in the order the sweep's front reaches them. With no window to
 * measure, that order is the document's own */
const refreshAll = async () => {
  const ids = useCanvas.getState().docs[CANVAS].blocks.map((b) => b.id);
  await Promise.all(ids.map((id) => useCanvas.getState().refreshWidget(CANVAS, id)));
};

describe("refreshWidget", () => {
  test("sends the widget's statement once, on the document's own connection", async () => {
    seed([widget("one"), widget("two", { cell: { x: 4, y: 0, w: 4, h: 4 } })]);
    await useCanvas.getState().refreshWidget(CANVAS, "one");
    expect(ran).toEqual([{ sessionId: "session-a", sql: "select one" }]);
  });

  test("a note, a drawing and a widget with no statement are never sent", async () => {
    seed([
      { id: "note", kind: "note", text: "Wednesday spike", cell: { x: 0, y: 0, w: 4, h: 4 } },
      { id: "sheet", kind: "drawing", strokes: [], cell: { x: 4, y: 0, w: 4, h: 4 } },
      widget("prose", { sql: null, cell: { x: 8, y: 0, w: 4, h: 4 } }),
      widget("rows", { cell: { x: 0, y: 4, w: 4, h: 4 } }),
    ]);
    await refreshAll();
    expect(ran.map((r) => r.sql)).toEqual(["select rows"]);
    const note = useCanvas.getState().docs[CANVAS].blocks.find((b) => b.id === "note");
    expect(note).toEqual({
      id: "note",
      kind: "note",
      text: "Wednesday spike",
      cell: { x: 0, y: 0, w: 4, h: 4 },
    });
    const sheet = useCanvas.getState().docs[CANVAS].blocks.find((b) => b.id === "sheet");
    expect(sheet).toEqual({
      id: "sheet",
      kind: "drawing",
      strokes: [],
      cell: { x: 4, y: 0, w: 4, h: 4 },
    });
  });

  test("a statement that writes is not run a second time", async () => {
    seed([widget("w", { sql: "delete from users where id = 1" })]);
    await refreshAll();
    expect(ran).toEqual([]);
    expect(blockAt("w").rows).toEqual([["old"]]);
  });

  test("a widget standing on a comparison keeps it and is not sent", async () => {
    seed([
      widget("cmp", {
        face: "diff",
        diff: {
          a: { profileId: PROFILE, name: "staging", ms: 10 },
          b: { profileId: "prod", name: "prod", ms: 12 },
          labelColumns: ["a"],
          numericColumns: [],
          rows: [],
          capped: false,
        },
      }),
    ]);
    await refreshAll();
    expect(ran).toEqual([]);
    expect(blockAt("cmp").diff).not.toBeUndefined();
    expect(blockAt("cmp").face).toBe("diff");
  });

  test("nothing is sent when the connection has no session, and the block says why", async () => {
    seed([widget("w")]);
    useConnections.setState({ sessions: {}, tabSessions: {} });
    await refreshAll();
    expect(ran).toEqual([]);
    expect(blockAt("w").rows).toEqual([["old"]]);
    // the same slot a refetch that failed on the wire writes to: a widget
    // with nothing to send on is news, not silence (E2 R6, LESSONS 9)
    expect(blockAt("w").mismatch).toBe(
      "could not refresh · connection to this canvas was lost. Refresh to reconnect",
    );
  });

  test("a block the document no longer holds sends nothing", async () => {
    seed([widget("w")]);
    await useCanvas.getState().refreshWidget(CANVAS, "gone");
    expect(ran).toEqual([]);
  });

  test("fresh rows land on the widget and the old ones go", async () => {
    seed([widget("w")]);
    answers["select w"] = { columns: ["a", "b"], rows: [["x", "1"], ["y", "2"]], ms: 41.5 };
    await refreshAll();
    const b = blockAt("w");
    expect(b.columns).toEqual(["a", "b"]);
    expect(b.rows).toEqual([["x", "1"], ["y", "2"]]);
    expect(b.status).toBe("2 rows · 41.5 ms");
    expect(b.ms).toBe(41.5);
  });

  test("a widget that fails keeps its rows and says why on its own line", async () => {
    seed([widget("gone"), widget("ok", { cell: { x: 4, y: 0, w: 4, h: 4 } })]);
    fails["select gone"] = 'relation "orders" does not exist\nLINE 1: select';
    answers["select ok"] = { columns: ["a"], rows: [["fresh"]], ms: 9 };
    await refreshAll();
    const bad = blockAt("gone");
    expect(bad.rows).toEqual([["old"]]);
    expect(bad.status).toBe("1 row · 10.0 ms");
    expect(bad.mismatch).toBe('could not refresh · relation "orders" does not exist');
    // one widget's failure never stops another's
    expect(blockAt("ok").rows).toEqual([["fresh"]]);
  });

  test("a statement that comes back with no result set is a failure, not a blanking", async () => {
    seed([widget("w")]);
    answers["select w"] = { columns: [], rows: [], ms: 3 };
    await refreshAll();
    expect(blockAt("w").rows).toEqual([["old"]]);
    expect(blockAt("w").mismatch).toContain("could not refresh");
  });
});

// ---- the order the document is refetched in (R3, R4) ----------------------

describe("refreshCanvas", () => {
  test("sends every result widget once, in document order", async () => {
    // the band no longer clocks anything, so nothing is staggered by where it
    // stands on screen: the document's own order is the sending order, and the
    // note in the middle of it has nothing to send at all (E3 rule 2)
    seed([
      widget("bottom", { cell: { x: 0, y: 4, w: 4, h: 4 } }),
      { id: "note", kind: "note", text: "Wednesday spike", cell: { x: 4, y: 4, w: 4, h: 4 } },
      widget("right", { cell: { x: 8, y: 0, w: 4, h: 4 } }),
      widget("left", { cell: { x: 0, y: 0, w: 4, h: 4 } }),
    ]);
    useRefresh.setState({ tier: "hard", startedAt: Date.now() });
    await refreshCanvas(CANVAS);
    expect(ran.map((r) => r.sql)).toEqual(["select bottom", "select right", "select left"]);
  });

  test("every widget it sends wears a skeleton, and the note never does", async () => {
    seed([
      widget("left", { cell: { x: 0, y: 0, w: 4, h: 4 } }),
      { id: "note", kind: "note", text: "Wednesday spike", cell: { x: 4, y: 0, w: 4, h: 4 } },
    ]);
    const act = refreshCanvas(CANVAS);
    // the plan's own write, before a single await (E3 rule 1)
    expect(useRefresh.getState().cycling["widget:left"]).toBe(true);
    expect(useRefresh.getState().cycling["widget:note"]).toBeUndefined();
    await act;
  });

  test("a document of notes alone sends nothing", async () => {
    seed([{ id: "note", kind: "note", text: "keep me", cell: { x: 0, y: 0, w: 4, h: 4 } }]);
    await refreshCanvas(CANVAS);
    expect(ran).toEqual([]);
  });
});

// ---- the write itself -----------------------------------------------------

describe("replaceResult", () => {
  const fresh = (rows: (string | null)[][], ms = 20): AgentRun => ({
    columns: ["a"],
    rows,
    rowCount: rows.length,
    capped: false,
    ms,
  });

  test("keeps where the block stands, how big it is and the face it wears", () => {
    seed([
      widget("w", {
        cell: { x: 4, y: 8, w: 6, h: 3 },
        face: "chart",
        question: "Onboarded per day",
        chips: ["Last Month = August 2026"],
        askedFrom: "blk-7",
        wroteBy: "ex-3",
      }),
    ]);
    useCanvas.getState().replaceResult(CANVAS, "w", fresh([["x"]]));
    const b = blockAt("w");
    expect(b.cell).toEqual({ x: 4, y: 8, w: 6, h: 3 });
    expect(b.face).toBe("chart");
    expect(b.question).toBe("Onboarded per day");
    expect(b.chips).toEqual(["Last Month = August 2026"]);
    expect(b.askedFrom).toBe("blk-7");
    expect(b.wroteBy).toBe("ex-3");
    expect(b.rows).toEqual([["x"]]);
  });

  test("a refusal from an earlier press leaves with the rows that answer it", () => {
    seed([widget("w", { mismatch: "table orders is not on prod" })]);
    useCanvas.getState().replaceResult(CANVAS, "w", fresh([["x"]]));
    expect(blockAt("w").mismatch).toBeUndefined();
  });

  test("the row cap and the sentence that reports it are capRun's, not a second copy", () => {
    seed([widget("w")]);
    const rows = Array.from({ length: 220 }, (_, i) => [String(i)]);
    useCanvas.getState().replaceResult(CANVAS, "w", fresh(rows, 88));
    const b = blockAt("w");
    expect(b.rows.length).toBe(200);
    expect(b.status).toBe("200 of 220 rows · 88.0 ms");
  });

  test("a note is not a result and is left exactly as it stands", () => {
    seed([{ id: "note", kind: "note", text: "keep me", cell: { x: 0, y: 0, w: 4, h: 4 } }]);
    useCanvas.getState().replaceResult(CANVAS, "note", fresh([["x"]]));
    const note = useCanvas.getState().docs[CANVAS].blocks[0];
    expect(note).toEqual({ id: "note", kind: "note", text: "keep me", cell: { x: 0, y: 0, w: 4, h: 4 } });
  });
});
