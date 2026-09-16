// The maintainer's report: browsing a table, the strip under the grid read
// `no such session` while the connection dot stayed green, and ⇧⌘R did not
// clear it. Both halves are frontend bookkeeping. A tab's executedSessionId is
// a STAMP of what ran, the app forgets sessions in five places without ever
// touching it, and a dozen call sites sent that stamp anyway; heal rebuilt
// connections and told no tab about it.
//
// So what is under test here is which SESSION ID leaves the app, and what a
// reader is left looking at afterwards. The transport is Tauri's own mock (a
// fake ipc/commands module would take forty unrelated commands with it) and it
// RECORDS every session id it is handed: a forgotten id reaching the backend
// is the bug itself, not a detail of how it is reached.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// the stores paint the theme and read localStorage as they evaluate; bun has
// neither (the same shim as checks.test.ts, kept identical so one fix serves
// every store test)
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
for (const k of ["window", "localStorage", "document"].filter((n) => !(n in globalThis))) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });
}

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

const { mockIPC } = await import("@tauri-apps/api/mocks");

/** every session id the backend was handed, in order, with the command */
const sent: { cmd: string; sessionId: string }[] = [];
/** every profile a handshake was opened for: a heal may rebuild what it was
 * asked to heal and nothing else */
const connects: string[] = [];
let connSeq = 0;
/** how many of the next insert_row calls answer with the backend's NoSession */
let refusals = 0;

mockIPC((cmd, payload) => {
  const a = (payload ?? {}) as Record<string, unknown>;
  if (typeof a.sessionId === "string") sent.push({ cmd, sessionId: a.sessionId });
  switch (cmd) {
    case "connect":
      connects.push(String(a.profileId));
      return `s${++connSeq}`;
    case "session_probe":
      return true;
    case "insert_row":
      if (refusals > 0) {
        refusals--;
        throw new Error("no such session");
      }
      return { statements: [] };
    default:
      return undefined;
  }
});

const {
  afterHeal,
  humanCloseReason,
  humanSessionError,
  isDeathStrip,
  isSessionDeath,
  liveSessionFor,
  withLiveSession,
} = await import("../liveSession");
const { useConnections } = await import("../connections");
const { useResults } = await import("../results");
const { useBrowser } = await import("../browser");
const { useEdits } = await import("../edits");
const { useTabs } = await import("../tabs");
const ipc = await import("../../ipc/commands");
type TableInfo = import("../schema").TableInfo;

type ResultsTab = (typeof useResults)["getState"] extends () => { byTab: Record<string, infer T> }
  ? T
  : never;
type BrowseTab = (typeof useBrowser)["getState"] extends () => { byTab: Record<string, infer T> }
  ? T
  : never;

const resultsTab = (over: Partial<ResultsTab> = {}): ResultsTab =>
  ({
    statements: [],
    activeStatement: 0,
    running: false,
    cancelling: false,
    connecting: false,
    totalMs: null,
    executedSql: "SELECT * FROM users",
    executedOffset: 0,
    notices: [],
    executedSessionId: "A",
    executedProfileId: "p1",
    globalError: null,
    ...over,
  }) as ResultsTab;

const browseTab = (over: Partial<BrowseTab> = {}): BrowseTab =>
  ({
    tab: "data",
    filters: [],
    whereMode: "builder",
    rawWhere: "",
    sortChain: [],
    sort: null,
    limit: 1000,
    jumpOffset: 0,
    draftRow: null,
    draftError: null,
    pinnedKeys: null,
    pageStale: false,
    paginationBroken: null,
    exactCount: null,
    counting: false,
    countError: null,
    ...over,
  }) as BrowseTab;

const users: TableInfo = {
  table_oid: 1,
  schema: "public",
  name: "users",
  kind: "r",
  // one real column, so a draft can be staged and commitDraft can write the
  // strip the user actually sees (a hand-set draftError tests the test)
  columns: [{ name: "name", attnum: 1, type: "text", type_oid: 25, not_null: false, default: null }],
  pk: ["id"],
};

/** the strip a dead session leaves behind, as browser.ts's own catch writes it */
const DEATH_STRIP = "couldn't load more rows: connection to this tab was lost. Refresh to reconnect";
const LOST = "connection to this tab was lost. Refresh to reconnect";

/** the add-row a user reaches for, as the store runs it: a staged draft on
 * the active browse tab, committed through the store's own writer */
async function commitADraft(over: Partial<BrowseTab> = {}) {
  const t = browseTab({ draftRow: { name: { text: "ada" } }, ...over });
  useBrowser.setState({ byTab: { t1: t }, active: "t1", table: users, ...t });
  await useBrowser.getState().commitDraft();
}

/** let the fire-and-forget chains (dynamic imports, replenish) settle */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

