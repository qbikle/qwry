// Writes (A4, AGENT-UX section 13), the store's half. Three things are under
// test and nothing else: what the store does with a `proposed` verdict (the
// dry run, the spinning chip, the thread that stays busy until it lands and
// the Stop that leaves the proposal standing), what Run does with the tab's
// outcome, and the one seam that reaches a query tab.
//
// The loop, the gate, the dry run and the tab's run are stood in through the
// store's `runner` seam, the same door agent-pending.test.ts uses; the backend
// is Tauri's own mock transport, so the appdb writes are assertable rather
// than swallowed. The seam's own test (BEGIN wrapping) drives the REAL
// runStatementInTab with `useResults.run` stood in: the wrapping is the thing
// being tested, so it is not the thing being mocked.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Profile, WritePreview } from "../../ipc/types";
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

const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
mockIPC((cmd, payload) => {
  invoked.push({ cmd, args: (payload ?? {}) as Record<string, unknown> });
  if (cmd === "agent_turn_add") return 7;
  // the event plugin answers the listeners results.ts registers at import;
  // everything else this file touches is a write with nothing to return
  return undefined;
});

// results.ts's own tab subscription reaches for edits.ts and browser.ts when a
// tab closes, and both subscribe to a Tauri event at import through `listen`,
// which reads `transformCallback` off the internals object a mock installs.
// Another file's `clearMocks` deletes it, so a subscription registered LATE
// rejects with no one waiting and takes the next file's tests down with it.
// Registering them here, under this file's own live mock, is the cure: a
// module body runs once, and this is the once.
await import("../edits");
await import("../browser");

const agent = await import("../agent");
const { useAgent, runner, writeVerbOf } = agent;
type Exchange = import("../agent").Exchange;
const { useSchema } = await import("../schema");
const { useSettings, writesAllowed } = await import("../settings");
const { endTabTx, useConnections, skey } = await import("../connections");
const { bandFace, bandSpecies } = await import("../../ask/ResultBlock");
const { cancelTabSaves, useTabs } = await import("../tabs");
const { runStatementInTab, useResults } = await import("../results");

const real = { ...runner };
afterAll(() => {
  Object.assign(runner, real);
  cancelTabSaves();
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

// ---- seed ------------------------------------------------------------------

const PID = "p";
const TID = "t";
const SQL = "UPDATE order_v2 SET payment_status = 'paid' WHERE id = 1";

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: PID,
  name: "auth_new",
  host: "localhost",
  port: 5432,
  dbname: "auth_new",
  user: "qwry",
  sslmode: "prefer",
  is_prod: false,
  ...over,
});

const preview = (over: Partial<WritePreview> = {}): WritePreview => ({
  verb: "UPDATE",
  table: "public.order_v2",
  has_where: true,
  exact_rows: 12,
  before: { columns: ["id", "payment_status"], rows: [["1", "pending"]] },
  after: { columns: ["id", "payment_status"], rows: [["1", "paid"]] },
  warnings: [],
  ...over,
});

/** what the store told the loop this connection allows */
const seenWrites: (import("../../agent/loop").WriteMode | null)[] = [];

/** the loop's answer, scripted: one verdict, no tools, the text streamed */

function answerOf(verdict: import("../../agent/types").Verdict, sql: string | null) {
  return {
    verdict,
    sql,
    run: null,
    assumptions: [],
    sanity: [],
    trace: [],
    text: "Marked them paid.",
    turns: 1,
    ms: 12,
    usage: { input: 1, output: 1 },
    promptVersion: "v4",
    candidates: [],
    recall: null,
    risky: false,
  };
}

function seed(over: { prod?: boolean; writes?: boolean } = {}) {
  invoked.length = 0;
  seenWrites.length = 0;
  Object.assign(runner, real);
  useSettings.setState({
    ...baseAgentSettings(),
    agentWrites: over.writes === false ? {} : { [PID]: true },
  });
  useConnections.setState({ profiles: [profile({ is_prod: over.prod === true })], activeProfileId: PID });
  useSchema.setState({ snapshots: { [PID]: minimalSnapshot() } });
  useAgent.setState({
    activeProfileId: PID,
    activeThread: { [PID]: TID },
    threads: { [PID]: [{ id: TID, profileId: PID, title: "t", createdAt: "2026-09-06" }] },
    exchanges: { [TID]: [] },
    sessions: { [TID]: "session-1" },
    busy: { [TID]: false },
    phase: { [TID]: null },
    pending: {},
    writing: {},
  });
}

