// B1 fixtures for the Ask harness: the change AFTER the Run, and the one verb
// that takes nothing away. A4 drew the proposal and stopped at the Run; these
// are the states the maintainer found the live build had no answer for.
//
//   b1-preview-insert  an INSERT proposed: the same block, the same headline
//                      and the same band as any change, with the Run in the
//                      app's ACCENT rather than in danger. Red states loss
//                      (DESIGN rule 3) and an INSERT loses nothing
//   b1-ran            a DELETE the tab took, its transaction still open: the
//                      headline reads the tab's outcome (`Deleted 1 row ·
//                      uncommitted`) and the band stays, wearing the TAB's own
//                      two actions, `Rollback` and `Commit` (danger, the
//                      commit being the irreversible moment of a DELETE)
//   b1-ran-insert     the INSERT the tab took: the same band with `Commit` in
//                      the accent, so the pair reads as one rule and not as
//                      two moods
//   b1-committed      after Commit: `Deleted 1 row · committed`, the word lit
//                      at tier 1, the exception speaking, and no band, the
//                      transaction having closed
//   b1-rolled-back    after Rollback: `Rolled back · nothing changed`. The
//                      count goes with the rows, which are back where they
//                      were, and there is nothing left to press
//
// The tab's live transaction is seeded straight into `useConnections.txTabs`
// under the exchange's own `ranTab` (fixtures.writes.ts's own seam), and the
// two settled states clear it and stamp `ranTx` instead, which is what the app
// stamps when it is the one that ended the transaction.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// APPEND B1_STATES to HarnessState, HARNESS_STATES and ask-frames' ALL_STATES;
// in `seed`, these states put `b1Seed(state).exchanges` under the fixture
// thread with the seed's busy and phase and take B1_CHOICE from `choiceFor`;
// in the post-mount rAF call `b1AfterMount(state)`; park them at the top, the
// block being the subject.

import type { AskAnswer, AskPhase } from "../agent/loop";
import type { Assumption } from "../agent/types";
import type { WritePreview } from "../ipc/types";
import type { Exchange, ToolChip } from "../stores/agent";
import { useConnections } from "../stores/connections";

export const B1_STATES = [
  "b1-preview-insert",
  "b1-ran",
  "b1-ran-insert",
  "b1-committed",
  "b1-rolled-back",
] as const;
export type B1State = (typeof B1_STATES)[number];

export interface B1Seed {
  /** the thread, oldest first */
  exchanges: Exchange[];
  /** useAgent.busy for the thread */
  busy: boolean;
  /** useAgent.phase for the thread */
  phase: AskPhase | null;
}

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the thread's choice, so the pill reads what the footers read */
export const B1_CHOICE = { provider: PROVIDER, model: MODEL } as const;

/** the session key the seeded transaction is open on: the shape
 * `skey(profileId, tabId)` writes, which is what `txTabs` is indexed by */
const RAN_TAB = "harness-staging::harness-query-tab";

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

// ---- the DELETE the tab took ------------------------------------------------

const DEL_ID = "harness-ex-b1-del";
const DEL_QUESTION = "drop the duplicate address row, the one with id 90312";
const DEL_SQL = ["DELETE FROM address", "WHERE id = 90312"].join("\n");
// the prose the rewritten WRITES block asks for: one sentence of what changes
// and why, and not a word about the fence under it
const DEL_TEXT = "Row 90312 repeats 90311 in every column but its id, so the user keeps one address.";

const DEL_PREVIEW: WritePreview = {
  verb: "DELETE",
  table: "address",
  has_where: true,
  exact_rows: 1,
  before: {
    columns: ["id", "user_id", "city", "pincode", "created_at"],
    rows: [["90312", "44127", "Bengaluru", "560038", "2026-08-29 11:04"]],
  },
  after: { columns: [], rows: [] },
  warnings: [],
};

const delChips = (): ToolChip[] => [
  chip(
    "call-1",
    "describe_tables",
    "describe address",
    306,
    { names: ["address"] },
    "address (612k rows)\n  id bigint PK\n  user_id bigint\n  city text\n  pincode text\n  created_at timestamptz",
  ),
  chip(
    "call-2",
    "run_sql",
    "count duplicates",
    188,
    { sql: "SELECT count(*) FROM address WHERE user_id = 44127" },
    "2",
  ),
  chip(`preview-${DEL_ID}`, "preview", "preview", 640, {}, "1 row"),
];

const delAnswer = (): AskAnswer => ({
  verdict: { status: "proposed", sql: DEL_SQL },
  sql: DEL_SQL,
  run: null,
  assumptions: [assumption("d1", "Duplicate = Same Address, Later Row")],
  sanity: [],
  trace: [
    {
      step: "context",
      ms: 3,
      candidates: ["public.address"],
      text: `${DEL_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\npublic.address`,
    },
    { step: "turn", ms: 9_800, index: 0, text: DEL_TEXT },
    { step: "verdict", ms: 9_800, verdict: { status: "proposed", sql: DEL_SQL } },
  ],
  text: DEL_TEXT,
  turns: 1,
  ms: 9_800,
  usage: { input: 8_600, output: 190 },
  promptVersion: "v4",
  candidates: ["public.address"],
  recall: null,
  risky: true,
});