/** one connected profile, one browse tab stamped with the session it ran on */
function seed(opts: { tabSessions?: Record<string, string>; inTx?: boolean } = {}) {
  useConnections.setState({
    profiles: [],
    sessions: { p1: "primary" },
    tabSessions: opts.tabSessions ?? { "p1::t1": "A" },
    txTabs: opts.inTx ? { "p1::t1": true } : {},
    writeTabs: {},
    connState: { p1: "connected" },
    activeProfileId: "p1",
    error: null,
    errorProfileId: null,
    closedToast: null,
  });
  const t1 = resultsTab();
  useResults.setState({ byTab: { t1 }, active: "t1", ...t1 });
  useBrowser.setState({ byTab: { t1: browseTab() }, active: "", table: users });
  useEdits.setState({ active: "t1", lastError: null });
  useTabs.setState({ activeId: "t1" });
}

beforeEach(() => {
  sent.length = 0;
  connects.length = 0;
  refusals = 0;
  connSeq = 0;
  seed();
});

// ---- (a) death clears the stamp, and only the stamp that named it ---------

describe("a forgotten session", () => {
  test("nulls the stamp on the matching tab only", () => {
    seed({ tabSessions: { "p1::t1": "A", "p1::t2": "B" } });
    useResults.setState({
      byTab: { t1: resultsTab(), t2: resultsTab({ executedSessionId: "B" }) },
    });

    useConnections.getState().markDisconnected("p1", "A", null);

    const { byTab } = useResults.getState();
    expect(byTab.t1.executedSessionId).toBeNull();
    expect(byTab.t2.executedSessionId).toBe("B");
    // the active mirror follows its own tab
    expect(useResults.getState().executedSessionId).toBeNull();
    // the data the session produced is real and stays
    expect(byTab.t1.executedSql).toBe("SELECT * FROM users");
    expect(byTab.t1.executedProfileId).toBe("p1");
  });
});

// ---- (b) the one resolver -------------------------------------------------

describe("liveSessionFor", () => {
  test("hands back the same session, unrebuilt, when it is still live", async () => {
    const live = await liveSessionFor("t1");
    expect(live).toEqual({ sid: "A", rebuilt: null });
  });

  test("re-stamps a rebuilt session and reports it as informational", async () => {
    useConnections.getState().markDisconnected("p1", "A", null);
    const live = await liveSessionFor("t1");
    expect(live?.rebuilt).toBe("info");
    expect(live?.sid).not.toBe("A");
    // pg-notice routes on the stamp: the new session has to wear it
    expect(useResults.getState().byTab.t1.executedSessionId).toBe(live!.sid);
    expect(useResults.getState().executedSessionId).toBe(live!.sid);
  });

  test("reports a session that died holding a transaction as tx", async () => {
    seed({ inTx: true });
    useConnections.getState().markDisconnected("p1", "A", null);
    const live = await liveSessionFor("t1");
    expect(live?.rebuilt).toBe("tx");
  });

  test("is null when the tab never ran, so nothing can be sent for it", async () => {
    useResults.setState({ byTab: { t1: resultsTab({ executedProfileId: null }) } });
    expect(await liveSessionFor("t1")).toBeNull();
  });
});

// ---- (c) no forgotten id ever leaves the app ------------------------------

describe("withLiveSession", () => {
  test("sends on the live session and never on a forgotten one", async () => {
    useConnections.getState().markDisconnected("p1", "A", null);
    await withLiveSession("t1", (sid) => ipc.insertRow(sid, "public", "users", ["a"], ["1"]));
    const inserts = sent.filter((s) => s.cmd === "insert_row");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sessionId).not.toBe("A");
  });

  test("a NoSession answer costs exactly one re-resolve and one retry", async () => {
    refusals = 1;
    await withLiveSession("t1", (sid) => ipc.insertRow(sid, "public", "users", ["a"], ["1"]));
    const inserts = sent.filter((s) => s.cmd === "insert_row").map((s) => s.sessionId);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toBe("A");
    expect(inserts[1]).not.toBe("A");
    // the refused handle is forgotten, not merely skipped
    expect(Object.values(useConnections.getState().tabSessions)).not.toContain("A");
  });

  test("a second NoSession rejects in the register a reader can act on", async () => {
    refusals = 2;
    const err = await withLiveSession("t1", (sid) =>
      ipc.insertRow(sid, "public", "users", ["a"], ["1"]),
    ).then(() => ({ message: "" }), (e: unknown) => e as { message: string });
    expect(err.message).toBe(LOST);
    // never a third attempt on a connection that answered twice
    expect(sent.filter((s) => s.cmd === "insert_row")).toHaveLength(2);
  });

  test("passes a real database error through untouched", async () => {
    const err = await withLiveSession("t1", () =>
      Promise.reject({ message: 'syntax error at or near "slect"', code: "42601" }),
    ).catch((e: unknown) => e as { message: string; code: string });
    expect(err.message).toBe('syntax error at or near "slect"');
    expect(err.code).toBe("42601");
  });
});

