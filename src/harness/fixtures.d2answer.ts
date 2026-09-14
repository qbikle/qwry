// D2 answer-rhythm states for the Ask fixture harness (the sketch's "D2 ·
// widgets and the answer's rhythm" pane rows), same conventions as
// fixtures.rich.ts: the store's own types, the harness connection `staging` on
// `auth_new`, and the model's LAST text block verbatim, which the parser
// (agent/display.ts) strips at render time and the trace keeps raw. Both are
// Sonnet 5 through Claude Code, and neither has a run on screen: the rhythm is
// the subject, so nothing below the prose competes with it.
//
//   d2-answer-typo  `how do the erp cost tables join to orders, and which of
//                   them matter`: the whole table of item 7 in one answer - a
//                   four-word lead-in as a label, a paragraph, five bullets
//                   each with its figures, the join written out as SQL in the
//                   editor's own highlighted face, a sentence ending in a
//                   colon that opens the group
//                   under it, and the model's own five-row comparison as the
//                   readOnly grid; three follow-ups 16 under, the footer 8
//                   under them. `describe erp_order_cost_snapshot +5` ·
//                   `peek currency`, `2 turns · 31.4 s · Sonnet 5`
//   d2-answer-list  `list every erp table`: the maintainer's own screenshot.
//                   A colon sentence over seventy names as an ordered list,
//                   folded after the twelfth behind `Show All 70` in the
//                   list's own text column, the ordinals ending on one edge.
//                   `tables`, `1 turn · 9.8 s · Sonnet 5`
//
// The fence in `d2-answer-typo` is the model's own statement, and it reaches
// the slot because NO run is on screen: with one, the SQL row owns it and
// display.ts drops the fence (DESIGN rule 14); with none, nothing else in the
// anatomy carries it, exactly as with the model's own table below it. So the
// face this frame is evidence for is the read-only SQL view itself, the
// result block's own (AGENT-UX section 2c), which is what the sketch draws.
// The list state is the answer prompt v4 writes for a question whose tool has no SQL to run;
// PROMPT v5's one sentence makes it rarer, never impossible, which is the fold
// the frame is evidence for.
//
// Self-contained: nothing here imports fixtures.ts, so there is no cycle to
// order. Wiring (the integrator's): fixtures.ts HarnessState + HARNESS_STATES
// + exchangeFor + choiceFor (D2ANSWER_CHOICE), AskHarness.seed (the exchange
// under the fixture thread with `followUps`, no busy and no phase; park these
// states at the top, the text is the subject), ask-frames.ts ALL_STATES at
// 320 / 392 / 560, tauriShim (`plugin:opener|open_url` -> nothing).

