// Checks (A2 item 6b): a saved query that also says what it expects. The
// shapes are stored as JSON on the bookmark, so read and write are a pair
// (LESSONS 1) and a blob this build cannot read leaves an ordinary bookmark
// rather than a check that fails for reasons nobody can see.
//
// The session and the run come through the store's `runner` seam, so a whole
// Run Checks is driven here without a database; the bookmarks themselves go
// through Tauri's own mock transport, which is what appdb would hold.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRun } from "../../ipc/types";

// checks.ts imports the ipc bridge, which pulls in settings.ts and paints the
// theme onto the document as it evaluates; bun has no window, storage or
// document, so stand-ins go in first and leave again after (bun test shares
// one global scope across files)
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
const {
  checkOf,
  driftLabel,
  expectCurrentShape,
  lastCheckOf,
  removeCheck,
  runChecks,
  runner,
  shapeOf,
  verdict,
  writeExpect,
  writeResult,
} = await import("../checks");
const { useSaved } = await import("../saved");
type SavedQuery = import("../saved").SavedQuery;
type CheckExpect = import("../checks").CheckExpect;

const realRunner = { ...runner };
afterAll(() => {
  clearMocks();
  Object.assign(runner, realRunner);
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

const run = (rows: (string | null)[][], columns = ["n"], capped = false): AgentRun => ({
  columns,
  rows,
  row_count: rows.length,
  capped,
  ms: 1,
});

/** the bookmarks appdb holds */
let stored: SavedQuery[] = [];
/** the SQL each session was asked to run, in order */
let ran: string[] = [];
let opened = 0;
let closed = 0;

const bookmark = (q: Partial<SavedQuery> & { id: string }): SavedQuery => ({
  name: q.id,
  sql: `SELECT ${q.id}`,
  profile_id: "p1",
  ...q,
});

beforeEach(() => {
  stored = [];
  ran = [];
  opened = 0;
  closed = 0;
  useSaved.setState({ queries: [] });
  mockIPC((cmd, args) => {
    const a = args as Record<string, never>;
    if (cmd === "saved_list") return stored;
    if (cmd === "saved_upsert") {
      const q = a.q as unknown as SavedQuery;
      const at = stored.findIndex((x) => x.id === q.id);
      if (at >= 0) stored[at] = q;
      else stored.push(q);
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  Object.assign(runner, {
    timeoutMs: async () => 10_000,
    connect: async () => {
      opened += 1;
      return "sess-1";
    },
    disconnect: async () => {
      closed += 1;
    },
    run: async (_s: string, sql: string) => {
      ran.push(sql);
      return run([["1"]]);
    },
  });
});

const seed = async (rows: SavedQuery[]) => {
  stored = [...rows];
  await useSaved.getState().load();
};
const held = (id: string) => useSaved.getState().queries.find((q) => q.id === id) as SavedQuery;

describe("the expectation a shape records", () => {
  test("one cell is a scalar to match", () => {
    expect(shapeOf(run([["7"]]))).toEqual({ kind: "scalar", eq: "7" });
  });

  test("a countable result is that count", () => {
    expect(shapeOf(run([["a"], ["b"]], ["x"]))).toEqual({ kind: "rows", op: "eq", n: 2 });
    expect(shapeOf(run([]))).toEqual({ kind: "rows", op: "eq", n: 0 });
  });

  test("a result past the row cap is only asked to have something in it", () => {
    expect(shapeOf(run([["a"], ["b"]], ["x"], true))).toEqual({ kind: "nonempty" });
  });

  test("one cell holding NULL is a count, not a scalar nobody can match", () => {
    expect(shapeOf(run([[null]]))).toEqual({ kind: "rows", op: "eq", n: 1 });
  });
});

describe("the three expect kinds", () => {
  const at = "2026-09-06T00:00:00.000Z";
  const judge = (e: CheckExpect, r: AgentRun) => verdict(e, r, at).ok;

  test("rows: eq, gte and lte", () => {
    const twelve = run(Array.from({ length: 12 }, () => ["x"]), ["x"]);
    expect(judge({ kind: "rows", op: "eq", n: 12 }, twelve)).toBe(true);
    expect(judge({ kind: "rows", op: "eq", n: 0 }, twelve)).toBe(false);
    expect(judge({ kind: "rows", op: "gte", n: 12 }, twelve)).toBe(true);
    expect(judge({ kind: "rows", op: "gte", n: 13 }, twelve)).toBe(false);
    expect(judge({ kind: "rows", op: "lte", n: 12 }, twelve)).toBe(true);
    expect(judge({ kind: "rows", op: "lte", n: 11 }, twelve)).toBe(false);
  });

  test("scalar: the one cell, and a result that is no longer one cell fails", () => {
    expect(judge({ kind: "scalar", eq: "7" }, run([["7"]]))).toBe(true);
    expect(judge({ kind: "scalar", eq: "7" }, run([["4"]]))).toBe(false);
    expect(judge({ kind: "scalar", eq: "7" }, run([["7"], ["7"]], ["n"]))).toBe(false);
    expect(judge({ kind: "scalar", eq: "7" }, run([["7", "x"]], ["n", "m"]))).toBe(false);
  });

  test("nonempty: anything at all", () => {
    expect(judge({ kind: "nonempty" }, run([["x"]]))).toBe(true);
    expect(judge({ kind: "nonempty" }, run([]))).toBe(false);
  });

  test("the verdict carries the count and the cell the drift line prints", () => {
    const v = verdict({ kind: "scalar", eq: "7" }, run([["4"]]), at);
    expect(v).toEqual({ ok: false, rows: 1, scalar: "4", at });
  });
});

describe("what a saved query says about its check", () => {
  test("read and write are a pair", () => {
    const expects: CheckExpect[] = [
      { kind: "rows", op: "eq", n: 0 },
      { kind: "rows", op: "gte", n: 100 },
      { kind: "scalar", eq: "7" },
      { kind: "nonempty" },
    ];
    for (const e of expects) {
      expect(checkOf(bookmark({ id: "s1", expect_json: writeExpect(e) }))).toEqual(e);
    }
    const r = { ok: false, rows: 12, at: "t", error: "boom" };
    expect(lastCheckOf(bookmark({ id: "s1", last_check_json: writeResult(r) }))).toEqual(r);
  });

  test("a blob this build cannot read leaves an ordinary bookmark", () => {
    for (const blob of [null, undefined, "", "{not json", "[]", '{"kind":"rowz"}', '{"kind":"rows"}']) {
      expect(checkOf(bookmark({ id: "s1", expect_json: blob }))).toBeNull();
    }
    expect(lastCheckOf(bookmark({ id: "s1", last_check_json: '{"ok":1}' }))).toBeNull();
  });
});

describe("what a failed row says", () => {
  const drift = (expect_json: string, last_check_json: string) =>
    driftLabel(bookmark({ id: "s1", expect_json, last_check_json }));
  const found = (r: Partial<import("../checks").CheckResult>) =>
    writeResult({ ok: false, rows: 0, at: "t", ...r });

  test("the drawn four", () => {
    expect(drift(writeExpect({ kind: "rows", op: "eq", n: 0 }), found({ rows: 12 }))).toBe(
      "12 rows · expected 0",
    );
    expect(drift(writeExpect({ kind: "rows", op: "gte", n: 100 }), found({ rows: 82 }))).toBe(
      "82 rows · expected ≥ 100",
    );
    expect(drift(writeExpect({ kind: "scalar", eq: "7" }), found({ rows: 1, scalar: "4" }))).toBe(
      "4 · expected 7",
    );
    expect(drift(writeExpect({ kind: "nonempty" }), found({ rows: 0 }))).toBe(
      "0 rows · expected some",
    );
  });

  test("a count of one is a row, and a run that could not run says why", () => {
    expect(drift(writeExpect({ kind: "rows", op: "eq", n: 0 }), found({ rows: 1 }))).toBe(
      "1 row · expected 0",
    );
    expect(
      drift(writeExpect({ kind: "nonempty" }), found({ error: "column paid_at does not exist" })),
    ).toBe("column paid_at does not exist");
  });

  test("a passing row is its dot and nothing more", () => {
    expect(
      drift(writeExpect({ kind: "nonempty" }), writeResult({ ok: true, rows: 3, at: "t" })),
    ).toBe("");
  });
});

describe("runChecks", () => {
  test("runs every check of the connection and stores each verdict", async () => {
    await seed([
      bookmark({ id: "a", expect_json: writeExpect({ kind: "rows", op: "eq", n: 1 }) }),
      bookmark({ id: "b", expect_json: writeExpect({ kind: "rows", op: "eq", n: 0 }) }),
      bookmark({ id: "plain" }),
      bookmark({
        id: "elsewhere",
        profile_id: "p2",
        expect_json: writeExpect({ kind: "nonempty" }),
      }),
    ]);

    const tally = await runChecks("p1");

    expect(tally).toEqual({ total: 2, failed: 1 });
    expect(ran).toEqual(["SELECT a", "SELECT b"]);
    expect(lastCheckOf(held("a"))?.ok).toBe(true);
    expect(lastCheckOf(held("b"))).toEqual({ ok: false, rows: 1, scalar: "1", at: expect.any(String) });
    expect(driftLabel(held("b"))).toBe("1 row · expected 0");
    expect(lastCheckOf(held("plain"))).toBeNull();
    expect(lastCheckOf(held("elsewhere"))).toBeNull();
    // one session for the run, closed when it ends
    expect([opened, closed]).toEqual([1, 1]);
  });

  test("a check that cannot run has not passed", async () => {
    await seed([bookmark({ id: "a", expect_json: writeExpect({ kind: "nonempty" }) })]);
    Object.assign(runner, {
      run: async () => {
        throw new Error("column paid_at does not exist\nposition 14");
      },
    });

    const tally = await runChecks("p1");

    expect(tally).toEqual({ total: 1, failed: 1 });
    expect(lastCheckOf(held("a"))?.error).toBe("column paid_at does not exist");
    expect(driftLabel(held("a"))).toBe("column paid_at does not exist");
    // the session closes even when every check in the run fails
    expect(closed).toBe(1);
  });

  test("a connection with no check opens no session", async () => {
    await seed([bookmark({ id: "plain" })]);
    expect(await runChecks("p1")).toEqual({ total: 0, failed: 0 });
    expect(opened).toBe(0);
  });

  test("the verdicts of one run share its moment", async () => {
    await seed([
      bookmark({ id: "a", expect_json: writeExpect({ kind: "nonempty" }) }),
      bookmark({ id: "b", expect_json: writeExpect({ kind: "nonempty" }) }),
    ]);
    await runChecks("p1");
    expect(lastCheckOf(held("a"))?.at).toBe(lastCheckOf(held("b"))?.at as string);
  });
});

describe("Expect Current Shape and Remove Check", () => {
  test("records the shape it was just seen in, passing", async () => {
    await seed([bookmark({ id: "a" })]);
    Object.assign(runner, { run: async () => run([["7"]]) });

    const expected = await expectCurrentShape("p1", "a");

    expect(expected).toEqual({ kind: "scalar", eq: "7" });
    expect(checkOf(held("a"))).toEqual({ kind: "scalar", eq: "7" });
    expect(lastCheckOf(held("a"))?.ok).toBe(true);
    expect([opened, closed]).toEqual([1, 1]);
  });

  test("Remove Check takes the verdict with it", async () => {
    await seed([
      bookmark({
        id: "a",
        expect_json: writeExpect({ kind: "nonempty" }),
        last_check_json: writeResult({ ok: false, rows: 0, at: "t" }),
      }),
    ]);
    await removeCheck("a");
    expect(checkOf(held("a"))).toBeNull();
    expect(lastCheckOf(held("a"))).toBeNull();
    // the bookmark itself stands: only its expectation went
    expect(held("a").name).toBe("a");
  });

  test("a rename does not drop the question or the check on the row", async () => {
    await seed([
      bookmark({
        id: "a",
        question: "which orders are unpaid?",
        expect_json: writeExpect({ kind: "nonempty" }),
      }),
    ]);
    await useSaved.getState().rename("a", "Unpaid orders");
    expect(held("a").name).toBe("Unpaid orders");
    expect(held("a").question).toBe("which orders are unpaid?");
    expect(checkOf(held("a"))).toEqual({ kind: "nonempty" });
  });
});
