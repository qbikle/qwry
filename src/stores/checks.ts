// Checks (A2 item 6b): a saved query that also says what it expects. There is
// no checks panel and no schedule. A check is a bookmark with an expectation
// on it, `Run Checks` runs every one the connection has through the agent's
// own read-only gate, and the verdict is a dot on the saved row.
//
// The expectation and the last verdict ride as JSON on the saved query, so
// both are written here and read here (LESSONS 1): `writeExpect`/`checkOf` and
// `writeResult`/`lastCheckOf` are pairs, and a blob this build cannot read
// makes the row an ordinary bookmark rather than a check nobody can explain.

import { agentConnect, agentRunReadonly, disconnect } from "../ipc/commands";
import type { AgentRun } from "../ipc/types";
import { RUN_SQL_TIMEOUT_MS, UI_ROW_CAP } from "../agent/tools";
import { useSaved, visibleSaved, type SavedQuery } from "./saved";

/** What a check asserts. `rows` counts what came back, `scalar` reads the one
 * cell a 1x1 result carries, `nonempty` asks only that something did. */
export type CheckExpect =
  | { kind: "rows"; op: "eq" | "gte" | "lte"; n: number }
  | { kind: "scalar"; eq: string }
  | { kind: "nonempty" };

/** What the last run found. `scalar` is absent when the result was not one
 * cell and null when that cell was SQL NULL; `error` carries the run's own
 * failure, which is a failed check and never a silent pass. */
export interface CheckResult {
  ok: boolean;
  rows: number;
  scalar?: string | null;
  at: string;
  error?: string | null;
}

/** What a run landed: every check of the connection, and the ones that did
 * not pass. Read once, at the seam where it arrives (LESSONS 13). */
export interface CheckTally {
  total: number;
  failed: number;
}

const OPS = new Set(["eq", "gte", "lte"]);

export function writeExpect(expect: CheckExpect): string {
  return JSON.stringify(expect);
}

/** The expectation on a saved query, or null when it has none. Null too for
 * anything this build cannot read: an unreadable blob leaves an ordinary
 * bookmark, not a check that fails for reasons nobody can see. */
export function checkOf(q: SavedQuery): CheckExpect | null {
  const o = parse(q.expect_json);
  if (!o) return null;
  if (o.kind === "rows" && typeof o.op === "string" && OPS.has(o.op) && typeof o.n === "number") {
    return { kind: "rows", op: o.op as "eq" | "gte" | "lte", n: o.n };
  }
  if (o.kind === "scalar" && typeof o.eq === "string") return { kind: "scalar", eq: o.eq };
  if (o.kind === "nonempty") return { kind: "nonempty" };
  return null;
}

export function writeResult(result: CheckResult): string {
  return JSON.stringify(result);
}

/** What the last run of this check found, or null before it has run once. */
export function lastCheckOf(q: SavedQuery): CheckResult | null {
  const o = parse(q.last_check_json);
  if (!o || typeof o.ok !== "boolean" || typeof o.rows !== "number" || typeof o.at !== "string") {
    return null;
  }
  const out: CheckResult = { ok: o.ok, rows: o.rows, at: o.at };
  if (o.scalar === null || typeof o.scalar === "string") out.scalar = o.scalar;
  if (typeof o.error === "string") out.error = o.error;
  return out;
}

