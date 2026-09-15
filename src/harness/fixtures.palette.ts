// The palette states for the second harness root (A2, the sketch's row 5 of
// `~/projects/qwry-agent-lab/docs/ask-sketch-a2.html`). The palette is not the
// Ask pane: it is a modal over the app background, so it has a root of its own
// (`?harness=palette`, src/harness/PaletteHarness.tsx) and one width, its own
// 620px. Same conventions as the Ask fixtures: the stores' own types, the
// harness connection `staging` on `auth_new`, and prose that interprets rather
// than repeats a cell (DESIGN rule 14).
//
//   a2-palette  the palette resting on a connection that has all three kinds
//               of Saved row: a bookmark, two quick-asks (the `MessageSquare`
//               the question earns), and three checks, two passing and one
//               failed. A passing row is its dot and nothing more; the failed
//               row alone speaks, with `Ask Why` and the drift in the status
//               register (DESIGN rule 11). `Run Checks` stands in Actions with
//               the last run in its own detail slot, and the `Definitions`
//               group is drawn because this connection has two
//   a2-define    `Define…` picked: the palette's own input IS the definition
//               line, `term = meaning`, and the list under it is what already
//               stands, the same rows the group draws (one list, rule 14)
//   a2-checks   the same palette with `checks` typed: `Run Checks` is the
//               thirteenth row of Actions in a real palette, so the way a user
//               reaches it is the way this frame does, and the action carries
//               the last run in its own detail slot
//
// The seed is read by PaletteHarness alone; nothing here imports the Ask
// fixtures except the failed check's NAME, so the palette row and the
// `Ask Why` exchange (fixtures.knowledge.ts) name one check.

import type { KnowledgeRow } from "../ipc/types";
import type { Profile } from "../ipc/types";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot } from "../stores/schema";
import type { Tab } from "../stores/tabs";
import { CHECK_NAME } from "./fixtures.knowledge";
import { MENTION_SNAPSHOT } from "./fixtures.mentions";

export const PALETTE_STATES = ["a2-palette", "a2-define", "a2-checks"] as const;
export type PaletteState = (typeof PALETTE_STATES)[number];

const PROFILE = "harness-staging";

