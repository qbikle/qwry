// W6 chips states for the Ask fixture harness (the sketch's "W6 · @ context
// tags" rows 3 and 4): the tagged question sent, and its trace. Same
// conventions as fixtures.ts (the store's own types, the harness connection
// `staging` on `auth_new`, the model's LAST text block verbatim with its fence
// and Assumptions line, prose that interprets and never repeats a cell,
// DESIGN rule 14), over the discussion thread on Haiku 4.5 through Claude
// Code, the thread the W4 and W5 rows read:
//
//   mention-echo   the discussion thread's first exchange, then `compare
//                  @order_v2 with @"Monthly revenue" for August` answered.
//                  Both mentions resolve (order_v2 is a table of the seeded
//                  snapshot, Monthly revenue a saved query of the connection),
//                  so the bubble wears two pills: at 320 it sits at its
//                  calc(100% - 76px) cap and wraps to three lines with both
//                  pills whole, at 392 the second pill breaks across the wrap
//                  (rounded on both fragments), at 560 the question is one
//                  line. One sentence carrying two derived figures over a
//                  two-row grid inside the result block, `2 rows · 402.3 ms`,
//                  `August = created_at` · `Revenue = Paid Orders`, three follow-ups,
//                  `1 turn · 31.6 s · Haiku 4.5`. The scroller parks at the
//                  tagged exchange (the W4 `actions` device): the bubble is
//                  the subject and the answer is taller than the floor's
//                  viewport either way
//   mention-trace  the same thread with the drawer open from the footer link,
//                  the context step expanded: `tagged order_v2 · "Monthly
//                  revenue"` in the status register over the block, whose
//                  last lines are the TAGGED BY THE USER block the loop sent
//                  (the table line, the saved query's name and its SQL)
//
// The seed carries what the chips need to resolve: the wave's one schema and
// saved queries (fixtures.mentions.ts: `MENTION_SNAPSHOT` with `order_v2`
// at ~2.1M rows and the sketch's comment, `mentionSaved` with `Monthly
// revenue`), so a tag the popover frame offers is a tag this frame resolves.
// The question itself is persisted as typed; the pills are the echo
// re-resolving it against these on render (AnswerBlock), which is what a
// reloaded thread does.
//
// Wiring (the integrator's): fixtures.ts HarnessState + HARNESS_STATES,
// `exchangeFor` → null (the thread is read whole, the echo shape) and
// `choiceFor` → ACTIONS_CHOICE (the discussion thread's Haiku 4.5);
// AskHarness.seed: `mentionsEchoSeed(state)` gives `exchanges` for the fixture
// thread, `snapshot` for `useSchema.snapshots[pid]` and `saved` for
// `useSaved.setState({ queries })`, busy false, phase null; AskHarness's
// post-mount effect: `mentionsEchoTraceFor(state)` → openTrace beside
// anatomyTraceFor, then `mentionsEchoAfterMount(state)` in the rAF beside
// actionsAfterMount (`scroll=top` re-parks after it and wins); ask-frames.ts
// ALL_STATES. Reads nothing from fixtures.ts at module level (the anatomy
// precedent: fixtures.mentions.ts reads `FIXTURE` inside its functions), so
// the import cycle never reads an uninitialised binding.

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import type { TraceTarget } from "../stores/ask";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot } from "../stores/schema";
import { echoExchangesFor } from "./fixtures.echo";
import {
  MENTION_SNAPSHOT,
  MONTHLY_REVENUE_NAME as SAVED_NAME,
  MONTHLY_REVENUE_SQL as SAVED_SQL,
  ORDER_V2_COMMENT,
  mentionSaved,
} from "./fixtures.mentions";

export const MENTIONS_ECHO_STATES = ["mention-echo", "mention-trace"] as const;
export type MentionsEchoState = (typeof MENTIONS_ECHO_STATES)[number];

