// W5 rich-answer states for the Ask fixture harness (the sketch's "W5 · rich
// answer text" rows), same conventions as fixtures.ts (the store's own types,
// the harness connection `staging` on `auth_new`, the model's LAST text block
// verbatim with its fence and Assumptions line, which the parser strips at
// render time and the trace keeps raw). Every text is what prompt v3 writes
// for its question, never a specimen sheet of the markdown subset (the W5
// sketch gate's S2, DESIGN rule 9). All five are Haiku 4.5 through Claude
// Code, the thread of the maintainer's finding (`order_v2`: good data but
// bland, eyes go to the SQL table):
//
//   insight        `what stood out in orders last month`: a bold lead-in
//                  carrying the denominator over three bullets, each one
//                  finding with its figure, none a cell of the nine-row grid
//                  under them; `describe order_v2` · `peek payment_status` ·
//                  `run`, `9 rows · 412.6 ms`, two chips, three follow-ups,
//                  `1 turn · 24.6 s · Haiku 4.5`
//   insight-prose  `which timestamp should I use for when an order was
//                  placed`, no run: one sentence, the model's own three-column
//                  comparison as a markdown table (rendered as the readOnly
//                  grid, since no run is on screen to restate), a closing
//                  sentence with a link whose text is an identifier in
//                  backticks; `describe order_v2` · `peek paid_at`
//   insight-steps  `how do I count orders placed each month`, no run: the
//                  table's comment quoted under the bold lead-in that names
//                  its source, the inference the comment does not state, then
//                  the two steps as the one ordered list (a sequence the
//                  reader follows); `describe order_v2` · `peek payment_status`
//   insight-code   `how many of the august orders were placed with a coupon`:
//                  one sentence and the JSON shape the peek found as a
//                  non-SQL fence, over a value (`1,096` · `coupon_orders`);
//                  the filter that shape implies is a chip (`Coupon = Code
//                  Set`), never a sentence
//   insight-stream the insight exchange mid-stream: every chip landed, the
//                  lead-in and first bullet whole, the second bullet cut
//                  mid-sentence, no answer yet, the composer's Stop face
//
// Self-contained: nothing here imports fixtures.ts, so there is no cycle to
// order. Wiring (the integrator's): fixtures.ts HarnessState + HARNESS_STATES
// + exchangeFor + choiceFor (RICH_CHOICE), AskHarness.seed (busy / phase from
// `richSeed`; park these states at the top, the text is the subject),
// ask-frames.ts ALL_STATES, tauriShim (`plugin:opener|open_url` → nothing).

import type { AskAnswer, AskPhase } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";

export type RichState = "insight" | "insight-prose" | "insight-steps" | "insight-code" | "insight-stream";
export const RICH_STATES: readonly RichState[] = [
  "insight",
  "insight-prose",
  "insight-steps",
  "insight-code",
  "insight-stream",
];