export const PALETTE_PROFILE: Profile = {
  id: PROFILE,
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

const tab = (id: string, name: string, kind: Tab["kind"], sql: string, position: number): Tab => ({
  id,
  name,
  sql,
  position,
  saved_id: null,
  kind,
  // the table a browser tab shows, as the snapshot spells it: the palette
  // reads only its kind and its name, so the row is the snapshot's own
  table: kind === "table" ? (MENTION_SNAPSHOT.tables.find((t) => t.name === name) ?? null) : null,
  canvas_id: null,
  profile_id: PROFILE,
});

/** the workspace behind the palette: the tab `Explain with Ask` acts on is the
 * active one, so the action draws (a tab with no SQL is a dead row) */
const TABS: Tab[] = [
  tab(
    "harness-tab-cohort",
    "cohort retention",
    "query",
    "SELECT date_trunc('month', created_at)::date AS cohort, COUNT(DISTINCT user_id)\nFROM order_v2 GROUP BY 1 ORDER BY 1;",
    0,
  ),
  tab("harness-tab-order-v2", "order_v2", "table", "", 1),
];

const check = (kind: "rows" | "scalar", n: number) =>
  kind === "rows"
    ? JSON.stringify({ kind: "rows", op: "eq", n })
    : JSON.stringify({ kind: "scalar", eq: String(n) });

const verdict = (ok: boolean, rows: number) =>
  JSON.stringify({ ok, rows, at: "2026-09-06T09:12:00Z" });

/** the connection's bookmarks: one plain, two quick-asks, three checks. The
 * failed one is the check the Ask pane's `a2-ask-why` answers about, named
 * once (LESSONS 13) */
export function paletteSaved(): SavedQuery[] {
  return [
    {
      id: "harness-saved-monthly",
      name: "Monthly revenue",
      sql: "SELECT date_trunc('month', created_at)::date AS month, SUM(total_amount) AS revenue\nFROM order_v2 WHERE payment_status = 'paid' GROUP BY 1 ORDER BY 1;",
      created_at: "2026-07-02T09:00:00Z",
      profile_id: PROFILE,
    },
    {
      id: "harness-saved-quick-ask",
      name: "how many active buyers made purchases in august",
      sql: "SELECT COUNT(DISTINCT o.user_id) AS active_buyers FROM order_v2 o JOIN users u ON u.id = o.user_id\nWHERE o.payment_status <> 'failed' AND o.created_at >= '2026-08-01';",
      created_at: "2026-09-05T18:22:00Z",
      profile_id: PROFILE,
      question: "how many active buyers made purchases in august",
    },
    {
      id: "harness-saved-orders-user",
      name: "Orders have a user",
      sql: "SELECT id FROM order_v2 WHERE user_id IS NULL;",
      created_at: "2026-07-11T10:14:00Z",
      profile_id: PROFILE,
      expect_json: check("rows", 0),
      last_check_json: verdict(true, 0),
    },
    {
      id: "harness-saved-currency",
      name: "how many orders are missing a currency",
      sql: "SELECT COUNT(*) FROM order_v2 WHERE currency IS NULL;",
      created_at: "2026-08-02T12:31:00Z",
      profile_id: PROFILE,
      question: "how many orders are missing a currency",
      expect_json: check("scalar", 0),
      last_check_json: JSON.stringify({ ok: true, rows: 1, scalar: "0", at: "2026-09-06T09:12:00Z" }),
    },
    {
      id: "harness-saved-unpaid-week",
      name: CHECK_NAME,
      sql: "SELECT payment_status, COUNT(*) AS orders FROM order_v2\nWHERE payment_status IN ('pending', 'cod_pending') AND created_at < now() - interval '7 days'\nGROUP BY 1;",
      created_at: "2026-07-19T11:05:00Z",
      profile_id: PROFILE,
      expect_json: check("rows", 0),
      last_check_json: verdict(false, 12),
    },
  ];
}

/** what this connection defines, oldest first (the store's own order): the
 * palette's `Definitions` group and define mode's list are the same rows */
export function paletteKnowledge(): KnowledgeRow[] {
  const at = "2026-09-05T18:40:00Z";
  const row = (id: string, text: string): KnowledgeRow => ({
    id,
    profile_id: PROFILE,
    kind: "definition",
    target: null,
    text,
    created_at: at,
    updated_at: at,
  });
  return [
    row("harness-def-buyers", "active buyers = signed in within the last 30 days"),
    row(
      "harness-def-revenue",
      "revenue = total_amount of orders whose payment_status is not failed, in INR",
    ),
  ];
}

export interface PaletteSeed {
  profile: Profile;
  snapshot: SchemaSnapshot;
  tabs: Tab[];
  activeTabId: string;
  saved: SavedQuery[];
  knowledge: KnowledgeRow[];
}

export function paletteSeed(): PaletteSeed {
  return {
    profile: PALETTE_PROFILE,
    snapshot: MENTION_SNAPSHOT,
    tabs: TABS,
    activeTabId: TABS[0].id,
    saved: paletteSaved(),
    knowledge: paletteKnowledge(),
  };
}

/** the line define mode holds in `a2-define`: the definition being edited,
 * typed into the palette's own input through the input's own event, so the
 * frame shows what the component renders and not what a fixture asserted */
export const DEFINE_LINE = "active buyers = signed in within the last 30 days";

/** what `a2-checks` types to reach the action: the palette's own filter, so
 * the frame is a route a user has rather than a state a fixture invented */
export const CHECKS_QUERY = "checks";

/** the row the keyboard rests on, stamped after mount because a still cannot
 * hold a hover (the `actions` precedent): the failed check, the one row of the
 * Saved group that says anything beyond its dot */
export const HOT_ROW = `saved harness-saved-unpaid-week ${CHECK_NAME}`;
