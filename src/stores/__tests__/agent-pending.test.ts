// Pending assumptions (round 2, finding 3) and the retry that keeps its
// answer (finding 4). A chip click writes the WANTED state into
// useAgent.pending and runs nothing; the retry pill applies the set as one
// re-ask; a cancelled retry restores the prior answer exactly and keeps the
// set so the pill returns. The loop is stood in through the store's `runner`
// seam (a bun module mock is process-global and reached the loop's own
// tests); everything else is the real store, driven through the same
// runInto() the app drives. The IPC bridge has no Tauri here: the one call
// the cancel path makes (cancel the session) rejects and is caught, as it
// would be with a dead backend.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// agent.ts pulls in settings.ts, which paints the theme onto the document at
// import, and sidePane.ts, which reads localStorage; bun has neither. An
// in-memory storage and a do-nothing element stand in and leave again after
// (bun test shares one global scope across files)
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
// an element whose every property is a no-op function or another such element
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

const agent = await import("../agent");
const { useAgent, retryLabel, pendingTarget, stashPrior, restorePrior, runner } = agent;
type Exchange = import("../agent").Exchange;
const { useSchema } = await import("../schema");
const { useSettings } = await import("../settings");

// ---- the loop seam --------------------------------------------------------------

const realRunAsk = runner.runAsk;

/** the stand-in loop: waits for the signal, then answers with a cancelled
 * verdict the way loop.ts's finish() does (one error event, then the answer) */
let runs = 0;
const cancelledRun: typeof realRunAsk = async (req) => {
  runs++;
  req.onEvent?.({ type: "status", phase: "tools" });
  req.onEvent?.({ type: "toolStart", id: "retry-call-1", name: "run_sql", label: "run", args: "{}" });
  req.onEvent?.({ type: "text", delta: "a new answer that must not show" });
  await new Promise<void>((res) => {
    if (req.signal.aborted) res();
    else req.signal.addEventListener("abort", () => res(), { once: true });
  });
  req.onEvent?.({ type: "error", kind: "cancelled", message: "cancelled" });
  return {
    verdict: { status: "cancelled", sql: null },
    sql: null,
    run: null,
    assumptions: [],
    sanity: [],
    followUps: [],
    trace: [],
    text: "",
    turns: 1,
    ms: 5,
    usage: { input: 0, output: 0 },
    promptVersion: "v2",
    candidates: [],
    recall: null,
    risky: false,
  };
};