export interface RichSeed {
  exchange: Exchange;
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the order_v2 thread's choice, so the pill reads what the footers read */
export const RICH_CHOICE = { provider: PROVIDER, model: MODEL } as const;

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

const CANDIDATES = ["public.order_v2", "public.users"];
const CONTEXT = (q: string) =>
  `${q}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n` +
  "public.order_v2 (2.1M rows): id, user_id, payment_status, total_amount, metadata, created_at, paid_at, shipped_at\n" +
  "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted";

const DESCRIBE_ORDERS = chip(
  "call-1",
  "describe_tables",
  "describe order_v2",
  418,
  { names: ["order_v2"] },
  [
    "order_v2 (2,104,377 rows) -- One row per checkout attempt, failed included.",
    "  id bigint PK",
    "  user_id bigint → users.id",
    "  payment_status text: cod_delivered, failed, paid, cod_pending, cancelled, rto, refunded, pending, partial_refund",
    "  total_amount numeric(12,2)",
    "  metadata jsonb",
    "  created_at timestamptz",
    "  paid_at timestamptz null",
    "  shipped_at timestamptz null",
  ].join("\n"),
);

const PEEK_STATUS = chip(
  "call-2",
  "peek_values",
  "peek payment_status",
  84,
  { table: "public.order_v2", column: "payment_status" },
  [
    "payment_status | count",
    "cod_delivered | 612,884",
    "paid | 401,209",
    "failed | 388,120",
    "cod_pending | 302,415",
    "cancelled | 171,006",
    "rto | 118,733",
    "refunded | 64,290",
    "pending | 29,412",
    "partial_refund | 16,308",
  ].join("\n"),
);

interface Seed {
  id: string;
  question: string;
  /** the model's last text block, verbatim */
  text: string;
  /** narration before the last block, as the turn's raw text keeps it */
  narration: string[];
  chips: ToolChip[];
  sql: string | null;
  run: AgentRun | null;
  assumptions: Assumption[];
  followUps: string[];
  turnMs: number;
  totalMs: number;
}

/** one finished exchange of one qwry turn through Claude Code, the loop's
 * trace in loop order: context, the turn (its whole text), its tool calls,
 * the verdict, the follow-ups call */
function landed(s: Seed): Exchange {
  const rowCount = s.run?.rowCount ?? null;
  const usage = { input: 14_800, output: 360, cacheRead: 13_000, cacheWrite: 0 };
  const trace: TraceStep[] = [
    { step: "context", ms: 3, candidates: CANDIDATES, text: CONTEXT(s.question) },
    { step: "turn", ms: s.turnMs, index: 0, text: [...s.narration, s.text].join("\n\n"), usage },
    ...s.chips.map(tool),
    { step: "verdict", ms: s.totalMs, verdict: { status: "answered", sql: s.sql, rowCount } },
    {
      step: "followups",
      ms: 1400,
      prompt: `Question: ${s.question}\n\nAnswer:\n${s.text}\n\nSQL:\n${s.sql ?? "none"}`,
      text: s.followUps.join("\n"),
      questions: s.followUps,
      usage: { input: 480, output: 36 },
    },
  ];
  const answer: AskAnswer = {
    verdict: { status: "answered", sql: s.sql, rowCount },
    sql: s.sql,
    run: s.run,
    assumptions: s.assumptions,
    sanity: [],
    followUps: s.followUps,
    trace,
    text: s.text,
    turns: 1,
    ms: s.totalMs,
    usage,
    promptVersion: "v3",
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

// ---- insight: August orders by payment state ------------------------------------

const INSIGHT_QUESTION = "what stood out in orders last month";

const INSIGHT_SQL = [
  "SELECT payment_status, COUNT(*) AS orders, SUM(total_amount) AS amount",
  "FROM order_v2",
  "WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01'",
  "GROUP BY 1",
  "ORDER BY 2 DESC",
].join("\n");

/** nine rows, three columns: the grid the bullets never restate */
const BY_STATE: [string, string, string][] = [
  ["cod_delivered", "731", "1988640.00"],
  ["failed", "611", "1402315.00"],
  ["paid", "482", "2277416.00"],
  ["cod_pending", "418", "982300.00"],
  ["cancelled", "207", "498115.00"],
  ["rto", "143", "341270.00"],
  ["refunded", "96", "214880.00"],
  ["pending", "54", "121905.00"],
  ["partial_refund", "21", "61420.00"],
];

const INSIGHT_RUN: AgentRun = {
  columns: ["payment_status", "orders", "amount"],
  rows: BY_STATE.map((r) => [...r]),
  rowCount: 9,
  capped: false,
  ms: 412.588,
};

/** the lead-in carries the denominator (the chip names the month); every
 * bullet is one finding with its figure and none holds a cell of the grid */
const INSIGHT_BODY = [
  "**Across 2,763 orders:**",
  "- A prepaid basket averages ₹4,725, a COD basket ₹2,564.",
  "- Failed payments are 22% of attempts, more than every refund and return combined.",
  "- Collected ₹4,266,056 so far, and the COD still in transit would add another 23%.",
].join("\n");

const INSIGHT_TEXT =
  `${INSIGHT_BODY}\n\n` +
  "```sql\n" +
  INSIGHT_SQL +
  "\n```\n\n" +
  "Assumptions: Last Month = August 2026; Orders = created_at";

const INSIGHT_RUN_CHIP = chip(
  "call-3",
  "run_sql",
  "run",
  413,
  { sql: INSIGHT_SQL },
  ["payment_status | orders | amount", ...BY_STATE.map((r) => r.join(" | "))].join("\n"),
);

const INSIGHT_FOLLOW_UPS = [
  "Why do so many payments fail?",
  "How does August compare with July?",
  "Which cities return the most COD?",
];

const insight = landed({
  id: "harness-ex-insight",
  question: INSIGHT_QUESTION,
  text: INSIGHT_TEXT,
  narration: [
    "I'll describe order_v2 to find its payment and amount columns.",
    "Checking the payment states before grouping by them.",
    "Grouping August by payment state.",
  ],
  chips: [DESCRIBE_ORDERS, PEEK_STATUS, INSIGHT_RUN_CHIP],
  sql: INSIGHT_SQL,
  run: INSIGHT_RUN,
  assumptions: [
    { id: "model:0", label: "Last Month = August 2026", source: "model", active: true },
    { id: "model:1", label: "Orders = created_at", source: "model", active: true },
  ],
  followUps: INSIGHT_FOLLOW_UPS,
  turnMs: 21_900,
  totalMs: 24_600,
});

// ---- insight-stream: the same answer, the second bullet half arrived -------------

/** mid-stream: the run has landed on its chip but the verdict has not, so the
 * slot reads `hasRun` from the chip; the text ends mid-sentence */
const insightStream: Exchange = {
  id: "harness-ex-insight-stream",
  turnId: null,
  question: INSIGHT_QUESTION,
  text: "**Across 2,763 orders:**\n- A prepaid basket averages ₹4,725, a COD basket ₹2,564.\n- Failed payments are 22% of attempts, more than",
  thinking: "",
  chips: [DESCRIBE_ORDERS, PEEK_STATUS, INSIGHT_RUN_CHIP],
  answer: null,
  error: null,
  streaming: true,
  provider: PROVIDER,
  model: MODEL,
};

// ---- insight-prose: which timestamp, no run -------------------------------------

const PEEK_PAID_AT = chip(
  "call-2",
  "peek_values",
  "peek paid_at",
  212,
  { table: "public.order_v2", column: "paid_at" },
  [
    "paid_at | count",
    "NULL | 1,021,644",
    "2026-09-05 09:41:12+00 | 3",
    "2026-09-05 09:40:57+00 | 2",
    "2026-09-05 09:40:31+00 | 2",
    "… 1,082,726 more distinct values",
  ].join("\n"),
);

/** one sentence, the model's own comparison as a markdown table (no run to
 * restate, so it renders as the grid), a closing sentence whose link text is
 * an identifier in backticks (the W5 sketch gate's S3: data wears data's
 * clothes inside a link too) */
const PROSE_TEXT = [
  "Use `created_at`. The three timestamps mark three different moments, and only one of them is the customer's:",
  "",
  "| column | set by | null for |",
  "|---|---|---|",
  "| created_at | checkout | never |",
  "| paid_at | payment webhook | COD in transit |",
  "| shipped_at | warehouse | unshipped |",
  "",
  "`created_at` is a `timestamptz`, so a month bucket follows the session time zone: [`date_trunc`](https://www.postgresql.org/docs/current/functions-datetime.html) has the rule.",
].join("\n");

const insightProse = landed({
  id: "harness-ex-insight-prose",
  question: "which timestamp should I use for when an order was placed",
  text: PROSE_TEXT,
  narration: ["I'll describe order_v2 to see its timestamp columns.", "Checking how often paid_at is set."],
  chips: [DESCRIBE_ORDERS, PEEK_PAID_AT],
  sql: null,
  run: null,
  assumptions: [],
  followUps: [
    "How many orders were paid but never shipped?",
    "How long does COD take to land, on average?",
    "Which orders have a paid_at before created_at?",
  ],
  turnMs: 17_300,
  totalMs: 18_900,
});

// ---- insight-steps: how to count, no run ------------------------------------------

/** the comment quoted under the lead-in that names its source, the inference
 * the comment does not state, then the steps in the order the reader follows
 * them: the one ordered list a v3 answer earns */
const STEPS_TEXT = [
  "**Comment on `order_v2`:**",
  "> One row per checkout attempt, failed included.",
  "",
  "So a bare count is attempts, not orders. Counting the orders placed is two steps:",
  "",
  "1. Drop the `failed` rows.",
  "2. Bucket the rest by `created_at`. `paid_at` lands days later for COD.",
].join("\n");

const insightSteps = landed({
  id: "harness-ex-insight-steps",
  question: "how do I count orders placed each month",
  text: STEPS_TEXT,
  narration: ["I'll describe order_v2 first.", "Checking what payment_status holds."],
  chips: [DESCRIBE_ORDERS, PEEK_STATUS],
  sql: null,
  run: null,
  assumptions: [],
  followUps: [
    "How many orders were placed each month this year?",
    "What share of checkout attempts fail?",
    "How many orders change month if bucketed by paid_at?",
  ],
  turnMs: 13_900,
  totalMs: 15_200,
});

// ---- insight-code: a JSON shape over a value ---------------------------------------

const COUPON_SQL = [
  "SELECT COUNT(*) AS coupon_orders",
  "FROM order_v2",
  "WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01'",
  "  AND metadata->'coupon'->>'code' IS NOT NULL",
].join("\n");

const PEEK_METADATA = chip(
  "call-2",
  "peek_values",
  "peek metadata",
  391,
  { table: "public.order_v2", column: "metadata" },
  [
    "metadata | count",
    "{} | 1,388,402",
    '{"coupon": {"code": "FIRST10", "kind": "percent", "value": 10}} | 212,930',
    '{"coupon": {"code": "FREESHIP", "kind": "shipping", "value": 0}} | 96,114',
    '{"coupon": {}} | 41,207',
    "… 2,918 more distinct values",
  ].join("\n"),
);

/** the shape the peek found, as a non-SQL fence; the filter it implies (a
 * coupon is a set code) is the second chip, so Retry Without Assumption can
 * undo it, and no sentence says it again (the W5 sketch gate's S1) */
const COUPON_TEXT =
  "Coupons sit inside `metadata`, in this shape:\n\n" +
  "```json\n" +
  '{"coupon": {"code": "FIRST10", "kind": "percent", "value": 10}}\n' +
  "```\n\n" +
  "```sql\n" +
  COUPON_SQL +
  "\n```\n\n" +
  "Assumptions: August = created_at; Coupon = Code Set";

const insightCode = landed({
  id: "harness-ex-insight-code",
  question: "how many of the august orders were placed with a coupon",
  text: COUPON_TEXT,
  narration: [
    "I'll describe order_v2 to find where a coupon would live.",
    "Peeking metadata for the coupon shape.",
    "Counting August orders whose coupon has a code.",
  ],
  chips: [DESCRIBE_ORDERS, PEEK_METADATA, chip("call-3", "run_sql", "run", 96, { sql: COUPON_SQL }, "coupon_orders\n1096")],
  sql: COUPON_SQL,
  run: { columns: ["coupon_orders"], rows: [["1096"]], rowCount: 1, capped: false, ms: 96.41 },
  assumptions: [
    { id: "model:0", label: "August = created_at", source: "model", active: true },
    { id: "model:1", label: "Coupon = Code Set", source: "model", active: true },
  ],
  followUps: [
    "Which coupon codes were used most?",
    "How much did coupons take off in August?",
    "Do coupon orders fail payment more often?",
  ],
  turnMs: 26_800,
  totalMs: 29_400,
});

export function richSeed(state: RichState): RichSeed {
  switch (state) {
    case "insight":
      return { exchange: insight, busy: false, phase: null };
    case "insight-prose":
      return { exchange: insightProse, busy: false, phase: null };
    case "insight-steps":
      return { exchange: insightSteps, busy: false, phase: null };
    case "insight-code":
      return { exchange: insightCode, busy: false, phase: null };
    case "insight-stream":
      return { exchange: insightStream, busy: true, phase: "thinking" };
  }
}