const deleted = (over: Partial<Exchange> = {}): Exchange => ({
  id: DEL_ID,
  turnId: 51,
  question: DEL_QUESTION,
  text: DEL_TEXT,
  thinking: "",
  chips: delChips(),
  answer: delAnswer(),
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
  // the tab's own count, never the dry run's (LESSONS 13); they agree here,
  // and the day they disagree the tab is the one that is right
  status: "ran",
  preview: DEL_PREVIEW,
  ranRows: 1,
  ranTab: RAN_TAB,
  ...over,
});

// ---- the INSERT: the verb that takes nothing away ---------------------------

const INS_ID = "harness-ex-b1-ins";
const INS_QUESTION = "add the three size tags we agreed on, after the last one";
const INS_SQL = [
  "INSERT INTO tag (name, kind, sort_order)",
  "VALUES ('petite', 'size', 40),",
  "       ('tall', 'size', 41),",
  "       ('plus', 'size', 42)",
].join("\n");
const INS_TEXT = "None of the three names is in `tag` yet, so they land after 39 and nothing existing moves.";

const INS_PREVIEW: WritePreview = {
  verb: "INSERT",
  table: "tag",
  has_where: false,
  exact_rows: 3,
  before: { columns: [], rows: [] },
  after: {
    columns: ["id", "name", "kind", "sort_order"],
    rows: [
      ["208", "petite", "size", "40"],
      ["209", "tall", "size", "41"],
      ["210", "plus", "size", "42"],
    ],
  },
  warnings: [],
};

const insChips = (): ToolChip[] => [
  chip(
    "call-1",
    "describe_tables",
    "describe tag",
    241,
    { names: ["tag"] },
    "tag (206 rows)\n  id bigint PK\n  name text\n  kind text\n  sort_order int",
  ),
  chip(
    "call-2",
    "peek_values",
    "peek kind",
    174,
    { table: "public.tag", column: "kind" },
    "fit | size | occasion | fabric",
  ),
  chip(`preview-${INS_ID}`, "preview", "preview", 712, {}, "3 rows"),
];

const insAnswer = (): AskAnswer => ({
  verdict: { status: "proposed", sql: INS_SQL },
  sql: INS_SQL,
  run: null,
  assumptions: [assumption("i1", "After = Sort Order 40 Onwards")],
  sanity: [],
  trace: [
    {
      step: "context",
      ms: 3,
      candidates: ["public.tag"],
      text: `${INS_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\npublic.tag`,
    },
    { step: "turn", ms: 11_300, index: 0, text: INS_TEXT },
    { step: "verdict", ms: 11_300, verdict: { status: "proposed", sql: INS_SQL } },
  ],
  text: INS_TEXT,
  turns: 1,
  ms: 11_300,
  usage: { input: 9_400, output: 210 },
  promptVersion: "v4",
  candidates: ["public.tag"],
  recall: null,
  risky: true,
});

const inserted = (over: Partial<Exchange> = {}): Exchange => ({
  id: INS_ID,
  turnId: 52,
  question: INS_QUESTION,
  text: INS_TEXT,
  thinking: "",
  chips: insChips(),
  answer: insAnswer(),
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
  status: "proposed",
  preview: INS_PREVIEW,
  ...over,
});

// ---- exports ---------------------------------------------------------------

export function b1Seed(state: B1State): B1Seed {
  // the tab's transaction is the one fact the band and the headline both read:
  // open for the two states that just ran, closed for the two that settled, so
  // no frame can show a band over a transaction that is not there
  const open = state === "b1-ran" || state === "b1-ran-insert";
  useConnections.setState({ txTabs: open ? { [RAN_TAB]: true } : {} });
  switch (state) {
    case "b1-preview-insert":
      return { exchanges: [inserted()], busy: false, phase: null };
    case "b1-ran":
      return { exchanges: [deleted()], busy: false, phase: null };
    case "b1-ran-insert":
      return {
        exchanges: [inserted({ status: "ran", ranRows: 3, ranTab: RAN_TAB })],
        busy: false,
        phase: null,
      };
    case "b1-committed":
      return { exchanges: [deleted({ ranTx: "committed" })], busy: false, phase: null };
    case "b1-rolled-back":
      return { exchanges: [deleted({ ranTx: "rolledback" })], busy: false, phase: null };
  }
}

/** the post-mount hook: the hot cluster on the one state whose block is the
 * subject before anything has run, the `a4-preview` treatment so the two sit
 * side by side. A hover cannot be held in a still, so `data-hot` stands in
 * for it (ask.css reads `[data-hot] > .acts-float` as that surface's hover) */
export function b1AfterMount(state: string): void {
  if (state !== "b1-preview-insert") return;
  const face = document.querySelector<HTMLElement>(`[data-exchange="${INS_ID}"] .rb`);
  if (face) face.dataset.hot = "";
}
