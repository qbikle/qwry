// Round-3 strip states for the Ask fixture harness (W2d, the maintainer's
// asks 3 and 4), same conventions as fixtures.ts (the store's own types, the
// harness connection `staging` on `auth_new`, prose that interprets and never
// repeats the data):
//
//   qwrying        a question just sent: the echo, then the strip holding
//                  `qwrying…` alone (no chip yet, no text yet; the composer
//                  wears the Stop face)
//   qwrying-trail  two landed chips and the word trailing them: the model is
//                  thinking between calls, nothing has streamed
//   kv-wide        one row × three columns: name-over-value pairs that flow as
//                  a row from a 480px slot up (shoot at 560) and stack below
//                  (shoot at 320)
//
// Self-contained: nothing here imports fixtures.ts, so there is no cycle to
// order. Wiring (the integrator's): fixtures.ts HarnessState + HARNESS_STATES
// + exchangeFor, AskHarness.seed (busy / phase from `stripSeed`), ask-frames.ts
// ALL_STATES.

import type { AskAnswer, AskPhase } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";

export type StripState = "qwrying" | "qwrying-trail" | "kv-wide";
export const STRIP_STATES: readonly StripState[] = ["qwrying", "qwrying-trail", "kv-wide"];

export interface StripSeed {
  exchange: Exchange;
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-sonnet-5";

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

const DESCRIBE_NH = chip(
  "call-1",
  "describe_tables",
  "describe notification_history",
  402,
  { names: ["notification_history"] },
  "notification_history (12,043,118 rows)\n  id bigint PK\n  user_id bigint → users.id\n  notification_type text: order_update, promo, reminder, system\n  channel text: push, email, sms\n  sent_at timestamptz\n  opened_at timestamptz null",
);

const PEEK_TYPE = chip(
  "call-2",
  "peek_values",
  "peek notification_type",
  96,
  { table: "public.notification_history", column: "notification_type" },
  "notification_type | count\npromo | 6,412,908\norder_update | 3,820,114\nreminder | 1,506,330\nsystem | 303,766",
);

// ---- qwrying: just sent ---------------------------------------------------------

const qwrying: Exchange = {
  id: "harness-ex-qwrying",
  turnId: null,
  question: "How many wardrobes have more than 50 products?",
  text: "",
  thinking: "",
  chips: [],
  answer: null,
  error: null,
  streaming: true,
  provider: PROVIDER,
  model: MODEL,
};

// ---- qwrying-trail: between calls -----------------------------------------------

const qwryingTrail: Exchange = {
  id: "harness-ex-qwrying-trail",
  turnId: null,
  question: "Which notification types were sent most in August?",
  text: "",
  thinking: "",
  chips: [DESCRIBE_NH, PEEK_TYPE],
  answer: null,
  error: null,
  streaming: true,
  provider: PROVIDER,
  model: MODEL,
};

// ---- kv-wide: one row, three columns ---------------------------------------------

const KV_QUESTION = "How many users signed up this quarter, and when were the first and last?";

const KV_SQL = [
  "SELECT COUNT(*) AS signups,",
  "       MIN(created_at)::date AS first_signup,",
  "       MAX(created_at)::date AS last_signup",
  "FROM users",
  "WHERE NOT is_deleted",
  "  AND created_at >= date_trunc('quarter', now())",
].join("\n");

const KV_TEXT =
  "Signups by `created_at` with deleted users left out; the quarter runs from July to today.\n\n" +
  "```sql\n" +
  KV_SQL +
  "\n```\n\n" +
  "Assumptions: Excluding Deleted Users; This Quarter = Q3 2026";

const KV_RUN: AgentRun = {
  columns: ["signups", "first_signup", "last_signup"],
  rows: [["48213", "2026-07-01", "2026-09-05"]],
  rowCount: 1,
  capped: false,
  ms: 812.44,
};

const kvChips: ToolChip[] = [
  chip(
    "call-1",
    "describe_tables",
    "describe users",
    388,
    { names: ["users"] },
    "users (1,204,310 rows)\n  id bigint PK\n  email text\n  created_at timestamptz\n  signup_source text\n  is_deleted boolean",
  ),
  chip(
    "call-2",
    "peek_values",
    "peek is_deleted",
    61,
    { table: "public.users", column: "is_deleted" },
    "is_deleted | count\nfalse | 1,180,204\ntrue | 24,106",
  ),
  chip("call-3", "run_sql", "run", 812, { sql: KV_SQL }, "signups | first_signup | last_signup\n48213 | 2026-07-01 | 2026-09-05\n(1 row)"),
];

const kvAssumptions: Assumption[] = [
  { id: "model:0", label: "Excluding Deleted Users", source: "model", active: true },
  { id: "model:1", label: "This Quarter = Q3 2026", source: "model", active: true },
];

const KV_FOLLOW_UPS = [
  "How do this quarter's signups compare with last quarter's?",
  "Which signup source grew most this quarter?",
  "How many of this quarter's signups have a wardrobe?",
];

const kvUsage = { input: 11_800, output: 240, cacheRead: 10_400, cacheWrite: 0 };
const KV_CANDIDATES = ["public.users (1.2M rows): id, email, created_at, signup_source, is_deleted"];

const kvTrace: TraceStep[] = [
  {
    step: "context",
    ms: 3,
    candidates: KV_CANDIDATES,
    text: `${KV_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n${KV_CANDIDATES.join("\n")}`,
  },
  { step: "turn", ms: 5_400, index: 0, text: KV_TEXT, usage: kvUsage },
  ...kvChips.map(tool),
  { step: "verdict", ms: 6_900, verdict: { status: "answered", sql: KV_SQL, rowCount: 1 } },
  {
    step: "followups",
    ms: 1100,
    prompt: `Question: ${KV_QUESTION}\n\nAnswer:\n${KV_TEXT}\n\nSQL:\n${KV_SQL}`,
    text: KV_FOLLOW_UPS.join("\n"),
    questions: KV_FOLLOW_UPS,
    usage: { input: 480, output: 44 },
  },
];

const kvAnswer: AskAnswer = {
  verdict: { status: "answered", sql: KV_SQL, rowCount: 1 },
  sql: KV_SQL,
  run: KV_RUN,
  assumptions: kvAssumptions,
  sanity: [],
  followUps: KV_FOLLOW_UPS,
  trace: kvTrace,
  text: KV_TEXT,
  turns: 1,
  ms: 6_900,
  usage: kvUsage,
  promptVersion: "v2",
  candidates: KV_CANDIDATES,
  recall: null,
  risky: false,
};

const kvWide: Exchange = {
  id: "harness-ex-kv-wide",
  turnId: 18,
  question: KV_QUESTION,
  text: KV_TEXT,
  thinking: "",
  chips: kvChips,
  answer: kvAnswer,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

// ---- exports ---------------------------------------------------------------------

export function stripSeed(state: StripState): StripSeed {
  switch (state) {
    case "qwrying":
      return { exchange: qwrying, busy: true, phase: "thinking" };
    case "qwrying-trail":
      return { exchange: qwryingTrail, busy: true, phase: "thinking" };
    case "kv-wide":
      return { exchange: kvWide, busy: false, phase: null };
  }
}
