// Bubble builder's fixtures for the Ask harness (W4): the action cluster on
// every question bubble, over the sketch's three-exchange discussion thread
// (the "W4 · message actions and jumping back" rows of ask-sketch-v2.html):
// fixtures.echo's two exchanges (`can you check the revenue in last month`
// with its four-row currency grid, then the converted question answered in
// prose) and a third, a 91-character question over a scalar (`217` ·
// `first_time_customers`, `1 row · 188.2 ms`, `probe created_at` · `run`,
// `New = No Earlier Paid Order`, `1 turn · 33.1 s · Haiku 4.5`).
//
//   actions         the second bubble hot: Copy · Restart · Jump Back beside a
//                   live bubble on a landed thread (Restart here would ask
//                   through the danger confirm: one later answer). The
//                   scroller parks at that exchange, the sketch's rest, so the
//                   still holds the hot row and the anatomy under it
//   actions-latest  the newest bubble hot (Restart there is the retry shape,
//                   no confirm); the bottom pin, where the cluster sits beside
//                   a question that wraps to two lines at 560 and four at 320
//   actions-busy    the third exchange streaming (probe landed, run running,
//                   no text yet) with the second bubble hot: Restart and Jump
//                   Back at the disabled value, Copy live, the Stop face in
//                   the composer (DESIGN rule 2's matrix in a still)
//
// The hot face: a hover cannot be held in a still, so `actionsAfterMount`
// stamps `data-hot` on the hot exchange's article (AnswerBlock's
// [data-exchange]) after mount, and ask.css reads `.ans[data-hot]
// .ans-echo-acts` as the row's hover. Frames run under reduced motion, so the
// cluster's face is its settled one; no spring is in flight. Same conventions
// as fixtures.ts: the store's own types, the harness connection `staging` on
// `auth_new`, prose that interprets and never repeats the data (DESIGN rule
// 14), Haiku 4.5 through Claude Code as the sketch's thread reads.
//
// Self-contained beside fixtures.echo.ts: nothing here imports fixtures.ts,
// so there is no cycle to order. Wiring (fixtures.ts / AskHarness.tsx /
// ask-frames.ts are the integrator's): add ACTIONS_STATES to HarnessState,
// HARNESS_STATES and ask-frames' ALL_STATES; in `seed`, these states put
// `actionsSeed(state).exchanges` under the fixture thread with the seed's
// busy and phase; in the post-mount rAF, call `actionsAfterMount(state)`
// beside `shellAfterMount(state)`, before the ready mark.

import type { AskAnswer, AskPhase } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import { echoExchangesFor } from "./fixtures.echo";

export const ACTIONS_STATES = ["actions", "actions-latest", "actions-busy"] as const;
export type ActionsState = (typeof ACTIONS_STATES)[number];

