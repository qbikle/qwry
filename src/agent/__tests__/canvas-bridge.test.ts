// The `claude -p` bridge's own registry (canvas-agent-spec 2.2, AGENT-SPEC 7):
// Rust parks each canvas call for 20 s and emits one event, so the app owes an
// ANSWER to every event it can see. A dropped event costs the child its whole
// wait and then tells it `the canvas did not answer`, which is a worse account
// of the same fact (LESSONS 9) - so a session with no live tools is answered
// `ERROR: the canvas is not open for this thread` instead.
//
// The Tauri event module and the IPC command are faked here: what is under
// test is which answer an event gets, not the transport.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// canvas.tauri.ts reaches the canvas store, which paints the theme and reads
// localStorage at import; bun has neither (the canvas store tests' own shim,
// kept identical so one fix serves all three)
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
for (const k of ["window", "localStorage", "document"].filter((n) => !(n in globalThis)))
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });

const { mockIPC } = await import("@tauri-apps/api/mocks");

type Handler = (ev: { payload: Record<string, string> }) => void;
const handlers = new Set<Handler>();

mock.module("@tauri-apps/api/event", () => ({
  listen: async (_name: string, cb: Handler) => {
    handlers.add(cb);
    return () => handlers.delete(cb);
  },
}));

const answers: { callId: string; text: string; isError: boolean }[] = [];
// the command itself is real; the transport under it is the mock every store
// test uses, so nothing else in the graph is replaced (a fake ipc/commands
// module would take agentKnowledgeDelete and forty siblings with it)
mockIPC((cmd, payload) => {
  if (cmd !== "agent_canvas_result") throw new Error(`unexpected command ${cmd}`);
  const a = (payload ?? {}) as { callId: string; text: string; isError: boolean };
  answers.push({ callId: a.callId, text: a.text, isError: a.isError });
  return undefined;
});

const { createCanvasTools } = await import("../canvas.tauri");
type CanvasTools = import("../tools").CanvasTools;

const emit = (session: string, name = "canvas_read", args = "{}") => {
  for (const h of [...handlers])
    h({ payload: { call_id: `c-${answers.length}`, token: "t", session_id: session, name, args_json: args } });
};

const toolsFor = (sessionId: string) =>
  createCanvasTools({
    sessionId,
    canvasId: "cv-gone",
    title: "Canvas 4",
    exchangeId: "ex-1",
    question: "what stood out in orders last month",
  });

/** the app answers on a microtask (the tool is async), never in the emit; the
 * subscription itself is one dynamic import away, so serving is awaited too */
const settle = () => new Promise<void>((done) => setTimeout(done, 0));

async function serving(sessionId: string): Promise<{ tools: CanvasTools; stop: () => void }> {
  const tools = toolsFor(sessionId);
  const stop = tools.serve?.(() => {}) ?? (() => {});
  await settle();
  return { tools, stop };
}

describe("the canvas bridge answers every event it can see", () => {
  // every test stops what it started, so the module's own registry is empty
  // between them and the listener count is a fact and not a leak
  beforeEach(() => {
    answers.length = 0;
    expect(handlers.size).toBe(0);
  });

  test("a registered session is answered by its own tools", async () => {
    const { tools, stop } = await serving("s-1");
    expect(handlers.size).toBe(1);
    emit("s-1");
    await settle();
    expect(answers).toHaveLength(1);
    expect(answers[0].text).toBe(await tools.read().then((o) => o.textForModel));
    expect(answers[0].isError).toBe(false);
    stop();
  });

  test("a session with no tools is answered, never dropped", async () => {
    const { stop } = await serving("s-1");
    emit("s-other");
    await settle();
    expect(answers).toEqual([
      { callId: "c-0", text: "ERROR: the canvas is not open for this thread", isError: true },
    ]);
    stop();
  });

  test("a session whose tools were disposed gets the same answer", async () => {
    // two exchanges, one on each thread: stopping the first must not silence
    // the second, and a late call on the first is an error and not a hang
    const a = await serving("s-a");
    const b = await serving("s-b");
    a.stop();
    emit("s-a");
    await settle();
    expect(answers[0].text).toBe("ERROR: the canvas is not open for this thread");
    emit("s-b");
    await settle();
    expect(answers[1].isError).toBe(false);
    b.stop();
  });

  test("one registration per session id, and one listener for the app", async () => {
    const first = await serving("s-1");
    const second = await serving("s-1");
    expect(handlers.size).toBe(1);
    // the older exchange's stop must not take the newer registration away
    first.stop();
    emit("s-1");
    await settle();
    expect(answers[0].isError).toBe(false);
    second.stop();
    // the last stop takes the listener down with it
    expect(handlers.size).toBe(0);
  });
});
