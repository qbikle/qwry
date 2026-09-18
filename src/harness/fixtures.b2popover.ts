// Popover builder's fixtures for the B2 context wave (rows 1 to 4 of the
// "B2 · context" section of ask-sketch-b2.html): the `@` completion box
// sectioned, narrowed and fuzzy, and the composer's control row at rest with
// the `+` pill in it. All four stand over the discussion thread's first
// exchange, the same still the W6 pair and `b2-pill-icons` stand over, so
// every B2 frame is one comparison at one width.
//
//   b2-popover-empty     the composer holds `which @`, focused, the caret
//                        after the `@`, and the box stands SECTIONED: five
//                        category rows (`tables/` · `columns/` · `saved/` ·
//                        `canvases/` · `threads/`), then `Recent` (order_v2
//                        ~2.1M rows · Monthly revenue · August finance · how
//                        many orders were refunded in August: four kinds
//                        under one word, which is why the word is
//                        load-bearing), `Tables` (the five recents Recent
//                        could not fit, by recent use: ~8.1M · ~4.4M · ~318k
//                        · ~92k · ~61k), `Saved` (3), `Canvases` (2),
//                        `Threads` (3). 22 rows and 5 hairlines. At the 320
//                        floor the first view holds the five categories,
//                        Recent whole, the `Tables` hairline and the top of
//                        its first row: the scroll cue, and the proof that
//                        the box's height is its own and not its content's.
//                        `order_v2` stands under `Recent` and NOT again under
//                        `Tables` (DESIGN rule 14)
//   b2-popover-category  `which @tables/pflg`: inside the tables level, ONE
//                        kind, no hairline, three subsequence matches
//                        (product_flatlay_generations ~8.1M ·
//                        pipeline_flatlay_logs ~2.3M ·
//                        wardrobe_products_flatlay_grid ~640k). Three rows in
//                        a box that holds its 320px: the sparse case, drawn
//                        honestly, and the one frame that proves the height
//                        is fixed rather than capped
//   b2-popover-fuzzy     `which @ta`: no level, so ONE run and no hairlines,
//                        the two categories `ta` reaches on top (`tables/` by
//                        prefix, `threads/` by subsequence), then tables,
//                        columns, saved, canvases, threads in the categories'
//                        own order. Longer than the box, so it scrolls inside
//                        one that has not moved
//   b2-plus-pill         the composer at rest: draft empty, placeholder `Ask
//                        about auth_new…`, and the control row reading `+` ·
//                        Haiku 4.5 · Send. Three controls in 151 of the 320
//                        floor's 274px (DESIGN rule 12, amended this wave),
//                        identical at 392 and 560
//
// The database is ONE snapshot for all four (the W6 rule: a tag typed in one
// frame resolves in every other), built so the sketch's own rows are what the
// product's own matcher returns. `b2-popover-category` adds two tables on top
// of it rather than into it (the `mention-first` precedent): `pflg` needs
// three `flatlay` relations and the other three states must not grow rows the
// sketch does not draw for them.
//
// Where the frames and the sketch differ, and why (measured against the
// landed matcher, `ask/fuzzy.ts`): the sketch drew its runs by hand, and the
// matcher scores a WORD START and a consecutive RUN, which item 2 of the
// brief requires. Two consequences, both inside the subsequence tier:
//   · `ta` also reaches `erp_order_cost_snapshot` (the `t` of `cost`, the `a`
//     of `snapshot`) and the canvas `August finance`, which the sketch's own
//     lists left out, so the fuzzy run is 14 rows where the sketch drew 12.
//     Both are real matches over one shared database, and the run scrolls
//     either way, which is what the frame is evidence for
//   · under `ta`, `is the USD share growing` stands above `what stood out in
//     orders last month` (the sketch had them the other way): its `t` opens
//     `the`, the other's sits inside `what`
// The ROWS are the sketch's rows; the order inside a tier is the brief's rule.
//
// Seed contract (fixtures.ts / AskHarness.tsx / tauriShim.ts / ask-frames.ts
// are the integrator's): add B2_POPOVER_STATES to HarnessState, HARNESS_STATES
// and ask-frames' ALL_STATES; `choiceFor` returns ACTIONS_CHOICE for them (the
// footer and the pill read Haiku 4.5, as every W6 composer state does); in
// `seed`, `b2PopoverSeed(state)` gives the schema store its `snapshot`, the
// agent store its `exchanges` under the fixture thread (busy false, phase
// null) and its `threads` for the connection, `useSaved.setState({ queries:
// seed.saved })`, `useTabs.setState({ tabs: seed.tabs, activeId: null })` (the
// canvas tabs ARE the connection's canvases: stores/tabs canvasTabRefs) and
// `useRecents.setState({ byProfile: { [pid]: seed.recents } })`. Every other
// state resets all four, so nothing a B2 page seeded reaches another frame
// (the bookmarks' own rule). tauriShim answers `agent_thread_list` with
// `b2ThreadRows()` for these states, else the mount's loadThreads
// overwrites the five with the one; and the post-mount rAF calls
// `b2PopoverAfterMount(state)` beside `mentionsAfterMount(state)`. It writes
// the draft through the store, asks for focus, and opens the popover through
// `openMentions`, the DOM-free door the store offers for exactly this. Frames
// run under reduced motion, so the box stands at once.
//
// Imports fixtures.ts for the connection and thread ids and fixtures.echo.ts
// for the exchange, and reads both only inside functions (the fixtures.edit.ts
// precedent).

