// A2 states for the Ask fixture harness (the sketch's "A2 · knowledge and quiz"
// rows 1 to 3, `~/projects/qwry-agent-lab/docs/ask-sketch-a2.html`). Same
// conventions as fixtures.ts and its siblings: the store's own types, the
// harness connection `staging` on `auth_new`, the model's LAST text block
// verbatim, prose that interprets and never repeats a cell (DESIGN rule 14),
// over the W6 order_v2 schema and bookmarks so every tag resolves:
//
//   a2-explain          `Explain with Ask` on the `cohort retention` tab: the
//                       bubble carries ONE pill wearing the tab's name, drawn
//                       from the exchange's own `tab` and never re-resolved (a
//                       closed tab must not un-pill a question that was really
//                       sent), the strip's second
//                       chip is `run EXPLAIN`, and the answer is prose in the
//                       slot that exists. The model wrote no fence, so `sql`
//                       is null, nothing ran, no result block stands under it
//                       and Save Query is disabled in the prose cluster
//                       (DESIGN rule 2's matrix). 6 always-visible elements,
//                       as W7 left an older exchange
//   a2-knowledge-trace  the drawer open at the `knowledge` step of a question
//                       this connection's own knowledge fed: two hints, one
//                       definition, one synonym and two earlier answers, the
//                       label counting exactly what the body under it holds
//                       (LESSONS 13). The kind column is 76px so `KNOWLEDGE`
//                       stands whole beside context · turn · tool · verdict
//   a2-ask-why          the exchange `Ask Why` opens on a failed check: the
//                       bubble names the check as a saved-query pill, the rows
//                       that drifted stand in the block, the drift is the
//                       prose's two bullets, and one `Assumed` chip says where
//                       the model read a state. An ordinary exchange, which is
//                       the point: nothing new stands for a check's answer
//
// The seed carries what the pills need: the wave's snapshot and saved queries
// (fixtures.mentions.ts), the failing check itself as a bookmark of the
// connection (so `Why did @"…" fail its check?` resolves), and the two open
// tabs `a2-explain` names. Reads `FIXTURE` only inside functions (the anatomy
// precedent), so the import cycle never reads an uninitialised binding.
//
// Wiring (the integrator's): fixtures.ts HarnessState + HARNESS_STATES,
// `exchangeFor` → null (whole threads are read here, the echo shape) and
// `choiceFor` → the discussion thread's Haiku 4.5; AskHarness.seed:
// `knowledgeSeed(state)` gives `exchanges`, `snapshot`, `saved` and `tabs`
// (`useTabs.setState({ tabs, activeId })`, which no state seeded before this
// one); AskHarness's post-mount effect: `knowledgeTraceFor(state)` → openTrace
// beside mentionsEchoTraceFor, then `knowledgeAfterMount(state)` in the rAF;
// ask-frames.ts ALL_STATES.

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import type { TraceTarget } from "../stores/ask";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot } from "../stores/schema";
import type { Tab } from "../stores/tabs";
import { MENTION_SNAPSHOT, ORDER_V2_COMMENT, mentionSaved } from "./fixtures.mentions";

export const KNOWLEDGE_STATES = ["a2-explain", "a2-knowledge-trace", "a2-ask-why"] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

