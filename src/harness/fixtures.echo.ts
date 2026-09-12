// Echo builder's fixtures for the Ask harness (W2d, round 3 ask 1): the
// question echo as the sketch's variant B, a tinted bubble at the right edge
// with the anatomy staying left, and exchanges 28px apart.
//
//   echo       the sketch's discussion thread (thread() in ask-sketch-v2.html):
//              `can you check the revenue in last month` answered with three
//              chips, a four-row grid, two assumptions and follow-ups, then
//              `what is the total in INR for all that, converted` answered in
//              prose alone (no SQL ran to completion: the model found no FX
//              rates). Two bubbles right, everything else left. A 640px card
//              cannot hold both exchanges at once: the bottom frame shows the
//              second bubble over the composer, the -top frame the first bubble
//              and, at 560, both
//   echo-long  one exchange whose question wraps to five lines inside the
//              bubble at 320 (86% of the pane, 13px at 1.45), fewer at 560; a
//              one-row two-column result so the bubble is the frame's subject
//
// Both are landed threads (nothing streams, no ghost: the lift is motion and
// belongs to the dev build's eye, not a still). Same conventions as
// fixtures.ts: the store's own types, the harness connection `staging` on
// `auth_new`, prose that interprets and never repeats the data (DESIGN rule
// 14), Haiku 4.5 through Claude Code as the sketch's thread reads.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add ECHO_STATES to HARNESS_STATES and ask-frames' ALL_STATES; in `seed`,
// these states put `echoExchangesFor(state)` (an ARRAY: two exchanges for
// `echo`) under the fixture thread, `activeThread` the fixture thread, busy
// false, phase null; the bottom scroll is the default and `--scroll top` is
// worth a run for `echo` (the answer/busy precedent).

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";

export const ECHO_STATES = ["echo", "echo-long"] as const;
export type EchoState = (typeof ECHO_STATES)[number];

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";

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

const assume = (i: number, label: string): Assumption => ({
  id: `model:${i}`,
  label,
  source: "model",
  active: true,
});

const run = (columns: string[], rows: (string | null)[][], ms: number): AgentRun => ({
  columns,
  rows,
  rowCount: rows.length,
  capped: false,
  ms,
});

interface Seed {
  id: string;
  turnId: number;
  question: string;
  text: string;
  chips: ToolChip[];
  /** null when the answer is prose alone (nothing to copy or open) */
  sql: string | null;
  run: AgentRun | null;
  assumptions: Assumption[];
  followUps: string[];
  turnMs: number;
  totalMs: number;
  candidates: string[];
}

/** one landed exchange of one qwry turn through Claude Code, the loop's trace
 * in loop order: context, the turn, its tool calls, the verdict, the
 * follow-ups call */
function exchange(s: Seed): Exchange {
  const usage = { input: 11_800, output: 240, cacheRead: 10_400, cacheWrite: 0 };
  const trace: TraceStep[] = [
    {
      step: "context",
      ms: 3,
      candidates: s.candidates,
      text: `${s.question}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n${s.candidates.join("\n")}`,
    },
    { step: "turn", ms: s.turnMs, index: 0, text: s.text, usage },
    ...s.chips.map(tool),
    { step: "verdict", ms: s.totalMs, verdict: { status: "answered", sql: s.sql, rowCount: s.run?.rowCount ?? null } },
    {
      step: "followups",
      ms: 1100,
      prompt: `Question: ${s.question}\n\nAnswer:\n${s.text}${s.sql ? `\n\nSQL:\n${s.sql}` : ""}`,
      text: s.followUps.join("\n"),
      questions: s.followUps,
      usage: { input: 480, output: 36 },
    },
  ];
  const answer: AskAnswer = {
    verdict: { status: "answered", sql: s.sql, rowCount: s.run?.rowCount ?? null },
    sql: s.sql,
    run: s.run,
    assumptions: s.assumptions,
    sanity: [],
    trace,
    text: s.text,
    turns: 1,
    ms: s.totalMs,
    usage,
    promptVersion: "v2",
    candidates: s.candidates,
    recall: null,
    risky: false,
  };
  return {
    id: s.id,
    turnId: s.turnId,
    question: s.question,
    text: s.text,
    thinking: "",
    chips: s.chips,
    answer,
    error: null,
    streaming: false,
    provider: PROVIDER,
    model: MODEL,
  };
}