// ---- (d) heal re-stamps, and takes down only what death wrote ------------

describe("afterHeal", () => {
  test("clears death strips, keeps real errors, re-stamps the active tab", async () => {
    seed({ tabSessions: { "p1::t1": "A", "p1::t2": "B" } });
    useResults.setState({
      byTab: {
        t1: resultsTab({ globalError: { message: DEATH_STRIP, position: null, code: null } }),
        t2: resultsTab({
          executedSessionId: "B",
          globalError: {
            message: 'syntax error at or near "slect"',
            position: 1,
            code: "42601",
          },
        }),
        // the user's own news, wearing the death class's words: a table named
        // connection_log, a constraint named connections_pkey below
        t3: resultsTab({
          executedSessionId: "B",
          globalError: {
            message: 'relation "connection_log" does not exist',
            position: 15,
            code: "42P01",
          },
        }),
      },
      active: "t1",
    });
    useBrowser.setState({
      byTab: {
        t1: browseTab({ draftError: LOST, paginationBroken: DEATH_STRIP }),
        t2: browseTab({
          draftError: 'duplicate key value violates unique constraint "connections_pkey"',
        }),
        t3: browseTab({ countError: "count returned nothing" }),
      },
      active: "",
    });
    useEdits.setState({ active: "t1", lastError: LOST });
    useConnections.getState().markDisconnected("p1", "A", null);

    await afterHeal("p1");

    const res = useResults.getState().byTab;
    expect(res.t1.globalError).toBeNull();
    expect(res.t2.globalError?.code).toBe("42601");
    expect(res.t3.globalError?.message).toBe('relation "connection_log" does not exist');
    const br = useBrowser.getState().byTab;
    expect(br.t1.draftError).toBeNull();
    expect(br.t1.paginationBroken).toBeNull();
    expect(br.t2.draftError).toBe(
      'duplicate key value violates unique constraint "connections_pkey"',
    );
    expect(br.t3.countError).toBe("count returned nothing");
    expect(useEdits.getState().lastError).toBeNull();
    // the gesture's other half: the tab can be sent on again
    expect(res.t1.executedSessionId).not.toBeNull();
    expect(res.t1.executedSessionId).not.toBe("A");
  });

  test("leaves a tab of another profile alone, and never connects it", async () => {
    // the rail is on p1 while the active tab still shows the result it ran on
    // p2, and p2 has no primary. Re-resolving THAT tab would hand p2 to
    // ensureTabSession, which connects a missing primary and takes the rail
    // with it: a heal opening a connection the user closed (heal.ts:34)
    useResults.setState({
      byTab: {
        t1: resultsTab({
          executedProfileId: "p2",
          globalError: { message: DEATH_STRIP, position: null, code: null },
        }),
      },
      active: "t1",
    });
    await afterHeal("p1");
    await settle();
    expect(connects).not.toContain("p2");
    expect(useConnections.getState().activeProfileId).toBe("p1");
    expect(useResults.getState().byTab.t1.globalError?.message).toBe(DEATH_STRIP);
  });
});

// ---- (e) the ten-minute death is named ----------------------------------

describe("humanCloseReason", () => {
  test("names PG's idle-in-transaction kill, and what it cost", () => {
    expect(humanCloseReason("terminating connection due to idle-in-transaction timeout")).toBe(
      "transaction expired after 10 minutes idle. Uncommitted changes on that tab were rolled back",
    );
  });

  test("passes every other reason through as the driver wrote it", () => {
    for (const r of ["connection closed by server", "SSL connection has been closed unexpectedly"]) {
      expect(humanCloseReason(r)).toBe(r);
    }
  });
});

// ---- (f) one death-class matcher, covering both regexes it replaced ------

describe("isSessionDeath", () => {
  test("matches every phrase the two reaping regexes matched", () => {
    for (const m of [
      "connection closed by server",
      "error communicating with the server",
      "broken pipe",
      "connection reset by peer",
      "terminating connection due to administrator command",
      "no such session",
      "Connection Closed", // the old test lowercased first
    ]) {
      expect(isSessionDeath(m)).toBe(true);
    }
  });

  test("leaves a real database error alone", () => {
    for (const m of [
      'syntax error at or near "slect"',
      'duplicate key value violates unique constraint "users_pkey"',
      "0 rows",
      null,
    ]) {
      expect(isSessionDeath(m)).toBe(false);
    }
  });
});

// ---- what a heal may erase: stricter than the net it reaps with ---------