export interface KnowledgeSeed {
  /** the fixture thread's exchanges, oldest first */
  exchanges: Exchange[];
  /** the snapshot under the fixture profile: the wave's order_v2 schema */
  snapshot: SchemaSnapshot;
  /** the connection's saved queries, the failing check among them */
  saved: SavedQuery[];
  /** the workspace's tabs and the one that is active: the `tab` pill names it */
  tabs: Tab[];
  activeTabId: string;
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
const PROFILE = "harness-staging";

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

// ---- the workspace the tab pill names ---------------------------------------------

const TAB_NAME = "cohort retention";

const TAB_SQL = [
  "WITH first_orders AS (",
  "  SELECT user_id, MIN(created_at) AS first_at",
  "  FROM order_v2 WHERE payment_status <> 'failed' GROUP BY user_id",
  ")",
  "SELECT date_trunc('month', f.first_at)::date AS cohort,",
  "       COUNT(DISTINCT f.user_id) AS buyers,",
  "       COUNT(DISTINCT o.user_id) AS returned",
  "FROM first_orders f",
  "LEFT JOIN order_v2 o",
  "  ON o.user_id = f.user_id AND o.created_at >= f.first_at + interval '30 days'",
  "GROUP BY 1 ORDER BY 1;",
].join("\n");

const tab = (id: string, name: string, sql: string, position: number): Tab => ({
  id,
  name,
  sql,
  position,
  saved_id: null,
  kind: "query",
  table: null,
  canvas_id: null,
  profile_id: PROFILE,
});

const TABS: Tab[] = [
  tab("harness-tab-cohort", TAB_NAME, TAB_SQL, 0),
  tab(
    "harness-tab-orders",
    "orders by status",
    "SELECT payment_status, COUNT(*) FROM order_v2 GROUP BY 1;",
    1,
  ),
];

// ---- a2-explain -------------------------------------------------------------------

const EXPLAIN_Q = `Explain this query @"${TAB_NAME}"`;

/** the line the app composed under the tags' own header (stores/agent
 * `explainWithAsk`): the tab by name, then the statement that was sent */
const EXPLAIN_CONTEXT = `tab "${TAB_NAME}":\n${TAB_SQL}`;

/** the model's last text block, verbatim: a lead-in and three findings about
 * the plan, no fence (nothing is being proposed to run) and no Assumptions
 * line, so the answer is prose and the block below it never mounts */
const EXPLAIN_TEXT = [
  "Two passes over `order_v2`, joined on `user_id`:",
  "",
  "- `first_orders` keeps each buyer's earliest non-failed order: a hash aggregate over 2.1M rows into 184k buyers.",
  "- The self-join reads the table again to find a second order 30 days or more after the first, 1.9M rows out of the hash join.",
  "- The month bucket and the two DISTINCT counts sort those 1.9M rows, 71% of the estimated cost; nothing indexes `(user_id, created_at)`.",
].join("\n");

const EXPLAIN_PLAN = [
  "GroupAggregate  (cost=418992.14..429117.02 rows=12 width=24)",
  "  Group Key: (date_trunc('month', f.first_at))",
  "  ->  Sort  (cost=418992.14..423738.55 rows=1898564 width=24)",
  "        Sort Key: (date_trunc('month', f.first_at))",
  "        ->  Hash Left Join  (cost=71204.00..184402.19 rows=1898564 width=24)",
  "              Hash Cond: (o.user_id = f.user_id)",
  "              Join Filter: (o.created_at >= (f.first_at + '30 days'::interval))",
  "              ->  Seq Scan on order_v2 o  (cost=0.00..61204.31 rows=2104331 width=16)",
  "              ->  Hash  (cost=48922.10..48922.10 rows=184312 width=16)",
  "                    ->  HashAggregate  (cost=45235.88..48922.10 rows=184312 width=16)",
  "                          Group Key: order_v2.user_id",
  "                          ->  Seq Scan on order_v2  (cost=0.00..66468.14 rows=2081992 width=16)",
  "                                Filter: (payment_status <> 'failed'::text)",
].join("\n");

const explainChips: ToolChip[] = [
  chip(
    "call-1",
    "describe_tables",
    "describe order_v2",
    364,
    { names: ["order_v2"] },
    `order_v2 (2,104,331 rows)  -- ${ORDER_V2_COMMENT}\n  id uuid PK\n  user_id bigint → users.id\n  payment_status text: paid, pending, failed, refunded\n  total_amount numeric\n  created_at timestamptz`,
  ),
  // the run's statement is the exception the chip names (AGENT-UX 2 item 2)
  chip("call-2", "run_sql", "run EXPLAIN", 212, { sql: `EXPLAIN ${TAB_SQL}` }, EXPLAIN_PLAN),
];

const EXPLAIN_FOLLOW_UPS = [
  "Which index would take the sort out?",
  "How does the plan change for August alone?",
  "Can the self-join become a window function?",
];

const explainTrace = (): TraceStep[] => [
  {
    step: "context",
    ms: 3,
    candidates: ["order_v2", "users", "order_items", "payments"],
    text: `${EXPLAIN_Q}\n\nCANDIDATE TABLES (pre-selected from 202 tables; if none fit, call list_tables):\norder_v2(id, user_id, payment_status, total_amount, created_at)  -- ${ORDER_V2_COMMENT}\nusers(id, email, created_at, signup_source, is_deleted)\n\nTAGGED BY THE USER:\n${EXPLAIN_CONTEXT}`,
  },
  {
    step: "turn",
    ms: 16_900,
    index: 0,
    text: `Reading the plan for the tagged tab.\n\n${EXPLAIN_TEXT}`,
    usage: { input: 9_400, output: 288, cacheRead: 8_100, cacheWrite: 0 },
  },
  ...explainChips.map(tool),
  { step: "verdict", ms: 18_400, verdict: { status: "answered", sql: null, rowCount: null } },
  {
    step: "followups",
    ms: 1100,
    prompt: `Question: ${EXPLAIN_Q}\n\nAnswer:\n${EXPLAIN_TEXT}`,
    text: EXPLAIN_FOLLOW_UPS.join("\n"),
    questions: EXPLAIN_FOLLOW_UPS,
    usage: { input: 520, output: 38 },
  },
];

const explainAnswer = (): AskAnswer => ({
  verdict: { status: "answered", sql: null, rowCount: null },
  sql: null,
  run: null,
  assumptions: [],
  sanity: [],
  trace: explainTrace(),
  text: EXPLAIN_TEXT,
  turns: 1,
  ms: 18_400,
  usage: { input: 9_400, output: 288, cacheRead: 8_100, cacheWrite: 0 },
  promptVersion: "v4",
  candidates: ["order_v2", "users", "order_items", "payments"],
  recall: null,
  risky: false,
});

const explainExchange = (): Exchange => ({
  id: "harness-ex-a2-explain",
  turnId: 40,
  // the pill names what was SENT: a fact about the exchange, kept on it, so a
  // closed tab can never un-pill the bubble (stores/agent `Exchange.tabName`);
  // the statement rides beside it as the line the app composed for the tags
  tabName: TAB_NAME,
  context: EXPLAIN_CONTEXT,
  question: EXPLAIN_Q,
  text: EXPLAIN_TEXT,
  thinking: "",
  chips: explainChips,
  answer: explainAnswer(),
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
});

// ---- a2-knowledge-trace -----------------------------------------------------------

const KNOW_Q = "how many active buyers made purchases in august";

const KNOW_SQL = [
  "SELECT COUNT(DISTINCT o.user_id) AS active_buyers",
  "FROM order_v2 o",
  "JOIN users u ON u.id = o.user_id",
  "WHERE o.payment_status <> 'failed'",
  "  AND o.created_at >= '2026-08-01' AND o.created_at < '2026-09-01'",
  "  AND u.last_seen_at >= now() - interval '30 days';",
].join("\n");

const KNOW_RUN: AgentRun = {
  columns: ["active_buyers"],
  rows: [["7412"]],
  rowCount: 1,
  capped: false,
  ms: 212.4,
};

const KNOW_TEXT =
  "7,412 buyers who signed in this month bought in August, 41% of everyone who bought that month.\n\n" +
  "```sql\n" +
  KNOW_SQL +
  "\n```\n\n" +
  "Assumptions: August = created_at";

/** the KNOWLEDGE and EARLIER ANSWERS blocks exactly as the user message
 * carried them; the step's own lists say what survived the caps, so the
 * label above counts what the body shows and nothing else (LESSONS 13) */
const KNOWLEDGE_HINTS = ["order_v2", "order_v2.gender"];
const KNOWLEDGE_DEFINITIONS = ["active buyers"];
const KNOWLEDGE_SYNONYMS = ["purchases"];
const KNOWLEDGE_HISTORY = [
  "what stood out in orders last month",
  "how many of those august orders came from customers who had never ordered before that month",
];

const KNOWLEDGE_BODY = [
  "KNOWLEDGE:",
  `order_v2  -- Checkout attempts, one row each; failed ones stay. Revenue questions want payment_status <> 'failed'.`,
  "order_v2.gender  -- the buyer's gender, not the garment's",
  "purchases -> order_v2",
  "active buyers: signed in within the last 30 days (users.last_seen_at)",
  "",
  "EARLIER ANSWERS ON THIS DATABASE:",
  `Q: ${KNOWLEDGE_HISTORY[0]}`,
  "SQL: SELECT payment_status, COUNT(*) AS orders, SUM(total_amount) AS amount FROM order_v2 WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01' GROUP BY payment_status ORDER BY orders DESC;",
  `Q: ${KNOWLEDGE_HISTORY[1]}`,
  "SQL: SELECT COUNT(*) AS first_time_customers FROM order_v2 o WHERE o.created_at >= '2026-08-01' AND o.created_at < '2026-09-01' AND NOT EXISTS (SELECT 1 FROM order_v2 p WHERE p.user_id = o.user_id AND p.created_at < '2026-08-01');",
].join("\n");

const KNOW_CANDIDATES = [
  "order_v2",
  "users",
  "order_items",
  "order_refunds",
  "payments",
  "carts",
  "cart_products",
  "products",
  "sessions",
];

const knowChips: ToolChip[] = [
  chip(
    "call-1",
    "describe_tables",
    "describe order_v2",
    402,
    { names: ["order_v2", "users"] },
    `order_v2 (2,104,331 rows)  -- ${ORDER_V2_COMMENT}\n  user_id bigint → users.id\n  payment_status text: paid, pending, failed, refunded\n  created_at timestamptz\nusers (1,204,310 rows)\n  id bigint PK\n  last_seen_at timestamptz`,
  ),
  chip(
    "call-2",
    "peek_values",
    "peek payment_status",
    41,
    { table: "order_v2", column: "payment_status" },
    "paid, pending, failed, refunded",
  ),
  chip("call-3", "run_sql", "run", 212, { sql: KNOW_SQL }, "active_buyers\n7412\n(1 row)"),
];

const knowTrace = (): TraceStep[] => [
  {
    step: "context",
    ms: 3,
    candidates: KNOW_CANDIDATES,
    // the message WITHOUT the two blocks: they are the knowledge step's own
    // body, and a block in two slots is the same fact twice (DESIGN rule 14)
    text: `${KNOW_Q}\n\nCANDIDATE TABLES (pre-selected from 202 tables; if none fit, call list_tables):\norder_v2(id, user_id, payment_status, total_amount, created_at)  -- ${ORDER_V2_COMMENT}\nusers(id, email, last_seen_at, signup_source, is_deleted)`,
  },
  {
    step: "knowledge",
    ms: 1,
    text: KNOWLEDGE_BODY,
    // the label counts what the body holds, counted once off the same lists
    // (LESSONS 13); a kind with nothing contributes no count at all
    counts: {
      hints: KNOWLEDGE_HINTS.length,
      definitions: KNOWLEDGE_DEFINITIONS.length,
      synonyms: KNOWLEDGE_SYNONYMS.length,
      history: KNOWLEDGE_HISTORY.length,
    },
  },
  {
    step: "turn",
    ms: 23_600,
    index: 0,
    text: `Lining the definition up against the users table before counting.\n\n${KNOW_TEXT}`,
    usage: { input: 15_200, output: 296, cacheRead: 13_100, cacheWrite: 0 },
  },
  ...knowChips.map(tool),
  { step: "verdict", ms: 24_100, verdict: { status: "answered", sql: KNOW_SQL, rowCount: 1 } },
];

const knowExchange = (): Exchange => ({
  id: "harness-ex-a2-knowledge",
  turnId: 41,
  question: KNOW_Q,
  text: KNOW_TEXT,
  thinking: "",
  chips: knowChips,
  answer: {
    verdict: { status: "answered", sql: KNOW_SQL, rowCount: 1 },
    sql: KNOW_SQL,
    run: KNOW_RUN,
    assumptions: [{ id: "model:0", label: "August = created_at", source: "model", active: true }],
    sanity: [],
    trace: knowTrace(),
    text: KNOW_TEXT,
    turns: 1,
    ms: 24_100,
    usage: { input: 15_200, output: 296, cacheRead: 13_100, cacheWrite: 0 },
    promptVersion: "v4",
    candidates: KNOW_CANDIDATES,
    recall: null,
    risky: false,
  },
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
});

// ---- a2-ask-why -------------------------------------------------------------------

/** the check the palette's failed row names, a bookmark of the connection with
 * an expectation on it and a verdict that did not pass */
export const CHECK_NAME = "Unpaid orders older than a week";
const CHECK_SQL = [
  "SELECT payment_status, COUNT(*) AS orders, MAX(EXTRACT(day FROM now() - created_at))::int AS oldest_days",
  "FROM order_v2",
  "WHERE payment_status IN ('pending', 'cod_pending')",
  "  AND created_at < now() - interval '7 days'",
  "GROUP BY 1 ORDER BY 2 DESC;",
].join("\n");

const WHY_Q = `Why did @"${CHECK_NAME}" fail its check?`;

/** the line the app appended to the tag (stores/agent `askWhy`): the drift in
 * the very words the palette's failed row prints (stores/checks `driftLabel`,
 * LESSONS 13) */
const WHY_CONTEXT = `check "${CHECK_NAME}": 12 rows · expected 0`;

const WHY_ROWS: string[][] = [
  ["cod_pending", "9", "9"],
  ["pending", "3", "13"],
];

const WHY_RUN: AgentRun = {
  columns: ["payment_status", "orders", "oldest_days"],
  rows: WHY_ROWS,
  rowCount: 2,
  capped: false,
  ms: 88.14,
};

const WHY_TEXT =
  "12 orders past the week, none of them lost:\n\n" +
  "- 9 are `cod_pending`: parcels delivered on Sep 4 whose cash collection has not been posted, the oldest 9 days.\n" +
  "- 3 are `pending`: card attempts that never received a webhook, 11 to 13 days old; the check was written before COD launched in July.\n\n" +
  "```sql\n" +
  CHECK_SQL +
  "\n```\n\n" +
  "Assumptions: Unpaid = Pending or COD Pending";

const whyChips: ToolChip[] = [
  chip(
    "call-1",
    "describe_tables",
    "describe order_v2",
    377,
    { names: ["order_v2"] },
    `order_v2 (2,104,331 rows)  -- ${ORDER_V2_COMMENT}\n  payment_status text: paid, pending, failed, refunded, cod_pending\n  created_at timestamptz\n  delivered_at timestamptz null`,
  ),
  chip(
    "call-2",
    "peek_values",
    "peek payment_status",
    38,
    { table: "order_v2", column: "payment_status" },
    "paid, pending, failed, refunded, cod_pending",
  ),
  chip("call-3", "run_sql", "run", 62, { sql: CHECK_SQL }, "12 rows"),
  chip(
    "call-4",
    "run_sql",
    "run",
    88,
    { sql: CHECK_SQL },
    ["payment_status | orders | oldest_days", ...WHY_ROWS.map((r) => r.join(" | ")), "(2 rows)"].join(
      "\n",
    ),
  ),
];

const whyAssumptions: Assumption[] = [
  { id: "model:0", label: "Unpaid = Pending or COD Pending", source: "model", active: true },
];

const WHY_FOLLOW_UPS = [
  "Should cod_pending count as unpaid at all?",
  "Which of the 3 pending orders have a payment attempt?",
  "How many COD parcels post cash within a week?",
];

const whyTrace = (): TraceStep[] => [
  {
    step: "context",
    ms: 4,
    candidates: ["order_v2", "payments", "payment_attempts", "order_shipments"],
    // the check rides as a saved query, and its expectation and what it found
    // are appended to the same line: the answer can only say what drifted if
    // it was told both (AGENT-SPEC 8.4, nothing sent is hidden)
    text: `${WHY_Q}\n\nCANDIDATE TABLES (pre-selected from 202 tables; if none fit, call list_tables):\norder_v2(id, user_id, payment_status, total_amount, created_at)  -- ${ORDER_V2_COMMENT}\npayments(id, order_id, gateway, status, amount, captured_at)\n\nTAGGED BY THE USER:\nsaved query "${CHECK_NAME}":\n${CHECK_SQL}\n${WHY_CONTEXT}`,
    mentions: [{ kind: "saved", token: `"${CHECK_NAME}"` }],
  },
  {
    step: "turn",
    ms: 20_900,
    index: 0,
    text: `Reading the statuses the check counts before running it again.\n\n${WHY_TEXT}`,
    usage: { input: 12_600, output: 302, cacheRead: 10_900, cacheWrite: 0 },
  },
  ...whyChips.map(tool),
  { step: "verdict", ms: 21_700, verdict: { status: "answered", sql: CHECK_SQL, rowCount: 2 } },
  {
    step: "followups",
    ms: 1200,
    prompt: `Question: ${WHY_Q}\n\nAnswer:\n${WHY_TEXT}\n\nSQL:\n${CHECK_SQL}`,
    text: WHY_FOLLOW_UPS.join("\n"),
    questions: WHY_FOLLOW_UPS,
    usage: { input: 590, output: 44 },
  },
];

const whyExchange = (): Exchange => ({
  id: "harness-ex-a2-why",
  turnId: 42,
  context: WHY_CONTEXT,
  question: WHY_Q,
  text: WHY_TEXT,
  thinking: "",
  chips: whyChips,
  answer: {
    verdict: { status: "answered", sql: CHECK_SQL, rowCount: 2 },
    sql: CHECK_SQL,
    run: WHY_RUN,
    assumptions: whyAssumptions,
    sanity: [],
    trace: whyTrace(),
    text: WHY_TEXT,
    turns: 1,
    ms: 21_700,
    usage: { input: 12_600, output: 302, cacheRead: 10_900, cacheWrite: 0 },
    promptVersion: "v4",
    candidates: ["order_v2", "payments", "payment_attempts", "order_shipments"],
    recall: null,
    risky: false,
  },
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
});

// ---- exports ----------------------------------------------------------------------

/** the connection's bookmarks: the W6 pair, the failing check the `Ask Why`
 * bubble names, and one quick-ask (a saved query that kept its question), so
 * the store behind the palette's Saved group holds all three kinds of row */
export function knowledgeSaved(): SavedQuery[] {
  return [
    ...mentionSaved(),
    {
      id: "harness-saved-unpaid-week",
      name: CHECK_NAME,
      sql: CHECK_SQL,
      created_at: "2026-07-19T11:05:00Z",
      profile_id: PROFILE,
      expect_json: JSON.stringify({ kind: "rows", op: "eq", n: 0 }),
      last_check_json: JSON.stringify({
        ok: false,
        rows: 12,
        at: "2026-09-06T09:12:00Z",
      }),
    },
    {
      id: "harness-saved-quick-ask",
      name: KNOW_Q,
      sql: KNOW_SQL,
      created_at: "2026-09-05T18:22:00Z",
      profile_id: PROFILE,
      question: KNOW_Q,
    },
  ];
}

/** the thread a state shows and everything its pills resolve against */
export function knowledgeSeed(state: KnowledgeState): KnowledgeSeed {
  const exchanges =
    state === "a2-explain"
      ? [explainExchange()]
      : state === "a2-knowledge-trace"
        ? [knowExchange()]
        : [whyExchange()];
  return {
    exchanges,
    snapshot: MENTION_SNAPSHOT,
    saved: knowledgeSaved(),
    tabs: TABS,
    activeTabId: TABS[0].id,
  };
}

/** the trace target a state opens with: the knowledge step itself, which is
 * the row the state is about (the anatomy precedent) */
export function knowledgeTraceFor(state: KnowledgeState): TraceTarget | null {
  return state === "a2-knowledge-trace"
    ? { exchangeId: "harness-ex-a2-knowledge", stepId: "knowledge" }
    : null;
}

/** the post-mount hook: the two answered states park at the question, whose
 * bubble is the subject in both (the `actions` rest); the trace state leaves
 * the scroller where the pane put it */
export function knowledgeAfterMount(state: string): void {
  if (state !== "a2-explain" && state !== "a2-ask-why") return;
  const id = state === "a2-explain" ? "harness-ex-a2-explain" : "harness-ex-a2-why";
  const at = document.querySelector<HTMLElement>(`[data-exchange="${id}"]`);
  const sc = document.querySelector<HTMLElement>(".ask-scroll");
  if (!at || !sc) return;
  const pad = parseFloat(getComputedStyle(sc).paddingTop) || 0;
  sc.scrollTop += at.getBoundingClientRect().top - sc.getBoundingClientRect().top - pad;
}