// ---- echo: the sketch's two exchanges ----------------------------------------------

const REVENUE_SQL = [
  "SELECT SUM(total_amount) AS revenue, COUNT(*) AS order_count, currency",
  "FROM order_v2",
  "WHERE payment_status = 'paid'",
  "  AND created_at >= date_trunc('month', now() - interval '1 month')",
  "  AND created_at <  date_trunc('month', now())",
  "GROUP BY currency",
  "ORDER BY revenue DESC",
].join("\n");

const REVENUE_ROWS: (string | null)[][] = [
  ["2277416.00", "482", "INR"],
  ["1893.50", "7", "USD"],
  ["412.00", "2", "AUD"],
  ["260.00", "1", "EUR"],
];

const CONVERTED_QUESTION = "what is the total in INR for all that, converted";

const revenue = exchange({
  id: "harness-ex-echo-1",
  turnId: 20,
  question: "can you check the revenue in last month",
  text:
    "Nearly all of last month's paid revenue is INR; the USD, AUD and EUR rows are ten orders between them, kept in their own currency rather than converted.\n\n" +
    "```sql\n" +
    REVENUE_SQL +
    "\n```\n\n" +
    "Assumptions: Last Month = August 2026; Revenue = Paid Orders",
  chips: [
    chip(
      "call-1",
      "describe_tables",
      "describe order_v2",
      388,
      { names: ["order_v2"] },
      "order_v2 (1,204,310 rows)\n  id bigint PK\n  user_id bigint → users.id\n  total_amount numeric\n  currency text: INR, USD, AUD, EUR\n  payment_status text\n  created_at timestamptz",
    ),
    chip(
      "call-2",
      "peek_values",
      "peek payment_status",
      131,
      { table: "order_v2", column: "payment_status" },
      "payment_status | count\npaid | 1,102,884\npending | 71,210\nfailed | 24,913\nrefunded | 5,303",
    ),
    chip(
      "call-3",
      "run_sql",
      "run",
      312,
      { sql: REVENUE_SQL },
      ["revenue | order_count | currency", ...REVENUE_ROWS.map((r) => r.join(" | ")), "(4 rows)"].join("\n"),
    ),
  ],
  sql: REVENUE_SQL,
  run: run(["revenue", "order_count", "currency"], REVENUE_ROWS, 311.8),
  assumptions: [assume(0, "Last Month = August 2026"), assume(1, "Revenue = Paid Orders")],
  followUps: [
    CONVERTED_QUESTION,
    "Which day of August had the most paid orders?",
    "How does August compare with July?",
  ],
  turnMs: 25_100,
  totalMs: 27_300,
  candidates: [
    "public.order_v2 (1.2M rows): id, user_id, total_amount, currency, payment_status, created_at",
    "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
  ],
});

