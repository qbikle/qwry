// E4 ask fixtures: the two shapes the conversational wave adds to the pane,
// both drawn from the maintainer's own canvas thread (the finding this wave
// exists for).
//
//   e4-prose-answer  a canvas thread, and a question no table answers. The
//                    model replied in text and called no tool, so R1 ends the
//                    exchange `answered` with the model's own words as the
//                    answer: bubble with the `@"Canvas"` pill, the prose, the
//                    footer `1 turn · 58.6 s · Haiku 4.5`. No thinking strip
//                    (nothing ran), no result block, no SQL face, no failure
//                    block and no Fix It. What shipped before this wave put
//                    the prose in the SQL field under `query failed` and
//                    offered to fix it, which is the picture this frame
//                    replaces.
//
//   e4-nudged        a data question the model first answered in prose. R3
//                    sends ONE nudge and lets it answer again; this is the
//                    trace, open at the nudge, with the run that followed it
//                    under the next turn. The subject is the two rows that
//                    are new in the list — `NUDGE no query ran` and the turn
//                    whose `run_sql` came after it — and the proof that they
//                    are the model's answer and not the loop's: the run is a
//                    call the model made, so it wears no `closing fence`.
//
// The first state's question and its prose are written for the frame, not
// lifted from the thread the finding came from: what the frame is evidence
// for is the ANATOMY of an answer in words (no thinking strip, no SQL face,
// no failure block, no Fix It), and that anatomy is the same whoever typed
// the question. The two texts the maintainer's own thread holds stay in the
// tests that replay it (`loop.test`, `agent-prose.test`) and nowhere else in
// the tree. Everything else here follows the house convention (the harness
// connection `staging` on `auth_new`, one answer per state, prose that
// interprets and never repeats a cell).
//
// Neither state carries a follow-up row. `followUpsFor` reads the row off the
// last exchange's own `followups` trace step, and neither of these traces has
// one: the row is a call that can come back empty, and what these two frames
// are evidence for is what stands ABOVE it.
//
// Self-contained: nothing here imports fixtures.ts, so there is no cycle to
// order. Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the
// integrator's): append E4_STATES to HarnessState, HARNESS_STATES and
// ask-frames' ALL_STATES; `exchangeFor` returns `e4Seed(state).exchange` and
// `choiceFor` returns E4_CHOICE; in AskHarness.seed take the canvas TAB from
// `e4Seed(state).tabs` (the bubble's `@"Canvas"` pill resolves against the
// connection's canvas tabs, and without one it is plain text), and in the
// mount effect call `e4TraceFor(state)` beside `knowledgeTraceFor`.

import type { AskAnswer } from "../agent/loop";
import type { AgentRun, TraceStep } from "../agent/types";
import type { Exchange, ToolChip } from "../stores/agent";
import type { TraceTarget } from "../stores/ask";
import type { Tab } from "../stores/tabs";

export const E4_STATES = ["e4-prose-answer", "e4-nudged"] as const;
export type E4State = (typeof E4_STATES)[number];

const PROVIDER = "claude-code";
const MODEL = "claude-haiku-4-5";
/** the thread the finding came from ran on Haiku 4.5, so the pill reads what
 * the footers read */
export const E4_CHOICE = { provider: PROVIDER, model: MODEL } as const;

export interface E4Seed {
  exchange: Exchange;
  /** the workspace behind the pane: the canvas TAB the bubble's pill resolves
   * against (stores/tabs `canvasTabRefs`). Empty on the states that name no
   * canvas, so a tab seeded by an earlier page never reaches a frame */
  tabs: Tab[];
}

const PROFILE_ID = "harness-staging";

// ---- e4-prose-answer -------------------------------------------------------

const CANVAS_ID = "e4-canvas";
const CANVAS_TITLE = "Canvas";
const TAB_ID = "e4-tab-canvas";

/** a question about the tool, asked of a canvas: the pill resolves and no
 * table does, which is the whole of what R3 reads before it nudges nobody */
const PROSE_QUESTION = `@"${CANVAS_TITLE}" so what sorts of things go on a canvas`;

/** the answer, at the length and in the four-sentence shape the recorded one
 * had: the model is right, says so plainly, and calls nothing. The whole
 * finding is that the harness could not hear it */
const PROSE_TEXT =
  "A canvas belongs to this tool and not to your data, so a question about one is answered here in words. No query bears on it. There are two blocks I can put on a canvas: a result block, which carries a statement and the rows it returned, and a note block, which carries written commentary. That is the whole of it.";

const PROSE_CANDIDATES: string[] = [];

/** R3's own test, run by the prefilter and not by a guess: the question
 * resolved to no table, so it wanted no data and earned no nudge. The block
 * says so in the words the model was actually sent */
const PROSE_CONTEXT = [
  PROSE_QUESTION,
  "",
  "CANDIDATE TABLES (pre-selected from 5 tables; if none fit, call list_tables):\nnone matched this question",
  "",
  `CANVAS: the user is working in the canvas "${CANVAS_TITLE}", and your answer goes INTO it through the canvas tools, not into this reply.`,
  `OUTLINE OF "${CANVAS_TITLE}" (3 blocks): Orders last month · Orders by channel · Against July.`,
].join("\n");

const PROSE_USAGE = { input: 14_200, output: 84, cacheRead: 13_600, cacheWrite: 0 };

const PROSE_TRACE: TraceStep[] = [
  {
    step: "context",
    ms: 3,
    candidates: PROSE_CANDIDATES,
    text: PROSE_CONTEXT,
    mentions: [{ kind: "canvas", token: `"${CANVAS_TITLE}"` }],
  },
  { step: "turn", ms: 58_500, index: 0, text: PROSE_TEXT, usage: PROSE_USAGE },
  { step: "verdict", ms: 58_600, verdict: { status: "answered", sql: null, rowCount: null } },
];

