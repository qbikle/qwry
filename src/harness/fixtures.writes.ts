// Write-preview fixtures for the Ask harness (A4 items 4-5, the "A4 · writes"
// rows of ask-sketch-a4.html): a change the model proposed and nothing has
// run, the result block wearing its third face over the dry run's sampled
// rows, and the same exchange once the query tab has taken it.
//
//   a4-preview       the sketch's UPDATE: the headline `UPDATE order_v2 · 12
//                    rows`, six sampled rows with two columns changing on
//                    each (`pending → paid`, `NULL → 2026-09-06 16:52`), the
//                    band's `Update 12 Rows`, the block hot
//   a4-preview-warn  a DELETE with no WHERE: the warning is a FRAGMENT of the
//                    headline under one glyph, never a line of its own
//                    (`DELETE notification_history · no WHERE · 48,213
//                    rows`), the before rows plain, `Delete 48,213 Rows`
//   a4-preview-sql   the same UPDATE flipped to the SQL face through the
//                    store's own door (useAsk.setFace): the flip's glyph is
//                    now the table and the band stays
//   a4-ran           after the Run: the headline reads the TAB's outcome
//                    (`Updated 12 rows · uncommitted`), the band is gone and
//                    the cluster stays. `uncommitted` is bound to the tab's
//                    LIVE transaction, so the seed opens one
//   a4-preview-busy  the dry run in flight: the strip's `preview` chip
//                    spinning over the block on its SQL face, the statement
//                    readable and insertable before the round trip, nothing
//                    the dry run owns on screen yet (no headline, no band, no
//                    Flip). AGENT-UX 13.2 and 13.9; the taste gate's spinner
//                    check
//   a4-writes-off    the same proposal on a connection whose edits are off:
//                    the failure card (`not run` over `edits are off for this
//                    connection`), the statement in the field with Insert on
//                    it, and `Settings… · Ask Differently`
//
// The hot face: a hover cannot be held in a still, so `writesAfterMount`
// stamps `data-hot` on the block the cluster floats over, the `result`
// precedent (ask.css reads `[data-hot] > .acts-float` as that surface's
// hover).
//
// One seam this file reaches that the pane cannot fake on its own: the tab's
// live transaction is seeded straight into `useConnections.txTabs` under the
// exchange's own `ranTab`, and every other state clears it, so `uncommitted`
// never leaks into a frame that has not run.
//
// Self-contained: nothing here imports fixtures.ts, so there is no cycle to
// order. Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the
// integrator's): add WRITES_STATES to HarnessState, HARNESS_STATES and
// ask-frames' ALL_STATES; in `seed`, these states put `writesSeed(state)
// .exchanges` under the fixture thread with the seed's busy and phase and
// take WRITES_CHOICE from `choiceFor`; in the post-mount rAF call
// `writesAfterMount(state)` beside `resultAfterMount(state)`; park them at
// the top (`scroll=top` by default, the `result` precedent), the block being
// the subject.

import type { AskAnswer, AskPhase } from "../agent/loop";
import type { Assumption } from "../agent/types";
import type { WritePreview } from "../ipc/types";
import type { Exchange, ToolChip } from "../stores/agent";
import { useAsk } from "../stores/ask";
import { useConnections } from "../stores/connections";

export const WRITES_STATES = [
  "a4-preview",
  "a4-preview-warn",
  "a4-preview-sql",
  "a4-ran",
  "a4-preview-busy",
  "a4-writes-off",
] as const;
export type WritesState = (typeof WRITES_STATES)[number];

