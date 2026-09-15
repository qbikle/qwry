// Ask-side fixtures for the A3 canvas wave (the sketch's `a3-add` and
// `a3-ask-block` rows of ask-sketch-a3.html): what the CANVAS changes about
// the pane, framed in the pane. Same conventions as fixtures.ts (the store's
// own types, the harness connection `staging` on `auth_new`, the model's LAST
// text block verbatim with its fence and Assumptions line, prose that
// interprets and never repeats a cell, DESIGN rule 14), on the discussion
// thread's Haiku 4.5 through Claude Code:
//
//   a3-add        the W5 `insight` exchange with its own cluster revealed:
//                 Copy · Save Query · Add to Canvas over the answer text's
//                 first line, 3 hot where W7 framed 2, the panel fading in
//                 from the left under them and the prose dissolving into it
//                 at the 320 floor. The scroller parks at the top, the
//                 sketch's rest, so the still holds the bubble, the strip and
//                 the cluster it is evidence for
//   a3-ask-block  a question asked FROM a canvas block: the revenue exchange
//                 the block was added from, then `@"can you check the revenue
//                 in last month" is the USD share growing?` answered as any
//                 other exchange. The block resolves (the seed registers it
//                 in useAsk.blocks, which is what `Ask` on a block does), so
//                 the bubble wears one `.mention` pill wrapping with the
//                 words: at 320 it breaks across two lines with rounded ends
//                 on both fragments, at 560 the question is two lines. The
//                 trace's context step carries the tag, so `tagged "can you
//                 check the revenue in last month"` is the record of it
//
// The block a question names is NOT part of the exchange: it is a session
// fact of the pane (stores/ask.ts `blocks`, the `@` ladder's fifth rung), so
// the seed hands it over separately and a frame that forgot it would show
// plain text, which is exactly what a deleted block gives back (LESSONS 5).
//
// The hot face: a hover cannot be held in a still, so `canvasAskAfterMount`
// stamps `data-hot` on the hot exchange's prose slot (ask.css reads
// `.ans-prose[data-hot] > .acts-float` as its hover), the `answer-actions`
// precedent. Frames run under reduced motion, so every cluster wears its
// settled face and no spring is in flight.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add CANVAS_ASK_STATES to HarnessState, HARNESS_STATES and ask-frames'
// ALL_STATES; `exchangeFor` returns null for them (the thread is read whole,
// the echo shape) and `choiceFor` gives them CANVAS_ASK_CHOICE; in `seed`,
// these states put `canvasAskSeed(state).exchanges` under the fixture thread
// with `followUps: { [tid]: canvasAskSeed(state).followUps }`, no busy and no
// phase, and `useAsk.setState({ blocks: canvasAskSeed(state).blocks })`; in
// the post-mount rAF call `canvasAskAfterMount(state)` beside
// `answerAfterMount(state)`, before the ready mark.

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import type { AskBlock } from "../stores/ask";
import { echoExchangesFor } from "./fixtures.echo";
import { richSeed } from "./fixtures.rich";

export const CANVAS_ASK_STATES = ["a3-add", "a3-ask-block"] as const;
export type CanvasAskState = (typeof CANVAS_ASK_STATES)[number];

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the discussion thread's choice, so the pill reads what the footers read */
export const CANVAS_ASK_CHOICE = { provider: PROVIDER, model: MODEL } as const;

export interface CanvasAskSeed {
  /** the thread, oldest first */
  exchanges: Exchange[];
  /** useAgent.followUps for the thread: the row stands under the last of them */
  followUps: string[];
  /** useAsk.blocks: the canvas blocks these questions may name */
  blocks: Record<string, AskBlock>;
}

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

// ---- the block the second state's question names ---------------------------

/** the revenue exchange, as a canvas block: its question line is its name,
 * its statement and the shape of its four rows are what the model is given
 * (mentions.ts `mentionContext`, the block rung) */