/** R1: the model stopped with no tool call, so its last text block IS the
 * answer. No fence, so no SQL; no run of the loop's own, so no run */
const PROSE_ANSWER: AskAnswer = {
  verdict: { status: "answered", sql: null, rowCount: null },
  sql: null,
  run: null,
  assumptions: [],
  sanity: [],
  trace: PROSE_TRACE,
  text: PROSE_TEXT,
  turns: 1,
  ms: 58_600,
  usage: PROSE_USAGE,
  promptVersion: "v4",
  candidates: PROSE_CANDIDATES,
  recall: null,
  risky: false,
};

const proseAnswer: Exchange = {
  id: "harness-ex-e4-prose",
  turnId: 71,
  question: PROSE_QUESTION,
  text: PROSE_TEXT,
  thinking: "",
  // nothing ran, which is the point: the exchange has no chips, and the
  // anatomy drops the strip rather than reserving its 24px
  chips: [],
  answer: PROSE_ANSWER,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

/** the canvas the question names, open behind the pane. The exchange wrote
 * nothing to it, so the pill cannot be minted from a `canvasWrites` record
 * the way b3's is: it resolves against the connection's canvas TABS, which is
 * what the composer's own pill resolves against */
const canvasTab = (): Tab => ({
  id: TAB_ID,
  name: CANVAS_TITLE,
  sql: "",
  position: 1,
  saved_id: null,
  kind: "canvas",
  table: null,
  canvas_id: CANVAS_ID,
  profile_id: PROFILE_ID,
});

// ---- e4-nudged -------------------------------------------------------------

const NUDGE_QUESTION = "how many films are there";

const FILM_SQL = "SELECT count(*) AS films\nFROM film";

/** the first stop: prose, no call, on a question the prefilter DID resolve to
 * a table. That is R3's whole condition */
const NUDGE_FIRST =
  "There are a bit over a thousand films in the catalogue, going by the table's own row estimate.";

/** `nudgeMessage` as prompt.ts spells it (loop copy, beside repairMessage,
 * never in the cached system prompt) */
const NUDGE_TEXT = "You have run_sql. Answer this with the data, then say what it shows.";

const NUDGE_CLOSING =
  "There are 1,000 films in the catalogue. The count is the whole table, with no filter on it.";

const NUDGE_RUN: AgentRun = {
  columns: ["films"],
  rows: [["1000"]],
  rowCount: 1,
  capped: false,
  ms: 11.4,
};

const runChip: ToolChip = {
  id: "e4-call-1",
  name: "run_sql",
  label: "run",
  ms: 11,
  isError: false,
  args: JSON.stringify({ sql: FILM_SQL }),
  result: "films\n1000\n(1 row)",
};

const NUDGE_CANDIDATES = [
  "public.film (1,000 rows): film_id, title, description, release_year, rental_rate, length",
  "public.inventory (4,581 rows): inventory_id, film_id, store_id, last_update",
];

const NUDGE_CONTEXT = [
  NUDGE_QUESTION,
  "",
  `CANDIDATE TABLES (pre-selected from 21 tables; if none fit, call list_tables):\n${NUDGE_CANDIDATES.join("\n")}`,
].join("\n");

const NUDGE_USAGE = { input: 9_800, output: 140, cacheRead: 9_100, cacheWrite: 0 };

const NUDGE_TRACE: TraceStep[] = [
  { step: "context", ms: 4, candidates: NUDGE_CANDIDATES, text: NUDGE_CONTEXT },
  { step: "turn", ms: 6_200, index: 0, text: NUDGE_FIRST, usage: NUDGE_USAGE },
  { step: "nudge", ms: 0, text: NUDGE_TEXT },
  { step: "turn", ms: 8_900, index: 1, text: NUDGE_CLOSING, usage: NUDGE_USAGE },
  {
    step: "tool",
    ms: 11,
    id: runChip.id,
    name: "run_sql",
    args: runChip.args,
    result: runChip.result ?? "",
    isError: false,
  },
  { step: "verdict", ms: 15_100, verdict: { status: "answered", sql: FILM_SQL, rowCount: 1 } },
];

const NUDGE_ANSWER: AskAnswer = {
  verdict: { status: "answered", sql: FILM_SQL, rowCount: 1 },
  sql: FILM_SQL,
  run: NUDGE_RUN,
  assumptions: [],
  sanity: [],
  trace: NUDGE_TRACE,
  text: NUDGE_CLOSING,
  turns: 2,
  ms: 15_100,
  usage: NUDGE_USAGE,
  promptVersion: "v4",
  candidates: NUDGE_CANDIDATES,
  recall: null,
  risky: false,
};

const nudged: Exchange = {
  id: "harness-ex-e4-nudged",
  turnId: 72,
  question: NUDGE_QUESTION,
  text: NUDGE_CLOSING,
  thinking: "",
  chips: [runChip],
  answer: NUDGE_ANSWER,
  error: null,
  streaming: false,
  provider: PROVIDER,
  model: MODEL,
};

// ---- exports ---------------------------------------------------------------

export function e4Seed(state: E4State): E4Seed {
  return state === "e4-prose-answer"
    ? { exchange: proseAnswer, tabs: [canvasTab()] }
    : { exchange: nudged, tabs: [] };
}

/** the trace state opens AT the nudge: it is the row the frame is evidence
 * for, and the reveal expands it and scrolls it into view */
export function e4TraceFor(state: string): TraceTarget | null {
  return state === "e4-nudged" ? { exchangeId: nudged.id, stepId: "nudge" } : null;
}
