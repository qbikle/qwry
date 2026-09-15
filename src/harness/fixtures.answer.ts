// Answer builder's fixtures for the Ask harness (W7 items 2 and 3), over the
// same three-exchange discussion thread the W4 states use (fixtures.actions
// `actionsSeed`, which is fixtures.echo's revenue and FX exchanges plus the
// `217` scalar): the sketch's W7 rows draw that thread and nothing else, so
// reusing it is what makes the frame comparable with the drawing.
//
//   answer-actions  the first exchange alone, its prose cluster revealed:
//                   Copy · Save Query over the answer text's first line, the
//                   panel fading in from the left under them. The scroller
//                   parks at the top, the sketch's rest, so the still holds
//                   the bubble, the strip and the cluster it is about
//   followups-end   the whole thread: one row of follow-ups, under the LAST
//                   answer only, with solid hairlines. The older two carry no
//                   row at all (absent, not folded), which is the item the
//                   frame is evidence for
//
// The follow-ups live on the THREAD now (useAgent.followUps), not on each
// answer, so the seed hands them over separately; the questions are the
// sketch's own. The hot face: a hover cannot be held in a still, so
// `answerAfterMount` stamps `data-hot` on the hot exchange's prose slot
// (ask.css reads `.ans-prose[data-hot] > .acts-float` as its hover), the
// `actions` precedent one level down. Frames run under reduced motion, so
// every cluster wears its settled face and no spring is in flight.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts are the integrator's):
// add ANSWER_STATES to HarnessState, HARNESS_STATES and ask-frames' ALL_STATES;
// `choiceFor` gives them ANSWER_CHOICE (the discussion thread's Haiku 4.5, so
// the pill matches the footers); in `seed`, these states put
// `answerSeed(state).exchanges` under the fixture thread with
// `followUps: { [tid]: answerSeed(state).followUps }` and no busy or phase; in
// the post-mount rAF, call `answerAfterMount(state)` beside
// `actionsAfterMount(state)`, before the ready mark.

import type { Exchange } from "../stores/agent";
import { actionsSeed } from "./fixtures.actions";

export const ANSWER_STATES = ["answer-actions", "followups-end"] as const;
export type AnswerState = (typeof ANSWER_STATES)[number];

/** the discussion thread's choice, so the pill reads what the footers read */
export const ANSWER_CHOICE = { provider: "claude-code", model: "claude-haiku-4-5" } as const;

export interface AnswerSeed {
  /** the thread, oldest first */
  exchanges: Exchange[];
  /** useAgent.followUps for the thread: the row stands under the last of them */
  followUps: string[];
}

const THREAD = actionsSeed("actions").exchanges;

/** what the thread would ask next after the currency answer (the sketch's
 * `answer-actions` row) */
const REVENUE_FOLLOW_UPS = [
  "Which channels sold the most in August?",
  "How did August compare with July?",
  "What was the average paid order in INR?",
];

/** after the first-time-customers answer (the sketch's `followups-end`) */
const NEW_FOLLOW_UPS = [
  "How many of them ordered again in September?",
  "What did new customers spend on average?",
  "Which cities were the new customers in?",
];

export function answerSeed(state: AnswerState): AnswerSeed {
  switch (state) {
    case "answer-actions":
      return { exchanges: [THREAD[0]], followUps: REVENUE_FOLLOW_UPS };
    case "followups-end":
      return { exchanges: THREAD, followUps: NEW_FOLLOW_UPS };
  }
}

/** the post-mount hook: the revealed cluster and, for `answer-actions`, the
 * sketch's rest (the thread's top). Runs in the harness's rAF after the pane's
 * own mount effects, so the bottom pin they made is what it moves */
export function answerAfterMount(state: string): void {
  if (state !== "answer-actions") return;
  const prose = document.querySelector<HTMLElement>(`[data-exchange="${THREAD[0].id}"] .ans-prose`);
  if (prose) prose.dataset.hot = "";
  const sc = document.querySelector<HTMLElement>(".ask-scroll");
  if (sc) sc.scrollTop = 0;
}
