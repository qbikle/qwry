// D1 ask fixtures for the Ask harness: the one state the maintainer's list
// names (item 11), drawn so that two of the wave's findings stand in one
// frame.
//
//   d1-list-numbered  `how do I move order_v2 onto the new payment_status
//                     enum` answered as an ordered list of fourteen steps
//                     over a nine-row run. Two subjects: the NUMERALS (item
//                     5), right-aligned in a fixed gutter so `1.` and `14.`
//                     end on one edge instead of the second digit hanging
//                     past the answer's own left margin; and the SEAM (item
//                     2), the 16px between the list's last line and the
//                     block's grid header, which the old 8 read as none.
//                     Fourteen steps is the stress case for the gutter and
//                     not the prompt's norm (a how-do-I answer is usually two
//                     or three, `insight-steps`): the frame has to hold a
//                     one-digit and a two-digit ordinal at once for the
//                     alignment to be provable at all.
//
// The two slots never carry one fact (DESIGN rule 14): the steps are the
// runbook, the grid is the batch plan the model sized off the id range, and
// no step prints a number the grid shows. A `-top` run frames the numerals,
// the default bottom pin frames the seam; the list is written one line per
// step at 392 so both ends reach a frame.
//
// Self-contained: nothing here imports fixtures.ts, so there is no cycle to
// order. Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the
// integrator's): APPEND D1_ASK_STATES to HarnessState, HARNESS_STATES and
// ask-frames' ALL_STATES; in `exchangeFor` return `d1AskSeed(state).exchange`
// and in `choiceFor` return D1_ASK_CHOICE; in AskHarness.seed take the busy
// and phase from `d1AskSeed`. Park it at the BOTTOM (the pane's own default),
// where the prose-to-block seam sits; `--scroll top` reaches the numerals.
// The follow-up row needs nothing: `followUpsFor` reads it off the exchange's
// own `followups` trace step, which this one carries.

import type { AskAnswer, AskPhase } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";

export const D1_ASK_STATES = ["d1-list-numbered"] as const;
export type D1AskState = (typeof D1_ASK_STATES)[number];