export interface MentionsEchoSeed {
  /** the fixture thread's exchanges, oldest first */
  exchanges: Exchange[];
  /** the snapshot to put under the fixture profile: the wave's order_v2 schema */
  snapshot: SchemaSnapshot;
  /** the connection's saved queries (useSaved.queries) */
  saved: SavedQuery[];
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";

// ---- the exchange -----------------------------------------------------------------

const QUESTION = `compare @order_v2 with @"${SAVED_NAME}" for August`;

const SQL = [
  "WITH saved AS (SELECT date_trunc('month', created_at)::date AS month, SUM(total_amount) AS revenue, COUNT(*) AS orders",
  "               FROM order_v2 WHERE payment_status <> 'failed' GROUP BY 1)",
  "SELECT 'paid_orders' AS source, SUM(total_amount) AS revenue, COUNT(*) AS orders",
  "FROM order_v2",
  "WHERE payment_status = 'paid'",
  "  AND created_at >= '2026-08-01' AND created_at < '2026-09-01'",
  "UNION ALL",
  "SELECT 'monthly_revenue', revenue, orders",
  "FROM saved",
  "WHERE month = '2026-08-01'",
].join("\n");

const ROWS: string[][] = [
  ["paid_orders", "2277416.00", "482"],
  ["monthly_revenue", "2301880.00", "491"],
];

const run: AgentRun = {
  columns: ["source", "revenue", "orders"],
  rows: ROWS,
  rowCount: 2,
  capped: false,
  ms: 402.31,
};

/** the model's last text block, verbatim: the two figures are derived (the
 * gap and its share), no cell of the grid repeated */
const FINAL_TEXT =
  "The saved query lands 1.1% higher for August, ₹24,464, because it keeps refunded orders in the sum.\n\n" +
  "```sql\n" +
  SQL +
  "\n```\n\n" +
  "Assumptions: August = created_at; Revenue = Paid Orders";

const NARRATION = [
  "Describing order_v2 to line the saved query's month up against paid orders.",
  "Running the saved query for August, then the paid-orders sum beside it.",
];

const chip = (
  id: string,
  name: ToolChip["name"],
  label: string,
  ms: number,
  args: Record<string, unknown>,
  result: string,
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

const SAVED_AUGUST_SQL = `SELECT month, revenue FROM (${SAVED_SQL.replace(/;$/, "")}) s WHERE month = '2026-08-01'`;

/** describe, then two runs: the saved query's August row, then the comparison;
 * consecutive runs collapse to `run ×2` in the strip */
const chips: ToolChip[] = [
  chip(
    "call-1",
    "describe_tables",
    "describe order_v2",
    388,
    { names: ["order_v2"] },
    `order_v2 (2,104,331 rows)  -- ${ORDER_V2_COMMENT}\n  id uuid PK\n  user_id bigint → users.id\n  order_status text: placed, packed, shipped, delivered, cancelled\n  payment_status text: paid, pending, failed, refunded\n  total_amount numeric\n  currency text: INR, USD, AUD, EUR\n  created_at timestamptz\n  paid_at timestamptz null`,
  ),
  chip("call-2", "run_sql", "run", 61, { sql: SAVED_AUGUST_SQL }, "month | revenue\n2026-08-01 | 2301880.00\n(1 row)"),
  chip(
    "call-3",
    "run_sql",
    "run",
    402,
    { sql: SQL },
    ["source | revenue | orders", ...ROWS.map((r) => r.join(" | ")), "(2 rows)"].join("\n"),
  ),
];

const assumptions: Assumption[] = [
  { id: "model:0", label: "August = created_at", source: "model", active: true },
  { id: "model:1", label: "Revenue = Paid Orders", source: "model", active: true },
];

const FOLLOW_UPS = [
  "Which August orders were refunded?",
  "How much did refunds take off the month?",
  "Does the saved query agree for July?",
];

// ---- the context block: the tagged table first, then the rest to k ---------------

/** the CANDIDATE TABLES block as context.ts writes it (`t(col, col)  -- comment`,
 * then the FK edges among the candidates), the tagged table leading */
const INDEX_LINES = [
  `order_v2(id, user_id, order_status, payment_status, total_amount, currency, created_at, paid_at)  -- ${ORDER_V2_COMMENT}`,
  "erp_order_cost_snapshot(id, order_id, order_ref, cost_inr, snapshot_at)",
  "order_items(id, order_id, product_id, quantity, unit_price)",
  "order_refunds(id, order_id, amount, reason, refunded_at)",
  "order_shipments(id, order_id, carrier, awb, shipped_at, delivered_at)",
  "order_status_history(id, order_id, status, changed_at)",
  "payments(id, order_id, gateway, status, amount, captured_at)",
  "payment_attempts(id, payment_id, status, attempted_at)",
  "coupons(id, code, discount_pct, valid_from, valid_to)",
  "coupon_redemptions(id, coupon_id, order_id, redeemed_at)",
  "users(id, email, created_at, signup_source, is_deleted)",
  "carts(id, user_id, created_at, checked_out_at)",
  "cart_products(id, cart_id, product_id, quantity, added_at)",
  "products(id, name, brand_id, price, currency, is_active)",
  "brands(id, name, country)",
  "erp_fx_rate(currency, rate_to_inr, as_of)",
  "erp_settlements(id, order_id, settled_inr, settled_at)",
  "wardrobes(id, user_id, name, created_at)",
  "sessions(id, user_id, platform, started_at)",
];

const CANDIDATES = INDEX_LINES.map((l) => l.slice(0, l.indexOf("(")));

const FK_LINES = [
  "order_v2.user_id -> users.id",
  "order_items.order_id -> order_v2.id",
  "order_refunds.order_id -> order_v2.id",
  "order_shipments.order_id -> order_v2.id",
  "order_status_history.order_id -> order_v2.id",
  "payments.order_id -> order_v2.id",
  "payment_attempts.payment_id -> payments.id",
  "coupon_redemptions.coupon_id -> coupons.id",
  "coupon_redemptions.order_id -> order_v2.id",
  "erp_settlements.order_id -> order_v2.id",
  "carts.user_id -> users.id",
  "cart_products.cart_id -> carts.id",
  "products.brand_id -> brands.id",
  "wardrobes.user_id -> users.id",
  "sessions.user_id -> users.id",
];

/** the exact user message: askMessage's shape, then the tagged lines after the
 * candidate block (one line per mention; a saved query carries its SQL) */
const CONTEXT_TEXT =
  `${QUESTION}\n\nCANDIDATE TABLES (pre-selected from 202 tables; if none fit, call list_tables):\n` +
  [...INDEX_LINES, ...FK_LINES].join("\n") +
  `\n\nTAGGED BY THE USER:\ntable public.order_v2\nsaved query "${SAVED_NAME}":\n${SAVED_SQL}`;

const usage = { input: 14_900, output: 310, cacheRead: 12_800, cacheWrite: 0 };

const trace: TraceStep[] = [
  {
    step: "context",
    ms: 3,
    candidates: CANDIDATES,
    text: CONTEXT_TEXT,
    mentions: [
      { kind: "table", token: "order_v2" },
      { kind: "saved", token: `"${SAVED_NAME}"` },
    ],
  },
  { step: "turn", ms: 28_400, index: 0, text: [...NARRATION, FINAL_TEXT].join("\n\n"), usage },
  ...chips.map(tool),
  { step: "verdict", ms: 31_600, verdict: { status: "answered", sql: SQL, rowCount: 2 } },
  {
    step: "followups",
    ms: 1300,
    prompt: `Question: ${QUESTION}\n\nAnswer:\n${FINAL_TEXT}\n\nSQL:\n${SQL}`,
    text: FOLLOW_UPS.join("\n"),
    questions: FOLLOW_UPS,
    usage: { input: 560, output: 42 },
  },
];

const answer: AskAnswer = {
  verdict: { status: "answered", sql: SQL, rowCount: 2 },
  sql: SQL,
  run,
  assumptions,
  sanity: [],
  trace,
  text: FINAL_TEXT,
  turns: 1,
  ms: 31_600,
  usage,
  promptVersion: "v3",
  candidates: CANDIDATES,
  recall: null,
  risky: false,
};

const tagged: Exchange = {
  id: "harness-ex-mention",
  turnId: 30,
  question: QUESTION,
  text: FINAL_TEXT,
  thinking: "",
  chips,
  answer,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

// ---- exports ----------------------------------------------------------------------

/** the thread and what its chips resolve against; both states share it */
export function mentionsEchoSeed(_state: MentionsEchoState): MentionsEchoSeed {
  const [revenue] = echoExchangesFor("echo");
  return {
    exchanges: [revenue, tagged],
    snapshot: MENTION_SNAPSHOT,
    saved: mentionSaved(),
  };
}

/** the trace target a state opens with (the footer link: no step, so the
 * drawer expands the context row); null for the echo */
export function mentionsEchoTraceFor(state: MentionsEchoState): TraceTarget | null {
  return state === "mention-trace" ? { exchangeId: tagged.id, stepId: null } : null;
}

/** the post-mount hook: `mention-echo` parks the scroller at the tagged
 * exchange's bubble, one padding in (the `actions` rest). Runs in the
 * harness's rAF after the pane's own mount effects, so the pin they made is
 * what it moves; the trace state leaves the scroller where the pane put it */
export function mentionsEchoAfterMount(state: string): void {
  if (state !== "mention-echo") return;
  const at = document.querySelector<HTMLElement>(`[data-exchange="${tagged.id}"]`);
  const sc = document.querySelector<HTMLElement>(".ask-scroll");
  if (!at || !sc) return;
  const pad = parseFloat(getComputedStyle(sc).paddingTop) || 0;
  sc.scrollTop += at.getBoundingClientRect().top - sc.getBoundingClientRect().top - pad;
}
