// Canned data for the Ask fixture harness: one connection, a schema snapshot
// the starters can draw real nouns from, and one thread per state. The
// `answer` exchange is the locked sketch's exchange
// (qwry-agent-lab/docs/ask-sketch-v2.html): a sixty-five-character question,
// three tool chips, the model's LAST text block as the answer (fence and
// Assumptions line included, as the model writes them; src/agent/display.ts
// strips them at render time and the trace keeps them raw), the earlier
// narration inside the one turn row's raw text (the loop pushes one `turn`
// step per qwry turn with the whole text, then the tools it ran), a nine-row
// run with the raw millisecond float, three assumptions (one five-word label,
// so the row wraps at the floor), three follow-ups, one turn of 20.4 s on
// Sonnet 5 through Claude Code. Types are the store's own, so a shape change
// here is a tsc failure, never a frame that quietly renders something else.
//
// `disconnected` and `small` are the configured empty state under the two
// composer variants the sketch does not draw: no session (textarea disabled,
// pill and starters dimmed) and a small-tier choice (the one pill that wears
// a badge).
//
// The round-2 states (the sketch's "Round 2 · new states" row) live in
// sibling files, one per builder, and are dispatched from `exchangeFor`:
// fixtures.interact.ts (`pending`, `retry`, `strip`: the chips' pending set,
// a retry over the prior answer, a nine-chip strip), fixtures.shell.ts
// (`threads`: the Threads sheet over the answer; its seeds are read by
// AskHarness and tauriShim directly) and fixtures.anatomy.ts (`scalar`,
// `kv`, `wide`, `trace`). Those files import `exchangeFor` from here and
// call it only inside functions, so the import cycle never reads an
// uninitialised binding.

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, Assumption, Thread, TraceStep } from "../agent/types";
import type { AgentThread, Profile } from "../ipc/types";
import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import type { Exchange, ToolChip } from "../stores/agent";
import { anatomyExchangeFor } from "./fixtures.anatomy";
import { interactSeed } from "./fixtures.interact";

export type HarnessState =
  | "answer"
  | "empty"
  | "busy"
  | "picker"
  | "failure"
  | "disconnected"
  | "small"
  | "pending"
  | "retry"
  | "strip"
  | "threads"
  | "scalar"
  | "kv"
  | "wide"
  | "trace";
export const HARNESS_STATES: readonly HarnessState[] = [
  "answer",
  "empty",
  "busy",
  "picker",
  "failure",
  "disconnected",
  "small",
  "pending",
  "retry",
  "strip",
  "threads",
  "scalar",
  "kv",
  "wide",
  "trace",
];
export const HARNESS_WIDTHS = [320, 392, 560] as const;
export type HarnessTheme = "dark" | "light";

const PROVIDER = "claude-code";
const MODEL = "claude-sonnet-5";
/** the `small` state's choice: llama-server reports the gguf path, the
 * registry matches the file name (LFM2.5 2.6B, small, 8k ctx) */
const SMALL_PROVIDER = "llama-server";
const SMALL_MODEL = "/models/LFM2.5-2.6B-Q4_K_M.gguf";

const profile: Profile = {
  id: "harness-staging",
  name: "staging",
  host: "staging-db.internal",
  port: 5432,
  dbname: "auth_new",
  user: "qwry_ro",
  sslmode: "require",
  color: "#2f9e7a",
  glyph: null,
  is_prod: false,
};

// ---- schema ---------------------------------------------------------------

const col = (name: string, type: string, attnum: number): TableInfo["columns"][number] => ({
  name,
  attnum,
  type,
  type_oid: 0,
  not_null: false,
  default: null,
});

const table = (
  oid: number,
  name: string,
  columns: TableInfo["columns"],
  reltuples: number,
): TableInfo => ({
  table_oid: oid,
  schema: "public",
  name,
  kind: "r",
  columns,
  pk: ["id"],
  has_children: false,
  reltuples,
  comment: null,
  parent_oid: null,
});

const fk = (src: string, col: string, dst: string) => ({
  src_schema: "public",
  src_table: src,
  src_cols: [col],
  dst_schema: "public",
  dst_table: dst,
  dst_cols: ["id"],
});