/** the verdicts written to appdb, in order: the wire record rides under
 * `answer`, the shape agentAnswerPut sends */
const answerPuts = () =>
  invoked
    .filter((i) => i.cmd === "agent_answer_put")
    .map((i) => i.args.answer as { status: string; row_count: number | null })
    .map(({ status, row_count }) => ({ status, row_count }));

const only = (): Exchange => {
  const list = useAgent.getState().exchanges[TID] ?? [];
  expect(list).toHaveLength(1);
  return list[0];
};

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(pred()).toBe(true);
};

/** a promise the test releases, so the dry run can be caught in flight */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---- the switch ------------------------------------------------------------

describe("who may propose a change", () => {
  test("off by default, on only when the connection says so, never on production", () => {
    expect(writesAllowed({}, PID, false)).toBe(false);
    expect(writesAllowed({ [PID]: true }, PID, false)).toBe(true);
    expect(writesAllowed({ [PID]: true }, PID, true)).toBe(false);
    // another connection's permission is not this one's
    expect(writesAllowed({ other: true }, PID, false)).toBe(false);
  });

  test("falling back to App default drops the model choice and NOT the permission", () => {
    // `dropAgentConn` fires from the model row, where the user chose a model,
    // not a permission; the connection's own delete is what revokes edits
    useSettings.setState({ agentByConn: { [PID]: { provider: "x", model: "y" } }, agentWrites: { [PID]: true } });
    useSettings.getState().dropAgentConn(PID);
    expect(useSettings.getState().agentByConn).toEqual({});
    expect(useSettings.getState().agentWrites).toEqual({ [PID]: true });
    useSettings.getState().setAgentWrites(PID, false);
    expect(useSettings.getState().agentWrites).toEqual({});
  });

  test("the row Record View attached rides with the question, once", async () => {
    // item 7's other half: `prefillAsk` parks the row on the seam and `ask()`
    // takes it, so the model sees WHICH row the sentence is about; a second
    // question over the same connection carries none (LESSONS 3)
    seed();
    const seen: (string | undefined)[] = [];
    runner.runAsk = async (req) => {
      seen.push(req.rowContext);
      return answerOf({ status: "answered", sql: null, rowCount: null }, null);
    };
    const { useAsk } = await import("../ask");
    useAsk.getState().prefillAsk(PID, "@public.order_v2 ", "row of public.order_v2, keyed id = 218841\nid = 218841");
    await useAgent.getState().ask("set status to shipped");
    await useAgent.getState().ask("and the one before it?");
    expect(seen[0]).toContain("keyed id = 218841");
    expect(seen[1]).toBeUndefined();
    expect(useAsk.getState().askContext[PID]).toBeUndefined();
  });

  test("the run is told what the connection allows, production included", async () => {
    seed({ prod: true });
    runner.runAsk = async (req) => {
      seenWrites.push(req.writes ?? null);
      return answerOf({ status: "answered", sql: null, rowCount: null }, null);
    };
    await useAgent.getState().ask("how many orders?");
    expect(seenWrites[0]).toMatchObject({ on: false, prod: true });
  });
});

// ---- the proposal ----------------------------------------------------------

