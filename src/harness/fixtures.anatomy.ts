// Round-2 anatomy states for the Ask fixture harness (W2c findings 7 and 1):
// a result of one row is a value, not a grid, and the trace paints above the
// grid with its bodies spanning the list. Same conventions as fixtures.ts
// (the store's own types, the harness connection `staging` on `auth_new`,
// prose that interprets and never repeats the data, DESIGN rule 14):
//
//   scalar  one row × one column: the count in the data register with the
//           column name as its caption (ScalarResult, one-column form)
//   kv      one row × three columns: name over value, stacked
//   wide    six rows × twelve columns: the grid, scrolling both ways at
//           every width (the fill never fires; the horizontal scrollbar
//           must not eat the sixth row)
//   trace   the W2b answer with its drawer open from the footer link, so the
//           context step is the one expanded
//
// PROBES are grid-slot repros for the fixer's own CDP run, never gate states:
// one row × one wide column (the maintainer's frame: the only row hid behind
// the header and the horizontal scrollbar), three rows × one column, and one
// row × six columns (the one-row grid the scalar form does not take).
//
// Wiring (the integrator's): fixtures.ts HARNESS_STATES, AskHarness.seed
// (exchange + `useAsk.traceOpenFor` from anatomyTraceFor), ask-frames.ts
// ALL_STATES.

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import type { TraceTarget } from "../stores/ask";
import { exchangeFor } from "./fixtures";

export type AnatomyState = "scalar" | "kv" | "wide" | "trace";
export const ANATOMY_STATES: readonly AnatomyState[] = ["scalar", "kv", "wide", "trace"];

const PROVIDER = "claude-code";
const MODEL = "claude-sonnet-5";

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

const usage = { input: 12_400, output: 280, cacheRead: 11_000, cacheWrite: 0 };

interface Seed {
  id: string;
  turnId: number;
  question: string;
  text: string;
  chips: ToolChip[];
  sql: string;
  run: AgentRun;
  assumptions: Assumption[];
  followUps: string[];
  turnMs: number;
  totalMs: number;
  candidates: string[];
}

/** one finished exchange of one qwry turn through Claude Code, the loop's
 * trace in loop order: context, the turn, its tool calls, the verdict, the
 * follow-ups call */