afterAll(() => {
  runner.runAsk = realRunAsk;
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- seed -----------------------------------------------------------------------

const PID = "p";
const TID = "t";
const EX = "ex-1";

function answered(): Exchange {
  return {
    id: EX,
    turnId: 2,
    question: "How many notification histories were added each month this year?",
    text: "Counted by sent_at. 4.65M this year.",
    thinking: "",
    chips: [
      { id: "c1", name: "describe_tables", label: "describe notification_history", ms: 412, isError: false, args: "{}", result: "…" },
      { id: "c2", name: "run_sql", label: "run", ms: 1862, isError: false, args: "{}", result: "…" },
    ],
    answer: {
      verdict: { status: "answered", sql: "SELECT 1", rowCount: 9 },
      sql: "SELECT 1",
      run: { columns: ["month", "n"], rows: [["2026-01-01", "1"]], rowCount: 1, capped: false, ms: 1861.9 },
      assumptions: [
        { id: "model:0", label: "Added = sent_at", source: "model", active: true },
        { id: "model:1", label: "This Year = 2026", source: "model", active: true },
        { id: "model:2", label: "Months With No Rows Omitted", source: "model", active: false },
      ],
      sanity: [],
      followUps: ["Which channels drove the spike?"],
      trace: [],
      text: "Counted by sent_at. 4.65M this year.",
      turns: 1,
      ms: 20_400,
      usage: { input: 1, output: 1 },
      promptVersion: "v2",
      candidates: [],
      recall: null,
      risky: false,
    },
    error: null,
    streaming: false,
    provider: "claude-code",
    model: "claude-sonnet-5",
  };
}

function seed(exchanges: Exchange[] = [answered()]) {
  runner.runAsk = cancelledRun;
  useSettings.setState({ agentProvider: "claude-code", agentModel: "claude-sonnet-5", agentByConn: {}, agentBaseUrls: {} });
  // an empty but well-formed snapshot: the real tools factory indexes it
  useSchema.setState({
    snapshots: {
      [PID]: {
        tables: [],
        foreign_keys: [],
        functions: [],
        schemas: ["public"],
        indexes: [],
        enums: [],
        sequences: [],
        extensions: [],
        server_version_num: 160004,
      },
    },
  });
  useAgent.setState({
    activeProfileId: PID,
    activeThread: { [PID]: TID },
    exchanges: { [TID]: exchanges },
    sessions: { [TID]: "session-1" },
    busy: { [TID]: false },
    phase: { [TID]: null },
    pending: {},
  });
  runs = 0;
}

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(pred()).toBe(true);
};

// ---- tests ------------------------------------------------------------------------

describe("pending assumptions", () => {
  beforeEach(() => seed());

  test("a chip click records its wanted state and runs nothing", () => {
    useAgent.getState().togglePending(EX, "model:1");
    expect(useAgent.getState().pending[EX]).toEqual({ "model:1": false });
    expect(useAgent.getState().busy[TID]).toBe(false);
    expect(runs).toBe(0);
    // an inactive chip turned on is wanted on
    useAgent.getState().togglePending(EX, "model:2");
    expect(useAgent.getState().pending[EX]).toEqual({ "model:1": false, "model:2": true });
  });

  test("toggling back to the answer's state removes the key, and the last key the entry", () => {
    useAgent.getState().togglePending(EX, "model:1");
    useAgent.getState().togglePending(EX, "model:0");
    useAgent.getState().togglePending(EX, "model:1");
    expect(useAgent.getState().pending[EX]).toEqual({ "model:0": false });
    useAgent.getState().togglePending(EX, "model:0");
    expect(EX in useAgent.getState().pending).toBe(false);
  });

  test("a busy thread and an unknown chip refuse the toggle; discard drops the set", () => {
    useAgent.getState().togglePending(EX, "nope");
    expect(useAgent.getState().pending).toEqual({});
    useAgent.setState((s) => ({ busy: { ...s.busy, [TID]: true } }));
    useAgent.getState().togglePending(EX, "model:1");
    expect(useAgent.getState().pending).toEqual({});
    useAgent.setState((s) => ({ busy: { ...s.busy, [TID]: false } }));
    useAgent.getState().togglePending(EX, "model:1");
    useAgent.getState().discardPending(EX);
    expect(useAgent.getState().pending).toEqual({});
  });

  test("the pill's face follows the set", () => {
    expect(retryLabel({ a: false })).toBe("Retry Without Assumption");
    expect(retryLabel({ a: false, b: false })).toBe("Retry Without Assumptions");
    expect(retryLabel({ a: true })).toBe("Retry with Changes");
    expect(retryLabel({ a: false, b: true })).toBe("Retry with Changes");
  });

  test("the pill targets the newest exchange with a non-empty set", () => {
    const older = { ...answered(), id: "ex-0" };
    const newer = answered();
    expect(pendingTarget([older, newer], {})).toBeNull();
    expect(pendingTarget([older, newer], { "ex-0": { "model:1": false } })).toBe("ex-0");
    expect(pendingTarget([older, newer], { "ex-0": { "model:1": false }, [EX]: { "model:0": false } })).toBe(EX);
    expect(pendingTarget([older, newer], { [EX]: {} })).toBeNull();
  });

  test("stash and restore are exact inverses", () => {
    const before = answered();
    const stashed = stashPrior(before);
    expect(stashed.streaming).toBe(true);
    expect(stashed.chips).toEqual([]);
    expect(stashed.text).toBe(before.text);
    const mid: Exchange = { ...stashed, chips: [{ ...before.chips[1], id: "new", ms: null, result: null }], thinking: "hmm" };
    const restored = restorePrior(mid);
    expect(restored).toEqual(before);
    expect("prior" in restored).toBe(false);
  });

  test("a cancelled retry restores the prior answer exactly and keeps the pending set", async () => {
    const before = answered();
    useAgent.getState().togglePending(EX, "model:1");
    const run = useAgent.getState().applyPending(EX);
    await until(() => useAgent.getState().exchanges[TID][0].chips.length === 1);
    const streaming = useAgent.getState().exchanges[TID][0];
    expect(useAgent.getState().busy[TID]).toBe(true);
    expect(streaming.streaming).toBe(true);
    expect(streaming.prior?.answer).toEqual(before.answer);
    // the old prose, grid and chips stay on screen while the new run streams
    expect(streaming.text).toBe(before.text);
    expect(streaming.answer).toEqual(before.answer);
    expect(streaming.chips[0].label).toBe("run");
    expect(useAgent.getState().pending[EX]).toEqual({ "model:1": false });

    useAgent.getState().cancel();
    await run;
    const after = useAgent.getState().exchanges[TID][0];
    expect(after).toEqual(before);
    expect(useAgent.getState().busy[TID]).toBe(false);
    expect(useAgent.getState().pending[EX]).toEqual({ "model:1": false });
    expect(runs).toBe(1);
  });

  test("a landed retry drops the prior, wears the flips and settles the set", async () => {
    runner.runAsk = async (req) => {
      req.onEvent?.({ type: "toolStart", id: "r1", name: "run_sql", label: "run", args: "{}" });
      req.onEvent?.({ type: "text", delta: "new prose" });
      return {
        verdict: { status: "answered", sql: "SELECT 2", rowCount: 1 },
        sql: "SELECT 2",
        run: { columns: ["n"], rows: [["1"]], rowCount: 1, capped: false, ms: 3 },
        // the re-run's own line puts the chip back on; the user's flip wins
        assumptions: [{ id: "model:1", label: "This Year = 2026", source: "model", active: true }],
        sanity: [],
        followUps: [],
        trace: [],
        text: "new prose",
        turns: 1,
        ms: 9,
        usage: { input: 0, output: 0 },
        promptVersion: "v2",
        candidates: [],
        recall: null,
        risky: false,
      };
    };
    useAgent.getState().togglePending(EX, "model:1");
    await useAgent.getState().applyPending(EX);
    const after = useAgent.getState().exchanges[TID][0];
    expect("prior" in after).toBe(false);
    expect(after.streaming).toBe(false);
    expect(after.text).toBe("new prose");
    expect(after.answer?.assumptions.find((a) => a.id === "model:1")?.active).toBe(false);
    expect(useAgent.getState().pending).toEqual({});
    expect(useAgent.getState().busy[TID]).toBe(false);
  });
});