export interface ActionsSeed {
  /** the thread, oldest first */
  exchanges: Exchange[];
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the discussion thread's choice, so the pill reads what the footers read */
export const ACTIONS_CHOICE = { provider: PROVIDER, model: MODEL } as const;

const chip = (
  id: string,
  name: ToolChip["name"],
  label: string,
  ms: number | null,
  args: Record<string, unknown>,
  result: string | null,
): ToolChip => ({ id, name, label, ms, isError: false, args: JSON.stringify(args), result });

const tool = (c: ToolChip): TraceStep => ({
  step: "tool",
  ms: c.ms ?? 0,
  id: c.id,
  name: c.name,
  args: c.args,
  result: c.result ?? "",
  isError: c.isError,
});

// ---- the third exchange: a 91-character question over a value ----------------

const NEW_QUESTION =
  "how many of those august orders came from customers who had never ordered before that month";

const NEW_SQL = [
  "SELECT COUNT(*) AS first_time_customers",
  "FROM (",
  "  SELECT DISTINCT o.user_id",
  "  FROM order_v2 o",
  "  WHERE o.payment_status = 'paid'",
  "    AND o.created_at >= date_trunc('month', now() - interval '1 month')",
  "    AND o.created_at <  date_trunc('month', now())",
  "    AND NOT EXISTS (",
  "      SELECT 1 FROM order_v2 p",
  "      WHERE p.user_id = o.user_id",
  "        AND p.payment_status = 'paid'",
  "        AND p.created_at < date_trunc('month', now() - interval '1 month'))",
  ") s",
].join("\n");

const NEW_TEXT =
  "Judged across every currency, so a customer whose only earlier order was in USD still counts as returning.\n\n" +
  "```sql\n" +
  NEW_SQL +
  "\n```\n\n" +
  "Assumptions: New = No Earlier Paid Order";

const PROBE_ARGS = {
  sqls: ["SELECT min(created_at), max(created_at) FROM order_v2 WHERE payment_status = 'paid'"],
};
const PROBE_RESULT = "min | max\n2021-11-02 06:41:19+00 | 2026-09-05 23:58:44+00";

const probeChip = chip("call-1", "probe", "probe created_at", 141, PROBE_ARGS, PROBE_RESULT);
const runChip = chip("call-2", "run_sql", "run", 188, { sql: NEW_SQL }, "first_time_customers\n217\n(1 row)");

const NEW_RUN: AgentRun = {
  columns: ["first_time_customers"],
  rows: [["217"]],
  rowCount: 1,
  capped: false,
  ms: 188.2,
};

const NEW_ASSUMPTIONS: Assumption[] = [
  { id: "model:0", label: "New = No Earlier Paid Order", source: "model", active: true },
];

const NEW_FOLLOW_UPS = [
  "How many of them ordered again in September?",
  "What did new customers spend on average?",
  "Which cities were the new customers in?",
];

const NEW_CANDIDATES = [
  "public.order_v2 (1.2M rows): id, user_id, total_amount, currency, payment_status, created_at",
  "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
];

const usage = { input: 12_400, output: 260, cacheRead: 10_900, cacheWrite: 0 };

const NEW_TRACE: TraceStep[] = [
  {
    step: "context",
    ms: 3,
    candidates: NEW_CANDIDATES,
    text: `${NEW_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n${NEW_CANDIDATES.join("\n")}`,
  },
  { step: "turn", ms: 30_900, index: 0, text: NEW_TEXT, usage },
  tool(probeChip),
  tool(runChip),
  { step: "verdict", ms: 33_100, verdict: { status: "answered", sql: NEW_SQL, rowCount: 1 } },
  {
    step: "followups",
    ms: 1200,
    prompt: `Question: ${NEW_QUESTION}\n\nAnswer:\n${NEW_TEXT}\n\nSQL:\n${NEW_SQL}`,
    text: NEW_FOLLOW_UPS.join("\n"),
    questions: NEW_FOLLOW_UPS,
    usage: { input: 510, output: 40 },
  },
];

const NEW_ANSWER: AskAnswer = {
  verdict: { status: "answered", sql: NEW_SQL, rowCount: 1 },
  sql: NEW_SQL,
  run: NEW_RUN,
  assumptions: NEW_ASSUMPTIONS,
  sanity: [],
  trace: NEW_TRACE,
  text: NEW_TEXT,
  turns: 1,
  ms: 33_100,
  usage,
  promptVersion: "v2",
  candidates: NEW_CANDIDATES,
  recall: null,
  risky: false,
};

const newCustomers: Exchange = {
  id: "harness-ex-actions-3",
  turnId: 24,
  question: NEW_QUESTION,
  text: NEW_TEXT,
  thinking: "",
  chips: [probeChip, runChip],
  answer: NEW_ANSWER,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

/** the same question mid-run: the probe landed, `run` still out, no text */
const newCustomersBusy: Exchange = {
  id: "harness-ex-actions-3",
  turnId: null,
  question: NEW_QUESTION,
  text: "",
  thinking: "",
  chips: [probeChip, chip("call-2", "run_sql", "run", null, { sql: NEW_SQL }, null)],
  answer: null,
  error: null,
  streaming: true,
  provider: PROVIDER,
  model: MODEL,
};

// ---- exports ---------------------------------------------------------------------------

const [revenue, converted] = echoExchangesFor("echo");

/** the exchange whose article wears `data-hot` in a state */
export function actionsHotExchangeId(state: ActionsState): string {
  return state === "actions-latest" ? newCustomers.id : converted.id;
}

export function actionsSeed(state: ActionsState): ActionsSeed {
  switch (state) {
    case "actions":
    case "actions-latest":
      return { exchanges: [revenue, converted, newCustomers], busy: false, phase: null };
    case "actions-busy":
      return { exchanges: [revenue, converted, newCustomersBusy], busy: true, phase: "tools" };
  }
}

/** the post-mount hook: the hot face, and for `actions` the sketch's rest
 * (the hot exchange's bubble at the scroller's top, one padding in). Runs in
 * the harness's rAF after the pane's own mount effects, so the pin they made
 * is what it moves */
export function actionsAfterMount(state: string): void {
  if (!(ACTIONS_STATES as readonly string[]).includes(state)) return;
  const hot = document.querySelector<HTMLElement>(`[data-exchange="${actionsHotExchangeId(state as ActionsState)}"]`);
  if (!hot) return;
  hot.dataset.hot = "";
  if (state !== "actions") return;
  const sc = document.querySelector<HTMLElement>(".ask-scroll");
  if (!sc) return;
  const pad = parseFloat(getComputedStyle(sc).paddingTop) || 0;
  sc.scrollTop += hot.getBoundingClientRect().top - sc.getBoundingClientRect().top - pad;
}