import type { AgentThread } from "../ipc/types";
import type { Thread } from "../agent/types";
import type { Exchange } from "../stores/agent";
import { useAsk, type MentionQuery } from "../stores/ask";
import type { Recent } from "../stores/recents";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import type { Tab } from "../stores/tabs";
import { FIXTURE } from "./fixtures";
import { echoExchangesFor } from "./fixtures.echo";

export const B2_POPOVER_STATES = [
  "b2-popover-empty",
  "b2-popover-category",
  "b2-popover-fuzzy",
  "b2-plus-pill",
] as const;
export type B2PopoverState = (typeof B2_POPOVER_STATES)[number];

export interface B2PopoverSeed {
  /** the thread, one exchange: the discussion thread's first */
  exchanges: Exchange[];
  /** the connection's schema */
  snapshot: SchemaSnapshot;
  /** the connection's saved queries (useSaved.queries) */
  saved: SavedQuery[];
  /** the connection's threads, newest first (useAgent.threads[pid]) */
  threads: Thread[];
  /** the workspace's tabs: the three canvas tabs ARE the three canvases the
   * box offers (stores/tabs canvasTabRefs) */
  tabs: Tab[];
  /** what this connection reached for last, newest first (useRecents) */
  recents: Recent[];
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

const table = (oid: number, name: string, columns: TableInfo["columns"], reltuples: number): TableInfo => ({
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

const TS = "timestamp with time zone";

/** The connection the four frames run on: nine relations whose row estimates
 * are the sketch's own hints (`~8.1M rows` down to `~61k rows`), and whose
 * COLUMN names are chosen so that `ta` reaches exactly the three the sketch
 * draws. That is the whole difficulty of this fixture: a `created_at`
 * anywhere would put a `t` before an `a` on every table in the database and
 * bury the three columns the row is about under twenty of its cousins, so the
 * timestamps here are `paid_at`, `run_at`, `seen_at` and `logged_at`, whose
 * `t` is their last character. */
export const B2_SNAPSHOT: SchemaSnapshot = {
  tables: [
    table(
      1,
      "product_flatlay_generations",
      [
        col("id", "uuid", 1),
        col("uid", "text", 2),
        col("prompt", "text", 3),
        col("model", "text", 4),
        col("run_at", TS, 5),
      ],
      8_142_990,
    ),
    table(
      2,
      "product_metadata",
      [
        col("id", "bigint", 1),
        col("uid", "text", 2),
        col("brand", "text", 3),
        col("colour", "text", 4),
        col("gender", "text", 5),
      ],
      4_612_400,
    ),
    table(
      3,
      "wardrobe_products_v2",
      [
        col("id", "bigint", 1),
        col("user_id", "bigint", 2),
        col("uid", "text", 3),
        col("price", "numeric", 4),
        col("is_deleted", "boolean", 5),
      ],
      4_402_118,
    ),
    table(
      4,
      "order_v2",
      [
        col("id", "uuid", 1),
        col("user_id", "bigint", 2),
        col("payment_status", "text", 3),
        col("total_amount", "numeric", 4),
        col("currency", "text", 5),
        col("paid_at", TS, 6),
      ],
      2_104_331,
    ),
    table(
      5,
      "tax_invoice_lines",
      [
        col("id", "bigint", 1),
        col("invoice_no", "text", 2),
        col("line_no", "integer", 3),
        col("gst_no", "text", 4),
        col("amount", "numeric", 5),
      ],
      1_204_882,
    ),
    table(
      6,
      "erp_order_cost_snapshot",
      [
        col("id", "uuid", 1),
        col("order_id", "uuid", 2),
        col("cost_inr", "numeric", 3),
        col("snapshot_at", TS, 4),
      ],
      318_204,
    ),
    table(
      7,
      "erp_order_cost_snapshot_daily_rollup",
      [
        col("id", "uuid", 1),
        col("rollup_day", "date", 2),
        col("orders", "bigint", 3),
        col("cost_inr", "numeric", 4),
      ],
      96_118,
    ),
    table(
      8,
      "pipeline_products",
      [
        col("id", "bigint", 1),
        col("sku", "text", 2),
        col("price", "numeric", 3),
        col("phase", "text", 4),
        col("seen_at", TS, 5),
      ],
      91_902,
    ),
    table(
      9,
      "users",
      [
        col("id", "bigint", 1),
        col("email", "text", 2),
        col("phone", "text", 3),
        col("signup_src", "text", 4),
        col("is_deleted", "boolean", 5),
      ],
      61_204,
    ),
  ],
  foreign_keys: [
    {
      src_schema: "public",
      src_table: "erp_order_cost_snapshot",
      src_cols: ["order_id"],
      dst_schema: "public",
      dst_table: "order_v2",
      dst_cols: ["id"],
    },
    {
      src_schema: "public",
      src_table: "wardrobe_products_v2",
      src_cols: ["user_id"],
      dst_schema: "public",
      dst_table: "users",
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

/** The two extra `flatlay` relations `pflg` needs, added on top of the one
 * snapshot and not into it (the `mention-first` precedent): they carry no
 * `ta`-reachable name the other three states would then have to show. */
const B2_CATEGORY_SNAPSHOT: SchemaSnapshot = {
  ...B2_SNAPSHOT,
  tables: [
    ...B2_SNAPSHOT.tables,
    table(
      10,
      "pipeline_flatlay_logs",
      [
        col("id", "bigint", 1),
        col("uid", "text", 2),
        col("level", "text", 3),
        col("note", "text", 4),
        col("logged_at", TS, 5),
      ],
      2_318_004,
    ),
    table(
      11,
      "wardrobe_products_flatlay_grid",
      [col("id", "bigint", 1), col("uid", "text", 2), col("grid_url", "text", 3), col("cells", "integer", 4)],
      640_231,
    ),
  ],
};

// ---- saved queries, canvases and threads --------------------------------------

const SAVED_MONTHLY = "b2-saved-monthly-revenue";
const CANVAS_AUGUST = "b2-canvas-august-finance";
const THREAD_REFUNDS = "b2-thread-refunds";

/** four bookmarks: the one `Recent` shows and the three that fill `Saved`
 * under it, in the order the store holds them */
export function b2Saved(): SavedQuery[] {
  const pid = FIXTURE.profile.id;
  return [
    {
      id: SAVED_MONTHLY,
      name: "Monthly revenue",
      sql: "SELECT date_trunc('month', paid_at)::date AS month, SUM(total_amount) AS revenue\nFROM order_v2 GROUP BY 1 ORDER BY 1;",
      created_at: "2026-08-14T09:30:00Z",
      profile_id: pid,
    },
    {
      id: "b2-saved-orders-by-day",
      name: "Orders by day",
      sql: "SELECT paid_at::date AS day, COUNT(*) AS orders FROM order_v2 GROUP BY 1 ORDER BY 1;",
      created_at: "2026-08-02T15:10:00Z",
      profile_id: pid,
    },
    {
      id: "b2-saved-revenue-last-month",
      name: "revenue last month",
      sql: "SELECT SUM(total_amount) AS revenue FROM order_v2 WHERE paid_at >= date_trunc('month', now()) - interval '1 month';",
      created_at: "2026-07-28T11:45:00Z",
      profile_id: pid,
    },
    {
      id: "b2-saved-unpaid-orders",
      name: "Unpaid orders older than a week",
      sql: "SELECT id, user_id, total_amount FROM order_v2\nWHERE payment_status <> 'paid' AND paid_at IS NULL;",
      created_at: "2026-07-19T10:15:00Z",
      profile_id: pid,
    },
  ];
}

/** The connection's canvases, as the box reads them: open canvas TABS
 * (stores/tabs canvasTabRefs), since the pane must not import the document
 * store (the canvas/port.ts rule). `August finance` is the one `Recent`
 * shows; the other two fill `Canvases`, and `Canvas` is the default title a
 * connection's first canvas wears. */
export function b2Tabs(): Tab[] {
  const pid = FIXTURE.profile.id;
  const canvas = (id: string, name: string, position: number): Tab => ({
    id: `b2-tab-${id}`,
    name,
    sql: "",
    position,
    saved_id: null,
    kind: "canvas",
    table: null,
    canvas_id: id,
    profile_id: pid,
  });
  return [
    canvas(CANVAS_AUGUST, "August finance", 0),
    canvas("b2-canvas-default", "Canvas", 1),
    canvas("b2-canvas-returns", "Returns by city", 2),
  ];
}

/** the connection's threads, newest first: the one on screen (never offered
 * to itself), the one `Recent` shows, and the three that fill `Threads` */
export function b2Threads(): Thread[] {
  const pid = FIXTURE.profile.id;
  return [
    { ...FIXTURE.thread, title: "can you check the revenue in last month" },
    {
      id: THREAD_REFUNDS,
      profileId: pid,
      title: "how many orders were refunded in August",
      createdAt: "2026-09-04T16:40:00Z",
    },
    {
      id: "b2-thread-cod",
      profileId: pid,
      title: "which cities return the most cod",
      createdAt: "2026-09-03T12:20:00Z",
    },
    {
      id: "b2-thread-stood-out",
      profileId: pid,
      title: "what stood out in orders last month",
      createdAt: "2026-09-02T09:05:00Z",
    },
    {
      id: "b2-thread-usd",
      profileId: pid,
      title: "is the USD share growing",
      createdAt: "2026-09-01T17:35:00Z",
    },
  ];
}

/** the same five as appdb rows, for tauriShim's `agent_thread_list` */
export function b2ThreadRows(): AgentThread[] {
  return b2Threads().map((t) => ({
    id: t.id,
    profile_id: t.profileId,
    title: t.title,
    created_at: t.createdAt,
  }));
}

/** What this connection reached for last, newest first. The first four are
 * the four kinds `Recent` shows (a table, a bookmark, a canvas, a thread);
 * the five tables below them are what `Tables` then orders itself by, which
 * is the whole reason the section reads `~8.1M · ~4.4M · ~318k · ~92k · ~61k`
 * instead of the database's own top five. Pointers, never copies: each row is
 * resolved against the live connection when it is drawn. */
export function b2Recents(): Recent[] {
  return [
    { kind: "table", key: "public.order_v2" },
    { kind: "saved", key: SAVED_MONTHLY },
    { kind: "canvas", key: CANVAS_AUGUST },
    { kind: "thread", key: THREAD_REFUNDS },
    { kind: "table", key: "public.product_flatlay_generations" },
    { kind: "table", key: "public.wardrobe_products_v2" },
    { kind: "table", key: "public.erp_order_cost_snapshot" },
    { kind: "table", key: "public.pipeline_products" },
    { kind: "table", key: "public.users" },
  ];
}

// ---- exports ---------------------------------------------------------------------------

const DRAFTS: Record<B2PopoverState, string> = {
  "b2-popover-empty": "which @",
  "b2-popover-category": "which @tables/pflg",
  "b2-popover-fuzzy": "which @ta",
  "b2-plus-pill": "",
};

/** the fragment after the `@`, which is also what the caret sits after */
const fragment = (draft: string) => draft.slice(draft.indexOf("@") + 1);

export function b2PopoverSeed(state: B2PopoverState): B2PopoverSeed {
  const first = echoExchangesFor("echo")[0];
  if (!first) throw new Error("fixtures.b2popover: the echo thread is empty");
  const draft = DRAFTS[state];
  const at = draft.indexOf("@");
  return {
    exchanges: [first],
    snapshot: state === "b2-popover-category" ? B2_CATEGORY_SNAPSHOT : B2_SNAPSHOT,
    saved: b2Saved(),
    threads: b2Threads(),
    tabs: b2Tabs(),
    recents: b2Recents(),
    draft,
    query: at === -1 ? null : { at, filter: fragment(draft) },
  };
}

/** the post-mount hook: the draft through the store, focus, and the popover
 * through the store's own door, the way a keystroke opens it */
export function b2PopoverAfterMount(state: string): void {
  if (!(B2_POPOVER_STATES as readonly string[]).includes(state)) return;
  const seed = b2PopoverSeed(state as B2PopoverState);
  const a = useAsk.getState();
  a.setDraft(seed.draft);
  a.requestFocus();
  if (seed.query) a.openMentions(seed.query.at, seed.query.filter);
}