import type { AskAnswer, AskPhase } from "../agent/loop";
import type { TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";

export const D2ANSWER_STATES = ["d2-answer-typo", "d2-answer-list"] as const;
export type D2AnswerState = (typeof D2ANSWER_STATES)[number];

export interface D2AnswerSeed {
  exchange: Exchange;
  /** the thread's row, under this answer (W7 item 3) */
  followUps: string[];
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-sonnet-5";
/** the erp thread's choice, so the pill reads what the footers read */
export const D2ANSWER_CHOICE = { provider: PROVIDER, model: MODEL } as const;

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

/** the seventy tables under the `erp_` prefix, in the order list_tables returns
 * them: the finance stack the maintainer's own screenshot listed */
const ERP70 = [
  "erp_order_cost_snapshot",
  "erp_fx_rate",
  "erp_cogs_line",
  "erp_shipping_cost",
  "erp_refund_ledger",
  "erp_sync_run",
  "erp_sync_error",
  "erp_vendor",
  "erp_vendor_contact",
  "erp_vendor_invoice",
  "erp_vendor_invoice_line",
  "erp_purchase_order",
  "erp_purchase_order_line",
  "erp_goods_receipt",
  "erp_goods_receipt_line",
  "erp_sku_cost",
  "erp_sku_cost_history",
  "erp_bom",
  "erp_bom_line",
  "erp_fabric_lot",
  "erp_fabric_lot_usage",
  "erp_trim_lot",
  "erp_trim_lot_usage",
  "erp_stitching_batch",
  "erp_stitching_batch_line",
  "erp_unit",
  "erp_unit_capacity",
  "erp_unit_rate_card",
  "erp_worker",
  "erp_worker_shift",
  "erp_worker_payout",
  "erp_qc_check",
  "erp_qc_defect",
  "erp_packet",
  "erp_packet_item",
  "erp_packet_scan",
  "erp_dispatch",
  "erp_dispatch_item",
  "erp_courier",
  "erp_courier_rate",
  "erp_courier_invoice",
  "erp_courier_invoice_line",
  "erp_rto_event",
  "erp_return_receipt",
  "erp_return_receipt_item",
  "erp_warehouse",
  "erp_warehouse_bin",
  "erp_stock_ledger",
  "erp_stock_count",
  "erp_stock_count_line",
  "erp_stock_adjustment",
  "erp_price_list",
  "erp_price_list_item",
  "erp_discount_rule",
  "erp_tax_rate",
  "erp_gst_invoice",
  "erp_gst_invoice_line",
  "erp_credit_note",
  "erp_credit_note_line",
  "erp_debit_note",
  "erp_payment_advice",
  "erp_bank_statement",
  "erp_bank_statement_line",
  "erp_reconciliation",
  "erp_reconciliation_match",
  "erp_cost_center",
  "erp_gl_account",
  "erp_gl_entry",
  "erp_period_close",
  "erp_audit_log",
];

const CANDIDATES = ["public.order_v2", "public.erp_order_cost_snapshot"];
const CONTEXT = (q: string) =>
  `${q}\n\nCANDIDATE TABLES (pre-selected from 70 tables; if none fit, call list_tables):\n` +
  "public.order_v2 (2.1M rows): id, user_id, payment_status, total_amount, created_at\n" +
  "public.erp_order_cost_snapshot (1.9M rows): order_id, snapshot_date, cogs_total, shipping_cost";

interface Seed {
  id: string;
  question: string;
  /** the model's last text block, verbatim */
  text: string;
  /** narration before the last block, as the turn's raw text keeps it */
  narration: string[];
  chips: ToolChip[];
  followUps: string[];
  turns: number;
  turnMs: number;
  totalMs: number;
}

/** one finished exchange of one qwry turn through Claude Code, the loop's
 * trace in loop order: context, the turn (its whole text), its tool calls,
 * the verdict, the follow-ups call. Neither state ran SQL, so neither has a
 * run, a statement or an assumption: the prose is the whole answer */
function landed(s: Seed): Exchange {
  const usage = { input: 21_400, output: 620, cacheRead: 19_800, cacheWrite: 0 };
  const trace: TraceStep[] = [
    { step: "context", ms: 3, candidates: CANDIDATES, text: CONTEXT(s.question) },
    { step: "turn", ms: s.turnMs, index: 0, text: [...s.narration, s.text].join("\n\n"), usage },
    ...s.chips.map(tool),
    { step: "verdict", ms: s.totalMs, verdict: { status: "answered", sql: null, rowCount: null } },
    {
      step: "followups",
      ms: 1300,
      prompt: `Question: ${s.question}\n\nAnswer:\n${s.text}\n\nSQL:\nnone`,
      text: s.followUps.join("\n"),
      questions: s.followUps,
      usage: { input: 520, output: 38 },
    },
  ];
  const answer: AskAnswer = {
    verdict: { status: "answered", sql: null, rowCount: null },
    sql: null,
    run: null,
    assumptions: [],
    sanity: [],
    trace,
    text: s.text,
    turns: s.turns,
    ms: s.totalMs,
    usage,
    promptVersion: "v4",
    candidates: CANDIDATES,
    recall: null,
    risky: false,
  };
  return {
    id: s.id,
    turnId: 2,
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

// ---- d2-answer-typo: the rhythm, every register in one answer ----------------

const DESCRIBE_COST = chip(
  "call-1",
  "describe_tables",
  "describe erp_order_cost_snapshot +5",
  641,
  { names: ERP70.slice(0, 6) },
  [
    "erp_order_cost_snapshot (1,904,882 rows) -- Nightly cost roll-up, one row per order per day.",
    "  order_id bigint -> order_v2.id",
    "  snapshot_date date",
    "  cogs_total numeric(12,2)",
    "  shipping_cost numeric(12,2) null",
    "erp_fx_rate (0 rows) -- Currency rates, written by the nightly sync.",
    "  currency text",
    "  rate_date date",
    "erp_cogs_line (9,412 rows) -- One row per order line.",
    "  order_id bigint -> order_v2.id",
    "  line_no int",
  ].join("\n"),
);

const PEEK_CURRENCY = chip(
  "call-2",
  "peek_values",
  "peek currency",
  118,
  { table: "public.order_v2", column: "currency" },
  ["currency | count", "INR | 2,753", "USD | 6", "AUD | 3", "EUR | 1"].join("\n"),
);

/** The whole of item 7's table in one answer the model would actually write:
 * a four-word lead-in (a label), a paragraph, the findings as bullets with
 * their figures, the join written out as a fence no run on screen owns, a
 * sentence ending in a colon, and the grain as the model's own table. */
const TYPO_TEXT = [
  "**Across 70 ERP tables:**",
  "",
  "Six carry cost. The snapshot is the one to start from, the rate table prices it, and three ledgers key on `order_id`, all of them written by the nightly sync.",
  "",
  "- `erp_order_cost_snapshot` holds 1 row per order per day, 2,763 orders in August.",
  "- `erp_fx_rate` is empty, so the 10 non-INR orders stay in their own currency.",
  "- `erp_cogs_line` breaks an order into 3.4 lines on average, 9,412 in the month.",
  "- `erp_shipping_cost` is filled for 68% of delivered orders and none of the failed ones.",
  "- `erp_refund_ledger` lags the order by 2 days at the median and 11 at the tail.",
  "",
  "```sql",
  "SELECT o.id,",
  "       s.cogs_total,",
  "       s.shipping_cost,",
  "       r.refund_total",
  "FROM order_v2 o",
  "JOIN erp_order_cost_snapshot s ON s.order_id = o.id",
  "LEFT JOIN erp_refund_ledger r ON r.order_id = o.id",
  "WHERE o.created_at >= '2026-08-01'",
  "  AND o.created_at < '2026-09-01';",
  "```",
  "",
  "The grain differs on every one of them:",
  "",
  "| table | grain | key |",
  "|---|---|---|",
  "| erp_order_cost_snapshot | order · day | order_id, snapshot_date |",
  "| erp_cogs_line | order line | order_id, line_no |",
  "| erp_shipping_cost | shipment | shipment_id |",
  "| erp_refund_ledger | refund | refund_id |",
  "| erp_fx_rate | currency · day | currency, rate_date |",
].join("\n");

const TYPO_FOLLOW_UPS = [
  "Which orders have a shipping cost but no snapshot?",
  "How stale is the newest snapshot?",
  "What does the sync write on a refund?",
];

const typo = landed({
  id: "harness-ex-d2-typo",
  question: "how do the erp cost tables join to orders, and which of them matter",
  text: TYPO_TEXT,
  narration: [
    "I'll describe the six cost tables to see what they key on.",
    "Checking which currencies the orders are in before I say the rates matter.",
  ],
  chips: [DESCRIBE_COST, PEEK_CURRENCY],
  followUps: TYPO_FOLLOW_UPS,
  turns: 2,
  turnMs: 28_600,
  totalMs: 31_400,
});

// ---- d2-answer-list: seventy names, folded after the twelfth -----------------

const LIST_TABLES = chip(
  "call-1",
  "list_tables",
  "tables",
  212,
  { schema: "public" },
  ERP70.map((n) => `public.${n}`).join("\n"),
);

const LIST_TEXT = [
  `The schema holds ${ERP70.length} tables under the \`erp_\` prefix:`,
  "",
  ...ERP70.map((n, i) => `${i + 1}. \`${n}\``),
].join("\n");

const LIST_FOLLOW_UPS = [
  "Which of these does the nightly sync write?",
  "Which erp tables are empty?",
  "How do the ledgers join to orders?",
];

const list = landed({
  id: "harness-ex-d2-list",
  question: "list every erp table",
  text: LIST_TEXT,
  narration: ["I'll list the schema and keep the erp_ prefix."],
  chips: [LIST_TABLES],
  followUps: LIST_FOLLOW_UPS,
  turns: 1,
  turnMs: 8_400,
  totalMs: 9_800,
});

export function d2AnswerSeed(state: D2AnswerState): D2AnswerSeed {
  return state === "d2-answer-typo"
    ? { exchange: typo, followUps: TYPO_FOLLOW_UPS, busy: false, phase: null }
    : { exchange: list, followUps: LIST_FOLLOW_UPS, busy: false, phase: null };
}
