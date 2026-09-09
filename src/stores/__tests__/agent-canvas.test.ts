// Where a question's answer goes, and what the pane keeps of it (B3). ONE
// mechanism, two routes and a default: the target is a property of the
// QUESTION, so it lives IN the question as a mention pill, and every route
// ends with the same token in the draft. A canvas TAB is not a target: its
// one job is to prefill that pill, and a ⌫ that removed the pill removed the
// target, so no answer lands anywhere the bubble does not name. The model
// never creates a canvas; the app does, once, for a question that asked for
// one on a connection with none, and a Send is the press.
//
// Pinned here: the three routes, the prefilled pill that follows the tab, the
// record the store keeps of what landed (which is what the compact exchange's
// status line counts, what a cut deletes and what a re-run clears), and the
// words of the older-Restart confirm now that a cut takes canvas blocks too.
//
// The loop is stood in through the store's `runner` seam and the backend
// through Tauri's own mock transport, so every request the store handed the
// loop can be read back, `canvas` field included.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseAgentSettings, minimalSnapshot } from "./fixtures";

// agent.ts pulls in settings.ts, which paints the theme onto the document at
// import, and sidePane.ts, which reads localStorage; bun has neither
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
const agent = await import("../agent");
const { canvasStatusText, restartConfirmText, runner, syncCanvasPill, useAgent } = agent;
type Exchange = import("../agent").Exchange;
type AskRequest = Parameters<typeof runner.runAsk>[0];
const { useAsk } = await import("../ask");
const { useCanvas, cancelCanvasSaves } = await import("../canvas");
const { useConnections } = await import("../connections");
const { useSchema } = await import("../schema");
const { useSettings } = await import("../settings");
const { useTabs } = await import("../tabs");
type Profile = import("../../ipc/types").Profile;
type Tab = ReturnType<typeof useTabs.getState>["tabs"][number];

// one listener for the file: the cue is a window event, and a second
// registration per seed would count every cue as many times as tests have run
window.addEventListener?.("qwry:copy-cue", ((e: Event) =>
  cues.push(String((e as CustomEvent).detail))) as EventListener);

