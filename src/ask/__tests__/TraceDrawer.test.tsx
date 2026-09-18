// The trace drawer's row KEYS (E5b, from E4's own open list). One exchange can
// carry two `closing-fence` steps: the loop runs a fence the model left, the
// gate refuses it, one `repairMessage` goes back and the second attempt fails
// too (AGENT-SPEC 4.6). Both steps keep that id, deliberately — `persist`
// filters on it exactly and the row's own label reads it — so the id cannot be
// the React key: under one key React renders one row, the drawer warns, and
// the two rows expand and collapse as a pair. The rows are keyed by POSITION,
// and what this file pins is that every key in a drawer is its own.
//
// Rendered to static markup (AnswerText.test's own seam): the keys are in the
// DOM as `data-step`, and `expanded` is a Set of exactly those strings, so two
// distinct keys ARE two independently expandable rows.

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// the drawer reaches the ask store, which touches `document` and localStorage
// at import; bun has neither (the store tests' own shim)
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
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const { mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { CLOSING_FENCE } = await import("../../agent/loop");
const { TraceDrawer } = await import("../TraceDrawer");
type Exchange = import("../../stores/agent").Exchange;
type TraceStep = import("../../agent/types").TraceStep;

const fence = (ms: number, result: string): TraceStep => ({
  step: "tool",
  ms,
  id: CLOSING_FENCE,
  name: "run_sql",
  args: JSON.stringify({ sql: "SELECT count(*) FROM order_v2" }),
  result,
  isError: true,
});

/** the repaired-then-failed exchange: one turn, its fence run, the repair, the
 * second fence, the verdict */
const TRACE: TraceStep[] = [
  { step: "context", ms: 12, candidates: ["order_v2"], text: "TABLES: order_v2" } as TraceStep,
  { step: "turn", ms: 900, index: 0, text: "```sql\nSELECT count(*) FROM order_v2\n```", thinking: "" } as TraceStep,
  fence(41, "column does not exist"),
  { step: "turn", ms: 700, index: 1, text: "```sql\nSELECT count(*) FROM order_v2\n```", thinking: "" } as TraceStep,
  fence(38, "column does not exist"),
  { step: "verdict", ms: 1700, verdict: { status: "failed", message: "column does not exist", sql: "SELECT 1" } } as TraceStep,
];

const exchange = (): Exchange =>
  ({
    id: "ex-1",
    question: "how many orders are there",
    text: "",
    thinking: "",
    chips: [],
    streaming: false,
    status: "failed",
    provider: "anthropic",
    model: "claude-sonnet-5",
    answer: {
      text: "",
      sql: "SELECT 1",
      run: null,
      assumptions: [],
      sanity: [],
      trace: TRACE,
      turns: 2,
      ms: 1700,
      risky: false,
    },
  }) as unknown as Exchange;

const keysOf = (html: string): string[] =>
  [...html.matchAll(/data-step="([^"]+)"/g)].map((m) => m[1]);

describe("the trace drawer's row keys", () => {
  const html = renderToStaticMarkup(
    <TraceDrawer open exchange={exchange()} focusStepId={null} onClose={() => {}} />,
  );

  test("two closing-fence steps are two rows, each with its own key", () => {
    expect(html.match(/closing fence/g)).toHaveLength(2);
    const fences = keysOf(html).filter((k) => k.startsWith("tool:"));
    expect(fences).toHaveLength(2);
    expect(fences[0]).not.toBe(fences[1]);
  });

  test("every row in the drawer carries a key of its own", () => {
    const keys = keysOf(html);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("each row opens on its own control, so one press opens one body", () => {
    // `expanded` holds row keys and `toggle` writes one; two keys are two
    // members of that set, which is what makes the second row's aria-expanded
    // independent of the first's
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(6);
    expect(html).not.toContain("trace-step expanded");
  });
});