const TS = "timestamp with time zone";

const snapshot: SchemaSnapshot = {
  tables: [
    table(
      1,
      "notification_history",
      [
        col("id", "bigint", 1),
        col("user_id", "bigint", 2),
        col("notification_type", "text", 3),
        col("channel", "text", 4),
        col("sent_at", TS, 5),
        col("opened_at", TS, 6),
      ],
      12_043_118,
    ),
    table(
      2,
      "users",
      [
        col("id", "bigint", 1),
        col("email", "text", 2),
        col("created_at", TS, 3),
        col("signup_source", "text", 4),
        col("is_deleted", "boolean", 5),
      ],
      1_204_310,
    ),
    table(
      3,
      "wardrobes",
      [col("id", "bigint", 1), col("user_id", "bigint", 2), col("name", "text", 3), col("created_at", TS, 4)],
      842_117,
    ),
    table(
      4,
      "wardrobe_products_v2",
      [
        col("id", "bigint", 1),
        col("wardrobe_id", "bigint", 2),
        col("product_id", "bigint", 3),
        col("added_at", TS, 4),
      ],
      9_811_402,
    ),
    table(
      5,
      "sessions",
      [col("id", "bigint", 1), col("user_id", "bigint", 2), col("platform", "text", 3), col("started_at", TS, 4)],
      3_002_918,
    ),
  ],
  foreign_keys: [
    fk("notification_history", "user_id", "users"),
    fk("wardrobes", "user_id", "users"),
    fk("wardrobe_products_v2", "wardrobe_id", "wardrobes"),
    fk("sessions", "user_id", "users"),
  ],
  functions: [],
  schemas: ["public"],
  indexes: [],
  enums: [],
  sequences: [],
  extensions: [],
  server_version_num: 160004,
};

// ---- the thread -----------------------------------------------------------

const QUESTION = "How many notification histories were added each month this year?";

const thread: Thread = {
  id: "harness-thread",
  profileId: profile.id,
  title: QUESTION,
  createdAt: "2026-09-05T10:12:00Z",
};

const threadRow: AgentThread = {
  id: thread.id,
  profile_id: thread.profileId,
  title: thread.title,
  created_at: thread.createdAt,
};

const SQL = [
  "SELECT date_trunc('month', sent_at)::date AS month,",
  "       COUNT(*) AS notification_count",
  "FROM notification_history",
  "WHERE sent_at >= date_trunc('year', now())",
  "GROUP BY 1",
  "ORDER BY 1",
].join("\n");

const ROWS: [string, string][] = [
  ["2026-01-01", "491528"],
  ["2026-02-01", "3062"],
  ["2026-03-01", "1147"],
  ["2026-04-01", "826"],
  ["2026-05-01", "16"],
  ["2026-06-01", "9"],
  ["2026-07-01", "873890"],
  ["2026-08-01", "2949786"],
  ["2026-09-01", "327759"],
];

const run: AgentRun = {
  columns: ["month", "notification_count"],
  rows: ROWS.map((r) => [r[0], r[1]]),
  rowCount: 9,
  capped: false,
  ms: 1861.922375,
};

/** the model's last text block, verbatim: prose, the mandated fence, the
 * mandated Assumptions line. The display strip owns what of it renders. */
const FINAL_TEXT =
  "Counted by `sent_at`, the only timestamp on the table. 4.65M this year, 2.95M of it in August.\n\n" +
  "```sql\n" +
  SQL +
  "\n```\n\n" +
  "Assumptions: Added = sent_at; This Year = 2026; Months With No Rows Omitted";

const CONTEXT_TEXT =
  `${QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n` +
  "public.notification_history (12.0M rows): id, user_id, notification_type, channel, sent_at, opened_at\n" +
  "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted";

