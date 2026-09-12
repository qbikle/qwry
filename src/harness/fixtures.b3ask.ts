// Ask-side fixture for the B3 canvas-agent wave (the sketch's `b3-ask-summary`
// row of ask-sketch-b3.html): what a canvas-targeted answer leaves in the
// PANE, framed in the pane. Same conventions as fixtures.ts (the store's own
// types, the harness connection `staging` on `auth_new`, prose that interprets
// and never repeats a cell), on the sketch's own Sonnet 5 through Claude Code:
//
//   b3-ask-summary  one exchange whose answer went onto a canvas. Bubble with
//                   the `@"Canvas 4"` pill, the strip (`describe order_v2` ·
//                   `peek payment_status` · `run ×3` · `canvas ×2`, the two
//                   canvas calls coalescing the way `run ×3` does), the status
//                   line `4 blocks · Canvas 4` with the title as the link that
//                   shows the tab, three follow-ups, the footer. No answer
//                   text, no result block, no assumption chips and no answer
//                   cluster: all four stand on the canvas already, so the
//                   exchange is four always-visible lines where a normal
//                   answer is seven (DESIGN rule 14, canvas-agent 3.2). The
//                   composer carries the prefilled pill and the caret after it
//
// The pill in the bubble is minted from the exchange's own `canvasWrites`, the
// way a query tab's is minted from `tabName` (AGENT-UX 15): it names where the
// answer WENT, so closing that tab could not un-pill a bubble that reported
// its destination. The COMPOSER's pill is not: a draft's tags resolve against
// the connection's canvas tabs, so the frame seeds the tab the prefill names
// (`tabs`, active) and the pill in the composer paints as a pill.
// The four block ids are the document's; the pane never reads the document,
// only this record of it, which is what the status line counts (LESSONS 13).
//
// The model's closing line rides in the trace and nowhere else: the CANVAS
// block asks for one sentence and no `sql` fence, and the answer slot renders
// nothing for it (`.ans-text:empty` collapses, AGENT-UX 2 item 3). `text` is
// therefore left empty ON the exchange, which is what a canvas answer looks
// like once its verdict has landed; the trace's `turn` step keeps the words.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add B3_ASK_STATES to HarnessState, HARNESS_STATES and ask-frames' ALL_STATES;
// `exchangeFor` returns null for it (the thread is read whole, the echo shape)
// and `choiceFor` gives it B3_ASK_CHOICE; in `seed`, put
// `b3AskSeed(state).exchanges` under the fixture thread with
// `followUps: { [tid]: b3AskSeed(state).followUps }`, no busy and no phase,
// and `drafts: { [FIXTURE.profile.id]: b3AskSeed(state).draft }` with
// `draftFor: FIXTURE.profile.id` so the composer's prefilled pill stands;
// `useTabs.setState({ tabs: seed.tabs, activeId: seed.activeTabId })` so that
// pill resolves against a canvas tab and paints as one.

