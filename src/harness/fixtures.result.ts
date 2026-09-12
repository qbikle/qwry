// Result-block fixtures for the Ask harness (W7 item 1, the "W7 · consolidate"
// rows of ask-sketch-v2.html): one block with two faces where the grid and
// the collapsed SQL row used to be, its Copy · Flip · Insert cluster floating
// at the top-right, and the turn cap's new Continue.
//
//   result-table    the sketch's W5 orders exchange with the block hot: the
//                   nine-row grid under the cluster, `9 rows · 412.6 ms`
//                   under the block, and no SQL row anywhere below it
//   result-sql      the same exchange flipped to the SQL face (through the
//                   store's own door, useAsk.setFace, after mount): the
//                   editor register wrapped at the floor, the flip's glyph
//                   now the table, the status line unmoved
//   result-scalar   a one-row run (`217` · `first_time_customers`) inside the
//                   block with its 8 / 12 padding, hot: a box around a value
//                   is not a table around a value
//   failure-cap     the turn cap with a statement tried: `stopped after 12
//                   turns`, Insert hot on the SQL field it acts on, and the
//                   row under it Fix It · Continue · Ask Differently, one
//                   line at the 320 floor where four buttons were two
//                   (DESIGN rules 13 and 15)
//
// The hot face: a hover cannot be held in a still, so `resultAfterMount`
// stamps `data-hot` on the surface the cluster floats over (ask.css reads
// `[data-hot] > .acts-float` as that surface's hover): the result block on
// the three answer states, the failure block's SQL field on the cap, the
// `actions` precedent. Frames run
// under reduced motion, so the cluster's face is its settled one and the
// flip's spring is not in flight.
//
// Self-contained beside the fixture files it reuses (fixtures.rich's orders
// exchange and fixtures.actions' scalar one ARE the exchanges the sketch
// draws over the block, so a second copy of either would be a second truth):
// nothing here imports fixtures.ts, so there is no cycle to order. Wiring
// (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's): add
// RESULT_STATES to HarnessState, HARNESS_STATES and ask-frames' ALL_STATES;
// in `seed`, these states put `resultSeed(state).exchanges` under the fixture
// thread with the seed's busy and phase and take RESULT_CHOICE from
// `choiceFor`; in the post-mount rAF, call `resultAfterMount(state)` beside
// `actionsAfterMount(state)`, before the ready mark; park them at the top
// (`scroll=top` by default, the `insight` precedent), the block being the
// subject.

import { turnCapMessage, type AskAnswer, type AskPhase } from "../agent/loop";
import type { Exchange, ToolChip } from "../stores/agent";
import { useAsk } from "../stores/ask";
import { actionsSeed } from "./fixtures.actions";
import { richSeed } from "./fixtures.rich";

export const RESULT_STATES = ["result-table", "result-sql", "result-scalar", "failure-cap"] as const;
export type ResultState = (typeof RESULT_STATES)[number];