export interface WritesSeed {
  /** the thread, oldest first */
  exchanges: Exchange[];
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the orders thread's choice, so the pill reads what the footers read */
export const WRITES_CHOICE = { provider: PROVIDER, model: MODEL } as const;

/** the session key the seeded transaction is open on: the shape
 * `skey(profileId, tabId)` writes, which is what `txTabs` is indexed by */
const RAN_TAB = "harness-staging::harness-query-tab";

/** the UPDATE exchange's id, which its preview chip is keyed on */
const UP_ID = "harness-ex-a4-up";

const chip = (
  id: string,
  name: ToolChip["name"],
  label: string,
  ms: number | null,
  args: Record<string, unknown>,
  result: string | null,
): ToolChip => ({ id, name, label, ms, isError: false, args: JSON.stringify(args), result });

const assumption = (id: string, label: string): Assumption => ({
  id,
  label,
  source: "model",
  active: true,
});

// ---- the UPDATE: twelve August orders Razorpay captured ---------------------

const UP_QUESTION = "mark the pending August orders that Razorpay captured as paid and stamp paid_at";

const UP_SQL = [
  "UPDATE order_v2",
  "SET payment_status = 'paid',",
  "    paid_at = now()",
  "WHERE payment_status = 'pending'",
  "  AND razorpay_payment_id IS NOT NULL",
  "  AND created_at >= '2026-08-01'",
  "  AND created_at < '2026-09-01'",
].join("\n");

const UP_TEXT =
  "Captured is read as a set `razorpay_payment_id`; every match is prepaid, so no COD row moves.";

const UP_COLUMNS = ["id", "payment_status", "paid_at", "total_amount", "currency"];
const UP_IDS = ["218841", "218903", "218977", "219012", "219054", "219118"];
const UP_AMOUNTS = ["4725.00", "2564.00", "1899.00", "3210.00", "6480.00", "1150.00"];

/** the dry run: the six rows it sampled before, and the six the statement
 * returned (`WRITE_SAMPLE_ROWS`, the block's own grid window, so a preview
 * fills it). Two columns move on every row, so the block's grid carries two
 * `old → new` cells per row and one of them starts at NULL */
const UP_PREVIEW: WritePreview = {
  verb: "UPDATE",
  // qualified exactly as the statement wrote it (agent.rs WriteShape): the
  // gate holds no connection, so it never resolves a search_path
  table: "order_v2",
  has_where: true,
  exact_rows: 12,
  before: {
    columns: UP_COLUMNS,
    rows: UP_IDS.map((id, i) => [id, "pending", null, UP_AMOUNTS[i], "INR"]),
  },
  after: {
    columns: UP_COLUMNS,
    rows: UP_IDS.map((id, i) => [id, "paid", "2026-09-06 16:52", UP_AMOUNTS[i], "INR"]),
  },
  warnings: [],
};

/** the dry run's own chip, in the `run` chip's species (A4 item 4): `ms: null`
 * is the spinning face, a landed one the filled ring. The id and the empty
 * `args` are the store's own (`previewInto`): the dry run is not a tool call
 * and writes no trace step, so the chip carries no arguments to open */
const previewChip = (ms: number | null) =>
  chip(`preview-${UP_ID}`, "preview", "preview", ms, {}, ms === null ? null : "12 rows");

const upChips = (previewMs: number | null): ToolChip[] => [
  chip(
    "call-1",
    "describe_tables",
    "describe order_v2",
    412,
    { names: ["order_v2"] },
    "order_v2 (2.1M rows)\n  id bigint PK\n  payment_status text\n  paid_at timestamptz\n  razorpay_payment_id text",
  ),
  chip(
    "call-2",
    "peek_values",
    "peek payment_status",
    233,
    { table: "public.order_v2", column: "payment_status" },
    "paid | pending | failed | cod_pending | refunded",
  ),
  previewChip(previewMs),
];

const UP_ASSUMPTIONS = [
  assumption("a1", "Captured = razorpay_payment_id Set"),
  assumption("a2", "August = created_at"),
  assumption("a3", "Paid At = Now"),
];

const upAnswer = (): AskAnswer => ({
  verdict: { status: "proposed", sql: UP_SQL },
  sql: UP_SQL,
  run: null,
  assumptions: UP_ASSUMPTIONS,
  sanity: [],
  trace: [
    {
      step: "context",
      ms: 4,
      candidates: ["public.order_v2"],
      text: `${UP_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\npublic.order_v2`,
    },
    { step: "turn", ms: 18_400, index: 0, text: UP_TEXT },
    { step: "verdict", ms: 18_400, verdict: { status: "proposed", sql: UP_SQL } },
  ],
  text: UP_TEXT,
  turns: 1,
  ms: 18_400,
  usage: { input: 12_400, output: 380 },
  promptVersion: "v4",
  candidates: ["public.order_v2"],
  recall: null,
  risky: true,
});

const proposedUpdate = (): Exchange => ({
  id: UP_ID,
  turnId: 41,
  question: UP_QUESTION,
  text: UP_TEXT,
  thinking: "",
  chips: upChips(1_240),
  answer: upAnswer(),
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
  status: "proposed",
  preview: UP_PREVIEW,
});

/** after the Run: the TAB's own count in the headline, its transaction still
 * open, and no band. `ranRows` is the tab's, never the preview's (LESSONS 13) */
const ranUpdate = (): Exchange => ({
  ...proposedUpdate(),
  status: "ran",
  ranRows: 12,
  ranTab: RAN_TAB,
});

/** the dry run in flight: the answer has landed, the chip is spinning and the
 * preview has not arrived, so no headline and no band stand yet. The exchange
 * keeps its STREAMING face while it runs, which is what the store leaves
 * behind (`previewInto`): the loop finished, the exchange did not */
const previewBusy = (): Exchange => ({
  ...proposedUpdate(),
  chips: upChips(null),
  streaming: true,
  preview: undefined,
});

/** edits are off for the connection: nothing ran, the statement is still
 * reachable in the field, and the way out is Settings */
const writesOff = (): Exchange => ({
  ...proposedUpdate(),
  id: "harness-ex-a4-off",
  chips: upChips(1_240).slice(0, 2),
  status: undefined,
  preview: undefined,
  error: { kind: "writesoff", message: "edits are off for this connection" },
  answer: {
    ...upAnswer(),
    ms: 14_200,
    trace: [{ step: "verdict", ms: 14_200, verdict: { status: "proposed", sql: UP_SQL } }],
  },
});

// ---- the DELETE with no WHERE ----------------------------------------------

const DEL_QUESTION = "clear out the notification history table, we are re-seeding it";
const DEL_SQL = "DELETE FROM notification_history";
const DEL_TEXT =
  "No foreign key points here and the sequence is not reset, so re-seeded ids continue where these end.";

const DEL_COLUMNS = ["id", "user_id", "type", "sent_at"];
const DEL_ROWS: (string | null)[][] = [
  ["1", "1042", "order_shipped", "2026-01-03 09:12"],
  ["2", "1042", "order_delivered", "2026-01-05 18:40"],
  ["3", "2210", "payment_failed", "2026-01-05 19:02"],
  ["4", "88", "promo", "2026-01-06 07:30"],
  ["5", "2210", "payment_retry", "2026-01-06 10:15"],
  ["6", "417", "order_shipped", "2026-01-06 11:48"],
];

/** both warnings are true at once: `missing_where` lifts its own fragment and
 * `many_rows` lifts the count, under the one glyph the first fragment carries */
const DEL_PREVIEW: WritePreview = {
  verb: "DELETE",
  table: "notification_history",
  has_where: false,
  exact_rows: 48_213,
  before: { columns: DEL_COLUMNS, rows: DEL_ROWS },
  after: { columns: [], rows: [] },
  warnings: ["missing_where", "many_rows"],
};

const proposedDelete = (): Exchange => ({
  id: "harness-ex-a4-del",
  turnId: 42,
  question: DEL_QUESTION,
  text: DEL_TEXT,
  thinking: "",
  chips: [
    chip(
      "call-1",
      "describe_tables",
      "describe notification_history",
      288,
      { names: ["notification_history"] },
      "notification_history (48,213 rows)\n  id bigint PK\n  user_id bigint\n  type text\n  sent_at timestamptz",
    ),
    previewChip(980),
  ],
  answer: {
    verdict: { status: "proposed", sql: DEL_SQL },
    sql: DEL_SQL,
    run: null,
    assumptions: [assumption("d1", "Clear = Delete Every Row")],
    sanity: [],
    trace: [
      {
        step: "context",
        ms: 3,
        candidates: ["public.notification_history"],
        text: `${DEL_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\npublic.notification_history`,
      },
      { step: "turn", ms: 12_700, index: 0, text: DEL_TEXT },
      { step: "verdict", ms: 12_700, verdict: { status: "proposed", sql: DEL_SQL } },
    ],
    text: DEL_TEXT,
    turns: 1,
    ms: 12_700,
    usage: { input: 9_100, output: 240 },
    promptVersion: "v4",
    candidates: ["public.notification_history"],
    recall: null,
    risky: true,
  },
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
  status: "proposed",
  preview: DEL_PREVIEW,
});

// ---- exports ---------------------------------------------------------------

export function writesSeed(state: WritesState): WritesSeed {
  // the tab's transaction is the ONE thing `uncommitted` reads: seed it only
  // for the state that ran, and clear it for every other, or the word would
  // stand over an exchange that never touched a tab (LESSONS 9)
  useConnections.setState({ txTabs: state === "a4-ran" ? { [RAN_TAB]: true } : {} });
  switch (state) {
    case "a4-preview":
    case "a4-preview-sql":
      return { exchanges: [proposedUpdate()], busy: false, phase: null };
    case "a4-preview-warn":
      return { exchanges: [proposedDelete()], busy: false, phase: null };
    case "a4-ran":
      return { exchanges: [ranUpdate()], busy: false, phase: null };
    case "a4-preview-busy":
      return { exchanges: [previewBusy()], busy: true, phase: "running" };
    case "a4-writes-off":
      return { exchanges: [writesOff()], busy: false, phase: null };
  }
}

/** the post-mount hook: the SQL face through the store's own door, then the
 * hot cluster. Runs in the harness's rAF after the pane's mount effects, so
 * the face is set on a block already on screen (the `result` precedent) */
export function writesAfterMount(state: string): void {
  if (!(WRITES_STATES as readonly string[]).includes(state)) return;
  const s = state as WritesState;
  if (s === "a4-preview-sql") useAsk.getState().setFace("harness-ex-a4-up", "sql");
  const hot =
    s === "a4-writes-off"
      ? { id: "harness-ex-a4-off", sel: ".ans-fix" }
      : s === "a4-preview" || s === "a4-preview-sql"
        ? { id: "harness-ex-a4-up", sel: ".rb" }
        : null;
  if (!hot) return;
  const face = document.querySelector<HTMLElement>(`[data-exchange="${hot.id}"] ${hot.sel}`);
  if (face) face.dataset.hot = "";
}