const REVENUE_QUESTION = "can you check the revenue in last month";
const REVENUE_BLOCK: AskBlock = {
  id: "harness-block-revenue",
  name: REVENUE_QUESTION,
  sql: [
    "SELECT SUM(total_amount) AS revenue, COUNT(*) AS order_count, currency",
    "FROM order_v2",
    "WHERE payment_status = 'paid'",
    "  AND created_at >= date_trunc('month', now() - interval '1 month')",
    "  AND created_at <  date_trunc('month', now())",
    "GROUP BY currency",
    "ORDER BY revenue DESC",
  ].join("\n"),
  columns: ["revenue", "order_count", "currency"],
  rowCount: 4,
};

// ---- a3-ask-block: the question asked from that block ----------------------

const USD_QUESTION = `@"${REVENUE_QUESTION}" is the USD share growing?`;

const USD_SQL = [
  "SELECT date_trunc('month', created_at)::date AS month,",
  "       COUNT(*) FILTER (WHERE currency = 'USD') AS usd_orders,",
  "       ROUND(100.0 * COUNT(*) FILTER (WHERE currency = 'USD') / COUNT(*), 1) AS share",
  "FROM order_v2",
  "WHERE payment_status = 'paid'",
  "  AND created_at >= '2026-07-01' AND created_at < '2026-09-01'",
  "GROUP BY 1",
  "ORDER BY 1",
].join("\n");

const USD_ROWS: (string | null)[][] = [
  ["2026-07-01", "4", "0.9"],
  ["2026-08-01", "7", "1.4"],
];

const USD_RUN: AgentRun = {
  columns: ["month", "usd_orders", "share"],
  rows: USD_ROWS.map((r) => [...r]),
  rowCount: 2,
  capped: false,
  ms: 288.4,
};

const USD_TEXT =
  "USD is 1.4% of August's paid orders, up from 0.9% in July; the AUD and EUR tails did not move.\n\n" +
  "```sql\n" +
  USD_SQL +
  "\n```\n\n" +
  "Assumptions: Share = of Paid Orders";

const USD_ASSUMPTIONS: Assumption[] = [
  { id: "model:0", label: "Share = of Paid Orders", source: "model", active: true },
];

const USD_FOLLOW_UPS = [
  "Which users placed the USD orders?",
  "Is the USD share higher for new customers?",
  "What do USD orders cost to ship?",
];

const USD_CANDIDATES = [
  "public.order_v2 (1.2M rows): id, user_id, total_amount, currency, payment_status, created_at",
  "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
];

/** the tagged block reaches the model as the loop sends it: under the header
 * prompt.ts owns, naming the block, its statement and the shape of its rows,
 * never the rows (they stand on the canvas already, DESIGN rule 14) */
const USD_CONTEXT = [
  USD_QUESTION,
  "",
  `CANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n${USD_CANDIDATES.join("\n")}`,
  "",
  "TAGGED BY THE USER:",
  `canvas block "${REVENUE_QUESTION}":`,
  REVENUE_BLOCK.sql ?? "",
  "4 rows: revenue, order_count, currency",
].join("\n");

const describeOrders = chip(
  "call-1",
  "describe_tables",
  "describe order_v2",
  372,
  { names: ["order_v2"] },
  "order_v2 (1,204,310 rows)\n  id bigint PK\n  total_amount numeric\n  currency text: INR, USD, AUD, EUR\n  payment_status text\n  created_at timestamptz",
);
const runUsd = chip(
  "call-2",
  "run_sql",
  "run",
  288,
  { sql: USD_SQL },
  ["month | usd_orders | share", ...USD_ROWS.map((r) => r.join(" | "))].join("\n"),
);

const usage = { input: 13_100, output: 240, cacheRead: 11_600, cacheWrite: 0 };