describe("isDeathStrip", () => {
  test("takes down what a dead transport wrote, whoever wrote it", () => {
    for (const m of [
      LOST,
      DEATH_STRIP,
      "origin connection not available",
      "no live connection",
      "connection closed by server",
      "SSL connection has been closed unexpectedly",
      "error communicating with the server",
      "connection reset by peer",
      "broken pipe",
      "no such session",
    ]) {
      expect(isDeathStrip(m)).toBe(true);
    }
    // PG's own kills carry the class in the SQLSTATE as well as the text
    expect(isDeathStrip("terminating connection due to administrator command", "57P01")).toBe(true);
    expect(isDeathStrip("terminating connection due to idle-in-transaction timeout", "25P03")).toBe(
      true,
    );
  });

  test("leaves news that merely spells a connection", () => {
    const strips: [string, string | null][] = [
      // what the maintainer would be reading when he pressed ⇧⌘R
      ['duplicate key value violates unique constraint "connections_pkey"', null],
      ['duplicate key value violates unique constraint "connections_pkey"', "23505"],
      ['relation "connection_log" does not exist', "42P01"],
      ['column "reset_at" does not exist', "42703"],
      ["count returned nothing", null],
      ["required (NOT NULL, no default): email", null],
      ['syntax error at or near "slect"', "42601"],
    ];
    for (const [m, code] of strips) expect(isDeathStrip(m, code)).toBe(false);
  });
});

// ---- rule 4: the backend's word never reaches a reader -------------------

describe("humanSessionError", () => {
  test("rewrites the backend's internal phrase and nothing else", () => {
    expect(humanSessionError(new Error("no such session")).message).toBe(LOST);
    expect(humanSessionError({ message: "no such session: 7f3", code: null }).message).toBe(LOST);
    const real = humanSessionError({
      message: 'null value in column "email" violates not-null constraint',
      code: "23502",
      detail: "Failing row contains (4, null).",
    });
    expect(real.message).toBe('null value in column "email" violates not-null constraint');
    expect(real.code).toBe("23502");
    expect(real.detail).toBe("Failing row contains (4, null).");
  });

  test("the literal never appears in any string the app renders", async () => {
    refusals = 2;
    const strips: string[] = [];
    const bad = await withLiveSession("t1", (sid) =>
      ipc.insertRow(sid, "public", "users", ["a"], ["1"]),
    ).then(() => ({ message: "" }), (e: unknown) => e as { message: string });
    strips.push(bad.message, humanSessionError(new Error("no such session")).message);

    // the add-row strip as the store writes it, not as a test imagines it
    refusals = 2;
    await commitADraft();
    await settle();
    const b = useBrowser.getState().byTab.t1;
    strips.push(b.draftError ?? "", b.paginationBroken ?? "", b.countError ?? "");
    strips.push(useResults.getState().byTab.t1.globalError?.message ?? "");
    strips.push(useEdits.getState().lastError ?? "");

    for (const s of strips) expect(s).not.toContain("no such session");
    expect(strips).toContain(LOST);
  });
});

// ---- (g) the maintainer's story, end to end -----------------------------

describe("a tab session dies while the profile lives", () => {
  test("the dot stays green, the next write goes to the rebuilt session, ⇧⌘R clears the strip", async () => {
    // the tab session's own idle-in-transaction kill: one session-closed
    // event, for a session that is NOT the profile's primary
    useConnections
      .getState()
      .markDisconnected("p1", "A", "terminating connection due to idle-in-transaction timeout");

    expect(useConnections.getState().connState.p1).toBe("connected");
    expect(useResults.getState().byTab.t1.executedSessionId).toBeNull();
    // the toast says what the ten minutes cost, not what the driver called it
    expect(humanCloseReason(useConnections.getState().closedToast!.reason)).toContain(
      "10 minutes idle",
    );

    // the add-row the user reaches for next
    const out = await useBrowser.getState().insertRow(["name"], ["ada"], "t1", users);
    expect(out.ok).toBe(true);
    const inserts = sent.filter((s) => s.cmd === "insert_row");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sessionId).not.toBe("A");
    expect(inserts[0].sessionId).toBe(useConnections.getState().tabSessions["p1::t1"]);

    // and the strips a reader is left with: the add-row the store itself
    // refuses when the rebuilt session dies too, beside the older pagination
    // failure and the run banner under it
    refusals = 2;
    await commitADraft({ paginationBroken: DEATH_STRIP });
    expect(useBrowser.getState().byTab.t1.draftError).toBe(LOST);
    useResults.setState((s) => ({
      byTab: {
        ...s.byTab,
        t1: { ...s.byTab.t1, globalError: { message: DEATH_STRIP, position: null, code: null } },
      },
    }));

    await useConnections.getState().healProfile("p1");
    await settle();

    expect(useBrowser.getState().byTab.t1.draftError).toBeNull();
    expect(useBrowser.getState().byTab.t1.paginationBroken).toBeNull();
    expect(useResults.getState().byTab.t1.globalError).toBeNull();
  });
});