const converted = exchange({
  id: "harness-ex-echo-2",
  turnId: 22,
  question: CONVERTED_QUESTION,
  text: "No FX rates are stored (`erp_fx_rate` is empty), so the non-INR tails cannot be converted here.",
  chips: [
    chip(
      "call-1",
      "describe_tables",
      "describe erp_order_cost_snapshot, erp_fx_rate",
      402,
      { names: ["erp_order_cost_snapshot", "erp_fx_rate"] },
      "erp_order_cost_snapshot (0 rows)\n  order_id bigint\n  cost_inr numeric\nerp_fx_rate (0 rows)\n  currency text\n  rate_to_inr numeric\n  as_of date",
    ),
    ...[1, 2, 3, 4, 5].map((i) =>
      chip(
        `call-${i + 1}`,
        "run_sql",
        "run",
        40 + i * 3,
        { sql: `SELECT rate_to_inr FROM erp_fx_rate WHERE currency = '${["USD", "AUD", "EUR", "USD", "AUD"][i - 1]}' ORDER BY as_of DESC LIMIT 1` },
        "rate_to_inr\n(0 rows)",
      ),
    ),
  ],
  sql: null,
  run: null,
  assumptions: [],
  followUps: [
    "How many orders were paid in each non-INR currency this year?",
    "Which users placed the USD orders?",
    "When was erp_fx_rate last written to?",
  ],
  turnMs: 38_600,
  totalMs: 41_000,
  candidates: [
    "public.erp_order_cost_snapshot (0 rows): order_id, cost_inr",
    "public.erp_fx_rate (0 rows): currency, rate_to_inr, as_of",
  ],
});

// ---- echo-long: a five-line question at the floor -----------------------------------

const LONG_QUESTION =
  "for every user who signed up through a paid campaign last quarter, how many wardrobes did they build and how many of those had products added this month?";

const LONG_SQL = [
  "SELECT COUNT(DISTINCT w.id) AS wardrobes,",
  "       COUNT(DISTINCT w.id) FILTER (",
  "         WHERE EXISTS (SELECT 1 FROM wardrobe_products_v2 p",
  "                       WHERE p.wardrobe_id = w.id",
  "                         AND p.added_at >= date_trunc('month', now()))",
  "       ) AS active_wardrobes",
  "FROM users u",
  "JOIN wardrobes w ON w.user_id = u.id",
  "WHERE u.signup_source IN ('paid_social', 'paid_search')",
  "  AND u.created_at >= date_trunc('quarter', now()) - interval '3 months'",
  "  AND u.created_at <  date_trunc('quarter', now())",
].join("\n");

const long = exchange({
  id: "harness-ex-echo-long",
  turnId: 24,
  question: LONG_QUESTION,
  text:
    "About one wardrobe in three saw a product this month.\n\n" +
    "```sql\n" +
    LONG_SQL +
    "\n```\n\n" +
    "Assumptions: Paid = paid_social, paid_search; Last Quarter = Q2 2026",
  chips: [
    chip(
      "call-1",
      "peek_values",
      "peek signup_source",
      124,
      { table: "users", column: "signup_source" },
      "signup_source | count\norganic | 611,204\napp_store | 302,118\npaid_social | 148,902\nreferral | 88,410\npaid_search | 53,676",
    ),
    chip("call-2", "run_sql", "run", 3918, { sql: LONG_SQL }, "wardrobes | active_wardrobes\n61847 | 19206\n(1 row)"),
  ],
  sql: LONG_SQL,
  run: run(["wardrobes", "active_wardrobes"], [["61847", "19206"]], 3917.6),
  assumptions: [assume(0, "Paid = paid_social, paid_search"), assume(1, "Last Quarter = Q2 2026")],
  followUps: [
    "Which paid channel builds the bigger wardrobes?",
    "How many of those users are still active?",
    "How does this compare with organic signups?",
  ],
  turnMs: 9_800,
  totalMs: 14_100,
  candidates: [
    "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
    "public.wardrobes (842k rows): id, user_id, name, created_at",
    "public.wardrobe_products_v2 (9.8M rows): id, wardrobe_id, product_id, added_at",
  ],
});

// ---- exports ---------------------------------------------------------------------------

/** the thread a state shows, oldest first: two exchanges for `echo`, one for
 * `echo-long`; the harness seeds them all under the fixture thread */
export function echoExchangesFor(state: EchoState): Exchange[] {
  switch (state) {
    case "echo":
      return [revenue, converted];
    case "echo-long":
      return [long];
  }
}