export interface D1AskSeed {
  exchange: Exchange;
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the order_v2 thread's choice, so the pill reads what the footer reads */
export const D1_ASK_CHOICE = { provider: PROVIDER, model: MODEL } as const;

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

const QUESTION = "how do I move order_v2 onto the new payment_status enum";

const CANDIDATES = ["public.order_v2"];
const CONTEXT =
  `${QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n` +
  "public.order_v2 (2.1M rows): id, user_id, payment_status, total_amount, metadata, created_at, paid_at, shipped_at";

const DESCRIBE = chip(
  "call-1",
  "describe_tables",
  "describe order_v2",
  392,
  { names: ["order_v2"] },
  [
    "order_v2 (2,104,377 rows) -- One row per checkout attempt, failed included.",
    "  id bigint PK",
    "  user_id bigint → users.id",
    "  payment_status text",
    "  total_amount numeric(12,2)",
    "  created_at timestamptz",
  ].join("\n"),
);

const PEEK = chip(
  "call-2",
  "peek_values",
  "peek payment_status",
  96,
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

/** the batch plan, the one thing the model ran: the steps say to backfill in
 * these ranges and never name one of their numbers (DESIGN rule 14) */
const SQL = [
  "SELECT batch, min(id) AS id_from, max(id) AS id_to, count(*) AS rows",
  "FROM (SELECT id, ntile(9) OVER (ORDER BY id) AS batch FROM order_v2) t",
  "GROUP BY batch",
  "ORDER BY batch",
].join("\n");

const BATCHES: [string, string, string, string][] = [
  ["1", "1", "238114", "233820"],
  ["2", "238115", "471902", "233820"],
  ["3", "471903", "706338", "233820"],
  ["4", "706339", "944017", "233820"],
  ["5", "944018", "1183466", "233820"],
  ["6", "1183467", "1420905", "233820"],
  ["7", "1420906", "1655214", "233820"],
  ["8", "1655215", "1889770", "233819"],
  ["9", "1889771", "2126503", "233818"],
];

const RUN: AgentRun = {
  columns: ["batch", "id_from", "id_to", "rows"],
  rows: BATCHES.map((r) => [...r]),
  rowCount: 9,
  capped: false,
  ms: 806.417,
};

const RUN_CHIP = chip("call-3", "run_sql", "run", 806, { sql: SQL }, [
  "batch | id_from | id_to | rows",
  ...BATCHES.map((r) => r.join(" | ")),
].join("\n"));

/** the runbook: a sequence the reader follows, which is what an ordered list
 * is for. One line per step at 392, so a frame can hold the whole run of
 * ordinals and the seam under it needs only the other scroll position */
const BODY = [
  "**The order that never holds a long lock:**",
  "1. Create the enum with the nine names in use.",
  "2. Add payment_state as a nullable column.",
  "3. Backfill it in the id ranges below.",
  "4. Run one range per statement, never in a loop.",
  "5. Commit each range before the next one starts.",
  "6. Compare the two columns after every range.",
  "7. Add the NOT NULL check as NOT VALID.",
  "8. Validate it, which takes a share lock only.",
  "9. Point the read path at the new column.",
  "10. Keep both columns written for a week.",
  "11. Diff them nightly while both are written.",
  "12. Stop writing the old column.",
  "13. Drop it in a migration of its own.",
  "14. Drop the check the column no longer needs.",
].join("\n");

const TEXT =
  `${BODY}\n\n` +
  "```sql\n" +
  SQL +
  "\n```\n\n" +
  "Assumptions: Safely = No Lock Over a Second; Batches = Nine by Id";

const ASSUMPTIONS: Assumption[] = [
  { id: "model:0", label: "Safely = No Lock Over a Second", source: "model", active: true },
  { id: "model:1", label: "Batches = Nine by Id", source: "model", active: true },
];

const FOLLOW_UPS = [
  "How long does one range take on staging?",
  "What breaks if a range fails halfway?",
  "Which code still writes payment_status?",
];

const NARRATION = [
  "I'll describe order_v2 before touching its payment column.",
  "Reading the states in use, so the enum carries all of them.",
  "Sizing the backfill off the id range.",
];

const TURN_MS = 16_400;
const TOTAL_MS = 18_700;
const USAGE = { input: 15_200, output: 480, cacheRead: 13_400, cacheWrite: 0 };

const trace: TraceStep[] = [
  { step: "context", ms: 3, candidates: CANDIDATES, text: CONTEXT },
  { step: "turn", ms: TURN_MS, index: 0, text: [...NARRATION, TEXT].join("\n\n"), usage: USAGE },
  ...[DESCRIBE, PEEK, RUN_CHIP].map(tool),
  { step: "verdict", ms: TOTAL_MS, verdict: { status: "answered", sql: SQL, rowCount: 9 } },
  {
    step: "followups",
    ms: 1_320,
    prompt: `Question: ${QUESTION}\n\nAnswer:\n${TEXT}\n\nSQL:\n${SQL}`,
    text: FOLLOW_UPS.join("\n"),
    questions: FOLLOW_UPS,
    usage: { input: 520, output: 38 },
  },
];

const answer: AskAnswer = {
  verdict: { status: "answered", sql: SQL, rowCount: 9 },
  sql: SQL,
  run: RUN,
  assumptions: ASSUMPTIONS,
  sanity: [],
  trace,
  text: TEXT,
  turns: 1,
  ms: TOTAL_MS,
  usage: USAGE,
  promptVersion: "v4",
  candidates: CANDIDATES,
  recall: null,
  risky: false,
};

const listNumbered: Exchange = {
  id: "harness-ex-d1-list",
  turnId: 2,
  question: QUESTION,
  text: TEXT,
  thinking: "",
  chips: [DESCRIBE, PEEK, RUN_CHIP],
  answer,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

export function d1AskSeed(state: D1AskState): D1AskSeed {
  switch (state) {
    case "d1-list-numbered":
      return { exchange: listNumbered, busy: false, phase: null };
  }
}