const DESCRIBE_ARGS = JSON.stringify({ names: ["notification_history"] });
const DESCRIBE_RESULT = [
  "notification_history (12,043,118 rows)",
  "  id bigint PK",
  "  user_id bigint → users.id",
  "  notification_type text: order_update, promo, reminder, system",
  "  channel text: push, email, sms",
  "  sent_at timestamptz",
  "  opened_at timestamptz null",
].join("\n");
const PROBE_ARGS = JSON.stringify({
  sqls: ["SELECT min(sent_at), max(sent_at) FROM notification_history"],
});
const PROBE_RESULT = "min | max\n2019-03-04 08:12:44+00 | 2026-09-05 09:58:01+00";
const RUN_ARGS = JSON.stringify({ sql: SQL });
const RUN_RESULT = ["month | notification_count", ...ROWS.map((r) => `${r[0]} | ${r[1]}`)].join("\n");

const FOLLOW_UPS = [
  "Which channels drove the August spike?",
  "How many users got more than 10 notifications in August?",
  "What share of notifications were opened?",
];

const chip = (
  id: string,
  name: ToolChip["name"],
  label: string,
  ms: number | null,
  args: string,
  result: string | null,
  isError = false,
): ToolChip => ({ id, name, label, ms, isError, args, result });

const describeChip = chip("call-1", "describe_tables", "describe notification_history", 412, DESCRIBE_ARGS, DESCRIBE_RESULT);
const probeChip = chip("call-2", "probe", "probe", 688, PROBE_ARGS, PROBE_RESULT);
const runChip = chip("call-3", "run_sql", "run", 1862, RUN_ARGS, RUN_RESULT);

const tool = (c: ToolChip): TraceStep => ({
  step: "tool",
  ms: c.ms ?? 0,
  id: c.id,
  name: c.name,
  args: c.args,
  result: c.result ?? "",
  isError: c.isError,
});

const usage = { input: 18_240, output: 412, cacheRead: 16_000, cacheWrite: 0 };

/** the whole text of the one qwry turn, as the loop records it: every block
 * the model wrote before a tool call is narration, kept raw here and never
 * in the answer (AGENT-UX 2.3) */
const TURN_TEXT = [
  "I'll describe notification_history to find its timestamp columns.",
  "Now probing the range of sent_at before counting by month.",
  "Running the monthly count.",
  FINAL_TEXT,
].join("\n\n");

/** one qwry turn through Claude Code (ownsLoop): the loop pushes the turn
 * step, then the tool calls the provider ran itself, then the verdict */
const answerTrace: TraceStep[] = [
  { step: "context", ms: 3, candidates: ["public.notification_history", "public.users"], text: CONTEXT_TEXT },
  { step: "turn", ms: 15_820, index: 0, text: TURN_TEXT, usage },
  tool(describeChip),
  tool(probeChip),
  tool(runChip),
  { step: "verdict", ms: 20_400, verdict: { status: "answered", sql: SQL, rowCount: 9 } },
  {
    step: "followups",
    ms: 1840,
    prompt: `Question: ${QUESTION}\n\nAnswer:\n${FINAL_TEXT}\n\nSQL:\n${SQL}`,
    text: FOLLOW_UPS.join("\n"),
    questions: FOLLOW_UPS,
    usage: { input: 640, output: 48 },
  },
];

const assumptions: Assumption[] = [
  { id: "model:0", label: "Added = sent_at", source: "model", active: true },
  { id: "model:1", label: "This Year = 2026", source: "model", active: true },
  { id: "model:2", label: "Months With No Rows Omitted", source: "model", active: true },
];

const answer: AskAnswer = {
  verdict: { status: "answered", sql: SQL, rowCount: 9 },
  sql: SQL,
  run,
  assumptions,
  sanity: [],
  followUps: FOLLOW_UPS,
  trace: answerTrace,
  text: FINAL_TEXT,
  turns: 1,
  ms: 20_400,
  usage,
  promptVersion: "v2",
  candidates: ["public.notification_history", "public.users"],
  recall: null,
  risky: false,
};