import type { AskAnswer } from "../agent/loop";
import type { TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import type { Tab } from "../stores/tabs";
import { FIXTURE } from "./fixtures";

export const B3_ASK_STATES = ["b3-ask-summary"] as const;
export type B3AskState = (typeof B3_ASK_STATES)[number];

const PROVIDER = "claude-code";
const MODEL = "claude-sonnet-5";
/** the sketch's own footer: `2 turns · 48.1 s · Sonnet 5` */
export const B3_ASK_CHOICE = { provider: PROVIDER, model: MODEL } as const;

export interface B3AskSeed {
  /** the thread, oldest first */
  exchanges: Exchange[];
  /** useAgent.followUps for the thread */
  followUps: string[];
  /** the connection's composer draft: the prefilled pill and the space after
   * it, which is what an empty draft beside an active canvas tab reads
   * (stores/agent `syncCanvasPill`) */
  draft: string;
  /** the workspace behind the pane: the canvas TAB the draft's pill resolves
   * against (stores/tabs `canvasTabRefs`), which is what makes the composer
   * paint a pill instead of plain text (AskPanel's `mentionCtx`) */
  tabs: Tab[];
  /** and it is the ACTIVE one, because a prefilled pill is what an active
   * canvas tab puts in an empty draft */
  activeTabId: string;
}

const CANVAS_ID = "harness-canvas-4";
const CANVAS_TITLE = "Canvas 4";
const CANVAS_PILL = `@"${CANVAS_TITLE}"`;
const QUESTION = `${CANVAS_PILL} what stood out in orders last month`;

/** the four blocks the answer wrote, in write order: the figure row, the
 * channel chart, the reading, the gateway table (the canvas root's own
 * `b3-canvas-analysis`). The pane holds their IDS and nothing else */
const BLOCK_IDS = ["b3f2a1c0", "9c11d4e7", "a0417bb2", "77de3f81"];

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

const MONTH_SQL = [
  "SELECT count(*) AS orders,",
  "       count(DISTINCT user_id) AS customers,",
  "       to_char(sum(total_amount), 'FM999,999,999') AS revenue",
  "FROM order_v2",
  "WHERE created_at >= date_trunc('month', now() - interval '1 month')",
  "  AND created_at <  date_trunc('month', now())",
].join("\n");

const CHANNEL_SQL = [
  "SELECT channel, count(*) AS orders",
  "FROM order_v2",
  "WHERE created_at >= date_trunc('month', now() - interval '1 month')",
  "  AND created_at <  date_trunc('month', now())",
  "GROUP BY 1",
  "ORDER BY 2 DESC",
].join("\n");

const GATEWAY_SQL = [
  "SELECT gateway, count(*) AS failed,",
  "       to_char(100.0 * count(*) / sum(count(*)) OVER (), 'FM990.0%') AS share",
  "FROM order_v2",
  "WHERE payment_status = 'failed'",
  "  AND created_at >= date_trunc('month', now() - interval '1 month')",
  "  AND created_at <  date_trunc('month', now())",
  "GROUP BY 1",
  "ORDER BY 2 DESC",
].join("\n");

const describeOrders = chip(
  "b3-call-1",
  "describe_tables",
  "describe order_v2",
  412,
  { names: ["order_v2"] },
  "order_v2 (1,204,310 rows)\n  id bigint PK\n  user_id bigint FK users.id\n  total_amount numeric\n  channel text: app, web, instagram, cod\n  gateway text\n  payment_status text\n  created_at timestamptz",
);
const peekStatus = chip(
  "b3-call-2",
  "peek_values",
  "peek payment_status",
  188,
  { table: "order_v2", column: "payment_status", limit: 20 },
  "paid\npending\nfailed\nrefunded",
);
const runMonth = chip(
  "b3-call-3",
  "run_sql",
  "run",
  96,
  { sql: MONTH_SQL },
  "orders | customers | revenue\n2,763 | 1,904 | 4,266,056\n(1 row)",
);
const runChannels = chip(
  "b3-call-4",
  "run_sql",
  "run",
  208,
  { sql: CHANNEL_SQL },
  "channel | orders\napp | 1,602\ninstagram | 611\nweb | 388\ncod | 162\n(6 rows total, showing 5)",
);
const runGateways = chip(
  "b3-call-5",
  "run_sql",
  "run",
  188,
  { sql: GATEWAY_SQL },
  "gateway | failed | share\nrazorpay | 402 | 66%\npayu | 134 | 22%\ncod_verify | 58 | 9%\npaypal | 17 | 3%\n(4 rows)",
);
/** the two canvas calls: three blocks, then the reading once their shapes came
 * back. Both wear the label `canvas`, so the strip coalesces them `canvas ×2`
 * exactly as it coalesces `run ×3`; the trace step keeps the true name */
const canvasFirst = chip(
  "b3-call-6",
  "canvas_write",
  "canvas",
  61,
  {
    blocks: [
      { kind: "result", title: "Orders last month", sql: MONTH_SQL, face: "values" },
      { kind: "result", title: "Orders by channel", sql: CHANNEL_SQL, face: "chart" },
      { kind: "result", title: "Failed payments by gateway", sql: GATEWAY_SQL, face: "table" },
    ],
  },
  [
    'Wrote 3 blocks to "Canvas 4".',
    "b3f2  result  Orders last month · values face",
    "orders | customers | revenue",
    "2,763 | 1,904 | 4,266,056",
    "(1 row)",
    "9c11  result  Orders by channel · chart face",
    "channel | orders",
    "app | 1,602",
    "instagram | 611",
    "web | 388",
    "cod | 162",
    "(6 rows total, showing 5)",
    "77de  result  Failed payments by gateway · table face",
    "gateway | failed | share",
    "razorpay | 402 | 66%",
    "payu | 134 | 22%",
    "cod_verify | 58 | 9%",
    "paypal | 17 | 3%",
    "(4 rows)",
  ].join("\n"),
);
const canvasSecond = chip(
  "b3-call-7",
  "canvas_write",
  "canvas",
  44,
  {
    blocks: [
      {
        kind: "note",
        text: "**Against July:**\n- COD is 43% of the month, six points up on July; the app's share held at 58%.\n- Failed attempts went from 15% of checkouts to 22%, all of it after the gateway change on the 12th.\n- Instagram grew 31% on July while web fell 9%, the only channel that shrank.",
      },
    ],
    after: "77de",
  },
  ['Wrote 1 block to "Canvas 4".', "a041  note    Against July: COD is 43% of the month, six points…"].join(
    "\n",
  ),
);

const CHIPS = [describeOrders, peekStatus, runMonth, runChannels, runGateways, canvasFirst, canvasSecond];

/** the model's closing line: one sentence, no fence, because the statements
 * are on the canvas (the CANVAS block's last clause). It stands in the trace
 * and nowhere else */
const CLOSING = "Four blocks are on Canvas 4: the month's figures, orders by channel, failed payments by gateway, and what changed against July.";

const CANDIDATES = [
  "public.order_v2 (1.2M rows): id, user_id, total_amount, channel, gateway, payment_status, created_at",
  "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
];

const FOLLOW_UPS = [
  "Which gateway failed most after the 12th?",
  "How does COD share differ by city?",
  "Did Instagram orders convert to paid?",
];

const usage = { input: 18_400, output: 620, cacheRead: 16_100, cacheWrite: 0 };

/** the CANVAS block rides LAST on the user message, after the candidates and
 * the risk check: it governs where the whole answer lands, which is the
 * outermost instruction (canvas-agent 3.1) */
const CONTEXT = [
  QUESTION,
  "",
  `CANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n${CANDIDATES.join("\n")}`,
  "",
  `CANVAS: the user is working in the canvas "${CANVAS_TITLE}", and your answer goes INTO it through the canvas tools, not into this reply.`,
  `OUTLINE OF "${CANVAS_TITLE}" (0 blocks): empty.`,
].join("\n");

const TRACE: TraceStep[] = [
  { step: "context", ms: 4, candidates: CANDIDATES, text: CONTEXT, mentions: [{ kind: "canvas", token: `"${CANVAS_TITLE}"` }] },
  { step: "turn", ms: 24_600, index: 0, text: "I'll read the table first, then write the month's figures.", usage },
  tool(describeOrders),
  tool(peekStatus),
  { step: "turn", ms: 19_100, index: 1, text: CLOSING, usage },
  tool(runMonth),
  tool(runChannels),
  tool(runGateways),
  tool(canvasFirst),
  tool(canvasSecond),
  { step: "verdict", ms: 48_100, verdict: { status: "answered", sql: null, rowCount: null } },
  {
    step: "followups",
    ms: 940,
    prompt: `Question: ${QUESTION}\n\nAnswer:\n${CLOSING}`,
    text: FOLLOW_UPS.join("\n"),
    questions: FOLLOW_UPS,
    usage: { input: 380, output: 31 },
  },
];

/** the verdict a canvas answer lands on: answered, with no SQL and no run of
 * its own, which is the shape the loop already produces when the model closes
 * without a fence. No new AnswerStatus, no new verdict */
const ANSWER: AskAnswer = {
  verdict: { status: "answered", sql: null, rowCount: null },
  sql: null,
  run: null,
  // each result block carries its own `assumed` fragment on the canvas
  // (canvas-agent-spec 2.7), so the pane holds none
  assumptions: [],
  sanity: [],
  trace: TRACE,
  text: CLOSING,
  turns: 2,
  ms: 48_100,
  usage,
  promptVersion: "v4",
  candidates: CANDIDATES,
  recall: null,
  risky: false,
};

const summary: Exchange = {
  id: "harness-ex-b3-summary",
  turnId: 61,
  question: QUESTION,
  // the answer slot renders nothing: the reading is on the canvas, and the
  // model's closing sentence is in the trace (canvas-agent 3.2 item 3)
  text: "",
  thinking: "",
  chips: CHIPS,
  answer: ANSWER,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
  canvasWrites: {
    canvasId: CANVAS_ID,
    blockIds: BLOCK_IDS,
    title: CANVAS_TITLE,
    replaced: 0,
  },
};

const TAB_ID = "b3-tab-canvas-4";

/** the canvas the answer wrote to, open and ACTIVE behind the pane: the tab
 * the composer's prefilled pill names (stores/tabs `canvasTabRefs`). Built
 * inside the function, which is where every fixture reads `FIXTURE` (the
 * anatomy precedent: fixtures.ts imports this module) */
const tab = (): Tab => ({
  id: TAB_ID,
  name: CANVAS_TITLE,
  sql: "",
  position: 1,
  saved_id: null,
  kind: "canvas",
  table: null,
  canvas_id: CANVAS_ID,
  profile_id: FIXTURE.profile.id,
});

export function b3AskSeed(_state: B3AskState): B3AskSeed {
  return {
    exchanges: [summary],
    followUps: FOLLOW_UPS,
    draft: `${CANVAS_PILL} `,
    tabs: [tab()],
    activeTabId: TAB_ID,
  };
}