const realRunAsk = runner.runAsk;
const realFollowUps = runner.suggestFollowUps;
afterAll(() => {
  runner.runAsk = realRunAsk;
  runner.suggestFollowUps = realFollowUps;
  cancelCanvasSaves();
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- seams ----------------------------------------------------------------

const PID = "p";
const TID = "t";

let cues: string[] = [];
let seen: AskRequest[] = [];
/** what the answer says it wrote to the canvas, replayed as the loop's event */
let writesBack: { canvasId: string; blockIds: string[]; replaced: number } | null = null;

const answeredRun: typeof realRunAsk = async (req) => {
  seen.push(req);
  if (writesBack) req.onEvent?.({ type: "canvasWrite", ...writesBack });
  req.onEvent?.({ type: "text", delta: "four blocks are on the canvas." });
  return {
    verdict: { status: "answered", sql: null, rowCount: null },
    sql: null,
    run: null,
    assumptions: [],
    sanity: [],
    trace: [],
    text: "four blocks are on the canvas.",
    turns: 2,
    ms: 7,
    usage: { input: 1, output: 1 },
    promptVersion: "v4",
    candidates: [],
    recall: null,
    risky: false,
  };
};

const canvasTab = (id: string, canvasId: string, name: string): Tab =>
  ({
    id,
    name,
    sql: "",
    position: 0,
    saved_id: null,
    profile_id: PID,
    canvas_id: canvasId,
    kind: "canvas",
  }) as unknown as Tab;

const queryTab = (id: string): Tab =>
  ({
    id,
    name: "scratch",
    sql: "",
    position: 1,
    saved_id: null,
    profile_id: PID,
    canvas_id: null,
    kind: "query",
  }) as unknown as Tab;

function seed(opts: { tabs?: Tab[]; activeId?: string | null; canvases?: { id: string; title: string }[] } = {}) {
  cues = [];
  seen = [];
  writesBack = null;
  mockIPC((cmd) => {
    if (cmd === "agent_thread_create")
      return { id: TID, profile_id: PID, title: "t", created_at: "2026-09-09", session_key: TID };
    if (cmd === "agent_connect") return "session-1";
    if (cmd === "canvas_list") return [];
    if (cmd === "agent_turn_add") return 1;
    return undefined;
  });
  runner.runAsk = answeredRun;
  runner.suggestFollowUps = async () => ({
    questions: [],
    step: { step: "followups", ms: 1, prompt: "", text: "", questions: [] },
  });
  useSettings.setState(baseAgentSettings());
  useSchema.setState({ snapshots: { [PID]: minimalSnapshot() } });
  useConnections.setState({
    profiles: [{ id: PID, name: "staging" }] as unknown as Profile[],
    activeProfileId: PID,
  });
  useTabs.setState({
    tabs: opts.tabs ?? [],
    activeId: opts.activeId ?? null,
    loaded: true,
    closedStack: [],
  });
  const list = (opts.canvases ?? []).map((c) => ({
    id: c.id,
    profileId: PID,
    title: c.title,
    updatedAt: "",
  }));
  useCanvas.setState({
    canvases: { [PID]: list },
    docs: Object.fromEntries(list.map((c) => [c.id, { blocks: [] }])),
    loaded: { [PID]: true },
    recent: {},
    comparing: {},
    saveError: false,
    askedFrom: {},
  });
  useAsk.setState({ drafts: {}, draftFor: PID, blocks: {}, askContext: {}, edit: null });
  useAgent.setState({
    activeProfileId: PID,
    threads: { [PID]: [{ id: TID, profileId: PID, title: "t", createdAt: "2026-09-09", sessionKey: TID }] },
    activeThread: { [PID]: TID },
    exchanges: { [TID]: [] },
    sessions: { [TID]: "session-1" },
    busy: { [TID]: false },
    phase: { [TID]: null },
    pending: {},
    followUps: {},
  });
}

beforeEach(() => seed());

const asked = () => useAgent.getState().exchanges[TID];
/** the target the last run was handed: the request carries the canvas TOOLS,
 * fixed to that canvas at construction, so no tool can take a canvas id */
const target = (): { canvasId: string; title: string } | null => {
  const tools = seen[seen.length - 1]?.canvas;
  return tools ? { canvasId: tools.canvasId, title: tools.title } : null;
};

// ---- the routes -----------------------------------------------------------

describe("where a question's answer goes", () => {
  test("1 · a canvas pill in the question wins", async () => {
    seed({
      tabs: [canvasTab("t-a", "cv-a", "August finance"), canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [
        { id: "cv-a", title: "August finance" },
        { id: "cv-b", title: "Canvas 4" },
      ],
    });
    await useAgent.getState().ask('@"August finance" what stood out last month');
    // the pill is the authority: the ACTIVE tab is Canvas 4 and the answer
    // goes where the bubble says it goes
    expect(target()?.canvasId).toBe("cv-a");
    expect(target()?.title).toBe("August finance");
  });

  test("1 · a canvas tab is no target on its own, active or not", async () => {
    seed({
      tabs: [queryTab("t-q"), canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    await useAgent.getState().ask("what stood out last month");
    // the tab prefills the pill and nothing more: a question sent without one
    // is answered in the pane, where its bubble says it was answered
    expect(target()).toBeNull();
    expect(asked()[0].question).toBe("what stood out last month");
  });

  test("1 · the prefilled pill can be declined: ⌫ takes the target with it", async () => {
    seed({
      tabs: [canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    syncCanvasPill(PID);
    expect(useAsk.getState().drafts[PID]).toBe('@"Canvas 4" ');
    // the ⌫ that empties the draft, then the question the user does type
    useAsk.getState().setDraft("");
    useAsk.getState().setDraft("what stood out last month");
    await useAgent.getState().ask("what stood out last month");
    expect(target()).toBeNull();
    expect("canvas" in seen[0]).toBe(false);
  });

  test("2 · the word `canvas` with no canvas tab makes one, once", async () => {
    await useAgent.getState().ask("create analysis of @order_v2 in a canvas");
    const made = target();
    expect(made).not.toBeNull();
    // the tab stands beside the user's and focus never moved
    const tabs = useTabs.getState();
    expect(tabs.tabs.some((t) => t.canvas_id === made?.canvasId)).toBe(true);
    expect(tabs.activeId).toBeNull();
    // the question carries the new canvas's own pill, so the bubble records
    // where the answer went
    expect(asked()[0].question).toBe(
      `@"${made?.title}" create analysis of @order_v2 in a canvas`,
    );
    expect(cues).toEqual(["New canvas"]);
  });

  test("2 · the word is a whole word, in any case", async () => {
    await useAgent.getState().ask("Canvas please");
    expect(target()).not.toBeNull();
    seed();
    await useAgent.getState().ask("how many canvases do we sell");
    expect(target()).toBeNull();
    expect(cues).toEqual([]);
  });

  test("2 · a connection that already HAS a canvas gets no second one", async () => {
    seed({
      tabs: [canvasTab("t-b", "cv-b", "Canvas 4"), queryTab("t-q")],
      activeId: "t-q",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    await useAgent.getState().ask("put this in a canvas");
    expect(target()).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(2);
    expect(cues).toEqual([]);
  });

  test("3 · else no target at all, and the run is exactly today's run", async () => {
    await useAgent.getState().ask("how many orders came from each channel");
    expect(target()).toBeNull();
    expect("canvas" in seen[0]).toBe(false);
  });

  test("a question a busy thread refuses makes no canvas and cues nothing", async () => {
    useAgent.setState({ busy: { [TID]: true } });
    await useAgent.getState().ask("create analysis of @order_v2 in a canvas");
    // the aim is read AFTER the refusal: a question that asked nothing must
    // leave no tab behind and no cue on screen (LESSONS 3)
    expect(useTabs.getState().tabs).toEqual([]);
    expect(cues).toEqual([]);
    expect(seen).toEqual([]);
    expect(asked()).toEqual([]);
  });

  test("a re-run aims at the canvas the exchange already wrote to", async () => {
    seed({
      tabs: [canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    writesBack = { canvasId: "cv-b", blockIds: ["b1", "b2"], replaced: 0 };
    await useAgent.getState().ask('@"Canvas 4" what stood out last month');
    // the tab is gone by the time the Restart runs; the record is not
    useTabs.setState({ tabs: [], activeId: null });
    seen = [];
    await useAgent.getState().retry(asked()[0].id);
    expect(target()).toEqual({ canvasId: "cv-b", title: "Canvas 4" });
  });
});

// ---- the prefilled pill ---------------------------------------------------

describe("the prefilled pill", () => {
  const draft = () => useAsk.getState().drafts[PID];

  test("an empty draft beside an active canvas tab reads the pill", () => {
    useTabs.setState({ tabs: [canvasTab("t-b", "cv-b", "Canvas 4")], activeId: "t-b" });
    syncCanvasPill(PID);
    expect(draft()).toBe('@"Canvas 4" ');
  });

  test("it follows the tab: another canvas changes it, a query tab takes it away", () => {
    useTabs.setState({
      tabs: [canvasTab("t-a", "cv-a", "August finance"), canvasTab("t-b", "cv-b", "Canvas 4"), queryTab("t-q")],
      activeId: "t-b",
    });
    syncCanvasPill(PID);
    expect(draft()).toBe('@"Canvas 4" ');
    useTabs.setState({ activeId: "t-a" });
    expect(draft()).toBe('@"August finance" ');
    useTabs.setState({ activeId: "t-q" });
    expect(draft()).toBeUndefined();
  });

  test("a draft the user has typed into is never edited", () => {
    useTabs.setState({ tabs: [canvasTab("t-b", "cv-b", "Canvas 4")], activeId: "t-b" });
    syncCanvasPill(PID);
    useAsk.setState({ drafts: { [PID]: 'what stood out' } });
    useTabs.setState({ tabs: [canvasTab("t-b", "cv-b", "Canvas 4"), queryTab("t-q")], activeId: "t-q" });
    expect(draft()).toBe("what stood out");
  });

  test("the pill asks for nothing else: activating a canvas gives the PAGE the caret", () => {
    const before = useAsk.getState().focusSeq;
    useTabs.setState({ tabs: [canvasTab("t-b", "cv-b", "Canvas 4")], activeId: "t-b" });
    syncCanvasPill(PID);
    expect(useAsk.getState().focusSeq).toBe(before);
  });

  test("after a send the composer's own clear brings the pill back", async () => {
    seed({
      tabs: [canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    syncCanvasPill(PID);
    useAsk.getState().setDraft('@"Canvas 4" what stood out last month');
    await useAgent.getState().ask('@"Canvas 4" what stood out last month');
    // the composer spends the draft in the notification that appends the
    // exchange (AskPanel's send net); nothing else asks for the pill
    useAsk.getState().setDraft("");
    expect(draft()).toBe('@"Canvas 4" ');
  });

  test("a ⌫ that empties the draft by hand refills nothing", () => {
    useTabs.setState({ tabs: [canvasTab("t-b", "cv-b", "Canvas 4")], activeId: "t-b" });
    syncCanvasPill(PID);
    useAsk.getState().setDraft('@"Canvas 4"');
    useAsk.getState().setDraft("");
    // a pill one keystroke could not remove would be a target nobody can
    // decline (canvas-agent 3.4 item 1)
    expect(draft()).toBeUndefined();
  });
});

// ---- the record, and the compact exchange's status line --------------------

describe("what the exchange records", () => {
  test("the loop's event is ASSIGNED whole, title and all", async () => {
    seed({
      tabs: [canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    writesBack = { canvasId: "cv-b", blockIds: ["b1", "b2", "b3", "b4"], replaced: 0 };
    await useAgent.getState().ask('@"Canvas 4" what stood out last month');
    expect(asked()[0].canvasWrites).toEqual({
      canvasId: "cv-b",
      blockIds: ["b1", "b2", "b3", "b4"],
      title: "Canvas 4",
      replaced: 0,
    });
  });

  test("the verdict's assumptions land on the first result block it wrote", async () => {
    seed({
      tabs: [canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    // the tool's own move, from inside the run: a note, then the result, both
    // stamped with the exchange this run is for
    runner.runAsk = async (req) => {
      seen.push(req);
      const id = useAgent.getState().exchanges[TID][0].id;
      useCanvas.getState().applyModelBlocks("cv-b", [
        { id: "n1", kind: "note", text: "a reading", wroteBy: id },
        {
          id: "r1",
          kind: "result",
          sql: "select 1",
          run: { columns: ["n"], rows: [["1"]], rowCount: 1, capped: false, ms: 1 },
          face: "values",
          wroteBy: id,
        },
        {
          id: "r2",
          kind: "result",
          sql: "select 2",
          run: { columns: ["n"], rows: [["2"]], rowCount: 1, capped: false, ms: 1 },
          face: "values",
          wroteBy: id,
        },
      ]);
      req.onEvent?.({
        type: "canvasWrite",
        canvasId: "cv-b",
        blockIds: ["n1", "r1", "r2"],
        replaced: 0,
      });
      return {
        verdict: { status: "answered", sql: null, rowCount: null },
        sql: null,
        run: null,
        assumptions: [
          { id: "m0", label: "Last Month = August 2026", source: "model", active: true },
          { id: "m1", label: "Excluded Test Orders", source: "detected", active: false },
        ],
        sanity: [],
        trace: [],
        text: "one line.",
        turns: 1,
        ms: 1,
        usage: { input: 1, output: 1 },
        promptVersion: "v4",
        candidates: [],
        recall: null,
        risky: false,
      };
    };
    await useAgent.getState().ask('@"Canvas 4" what stood out last month');
    const chipsOf = (id: string) => {
      const b = useCanvas.getState().docs["cv-b"].blocks.find((x) => x.id === id);
      return b?.kind === "result" ? b.chips : null;
    };
    // the FIRST result block, never the note above it and never the one after;
    // and an assumption the user switched off is not one the answer made
    expect(chipsOf("r1")).toEqual(["Last Month = August 2026"]);
    expect(chipsOf("r2")).toEqual([]);
  });

  test("a block deleted by hand takes itself out of the number", async () => {
    seed({
      tabs: [canvasTab("t-b", "cv-b", "Canvas 4")],
      activeId: "t-b",
      canvases: [{ id: "cv-b", title: "Canvas 4" }],
    });
    writesBack = { canvasId: "cv-b", blockIds: ["b1", "b2", "b3", "b4"], replaced: 0 };
    await useAgent.getState().ask('@"Canvas 4" what stood out last month');
    useAgent.getState().forgetCanvasBlocks(["b2"]);
    expect(canvasStatusText(asked()[0].canvasWrites!)).toBe("3 blocks");
    // and an exchange left with nothing on the canvas loses the line
    useAgent.getState().forgetCanvasBlocks(["b1", "b3", "b4"]);
    expect(asked()[0].canvasWrites).toBeUndefined();
  });
});

describe("the compact exchange's status line", () => {
  const line = (blockIds: string[], replaced = 0) =>
    canvasStatusText({ canvasId: "cv", blockIds, title: "Canvas 4", replaced });

  test("the blocks, singular at one", () => {
    expect(line(["a", "b", "c", "d"])).toBe("4 blocks");
    expect(line(["a"])).toBe("1 block");
  });

  test("a replace is its own fragment, and the block count is what was added", () => {
    expect(line(["a", "b", "c", "d"], 1)).toBe("3 blocks · 1 replaced");
    expect(line(["a"], 1)).toBe("1 replaced");
  });

  test("nothing standing prints nothing, never a zero", () => {
    expect(line([])).toBe("");
  });
});

// ---- the cut --------------------------------------------------------------

function exchange(n: number, blocks?: string[]): Exchange {
  return {
    id: `ex-${n}`,
    turnId: 10 + n,
    userTurnId: 40 + n,
    idx: n * 2,
    question: `question ${n}`,
    text: `answer ${n}`,
    thinking: "",
    chips: [],
    answer: {
      verdict: { status: "answered", sql: null, rowCount: null },
      sql: null,
      run: null,
      assumptions: [],
      sanity: [],
      trace: [],
      text: `answer ${n}`,
      turns: 1,
      ms: 10,
      usage: { input: 1, output: 1 },
      promptVersion: "v4",
      candidates: [],
      recall: null,
      risky: false,
    },
    error: null,
    streaming: false,
    provider: "claude-code",
    model: "claude-sonnet-5",
    ...(blocks ? { canvasWrites: { canvasId: "cv-b", blockIds: blocks, title: "Canvas 4", replaced: 0 } } : null),
  };
}

describe("a cut takes the blocks of the exchanges it removes", () => {
  test("the blocks after the cut go; the blocks before it stay", async () => {
    seed({ canvases: [{ id: "cv-b", title: "Canvas 4" }] });
    const doc = useCanvas.getState();
    doc.applyModelBlocks("cv-b", [
      { id: "k1", kind: "note", text: "kept", wroteBy: "ex-0" },
      { id: "g1", kind: "note", text: "goes", wroteBy: "ex-1" },
      { id: "g2", kind: "note", text: "goes too", wroteBy: "ex-2" },
    ]);
    // a note the user wrote by hand: no thread may take it away
    const mine = doc.addNote("cv-b", "the user's own");
    useAgent.setState({
      exchanges: { [TID]: [exchange(0, ["k1"]), exchange(1, ["g1"]), exchange(2, ["g2"])] },
    });
    await useAgent.getState().truncateThread(TID, "ex-1", true);
    expect(useCanvas.getState().docs["cv-b"].blocks.map((b) => b.id)).toEqual(["k1", mine]);
    expect(asked().map((e) => e.id)).toEqual(["ex-0"]);
  });
});

// ---- the older-Restart confirm --------------------------------------------

describe("the older-Restart confirm", () => {
  test("questions and answers alone when no canvas is involved", () => {
    expect(restartConfirmText([exchange(1)])).toEqual({
      title: "Restart from Here?",
      detail: "The question after this one and its answer will be deleted.",
      label: "Delete 1 Question",
    });
    expect(restartConfirmText([exchange(1), exchange(2)]).detail).toBe(
      "The 2 questions after this one and their answers will be deleted.",
    );
  });

  test("the canvas blocks join the sentence, counted from what still stands", () => {
    const two = [exchange(1, ["a", "b", "c", "d"]), exchange(2, ["e", "f", "g"])];
    expect(restartConfirmText(two)).toEqual({
      title: "Restart from Here?",
      detail: "The 2 questions after this one, their answers and 7 canvas blocks will be deleted.",
      label: "Delete 2 Questions",
    });
    expect(restartConfirmText([exchange(1, ["a"])]).detail).toBe(
      "The question after this one, its answer and 1 canvas block will be deleted.",
    );
  });

  test("the bubble's Restart asks with THESE words: one definition, one caller", () => {
    // the sentence and the arithmetic that counts the blocks must not drift
    // apart again (LESSONS 13): EchoActions holds neither
    const src = readFileSync(join(import.meta.dir, "../../ask/EchoActions.tsx"), "utf8");
    expect(src).toContain('import { restartConfirmText, useAgent, type Exchange } from "../stores/agent"');
    expect(src).toContain("restartConfirmText(later)");
    expect(src).not.toContain("function restartConfirmText");
    expect(src).not.toContain("will be deleted");
  });
});