function parse(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The one cell a 1x1 result carries; undefined when the result is not one
 * cell, null when that cell holds SQL NULL. */
function cellOf(run: AgentRun): string | null | undefined {
  return run.row_count === 1 && run.columns.length === 1 ? run.rows[0]?.[0] : undefined;
}

/** The expectation `Expect Current Shape` records, read off one run: one cell
 * is a scalar to match, a countable result is that count, and a result past
 * the row cap is only ever asked to have something in it, because an exact
 * count nobody could see is a check that fails on a good day. */
export function shapeOf(run: AgentRun): CheckExpect {
  const cell = cellOf(run);
  if (typeof cell === "string") return { kind: "scalar", eq: cell };
  if (run.capped) return { kind: "nonempty" };
  return { kind: "rows", op: "eq", n: run.row_count };
}

/** Judge one run against one expectation. `at` is stamped by the caller, so a
 * whole run of checks reads as one moment. */
export function verdict(expect: CheckExpect, run: AgentRun, at: string): CheckResult {
  const cell = cellOf(run);
  const out: CheckResult = { ok: false, rows: run.row_count, at };
  if (cell !== undefined) out.scalar = cell;
  if (expect.kind === "rows") {
    out.ok =
      expect.op === "eq"
        ? run.row_count === expect.n
        : expect.op === "gte"
          ? run.row_count >= expect.n
          : run.row_count <= expect.n;
  } else if (expect.kind === "scalar") {
    out.ok = cell === expect.eq;
  } else {
    out.ok = run.row_count > 0;
  }
  return out;
}

const rowsText = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;

/** What a FAILED row says: what the query holds now and what the check wanted,
 * in the status register. A passing row says nothing more than its dot, so
 * this is empty for one (DESIGN rule 11: the exception speaks). */
export function driftLabel(q: SavedQuery): string {
  const expect = checkOf(q);
  const result = lastCheckOf(q);
  if (!expect || !result || result.ok) return "";
  if (result.error) return result.error;
  if (expect.kind === "rows") {
    const want =
      expect.op === "eq" ? `${expect.n}` : `${expect.op === "gte" ? "≥" : "≤"} ${expect.n}`;
    return `${rowsText(result.rows)} · expected ${want}`;
  }
  if (expect.kind === "scalar") {
    return result.scalar === undefined
      ? `${rowsText(result.rows)} · expected ${expect.eq}`
      : `${result.scalar ?? "NULL"} · expected ${expect.eq}`;
  }
  return `${rowsText(result.rows)} · expected some`;
}

/** The seam the tests stand in: everything a check run needs from outside. */
export const runner = {
  connect: agentConnect,
  disconnect,
  run: agentRunReadonly,
  timeoutMs: async () => {
    const { useSettings } = await import("./settings");
    const ms = useSettings.getState().statementTimeoutSecs * 1000;
    return ms > 0 ? ms : RUN_SQL_TIMEOUT_MS;
  },
};

/** A read-only session for the length of one run, then gone. Checks do not
 * borrow an Ask thread's session: a thread holds ONE connection (AGENT-SPEC
 * section 2.3), and a check landing on it mid-exchange would be two
 * statements on one connection. */
async function withSession<T>(profileId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
  const sessionId = await runner.connect(profileId);
  try {
    return await fn(sessionId);
  } finally {
    await runner.disconnect(sessionId).catch(() => {});
  }
}

const firstLine = (e: unknown) => String((e as { message?: string })?.message ?? e).split("\n")[0];

/** connections with a run in flight: `Run Checks` is one at a time */
const running = new Set<string>();

/** the tally these rows carry from their last run */
const standing = (checks: SavedQuery[]): CheckTally => ({
  total: checks.length,
  failed: checks.filter((q) => lastCheckOf(q)?.ok === false).length,
});

/** Run every check of a connection and store each verdict. Returns the tally
 * the toast prints, counted here rather than re-derived downstream. */
export async function runChecks(profileId: string): Promise<CheckTally> {
  // the rows and the connection are read before the first await (LESSONS 3): a
  // run reports on the checks it was started for
  const checks = visibleSaved(useSaved.getState().queries, profileId).filter((q) => checkOf(q));
  // a run already in flight is not this call's to report on: hand back what
  // stands rather than an invented zero (LESSONS 9)
  if (!checks.length || running.has(profileId)) return standing(checks);
  running.add(profileId);
  const at = new Date().toISOString();
  let failed = 0;
  try {
    const timeoutMs = await runner.timeoutMs();
    await withSession(profileId, async (sessionId) => {
      for (const q of checks) {
        const expect = checkOf(q);
        if (!expect) continue;
        let result: CheckResult;
        try {
          const run = await runner.run(sessionId, q.sql, UI_ROW_CAP, timeoutMs);
          result = verdict(expect, run, at);
        } catch (e) {
          // a check that cannot run has not passed: the gate refused it, the
          // column it counted is gone, or the statement timed out
          result = { ok: false, rows: 0, at, error: firstLine(e) };
        }
        if (!result.ok) failed += 1;
        await useSaved.getState().upsert({ ...q, last_check_json: writeResult(result) });
      }
    });
  } finally {
    running.delete(profileId);
  }
  return { total: checks.length, failed };
}

/** `Expect Current Shape`: record what this query returns now as what it
 * should return. The shape it was just seen in is a passing verdict, so the
 * row wears its dot from the moment it becomes a check. */
export async function expectCurrentShape(
  profileId: string,
  savedId: string,
): Promise<CheckExpect | null> {
  const q = useSaved.getState().queries.find((x) => x.id === savedId);
  if (!q) return null;
  const timeoutMs = await runner.timeoutMs();
  const run = await withSession(profileId, (sessionId) =>
    runner.run(sessionId, q.sql, UI_ROW_CAP, timeoutMs),
  );
  const expect = shapeOf(run);
  await useSaved.getState().upsert({
    ...q,
    expect_json: writeExpect(expect),
    last_check_json: writeResult(verdict(expect, run, new Date().toISOString())),
  });
  return expect;
}

/** `Remove Check`: the row goes back to being an ordinary bookmark, its last
 * verdict with it. */
export async function removeCheck(savedId: string): Promise<void> {
  const q = useSaved.getState().queries.find((x) => x.id === savedId);
  if (!q) return;
  await useSaved.getState().upsert({ ...q, expect_json: null, last_check_json: null });
}
