// Popover builder's fixtures for the Ask harness (W6): the `@` completion
// popover and the draft's chips, the "W6 · @ context tags" rows 1 and 2 of
// ask-sketch-v2.html, over the discussion thread's first exchange
// (fixtures.echo.ts: `can you check the revenue in last month`, Haiku 4.5).
//
//   mention-popover  the composer holds `which @ord`, focused, the caret after
//                    `ord`, and the popover stands over the box with what
//                    `ord` matches in this file's schema: Tables `order_v2`
//                    (~2.1M rows) · `erp_order_cost_snapshot` (~318k rows),
//                    Columns `order_v2.order_status` (text) ·
//                    `erp_order_cost_snapshot.order_id` (uuid) ·
//                    `erp_order_cost_snapshot.order_ref` (text), Saved
//                    Queries `Orders by day`, Threads `how many orders were
//                    refunded in August`; the first row hot. `orders_legacy`
//                    (a LEGACY comment) is in the schema and never a row;
//                    `Monthly revenue` and the thread `revenue last month`
//                    are seeded and absent, since `ord` cannot produce them.
//                    At 320 the two erp column rows prove the two-span rule:
//                    the table part ellipsizes, `.order_id` and `.order_ref`
//                    stay whole
//   mention-draft    the composer holds `compare @order_v2 with @"Monthly
//                    revenue" for August`, focused, the caret at its end, no
//                    popover: two pills in the draft, the second wrapping
//                    with its words at 320
//
// Seed contract (fixtures.ts / AskHarness.tsx / tauriShim.ts / ask-frames.ts
// are the integrator's): add MENTION_STATES to HarnessState, HARNESS_STATES
// and ask-frames' ALL_STATES; `choiceFor` returns ACTIONS_CHOICE for them
// (the footer reads Haiku 4.5); in `seed`, `mentionsSeed(state)` gives the
// schema store its `snapshot` (in place of FIXTURE.snapshot), the agent store
// its `exchanges` under the fixture thread (busy false, phase null) and its
// `threads` for the connection, and `useSaved.setState({ queries: seed.saved })`
// (every other state resets `queries: []`, so a bookmark never leaks into
// another frame); tauriShim answers `agent_thread_list` with
// MENTION_THREAD_ROWS for these states, else the mount's loadThreads
// overwrites the three with the one; and the post-mount rAF calls
// `mentionsAfterMount(state)` beside the W4 hooks. It writes the draft
// through the store (after the pane's mount effect has set draftFor), asks
// for focus (the caret lands at the end of the value, one frame later, inside
// the script's settle) and opens the popover through `openMentions`, the
// DOM-free door the store offers for exactly this. Frames run under reduced
// motion, so the box stands at once.
//
// Imports fixtures.ts for the connection and thread ids and reads them only
// inside functions (the fixtures.edit.ts precedent).

import type { AgentThread } from "../ipc/types";
import type { Thread } from "../agent/types";
import type { Exchange } from "../stores/agent";
import { useAsk, type MentionQuery } from "../stores/ask";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import { FIXTURE } from "./fixtures";
import { echoExchangesFor } from "./fixtures.echo";

export const MENTION_STATES = ["mention-popover", "mention-draft"] as const;
export type MentionState = (typeof MENTION_STATES)[number];

export interface MentionsSeed {
  /** the thread, one exchange: the discussion thread's first */
  exchanges: Exchange[];
  /** the connection's schema: the orders shape the sketch draws */
  snapshot: SchemaSnapshot;
  /** the connection's saved queries (useSaved.queries) */
  saved: SavedQuery[];
  /** the connection's threads, newest first (useAgent.threads[pid]) */
  threads: Thread[];
  /** the composer's text */
  draft: string;
  /** the popover's query, null for a closed popover */
  query: MentionQuery | null;
}

// ---- schema -------------------------------------------------------------------

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
  comment: string | null = null,
): TableInfo => ({
  table_oid: oid,
  schema: "public",
  name,
  kind: "r",
  columns,
  pk: ["id"],
  has_children: false,
  reltuples,
  comment,
  parent_oid: null,
});

const TS = "timestamp with time zone";

/** order_v2's comment, as the snapshot, the candidate block and the describe
 * result of the echo fixture all repeat it */
export const ORDER_V2_COMMENT = "One row per checkout attempt, failed included.";

/** the order_v2 database the discussion thread runs on: two tables and three
 * columns carry `ord`, the LEGACY twin carries it too and is never offered.
 * The one schema of the wave: the echo and trace states resolve their tags
 * against it too (fixtures.mentions-echo.ts) */