describe("a proposal and its dry run", () => {
  beforeEach(() => seed());

  test("the exchange lands proposed, the chip spins, and the preview fills it", async () => {
    const gate = deferred<WritePreview>();
    runner.runAsk = async (req) => {
      seenWrites.push(req.writes ?? null);
      return answerOf({ status: "proposed", sql: SQL }, SQL);
    };
    runner.writePreview = () => gate.promise;
    const done = useAgent.getState().ask("mark them paid");

    // in flight: the proposal is on screen, the strip's chip is running, and
    // the thread is still busy, because the exchange is not finished
    await until(() => (useAgent.getState().exchanges[TID] ?? []).some((e) => e.status === "proposed"));
    const live = only();
    expect(live.streaming).toBe(true);
    expect(useAgent.getState().busy[TID]).toBe(true);
    expect(live.chips.map((c) => [c.name, c.label, c.ms])).toEqual([["preview", "preview", null]]);
    expect(live.preview).toBeUndefined();
    expect(seenWrites[0]).toMatchObject({ on: true, prod: false });

    gate.resolve(preview());
    await done;
    const landed = only();
    expect(landed.status).toBe("proposed");
    expect(landed.preview).toMatchObject({ verb: "UPDATE", exact_rows: 12 });
    expect(landed.streaming).toBe(false);
    expect(useAgent.getState().busy[TID]).toBe(false);
    // the chip's ring fills: it ran and it landed
    expect(landed.chips[0].ms).not.toBeNull();
    expect(landed.chips[0].isError).toBe(false);
    // nothing ran: the statement is the answer's, the run is null
    expect(landed.answer?.run).toBeNull();
    expect(landed.answer?.sql).toBe(SQL);
    // and appdb has the proposal
    expect(answerPuts()).toEqual([{ status: "proposed", row_count: null }]);
  });

  test("a dry run that fails leaves the proposal standing, with no band and an errored chip", async () => {
    runner.runAsk = async () => answerOf({ status: "proposed", sql: SQL }, SQL);
    runner.writePreview = async () => {
      throw new Error("edits are off on production\nsecond line");
    };
    await useAgent.getState().ask("mark them paid");
    const e = only();
    expect(e.status).toBe("proposed");
    // null, not undefined: the dry run answered, and its answer was no
    expect(e.preview).toBeNull();
    expect(e.chips[0].isError).toBe(true);
    expect(e.chips[0].result).toBe("edits are off on production");
    expect(useAgent.getState().busy[TID]).toBe(false);
  });

  test("a Stop during the dry run leaves the proposal standing and the chip stopped", async () => {
    const gate = deferred<WritePreview>();
    runner.runAsk = async () => answerOf({ status: "proposed", sql: SQL }, SQL);
    runner.writePreview = () => gate.promise;
    const done = useAgent.getState().ask("mark them paid");
    await until(() => useAgent.getState().exchanges[TID]?.[0]?.chips.length === 1);

    useAgent.getState().cancel();
    await until(() => useAgent.getState().busy[TID] === false);
    const e = only();
    expect(e.status).toBe("proposed");
    expect(e.answer?.sql).toBe(SQL);
    expect(e.streaming).toBe(false);
    // still running, never landed: the hollow ring a stopped call wears
    expect(e.chips[0].ms).toBeNull();
    expect(e.preview).toBeUndefined();

    // the late answer changes nothing
    gate.resolve(preview());
    await done;
    expect(only().preview).toBeUndefined();
  });

  test("edits off: the failure keeps its own kind and asks for no dry run", async () => {
    seed({ writes: false });
    let previews = 0;
    runner.runAsk = async () =>
      answerOf({ status: "failed", sql: SQL, message: "edits are off for this connection" }, SQL);
    runner.writePreview = async () => {
      previews++;
      return preview();
    };
    // the loop emits the error; the store keeps the kind it was given
    await useAgent.getState().ask("mark them paid");
    const e = only();
    expect(e.status).toBeUndefined();
    expect(e.preview).toBeUndefined();
    expect(previews).toBe(0);
    expect(e.answer?.sql).toBe(SQL);
  });
});

// ---- Run -------------------------------------------------------------------

describe("running a proposal", () => {
  const proposed = (over: Partial<Exchange> = {}): Exchange => ({
    id: "ex-1",
    turnId: 7,
    userTurnId: 6,
    idx: 0,
    question: "mark them paid",
    text: "Marked them paid.",
    thinking: "",
    chips: [],
    answer: { ...answerOf({ status: "proposed", sql: SQL }, SQL), text: "Marked them paid." },
    error: null,
    streaming: false,
    provider: "claude-code",
    model: "claude-sonnet-5",
    status: "proposed",
    preview: preview(),
    ...over,
  });

  beforeEach(() => {
    seed();
    useAgent.setState({ exchanges: { [TID]: [proposed()] } });
  });

  test("the tab's outcome lands on the exchange and persists as ran", async () => {
    const calls: unknown[][] = [];
    runner.runInTab = async (...a) => {
      calls.push(a);
      return { ran: true, rows: 12, tabKey: skey(PID, "tab-1"), error: null };
    };
    await useAgent.getState().runWrite("ex-1");
    const e = only();
    expect(e.status).toBe("ran");
    expect(e.ranRows).toBe(12);
    expect(e.ranTab).toBe(skey(PID, "tab-1"));
    // the statement went as written; the tab is named by the question
    expect(calls[0][0]).toBe(PID);
    expect(calls[0][1]).toBe(SQL);
    expect(calls[0][2]).toBe("mark them paid");
    expect(answerPuts()).toEqual([{ status: "ran", row_count: 12 }]);
    expect(useAgent.getState().writing["ex-1"]).toBeUndefined();
  });

  test("a refused or failed run leaves the proposal exactly as it was", async () => {
    runner.runInTab = async () => ({ ran: false, rows: null, tabKey: skey(PID, "tab-1"), error: null });
    await useAgent.getState().runWrite("ex-1");
    expect(only().status).toBe("proposed");

    runner.runInTab = async () => ({
      ran: true,
      rows: null,
      tabKey: skey(PID, "tab-1"),
      error: 'relation "order_v2" does not exist',
    });
    await useAgent.getState().runWrite("ex-1");
    const e = only();
    expect(e.status).toBe("proposed");
    expect(e.ranRows).toBeUndefined();
    expect(invoked.some((i) => i.cmd === "agent_answer_put")).toBe(false);
  });

  test("it runs once: a second press, a busy thread and an answered exchange all refuse", async () => {
    let runs = 0;
    runner.runInTab = async () => {
      runs++;
      return { ran: true, rows: 1, tabKey: skey(PID, "tab-1"), error: null };
    };
    await useAgent.getState().runWrite("ex-1");
    await useAgent.getState().runWrite("ex-1");
    expect(runs).toBe(1);

    useAgent.setState({ exchanges: { [TID]: [proposed()] }, busy: { [TID]: true } });
    await useAgent.getState().runWrite("ex-1");
    expect(runs).toBe(1);

    useAgent.setState({ exchanges: { [TID]: [proposed({ status: undefined })] }, busy: { [TID]: false } });
    await useAgent.getState().runWrite("ex-1");
    expect(runs).toBe(1);
  });
});

