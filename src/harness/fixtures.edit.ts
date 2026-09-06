// Edit builder's fixtures for the Ask harness (W4): edit mode over the
// sketch's three-exchange thread (fixtures.actions.ts: the discussion
// thread's two exchanges and the 91-character third), the "edit" rows of
// ask-sketch-v2.html, and a fourth exchange of this file's own for the stack.
//
//   edit         edit mode at the second exchange: its question sits in the
//                composer (focused, the caret after the last word), the
//                exchange itself is gone from the thread (the sketch's variant
//                B) and the third stands as its dimmed bubble alone; the first
//                keeps its anatomy. The composer holds the 48-character
//                question on one line at every width, the caret at its end
//   edit-latest  edit mode at the newest exchange: only it leaves, the first
//                two stand whole, the composer holds the 91-character
//                question (three lines at 320, two at 560)
//   edit-stack   edit mode at the second of FOUR exchanges (the three, then a
//                41-character follow-up over a value), so the third and fourth
//                fold together: two dimmed bubbles in one stack, the 91-
//                character one over the short one (four lines over two at
//                320, two over one at 560), --sp-2 apart where the thread
//                gives 28px (ask.css, the fold section). The one state that
//                draws neighbouring folded bubbles, the pixel evidence for
//                that rule (DESIGN rule 9)
//
// Seed contract (fixtures.ts / AskHarness.tsx / ask-frames.ts are the
// integrator's): add EDIT_STATES to HarnessState, HARNESS_STATES and
// ask-frames' ALL_STATES; in `seed`, put `editSeed(state).exchanges` under the
// fixture thread, busy false, phase null, and reset `edit: null` beside the
// other useAsk fields; then, in the post-mount rAF (after the pane's own mount
// effects have set draftFor: the store's setDraftFor clears an edit seeded
// against another connection), call `editAfterMount(state)`. It enters the
// mode through the store's own door, `beginEdit`, which writes the draft and
// asks for focus, so the frame shows what the product shows; the focus lands
// one frame after the ready mark, inside the script's settle. Frames run
// under reduced motion, so no travel ghost renders and the textarea holds
// the text at once; the bottom pin is the sketch's (the stack, then the
// composer).
//
// Imports fixtures.ts for the harness connection and thread ids, and reads
// them only inside functions, so the cycle through fixtures.ts never meets
// an uninitialised binding (the fixtures.interact.ts precedent).

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, Assumption, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import { useAsk, type AskEdit } from "../stores/ask";
import { FIXTURE } from "./fixtures";
import { actionsSeed } from "./fixtures.actions";

export const EDIT_STATES = ["edit", "edit-latest", "edit-stack"] as const;
export type EditState = (typeof EDIT_STATES)[number];

export interface EditSeed {
  /** the thread, oldest first: the actions builder's three exchanges, and
   * for `edit-stack` the fourth below */
  exchanges: Exchange[];
  /** useAsk.edit for the state, entered after mount (editAfterMount) */
  edit: AskEdit;
}

// ---- the fourth exchange: a short follow-up over a value -----------------------
// Asked after the 91-character third (`217` first-time customers): the same
// thread, Haiku 4.5 through Claude Code, prose that interprets and never
// repeats the value (DESIGN rule 14). Folded in the one state that seeds it,
// so only its bubble renders; the anatomy is here so the seed is a landed
// thread and not a bubble over nothing.

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";

const AGAIN_QUESTION = "did any of them order again in september";

const AGAIN_SQL = [
  "SELECT COUNT(DISTINCT r.user_id) AS returned_in_september",
  "FROM order_v2 r",
  "WHERE r.payment_status = 'paid'",
  "  AND r.created_at >= date_trunc('month', now())",
  "  AND r.user_id IN (",
  "    SELECT o.user_id",
  "    FROM order_v2 o",
  "    WHERE o.payment_status = 'paid'",
  "      AND o.created_at >= date_trunc('month', now() - interval '1 month')",
  "      AND o.created_at <  date_trunc('month', now())",
  "      AND NOT EXISTS (",
  "        SELECT 1 FROM order_v2 p",
  "        WHERE p.user_id = o.user_id",
  "          AND p.payment_status = 'paid'",
  "          AND p.created_at < date_trunc('month', now() - interval '1 month')))",
].join("\n");