function exchange(s: Seed): Exchange {
  const trace: TraceStep[] = [
    {
      step: "context",
      ms: 3,
      candidates: s.candidates,
      text: `${s.question}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n${s.candidates.join("\n")}`,
    },
    { step: "turn", ms: s.turnMs, index: 0, text: s.text, usage },
    ...s.chips.map(tool),
    { step: "verdict", ms: s.totalMs, verdict: { status: "answered", sql: s.sql, rowCount: s.run.rowCount } },
    {
      step: "followups",
      ms: 1200,
      prompt: `Question: ${s.question}\n\nAnswer:\n${s.text}\n\nSQL:\n${s.sql}`,
      text: s.followUps.join("\n"),
      questions: s.followUps,
      usage: { input: 520, output: 40 },
    },
  ];
  const answer: AskAnswer = {
    verdict: { status: "answered", sql: s.sql, rowCount: s.run.rowCount },
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

const run = (columns: string[], rows: (string | null)[][], ms: number): AgentRun => ({
  columns,
  rows,
  rowCount: rows.length,
  capped: false,
  ms,
});

const assume = (i: number, label: string): Assumption => ({
  id: `model:${i}`,
  label,
  source: "model",
  active: true,
});

// ---- scalar: one row, one column ---------------------------------------------

const SCALAR_SQL = [
  "SELECT COUNT(*) AS users_never_opened",
  "FROM users u",
  "WHERE NOT u.is_deleted",
  "  AND EXISTS (SELECT 1 FROM notification_history n WHERE n.user_id = u.id)",
  "  AND NOT EXISTS (",
  "    SELECT 1 FROM notification_history n",
  "    WHERE n.user_id = u.id AND n.opened_at IS NOT NULL",
  "  )",
].join("\n");

const scalar = exchange({
  id: "harness-ex-scalar",
  turnId: 6,
  question: "How many users have never opened a notification?",
  text:
    "Users who received at least one notification and opened none of them; `opened_at` is the only open signal on the table.\n\n" +
    "```sql\n" +
    SCALAR_SQL +
    "\n```\n\n" +
    "Assumptions: Excluding Deleted Users; Opened = opened_at Set",
  chips: [
    chip(
      "call-1",
      "describe_tables",
      "describe notification_history",
      402,
      { names: ["notification_history"] },
      "notification_history (12,043,118 rows)\n  id bigint PK\n  user_id bigint → users.id\n  notification_type text\n  channel text\n  sent_at timestamptz\n  opened_at timestamptz null",
    ),
    chip(
      "call-2",
      "peek_values",
      "peek is_deleted",
      118,
      { table: "users", column: "is_deleted" },
      "is_deleted | count\nfalse | 1,180,204\ntrue | 24,106",
    ),
    chip("call-3", "run_sql", "run", 4781, { sql: SCALAR_SQL }, "users_never_opened\n48213\n(1 row)"),
  ],
  sql: SCALAR_SQL,
  run: run(["users_never_opened"], [["48213"]], 4781.36),
  assumptions: [assume(0, "Excluding Deleted Users"), assume(1, "Opened = opened_at Set")],
  followUps: [
    "Which channels reach users who never open?",
    "How many notifications did those users receive?",
    "When did they last get one?",
  ],
  turnMs: 7_400,
  totalMs: 9_600,
  candidates: [
    "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
    "public.notification_history (12.0M rows): id, user_id, notification_type, channel, sent_at, opened_at",
  ],
});

// ---- kv: one row, three columns ------------------------------------------------

const KV_SQL = [
  "SELECT COUNT(*) AS sent,",
  "       COUNT(opened_at) AS opened,",
  "       ROUND(100.0 * COUNT(opened_at) / COUNT(*), 1) AS opened_pct",
  "FROM notification_history",
  "WHERE sent_at >= date_trunc('year', now())",
].join("\n");

const kv = exchange({
  id: "harness-ex-kv",
  turnId: 8,
  question: "What share of this year's notifications were opened?",
  text:
    "Two in five, with `opened_at` as the open signal; push and email are not separated here.\n\n" +
    "```sql\n" +
    KV_SQL +
    "\n```\n\n" +
    "Assumptions: This Year = 2026; Opened = opened_at Set",
  chips: [
    chip(
      "call-1",
      "describe_tables",
      "describe notification_history",
      388,
      { names: ["notification_history"] },
      "notification_history (12,043,118 rows)\n  sent_at timestamptz\n  opened_at timestamptz null",
    ),
    chip(
      "call-2",
      "run_sql",
      "run",
      2214,
      { sql: KV_SQL },
      "sent | opened | opened_pct\n4652023 | 1893310 | 40.7\n(1 row)",
    ),
  ],
  sql: KV_SQL,
  run: run(["sent", "opened", "opened_pct"], [["4652023", "1893310", "40.7"]], 2214.08),
  assumptions: [assume(0, "This Year = 2026"), assume(1, "Opened = opened_at Set")],
  followUps: [
    "How does the open share differ by channel?",
    "Which notification type is opened least?",
    "How long after sending are notifications opened?",
  ],
  turnMs: 5_900,
  totalMs: 7_300,
  candidates: [
    "public.notification_history (12.0M rows): id, user_id, notification_type, channel, sent_at, opened_at",
  ],
});

// ---- wide: six rows, twelve columns ---------------------------------------------

const WIDE_COLS = [
  "session_id",
  "user_id",
  "platform",
  "started_at",
  "email",
  "signup_source",
  "created_at",
  "is_deleted",
  "wardrobes",
  "products",
  "last_notification",
  "channel",
];

const WIDE_ROWS: (string | null)[][] = [
  ["3002918", "884210", "ios", "2026-09-05 09:58:01+00", "priya.n@example.com", "app_store", "2024-11-02 07:14:55+00", "f", "3", "412", "2026-09-05 08:30:12+00", "push"],
  ["3002917", "1190043", "android", "2026-09-05 09:57:44+00", "arjun.k@example.com", "play_store", "2026-08-30 18:02:10+00", "f", "1", "27", "2026-09-04 19:11:03+00", "push"],
  ["3002916", "52", "web", "2026-09-05 09:57:12+00", "ops@shoppin.app", "invite", "2022-03-14 11:00:00+00", "f", "12", "1839", null, null],
  ["3002915", "402118", "ios", "2026-09-05 09:56:59+00", "meera.s@example.com", "app_store", "2025-06-21 14:41:27+00", "f", "2", "96", "2026-09-05 06:00:00+00", "email"],
  ["3002914", "77103", "android", "2026-09-05 09:56:30+00", null, "referral", "2023-01-09 09:09:09+00", "t", "0", "0", "2025-12-24 10:00:00+00", "sms"],
  ["3002913", "1204310", "web", "2026-09-05 09:56:02+00", "new.user@example.com", "organic", "2026-09-05 09:55:48+00", "f", "0", "0", null, null],
];

const WIDE_SQL = [
  "SELECT s.id AS session_id, s.user_id, s.platform, s.started_at,",
  "       u.email, u.signup_source, u.created_at, u.is_deleted,",
  "       (SELECT COUNT(*) FROM wardrobes w WHERE w.user_id = u.id) AS wardrobes,",
  "       (SELECT COUNT(*) FROM wardrobe_products_v2 p",
  "         JOIN wardrobes w ON w.id = p.wardrobe_id WHERE w.user_id = u.id) AS products,",
  "       n.sent_at AS last_notification, n.channel",
  "FROM sessions s",
  "JOIN users u ON u.id = s.user_id",
  "LEFT JOIN LATERAL (",
  "  SELECT sent_at, channel FROM notification_history",
  "  WHERE user_id = u.id ORDER BY sent_at DESC LIMIT 1",
  ") n ON true",
  "ORDER BY s.started_at DESC",
  "LIMIT 6",
].join("\n");

const wide = exchange({
  id: "harness-ex-wide",
  turnId: 10,
  question: "Show the six latest sessions with each user's wardrobe size and last notification.",
  text:
    "Newest session first; wardrobe and product counts are per user, and the last notification is the newest by `sent_at`.\n\n" +
    "```sql\n" +
    WIDE_SQL +
    "\n```\n\n" +
    "Assumptions: Latest = started_at Desc",
  chips: [
    chip(
      "call-1",
      "describe_tables",
      "describe sessions, users",
      455,
      { names: ["sessions", "users"] },
      "sessions (3,002,918 rows)\n  id bigint PK\n  user_id bigint → users.id\n  platform text: ios, android, web\n  started_at timestamptz\nusers (1,204,310 rows)\n  id bigint PK\n  email text\n  created_at timestamptz\n  signup_source text\n  is_deleted boolean",
    ),
    chip(
      "call-2",
      "run_sql",
      "run",
      212,
      { sql: WIDE_SQL },
      [WIDE_COLS.join(" | "), ...WIDE_ROWS.map((r) => r.map((v) => v ?? "").join(" | ")), "(6 rows)"].join("\n"),
    ),
  ],
  sql: WIDE_SQL,
  run: run(WIDE_COLS, WIDE_ROWS, 212.41),
  assumptions: [assume(0, "Latest = started_at Desc")],
  followUps: [
    "Which platform has the most sessions today?",
    "How many sessions belong to deleted users?",
    "Which users have sessions but no wardrobe?",
  ],
  turnMs: 6_100,
  totalMs: 7_800,
  candidates: [
    "public.sessions (3.0M rows): id, user_id, platform, started_at",
    "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
    "public.wardrobes (842k rows): id, user_id, name, created_at",
  ],
});

// ---- probes (grid-slot repros; the fixer's CDP run, not gate states) ----------

const LONG_URL =
  "https://assets.shoppin.app/internal-tools/flatlay-gallery/2026/09/05/wardrobe-884210-signature-tier-render-v3-final.png";

const ONE_WIDE_SQL = "SELECT url FROM wardrobe_products_v2 ORDER BY added_at DESC LIMIT 1";
/** one row × one column wider than any pane: the grid path before the scalar
 * form existed (the maintainer's frame) */
const oneWide = exchange({
  id: "harness-ex-one-wide",
  turnId: 12,
  question: "What is the newest product image?",
  text: "The newest by `added_at`.\n\n```sql\n" + ONE_WIDE_SQL + "\n```",
  chips: [chip("call-1", "run_sql", "run", 38, { sql: ONE_WIDE_SQL }, `url\n${LONG_URL}\n(1 row)`)],
  sql: ONE_WIDE_SQL,
  run: run(["url"], [[LONG_URL]], 38.2),
  assumptions: [],
  followUps: [],
  turnMs: 3_000,
  totalMs: 3_400,
  candidates: ["public.wardrobe_products_v2 (9.8M rows): id, wardrobe_id, product_id, added_at"],
});

const ROWS3_SQL = "SELECT DISTINCT platform FROM sessions ORDER BY 1";
/** three rows × one column: a short grid whose fill fires */
const rows3 = exchange({
  id: "harness-ex-rows3",
  turnId: 14,
  question: "Which platforms do sessions come from?",
  text: "Three, as `platform` spells them.\n\n```sql\n" + ROWS3_SQL + "\n```",
  chips: [chip("call-1", "run_sql", "run", 51, { sql: ROWS3_SQL }, "platform\nandroid\nios\nweb\n(3 rows)")],
  sql: ROWS3_SQL,
  run: run(["platform"], [["android"], ["ios"], ["web"]], 51.7),
  assumptions: [],
  followUps: [],
  turnMs: 2_800,
  totalMs: 3_100,
  candidates: ["public.sessions (3.0M rows): id, user_id, platform, started_at"],
});

const ONE_SIX_SQL = "SELECT * FROM notification_history ORDER BY sent_at DESC LIMIT 1";
/** one row × six columns: the one-row grid the scalar form leaves to the grid */
const oneSix = exchange({
  id: "harness-ex-one-six",
  turnId: 16,
  question: "What was the last notification sent?",
  text: "The newest row by `sent_at`.\n\n```sql\n" + ONE_SIX_SQL + "\n```",
  chips: [
    chip(
      "call-1",
      "run_sql",
      "run",
      44,
      { sql: ONE_SIX_SQL },
      "id | user_id | notification_type | channel | sent_at | opened_at\n12043118 | 884210 | order_update | push | 2026-09-05 09:58:01+00 | \n(1 row)",
    ),
  ],
  sql: ONE_SIX_SQL,
  run: run(
    ["id", "user_id", "notification_type", "channel", "sent_at", "opened_at"],
    [["12043118", "884210", "order_update", "push", "2026-09-05 09:58:01+00", null]],
    44.9,
  ),
  assumptions: [],
  followUps: [],
  turnMs: 2_600,
  totalMs: 2_900,
  candidates: ["public.notification_history (12.0M rows): id, user_id, notification_type, channel, sent_at, opened_at"],
});

export const PROBE_EXCHANGES: Readonly<Record<"one-wide" | "rows3" | "one-six", Exchange>> = {
  "one-wide": oneWide,
  rows3,
  "one-six": oneSix,
};

// ---- exports ------------------------------------------------------------------

/** the exchange a state shows; `trace` is the W2b answer */
export function anatomyExchangeFor(state: AnatomyState): Exchange {
  switch (state) {
    case "scalar":
      return scalar;
    case "kv":
      return kv;
    case "wide":
      return wide;
    case "trace": {
      const answer = exchangeFor("answer");
      if (!answer) throw new Error("fixtures.ts: the answer state has no exchange");
      return answer;
    }
  }
}

/** the trace target a state opens with (the footer link: no step, so the
 * drawer expands the context row); null for the rest */
export function anatomyTraceFor(state: AnatomyState): TraceTarget | null {
  return state === "trace" ? { exchangeId: anatomyExchangeFor(state).id, stepId: null } : null;
}