// ---- the seam into a query tab ---------------------------------------------

describe("the statement's way into a query tab", () => {
  let ran: { sql: string; profileId: string | undefined }[] = [];

  beforeEach(() => {
    seed();
    ran = [];
    useTabs.setState({
      tabs: [
        {
          id: "tab-1",
          name: "one",
          sql: "",
          position: 0,
          saved_id: null,
          kind: "query",
          table: null,
          canvas_id: null,
          profile_id: PID,
        },
      ],
      activeId: "tab-1",
      pinned: new Set(),
    });
    useConnections.setState({ txTabs: {} });
    useResults.setState({
      active: "tab-1",
      byTab: {},
      // the tab's own run path, stood in: what it EXECUTES is the assertion
      run: async (sqlOverride, _offset, opts) => {
        ran.push({ sql: sqlOverride ?? "", profileId: opts?.profileId });
        useResults.setState((s) => ({
          byTab: {
            ...s.byTab,
            "tab-1": {
              ...(s.byTab["tab-1"] ?? {
                statements: [],
                activeStatement: 0,
                running: false,
                cancelling: false,
                connecting: false,
                totalMs: null,
                executedOffset: 0,
                notices: [],
                executedSessionId: null,
                globalError: null,
              }),
              executedSql: sqlOverride ?? "",
              executedProfileId: opts?.profileId ?? null,
              statements: [
                {
                  index: 0,
                  sql: "BEGIN",
                  columns: [],
                  rows: [],
                  truncated: new Set<string>(),
                  affected: null,
                  ms: 1,
                  rowCount: 0,
                  capped: false,
                  done: true,
                  error: null,
                },
                {
                  index: 1,
                  sql: SQL,
                  columns: [],
                  rows: [],
                  truncated: new Set<string>(),
                  affected: 12,
                  ms: 4,
                  rowCount: 0,
                  capped: false,
                  done: true,
                  error: null,
                },
              ],
            },
          },
        }));
      },
    });
  });

  test("no open transaction: the statement is wrapped in one the tab can commit", async () => {
    const out = await runStatementInTab(PID, SQL);
    expect(ran[0].sql).toBe(`BEGIN;\n${SQL}`);
    expect(ran[0].profileId).toBe(PID);
    expect(out).toEqual({ ran: true, rows: 12, tabKey: skey(PID, "tab-1"), error: null });
  });

  test("a transaction already open: the statement joins it, never a second BEGIN", async () => {
    useConnections.setState({ txTabs: { [skey(PID, "tab-1")]: true } });
    const out = await runStatementInTab(PID, SQL);
    expect(ran[0].sql).toBe(SQL);
    expect(out.ran).toBe(true);
  });

  test("no query tab: one is opened for it and the statement is its text", async () => {
    useTabs.setState({ tabs: [], activeId: null });
    // the new tab is the active one, and the run lands in it
    await runStatementInTab(PID, SQL, "mark them paid");
    const opened = useTabs.getState().tabs;
    expect(opened).toHaveLength(1);
    expect(opened[0].sql).toBe(SQL);
    expect(opened[0].name).toBe("mark them paid");
    expect(ran[0].sql).toBe(`BEGIN;\n${SQL}`);
  });

  test("a confirm that said no leaves nothing executed, and the outcome says so", async () => {
    useResults.setState({ run: async () => {} });
    const out = await runStatementInTab(PID, SQL);
    expect(out).toMatchObject({ ran: false, rows: null });
  });

  test("another connection on screen refuses: a tab is never opened in someone else's workspace", async () => {
    useConnections.setState({ activeProfileId: "other" });
    const out = await runStatementInTab(PID, SQL);
    expect(out.ran).toBe(false);
    expect(ran).toHaveLength(0);
  });
});