export const MENTION_SNAPSHOT: SchemaSnapshot = {
  tables: [
    table(
      1,
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
      2,
      "order_v2",
      [
        col("id", "uuid", 1),
        col("user_id", "bigint", 2),
        col("order_status", "text", 3),
        col("payment_status", "text", 4),
        col("total_amount", "numeric", 5),
        col("currency", "text", 6),
        col("created_at", TS, 7),
        col("paid_at", TS, 8),
      ],
      2_104_331,
      ORDER_V2_COMMENT,
    ),
    table(
      3,
      "erp_order_cost_snapshot",
      [
        col("id", "uuid", 1),
        col("order_id", "uuid", 2),
        col("order_ref", "text", 3),
        col("cost_inr", "numeric", 4),
        col("snapshot_at", TS, 5),
      ],
      318_204,
    ),
    table(
      4,
      "orders_legacy",
      [
        col("id", "bigint", 1),
        col("user_id", "bigint", 2),
        col("status", "text", 3),
        col("amount", "numeric", 4),
        col("created_at", TS, 5),
      ],
      1_902_114,
      "LEGACY: replaced by order_v2 in 2024",
    ),
    table(
      5,
      "erp_fx_rate",
      [col("currency", "text", 1), col("rate_to_inr", "numeric", 2), col("as_of", "date", 3)],
      0,
    ),
    table(
      6,
      "products",
      [col("id", "bigint", 1), col("name", "text", 2), col("price", "numeric", 3), col("created_at", TS, 4)],
      48_211,
    ),
  ],
  foreign_keys: [
    {
      src_schema: "public",
      src_table: "order_v2",
      src_cols: ["user_id"],
      dst_schema: "public",
      dst_table: "users",
      dst_cols: ["id"],
    },
    {
      src_schema: "public",
      src_table: "erp_order_cost_snapshot",
      src_cols: ["order_id"],
      dst_schema: "public",
      dst_table: "order_v2",
      dst_cols: ["id"],
    },
  ],
  functions: [],
  schemas: ["public"],
  indexes: [],
  enums: [],
  sequences: [],
  extensions: [],
  server_version_num: 160004,
};

// ---- saved queries and threads -----------------------------------------------------

/** the saved query the draft tags; its SQL rides under the tag in the echo
 * fixture's context block */
export const MONTHLY_REVENUE_NAME = "Monthly revenue";
export const MONTHLY_REVENUE_SQL = [
  "SELECT date_trunc('month', created_at)::date AS month, SUM(total_amount) AS revenue",
  "FROM order_v2 WHERE payment_status <> 'failed' GROUP BY 1 ORDER BY 1;",
].join("\n");

/** two bookmarks of the connection: the one the draft tags and the one `ord` finds */
export function mentionSaved(): SavedQuery[] {
  const pid = FIXTURE.profile.id;
  return [
    {
      id: "harness-saved-monthly-revenue",
      name: MONTHLY_REVENUE_NAME,
      sql: MONTHLY_REVENUE_SQL,
      created_at: "2026-08-14T09:30:00Z",
      profile_id: pid,
    },
    {
      id: "harness-saved-orders-by-day",
      name: "Orders by day",
      sql: "SELECT created_at::date AS day, COUNT(*) AS orders FROM order_v2 GROUP BY 1 ORDER BY 1;",
      created_at: "2026-07-02T15:10:00Z",
      profile_id: pid,
    },
  ];
}

/** the connection's threads, newest first: the one on screen (titled after
 * its first question), the one `ord` finds, and one it cannot */
export function mentionThreads(): Thread[] {
  const pid = FIXTURE.profile.id;
  return [
    { ...FIXTURE.thread, title: "can you check the revenue in last month" },
    {
      id: "harness-thread-refunds",
      profileId: pid,
      title: "how many orders were refunded in August",
      createdAt: "2026-09-04T16:40:00Z",
    },
    {
      id: "harness-thread-revenue",
      profileId: pid,
      title: "revenue last month",
      createdAt: "2026-09-02T11:05:00Z",
    },
  ];
}

/** the same three as appdb rows, for tauriShim's `agent_thread_list` */
export function mentionThreadRows(): AgentThread[] {
  return mentionThreads().map((t) => ({
    id: t.id,
    profile_id: t.profileId,
    title: t.title,
    created_at: t.createdAt,
  }));
}

// ---- exports ---------------------------------------------------------------------------

const POPOVER_DRAFT = "which @ord";
const CHIPS_DRAFT = 'compare @order_v2 with @"Monthly revenue" for August';

export function mentionsSeed(state: MentionState): MentionsSeed {
  const first = echoExchangesFor("echo")[0];
  if (!first) throw new Error("fixtures.mentions: the echo thread is empty");
  return {
    exchanges: [first],
    snapshot: MENTION_SNAPSHOT,
    saved: mentionSaved(),
    threads: mentionThreads(),
    draft: state === "mention-popover" ? POPOVER_DRAFT : CHIPS_DRAFT,
    query: state === "mention-popover" ? { at: POPOVER_DRAFT.indexOf("@"), filter: "ord" } : null,
  };
}

/** the post-mount hook: the draft through the store, focus, and the popover
 * through the store's own door, the way a keystroke opens it */
export function mentionsAfterMount(state: string): void {
  if (!(MENTION_STATES as readonly string[]).includes(state)) return;
  const seed = mentionsSeed(state as MentionState);
  const a = useAsk.getState();
  a.setDraft(seed.draft);
  a.requestFocus();
  if (seed.query) a.openMentions(seed.query.at, seed.query.filter);
}