export interface ResultSeed {
  /** the thread, oldest first */
  exchanges: Exchange[];
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the order_v2 thread's choice, so the pill reads what the footers read */
export const RESULT_CHOICE = { provider: PROVIDER, model: MODEL } as const;

/** the sketch's W7 block rows are the W5 orders exchange (nine rows, three
 * columns, `9 rows · 412.6 ms`) and the W4 thread's one-row run (`217`) */
const orders = richSeed("insight").exchange;
const scalar = actionsSeed("actions").exchanges[2];

// ---- failure-cap: a wide question that spent its budget --------------------

const CAP_QUESTION = "what should I know about how payments behave across the whole order history";

const CAP_SQL = [
  "SELECT date_trunc('month', o.created_at) AS month,",
  "       o.payment_status,",
  "       COUNT(*) AS orders",
  "FROM order_v2 o",
  "JOIN payment_attempt p ON p.order_id = o.id",
  "GROUP BY 1, 2",
  "ORDER BY 1",
].join("\n");

const chip = (
  id: string,
  name: ToolChip["name"],
  label: string,
  ms: number,
  args: Record<string, unknown>,
  result: string,
  isError = false,
): ToolChip => ({ id, name, label, ms, isError, args: JSON.stringify(args), result });

const capChips: ToolChip[] = [
  chip("call-1", "describe_tables", "describe order_v2, payment_attempt", 412, { names: ["order_v2", "payment_attempt"] }, "order_v2 (2.1M rows)\n  id bigint PK\n  payment_status text\n  created_at timestamptz"),
  chip("call-2", "peek_values", "peek payment_status", 233, { table: "public.order_v2", column: "payment_status" }, "paid | failed | cod_pending | refunded | rto"),
  chip("call-3", "peek_values", "peek attempt_result", 198, { table: "public.payment_attempt", column: "attempt_result" }, "success | declined | timeout"),
  chip("call-4", "probe", "probe created_at", 176, { sqls: ["SELECT min(created_at), max(created_at) FROM order_v2"] }, "min | max\n2021-11-02 | 2026-09-05"),
  chip("call-5", "run_sql", "run", 61, { sql: CAP_SQL }, 'ERROR: relation "payment_attempt" does not exist', true),
];

/** the verdict is the ONE place the turn count is written down: the failure
 * heading, the trace's verdict step and the footer all read this number, the
 * way the loop now hands the child's own `num_turns` to all three (LESSONS
 * 13, DESIGN rule 14). A fixture that types the footer's number by hand can
 * draw a state the loop cannot produce */
const CAP_TURNS = 12;

const CAP_ANSWER: AskAnswer = {
  verdict: { status: "turn_cap", sql: CAP_SQL, turns: CAP_TURNS },
  sql: CAP_SQL,
  run: null,
  assumptions: [],
  sanity: [],
  trace: [
    {
      step: "context",
      ms: 3,
      candidates: ["public.order_v2", "public.users"],
      text: `${CAP_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\npublic.order_v2\npublic.users`,
    },
    { step: "turn", ms: 18_400, index: 0, text: "Describing the order and payment tables before grouping." },
    { step: "verdict", ms: 96_400, verdict: { status: "turn_cap", sql: CAP_SQL, turns: CAP_TURNS } },
  ],
  text: "",
  turns: CAP_TURNS,
  ms: 96_400,
  usage: { input: 41_800, output: 1_940 },
  promptVersion: "v4",
  candidates: ["public.order_v2", "public.users"],
  recall: null,
  risky: false,
};

/** the child's own turn count, in the status register, singular at 1: the
 * number the user watched work, never an internal counter (LESSONS) */
const capped: Exchange = {
  id: "harness-ex-result-cap",
  turnId: 31,
  question: CAP_QUESTION,
  text: "",
  thinking: "",
  chips: capChips,
  answer: CAP_ANSWER,
  error: { kind: "turncap", message: turnCapMessage(CAP_TURNS) },
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

// ---- exports ---------------------------------------------------------------

export function resultSeed(state: ResultState): ResultSeed {
  switch (state) {
    case "result-table":
    case "result-sql":
      return { exchanges: [orders], busy: false, phase: null };
    case "result-scalar":
      return { exchanges: [scalar], busy: false, phase: null };
    case "failure-cap":
      return { exchanges: [capped], busy: false, phase: null };
  }
}

/** the exchange whose cluster is hot, and the surface it floats over: the
 * result block on the answer states, the SQL field on the cap, where Insert
 * rides the field it acts on (W7 fix, DESIGN rule 15) */
function hotFace(state: ResultState): { id: string; sel: string } {
  switch (state) {
    case "result-table":
    case "result-sql":
      return { id: orders.id, sel: ".rb" };
    case "result-scalar":
      return { id: scalar.id, sel: ".rb" };
    case "failure-cap":
      return { id: capped.id, sel: ".ans-fix" };
  }
}

/** the post-mount hook: the SQL face through the store's own door, then the
 * hot cluster. Runs in the harness's rAF after the pane's mount effects, so
 * the face is set on a block that is already on screen */
export function resultAfterMount(state: string): void {
  if (!(RESULT_STATES as readonly string[]).includes(state)) return;
  const s = state as ResultState;
  if (s === "result-sql") useAsk.getState().setFace(orders.id, "sql");
  const { id, sel } = hotFace(s);
  const face = document.querySelector<HTMLElement>(`[data-exchange="${id}"] ${sel}`);
  if (face) face.dataset.hot = "";
}