// ---- a re-run over a proposal ----------------------------------------------

describe("what a re-run does to a proposal", () => {
  const proposal = (): Exchange => ({
    id: "ex-1",
    turnId: 7,
    question: "mark them paid",
    text: "Marked them paid.",
    thinking: "",
    chips: [],
    answer: { ...answerOf({ status: "proposed", sql: SQL }, SQL), text: "Marked them paid." },
    error: null,
    streaming: false,
    provider: "claude-code",
    model: "claude-sonnet-5",
    status: "proposed",
    preview: preview(),
  });

  test("a Restart forgets the dry run with the answer, and a Stop puts both back", () => {
    const before = proposal();
    const forgotten = agent.stashPrior(before, true);
    // nothing of the proposal is on screen while the new run streams
    expect(forgotten.answer).toBeNull();
    expect(forgotten.status).toBeUndefined();
    expect(forgotten.preview).toBeUndefined();
    // and the Stop restores it exactly, dry run included (`textStale: false`
    // is W7's own leftover from emptying the slot, and reads as its default)
    expect(agent.restorePrior(forgotten)).toEqual({ ...before, textStale: false });
  });

  test("a plain retry keeps the proposal on screen until its own verdict lands", () => {
    const before = proposal();
    const stashed = agent.stashPrior(before);
    expect(stashed.status).toBe("proposed");
    expect(stashed.preview).toMatchObject({ exact_rows: 12 });
    expect(agent.restorePrior(stashed)).toEqual(before);
  });

  test("a run that already happened is restored with its rows and its tab", () => {
    const ran: Exchange = { ...proposal(), status: "ran", ranRows: 12, ranTab: skey(PID, "tab-1") };
    expect(agent.restorePrior(agent.stashPrior(ran, true))).toEqual({ ...ran, textStale: false });
  });
});

// ---- a reloaded exchange ---------------------------------------------------

describe("what a reload can still say", () => {
  test("the verb of a statement, for a headline whose dry run is long gone", () => {
    expect(writeVerbOf(SQL)).toBe("UPDATE");
    expect(writeVerbOf("-- comment\ndelete from t where id = 1")).toBe("DELETE");
    expect(writeVerbOf("INSERT INTO t VALUES (1)")).toBe("INSERT");
    expect(writeVerbOf("SELECT 1")).toBeNull();
    expect(writeVerbOf(null)).toBeNull();
  });
});

// ---- the transaction the run opened (B1) ------------------------------------
//
// Four things: the two actions reach the TAB's one implementation with the
// exchange's own tab key; what the exchange SAYS is stamped by the transaction
// closing and not by the press, so the status bar's own ROLLBACK reaches it
// too; a transaction that ended anywhere the app cannot see stamps nothing;
// and the band's face and species, the two pure rules the block draws from.