const answered: Exchange = {
  id: "harness-ex-answer",
  turnId: 2,
  question: QUESTION,
  text: FINAL_TEXT,
  thinking: "",
  chips: [describeChip, probeChip, runChip],
  answer,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

/** mid-run: describe landed, the probe is still out, nothing else exists yet */
const busy: Exchange = {
  id: "harness-ex-busy",
  turnId: null,
  question: QUESTION,
  text: "",
  thinking: "",
  chips: [describeChip, chip("call-2", "probe", "probe", null, PROBE_ARGS, null)],
  answer: null,
  error: null,
  streaming: true,
  provider: PROVIDER,
  model: MODEL,
};

// ---- failure --------------------------------------------------------------

const FAIL_QUESTION = "How many users signed up each week this quarter?";
const FAIL_SQL = [
  "SELECT date_trunc('week', signed_up_at)::date AS week,",
  "       COUNT(*) AS users",
  "FROM users",
  "WHERE signed_up_at >= date_trunc('quarter', now())",
  "GROUP BY 1",
  "ORDER BY 1",
].join("\n");
const FAIL_MESSAGE = 'column "signed_up_at" does not exist';
const failDescribe = chip(
  "call-1",
  "describe_tables",
  "describe users",
  388,
  JSON.stringify({ names: ["users"] }),
  "users (1,204,310 rows)\n  id bigint PK\n  email text\n  created_at timestamptz\n  signup_source text\n  is_deleted boolean",
);
const failRun = chip("call-2", "run_sql", "run", 41, JSON.stringify({ sql: FAIL_SQL }), `ERROR: ${FAIL_MESSAGE}`, true);

const failed: Exchange = {
  id: "harness-ex-failure",
  turnId: 4,
  question: FAIL_QUESTION,
  text: "",
  thinking: "",
  chips: [failDescribe, failRun],
  answer: {
    verdict: { status: "failed", sql: FAIL_SQL, message: FAIL_MESSAGE },
    sql: FAIL_SQL,
    run: null,
    assumptions: [],
    sanity: [],
    followUps: [],
    trace: [
      { step: "context", ms: 2, candidates: ["public.users"], text: `${FAIL_QUESTION}\n\nCANDIDATE TABLES …` },
      {
        step: "turn",
        ms: 7120,
        index: 0,
        text: "Describing users to find the signup timestamp.\n\nCounting signups by week.",
      },
      tool(failDescribe),
      tool(failRun),
      { step: "verdict", ms: 8300, verdict: { status: "failed", sql: FAIL_SQL, message: FAIL_MESSAGE } },
    ],
    text: "",
    turns: 1,
    ms: 8300,
    usage: { input: 9_100, output: 210 },
    promptVersion: "v2",
    candidates: ["public.users"],
    recall: null,
    risky: false,
  },
  error: { kind: "sql", message: FAIL_MESSAGE },
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

// ---- the picker's local runtime -------------------------------------------

/** the llama.cpp preset's default base URL (presets.ts); the shim answers
 * GET <this>/models with the list below */
export const LOCAL_MODELS_URL = "http://127.0.0.1:8080/v1/models";
/** llama-server reports ids as gguf paths; the registry matches the file name
 * (LFM2.5 2.6B, small, 8k ctx) */
export const LOCAL_MODELS_JSON = JSON.stringify({
  object: "list",
  data: [{ id: "/models/LFM2.5-2.6B-Q4_K_M.gguf", object: "model" }],
});

// ---- exports --------------------------------------------------------------

export const FIXTURE = {
  profile,
  snapshot,
  thread,
  threadRow,
  provider: PROVIDER,
  model: MODEL,
} as const;

/** the exchange a state shows; null for the configured empty states. The
 * Threads sheet sits over the sketch's answer; the round-2 builders' states
 * come from their own files */
export function exchangeFor(state: HarnessState): Exchange | null {
  switch (state) {
    case "answer":
    case "picker":
    case "threads":
      return answered;
    case "busy":
      return busy;
    case "failure":
      return failed;
    case "empty":
    case "disconnected":
    case "small":
      return null;
    case "pending":
    case "retry":
    case "strip":
      return interactSeed(state).exchange;
    case "scalar":
    case "kv":
    case "wide":
    case "trace":
      return anatomyExchangeFor(state);
  }
}

/** the configured provider and model a state runs under */
export function choiceFor(state: HarnessState): { provider: string; model: string } {
  return state === "small"
    ? { provider: SMALL_PROVIDER, model: SMALL_MODEL }
    : { provider: PROVIDER, model: MODEL };
}
