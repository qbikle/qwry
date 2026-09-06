// The Structure view's states for the third harness root (A2 item 2, the
// sketch's row 4 of `~/projects/qwry-agent-lab/docs/ask-sketch-a2.html`). The
// hint line lives where this view already printed the live `COMMENT`, so the
// frame has to be the view, not a card: `?harness=structure`
// (src/harness/StructureHarness.tsx), one width, the browser's own.
//
//   a2-hint       the view at rest over a connection that has hinted this
//                 table (tier 1, with its `aka` clause) and one of its
//                 columns; the table's own comment is still there, under the
//                 hint, reachable as the line's tooltip. Columns with neither
//                 print nothing at rest: a sixty-column table prints no sixty
//                 lines of chrome (DESIGN rule 8's two routes)
//   a2-hint-edit  the same line open: the field in place, the same padding,
//                 the ring turned accent, and the database's own comment as
//                 the placeholder, so clearing the field previews what will
//                 read again
//   a2-hint-rest  the same view over a connection that knows NOTHING: the
//                 table's line is the database's own comment in tier 2 and
//                 every uncommented column cell prints nothing, with the
//                 `currency` cell focused so the placeholder's second route
//                 is in the frame (rule 8: hover OR focus)
//   a2-hint-aka   one hinted column and no comments anywhere: the table's own
//                 line wears `Hint for Ask…` at rest, the one place the
//                 feature says its name, and `payment_status` carries the
//                 `aka` clause in a cell one row high
//
// The stats are canned because the view asks the database for them on mount
// (tauriShim answers `table_stats`): everything below the Columns table is
// the view as it stands today and is here so the hint line is framed in its
// real neighbourhood, not on an empty page.

import type { KnowledgeRow, TableStats } from "../ipc/types";
import type { SchemaSnapshot, TableInfo } from "../stores/schema";
import { MENTION_SNAPSHOT, ORDER_V2_COMMENT } from "./fixtures.mentions";

export const STRUCTURE_STATES = ["a2-hint", "a2-hint-edit", "a2-hint-rest", "a2-hint-aka"] as const;
export type StructureState = (typeof STRUCTURE_STATES)[number];

const PROFILE = "harness-staging";

/** the state the canned `table_stats` answers for. tauriShim asks this module
 * for the stats with no arguments (it answers one command, not one state), so
 * the harness hands the state here before it mounts. */
let fixtureState: StructureState = "a2-hint";

export function setStructureFixture(state: StructureState): void {
  fixtureState = state;
}

export const STRUCTURE_TABLE: TableInfo =
  MENTION_SNAPSHOT.tables.find((t) => t.name === "order_v2") ?? MENTION_SNAPSHOT.tables[0];

export const STRUCTURE_SNAPSHOT: SchemaSnapshot = MENTION_SNAPSHOT;

/** what this connection knows about the table on screen: a hint with the
 * names its people call it by, and one hinted column among eight. A connection
 * that knows nothing (`a2-hint-rest`) is the empty list, which is what a
 * database reads like before anyone has typed into this feature. */
export function structureKnowledge(state: StructureState = "a2-hint"): KnowledgeRow[] {
  const at = "2026-09-05T18:40:00Z";
  const row = (id: string, target: string, kind: KnowledgeRow["kind"], text: string): KnowledgeRow => ({
    id,
    profile_id: PROFILE,
    kind,
    target,
    text,
    created_at: at,
    updated_at: at,
  });
  if (state === "a2-hint-rest") return [];
  if (state === "a2-hint-aka") {
    return [
      row(
        "harness-hint-payment",
        "public.order_v2.payment_status",
        "hint",
        "Set by the gateway",
      ),
      row("harness-syn-status", "public.order_v2.payment_status", "synonym", "status"),
      row("harness-syn-state", "public.order_v2.payment_status", "synonym", "payment_state"),
    ];
  }
  return [
    row(
      "harness-hint-order",
      "public.order_v2",
      "hint",
      "Checkout attempts, one row each; failed ones stay. Revenue questions want payment_status <> 'failed'.",
    ),
    row("harness-syn-orders", "public.order_v2", "synonym", "orders"),
    row("harness-syn-purchases", "public.order_v2", "synonym", "purchases"),
    row(
      "harness-hint-currency",
      "public.order_v2.currency",
      "hint",
      "ISO-4217; everything before July is INR whatever this says",
    ),
  ];
}

const ix = (
  name: string,
  definition: string,
  size: string,
  scans: number | null,
  flags: Partial<TableStats["indexes"][number]> = {},
): TableStats["indexes"][number] => ({
  name,
  definition,
  is_unique: false,
  is_primary: false,
  backs_constraint: false,
  size_bytes: 0,
  size_pretty: size,
  scans,
  ...flags,
});

/** the stats the view asks for on mount, as `agent`-free canned data: the
 * numbers are the wave's own order_v2 (2.1M rows) */
export function structureStats(): TableStats {
  // `a2-hint-aka` is the table the database never commented: the hint line has
  // nothing under it, so it wears its placeholder at rest
  const bare = fixtureState === "a2-hint-aka";
  return {
    comment: bare ? null : ORDER_V2_COMMENT,
    column_comments: bare
      ? []
      : [
          { column: "payment_status", comment: "paid, pending, failed, refunded, cod_pending" },
          { column: "paid_at", comment: "null until the gateway confirms" },
        ],
    columns: STRUCTURE_TABLE.columns.map((c) => ({
      name: c.name,
      attnum: c.attnum,
      data_type: c.type,
      not_null: c.name === "id" || c.name === "created_at",
      default: c.name === "id" ? "gen_random_uuid()" : null,
      identity: "",
      generated: "",
    })),
    constraints: [
      { name: "order_v2_pkey", kind: "p", definition: "PRIMARY KEY (id)" },
      {
        name: "order_v2_user_id_fkey",
        kind: "f",
        definition: "FOREIGN KEY (user_id) REFERENCES users(id)",
      },
      {
        name: "order_v2_total_amount_check",
        kind: "c",
        definition: "CHECK (total_amount >= 0::numeric)",
      },
    ],
    indexes: [
      ix("order_v2_pkey", "CREATE UNIQUE INDEX order_v2_pkey ON public.order_v2 USING btree (id)", "184 MB", 41_882_104, {
        is_unique: true,
        is_primary: true,
        backs_constraint: true,
      }),
      ix(
        "order_v2_user_id_idx",
        "CREATE INDEX order_v2_user_id_idx ON public.order_v2 USING btree (user_id)",
        "96 MB",
        2_104_882,
      ),
      ix(
        "order_v2_currency_idx",
        "CREATE INDEX order_v2_currency_idx ON public.order_v2 USING btree (currency)",
        "48 MB",
        0,
      ),
    ],
    triggers: [
      {
        name: "order_v2_set_updated_at",
        definition:
          "CREATE TRIGGER order_v2_set_updated_at BEFORE UPDATE ON public.order_v2 FOR EACH ROW EXECUTE FUNCTION set_updated_at()",
        enabled: true,
      },
    ],
    sizes: {
      table_bytes: 0,
      indexes_bytes: 0,
      total_bytes: 0,
      table_pretty: "1204 MB",
      indexes_pretty: "328 MB",
      total_pretty: "1532 MB",
    },
    activity: {
      n_live_tup: 2_104_331,
      n_dead_tup: 18_402,
      seq_scan: 214,
      idx_scan: 44_102_918,
      last_vacuum: null,
      last_autovacuum: "2026-09-06T02:14:00Z",
      last_analyze: null,
      last_autoanalyze: "2026-09-06T02:16:00Z",
    },
  };
}