describe("committing and rolling back a run", () => {
  const KEY = skey(PID, "tab-1");
  const ran = (over: Partial<Exchange> = {}): Exchange => ({
    id: "ex-1",
    turnId: 7,
    question: "mark them paid",
    text: "Marked them paid.",
    thinking: "",
    chips: [],
    answer: { ...answerOf({ status: "proposed", sql: SQL }, SQL), text: "Marked them paid." },
    error: null,
    streaming: false,
    provider: "claude-code",
    model: "claude-sonnet-5",
    status: "ran",
    preview: preview(),
    ranRows: 12,
    ranTab: KEY,
    ...over,
  });

  let sent: [string, string][] = [];
  beforeEach(() => {
    seed();
    sent = [];
    runner.endTabTx = async (key, end) => {
      sent.push([key, end]);
      useConnections.getState().setTxTab(key, false);
      return true;
    };
    useAgent.setState({ exchanges: { [TID]: [ran()] } });
    // opened the way the app opens one (results.ts's tx-state listener), which
    // is also what forgets how the LAST transaction on this tab ended
    useConnections.setState({ txTabs: {}, tabSessions: { [KEY]: "session-tab-1" } });
    useConnections.getState().setTxTab(KEY, true);
  });

  test("both actions go to the tab's own way of ending it, on the exchange's own tab", async () => {
    await useAgent.getState().commitWrite("ex-1");
    expect(sent).toEqual([[KEY, "commit"]]);

    useAgent.setState({ exchanges: { [TID]: [ran()] } });
    useConnections.getState().setTxTab(KEY, true);
    await useAgent.getState().rollbackWrite("ex-1");
    expect(sent[1]).toEqual([KEY, "rollback"]);
    expect(useAgent.getState().writing["ex-1"]).toBeUndefined();
  });

  test("nothing to end: a proposal, a closed transaction and a reloaded run all refuse", async () => {
    useAgent.setState({ exchanges: { [TID]: [ran({ status: "proposed" })] } });
    await useAgent.getState().commitWrite("ex-1");

    useAgent.setState({ exchanges: { [TID]: [ran()] } });
    useConnections.setState({ txTabs: {} });
    await useAgent.getState().commitWrite("ex-1");

    // a reload keeps the run and loses the tab: there is no transaction to name
    useAgent.setState({ exchanges: { [TID]: [ran({ ranTab: undefined })] } });
    useConnections.getState().setTxTab(KEY, true);
    await useAgent.getState().rollbackWrite("ex-1");
    expect(sent).toEqual([]);
  });

  test("the transaction closing is what stamps the exchange, from either side", async () => {
    // the block's own Commit, through the REAL endTabTx: the seam being tested
    // is the one both surfaces press, so it is not the one being stood in
    Object.assign(runner, { endTabTx: real.endTabTx });
    await useAgent.getState().commitWrite("ex-1");
    expect(only().ranTx).toBe("committed");
    expect(useConnections.getState().txTabs[KEY]).toBe(false);

    // and the status bar's ROLLBACK, which never touches the agent store: the
    // tab closes the transaction and the exchange reads it
    useAgent.setState({ exchanges: { [TID]: [ran()] } });
    useConnections.getState().setTxTab(KEY, true);
    await endTabTx(KEY, "rollback");
    expect(only().ranTx).toBe("rolledback");
  });

  test("a transaction that ended somewhere else says nothing, and a new one forgets the last", async () => {
    // a typed COMMIT, a dead session: the tab's flag goes and the app never
    // sent the word, so the headline falls back to what a reload says
    useConnections.getState().setTxTab(KEY, false);
    expect(only().ranTx).toBeUndefined();

    Object.assign(runner, { endTabTx: real.endTabTx });
    useConnections.getState().setTxTab(KEY, true);
    await endTabTx(KEY, "commit");
    expect(only().ranTx).toBe("committed");

    // the NEXT transaction on that tab is not the one that was committed
    useAgent.setState({ exchanges: { [TID]: [ran()] } });
    useConnections.getState().setTxTab(KEY, true);
    useConnections.getState().setTxTab(KEY, false);
    expect(only().ranTx).toBeUndefined();
  });

  test("a stash carries the ending and a new verdict clears it", () => {
    const before = ran({ ranTx: "committed" });
    expect(agent.restorePrior(agent.stashPrior(before, true))).toEqual({
      ...before,
      textStale: false,
    });
    expect(agent.stashPrior(before, true).ranTx).toBeUndefined();
  });
});

describe("what the band shows", () => {
  const run = { verb: "UPDATE" } as WritePreview;
  const noop = () => {};

  test("the tab's two while its transaction is open, the Run before that, none after", () => {
    expect(bandFace({ preview: run, onRun: noop })).toBe("run");
    expect(bandFace({ preview: run, onRun: noop, onCommit: noop, onRollback: noop })).toBe("tx");
    // the surface hands the pair over only while the transaction is open, so a
    // settled change and a reloaded one are the same thing here: no band
    expect(bandFace({ preview: run })).toBeNull();
    expect(bandFace({ preview: null, onRun: noop })).toBeNull();
  });

  test("red states loss: INSERT wears the accent, the other two and the unknown wear danger", () => {
    expect(bandSpecies("INSERT")).toBe("primary");
    expect(bandSpecies("UPDATE")).toBe("danger");
    expect(bandSpecies("DELETE")).toBe("danger");
    expect(bandSpecies(null)).toBe("danger");
  });
});