const USD_TRACE: TraceStep[] = [
  {
    step: "context",
    ms: 3,
    candidates: USD_CANDIDATES,
    text: USD_CONTEXT,
    mentions: [{ kind: "block", token: `"${REVENUE_QUESTION}"` }],
  },
  { step: "turn", ms: 21_400, index: 0, text: USD_TEXT, usage },
  tool(describeOrders),
  tool(runUsd),
  { step: "verdict", ms: 22_800, verdict: { status: "answered", sql: USD_SQL, rowCount: 2 } },
  {
    step: "followups",
    ms: 1100,
    prompt: `Question: ${USD_QUESTION}\n\nAnswer:\n${USD_TEXT}\n\nSQL:\n${USD_SQL}`,
    text: USD_FOLLOW_UPS.join("\n"),
    questions: USD_FOLLOW_UPS,
    usage: { input: 460, output: 34 },
  },
];

const USD_ANSWER: AskAnswer = {
  verdict: { status: "answered", sql: USD_SQL, rowCount: 2 },
  sql: USD_SQL,
  run: USD_RUN,
  assumptions: USD_ASSUMPTIONS,
  sanity: [],
  trace: USD_TRACE,
  text: USD_TEXT,
  turns: 1,
  ms: 22_800,
  usage,
  promptVersion: "v3",
  candidates: USD_CANDIDATES,
  recall: null,
  risky: false,
};

/** the reply, which remembers the block it was asked from: Add to Canvas on
 * it lands the new block under that one rather than at the document's end */
const usdShare: Exchange = {
  id: "harness-ex-a3-usd",
  turnId: 42,
  question: USD_QUESTION,
  text: USD_TEXT,
  thinking: "",
  chips: [describeOrders, runUsd],
  answer: USD_ANSWER,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
  askedFrom: REVENUE_BLOCK.id,
};

// ---- exports ---------------------------------------------------------------

/** the exchange whose prose slot wears `data-hot` in a state: the cluster is
 * what both frames are about */
export function canvasAskHotExchangeId(state: CanvasAskState): string {
  return state === "a3-add" ? richSeed("insight").exchange.id : usdShare.id;
}

export function canvasAskSeed(state: CanvasAskState): CanvasAskSeed {
  if (state === "a3-add") {
    const exchange = richSeed("insight").exchange;
    return {
      exchanges: [exchange],
      followUps: [
        "Why do so many payments fail?",
        "How does August compare with July?",
        "Which cities return the most COD?",
      ],
      blocks: {},
    };
  }
  return {
    exchanges: [echoExchangesFor("echo")[0], usdShare],
    followUps: USD_FOLLOW_UPS,
    blocks: { [REVENUE_BLOCK.id]: REVENUE_BLOCK },
  };
}

/** the post-mount hook: the revealed cluster, and the sketch's rest. `a3-add`
 * parks at the top (the bubble, the strip and the cluster are the subject);
 * `a3-ask-block` parks at the tagged question, so the pill and the reply
 * under it are what the still holds. Runs in the harness's rAF after the
 * pane's own mount effects, so the bottom pin they made is what it moves */
export function canvasAskAfterMount(state: string): void {
  if (!(CANVAS_ASK_STATES as readonly string[]).includes(state)) return;
  const id = canvasAskHotExchangeId(state as CanvasAskState);
  const prose = document.querySelector<HTMLElement>(`[data-exchange="${id}"] .ans-prose`);
  if (prose) prose.dataset.hot = "";
  const sc = document.querySelector<HTMLElement>(".ask-scroll");
  if (!sc) return;
  if (state === "a3-add") {
    sc.scrollTop = 0;
    return;
  }
  const hot = document.querySelector<HTMLElement>(`[data-exchange="${id}"]`);
  if (!hot) return;
  const pad = parseFloat(getComputedStyle(sc).paddingTop) || 0;
  sc.scrollTop += hot.getBoundingClientRect().top - sc.getBoundingClientRect().top - pad;
}