const AGAIN_TEXT =
  "Counted on paid orders only, so a September order still awaiting payment does not make its customer a returner yet.\n\n" +
  "```sql\n" +
  AGAIN_SQL +
  "\n```\n\n" +
  "Assumptions: Again = A Paid Order This Month";

const AGAIN_RUN: AgentRun = {
  columns: ["returned_in_september"],
  rows: [["38"]],
  rowCount: 1,
  capped: false,
  ms: 96.4,
};

const AGAIN_ASSUMPTIONS: Assumption[] = [
  { id: "model:0", label: "Again = A Paid Order This Month", source: "model", active: true },
];

const AGAIN_FOLLOW_UPS = [
  "How soon after their first order did they come back?",
  "What did the returning customers spend?",
  "How many of them came back more than once?",
];

const AGAIN_CANDIDATES = [
  "public.order_v2 (1.2M rows): id, user_id, total_amount, currency, payment_status, created_at",
  "public.users (1.2M rows): id, email, created_at, signup_source, is_deleted",
];

const runChip: ToolChip = {
  id: "call-1",
  name: "run_sql",
  label: "run",
  ms: 96,
  isError: false,
  args: JSON.stringify({ sql: AGAIN_SQL }),
  result: "returned_in_september\n38\n(1 row)",
};

const usage = { input: 13_100, output: 240, cacheRead: 11_600, cacheWrite: 0 };

const AGAIN_TRACE: TraceStep[] = [
  {
    step: "context",
    ms: 3,
    candidates: AGAIN_CANDIDATES,
    text: `${AGAIN_QUESTION}\n\nCANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\n${AGAIN_CANDIDATES.join("\n")}`,
  },
  { step: "turn", ms: 17_400, index: 0, text: AGAIN_TEXT, usage },
  {
    step: "tool",
    ms: runChip.ms ?? 0,
    id: runChip.id,
    name: runChip.name,
    args: runChip.args,
    result: runChip.result ?? "",
    isError: false,
  },
  { step: "verdict", ms: 18_700, verdict: { status: "answered", sql: AGAIN_SQL, rowCount: 1 } },
  {
    step: "followups",
    ms: 1100,
    prompt: `Question: ${AGAIN_QUESTION}\n\nAnswer:\n${AGAIN_TEXT}\n\nSQL:\n${AGAIN_SQL}`,
    text: AGAIN_FOLLOW_UPS.join("\n"),
    questions: AGAIN_FOLLOW_UPS,
    usage: { input: 480, output: 38 },
  },
];

const AGAIN_ANSWER: AskAnswer = {
  verdict: { status: "answered", sql: AGAIN_SQL, rowCount: 1 },
  sql: AGAIN_SQL,
  run: AGAIN_RUN,
  assumptions: AGAIN_ASSUMPTIONS,
  sanity: [],
  followUps: AGAIN_FOLLOW_UPS,
  trace: AGAIN_TRACE,
  text: AGAIN_TEXT,
  turns: 1,
  ms: 18_700,
  usage,
  promptVersion: "v2",
  candidates: AGAIN_CANDIDATES,
  recall: null,
  risky: false,
};

const again: Exchange = {
  id: "harness-ex-edit-4",
  turnId: 26,
  question: AGAIN_QUESTION,
  text: AGAIN_TEXT,
  thinking: "",
  chips: [runChip],
  answer: AGAIN_ANSWER,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

// ---- exports ---------------------------------------------------------------------------

export function editSeed(state: EditState): EditSeed {
  const three = actionsSeed("actions").exchanges;
  const exchanges = state === "edit-stack" ? [...three, again] : three;
  const source = exchanges[state === "edit-latest" ? exchanges.length - 1 : 1];
  if (!source) throw new Error("fixtures.edit: the actions thread is short");
  return {
    exchanges,
    edit: {
      profileId: FIXTURE.profile.id,
      threadId: FIXTURE.thread.id,
      exchangeId: source.id,
      question: source.question,
    },
  };
}

/** the post-mount hook: enter the mode the way a click does, minus the
 * bubble's arming frame (a still has no travel to arm for) */
export function editAfterMount(state: string): void {
  if (!(EDIT_STATES as readonly string[]).includes(state)) return;
  useAsk.getState().beginEdit(editSeed(state as EditState).edit);
}
