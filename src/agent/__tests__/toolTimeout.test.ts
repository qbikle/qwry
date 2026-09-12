// The statement_timeout a tool call carries (AGENT-SPEC 5 and 8.2). The
// setting's 0 means "no timeout" for a SESSION (ipc/commands.ts connect);
// agent.rs clamps a tool timeout to a one-second FLOOR, so 0 has to fall
// through to the section 5 default here — arriving as 0 would hand the
// tightest timeout in the app to whoever switched the timeout off. The seam
// is Tauri's own mock transport, so what is asserted is the payload Rust
// would have received.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import snapshotJson from "./fixtures/pagila-snapshot.json";
import type { SchemaSnapshot } from "../../stores/schema";

// settings.ts paints the theme onto the document at import and persists
// through localStorage; bun has neither
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
// bun shares one global scope across files and every file that shims it also
// tears its own shims down, so install what is missing at import AND before
// each test, and take back exactly what this file put there
const STANDINS: Record<string, unknown> = {
  window: globalThis,
  localStorage: storage,
  document: inert,
};
const shimmed = new Set<string>();
function shim() {
  for (const [k, value] of Object.entries(STANDINS)) {
    if (k in globalThis) continue;
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
    shimmed.add(k);
  }
}
shim();

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { createTauriTools } = await import("../tools.tauri");
const { RUN_SQL_TIMEOUT_MS } = await import("../tools");
const { useSettings } = await import("../../stores/settings");

const snapshot = snapshotJson as unknown as SchemaSnapshot;
const realTimeout = useSettings.getState().statementTimeoutSecs;

afterAll(() => {
  useSettings.getState().setStatementTimeoutSecs(realTimeout);
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

let sent: Record<string, unknown> = {};
beforeEach(() => {
  shim();
  sent = {};
  mockIPC((cmd, payload) => {
    if (cmd !== "agent_run_readonly") throw new Error(`no backend in this test: ${cmd}`);
    sent = (payload ?? {}) as Record<string, unknown>;
    return { columns: ["n"], rows: [["1"]], row_count: 1, capped: false, ms: 1 };
  });
});

/** the timeout the tool put on the wire for one run_sql */
async function timeoutOf(secs: number, timeoutMs?: number): Promise<unknown> {
  useSettings.getState().setStatementTimeoutSecs(secs);
  const tools = createTauriTools({ sessionId: "s1", snapshot, timeoutMs });
  await tools.runSql("SELECT 1");
  return sent.timeoutMs;
}

describe("run_sql statement_timeout", () => {
  test("the setting travels in milliseconds", async () => {
    expect(await timeoutOf(30)).toBe(30_000);
  });

  test("timeout switched off falls to the section 5 default, not the floor", async () => {
    expect(await timeoutOf(0)).toBe(RUN_SQL_TIMEOUT_MS);
    expect(RUN_SQL_TIMEOUT_MS).toBe(10_000);
  });

  test("an explicit override wins, and its own 0 falls through too", async () => {
    expect(await timeoutOf(300, 2_000)).toBe(2_000);
    expect(await timeoutOf(300, 0)).toBe(RUN_SQL_TIMEOUT_MS);
  });
});
