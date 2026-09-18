// Risky-shape classifier (AGENT-SPEC section 4.4). Ported verbatim from
// qwry-agent-lab/agent_cc.py.
//
// Measured: 7 of the 28 bench questions fire, and the block below flipped
// Sonnet's cohort answer from wrong to right. Widening or narrowing the regex
// changes a measured result, so it changes with a new measurement.

/** Time-window / cohort / percentage / first-after / growth / retention /
 * conversion shapes. No `g` flag: a stateful lastIndex would make the same
 * question risky only every other call. */
export const RISK =
  /\b(within|days?|weeks?|months?|years?|cohort|percent|percentage|rate|first|after|before|since|growth|retention|conversion|churn|funnel|week-over-week|month-over-month)\b|%/i;

export function isRisky(question: string): boolean {
  return RISK.test(question);
}

/** Appended to the user message when `isRisky` fires (AGENT-SPEC section 6.5).
 * Model-facing text: WRITING.md governs the UI, not the prompt. */
export const RISK_BLOCK = `
RISK CHECK REQUIRED (time-window / cohort / percentage question): before trusting your final query, run probe queries that
show min() and max() of every timestamp you filter or compare on, and check for rows outside the expected order
(for example an event dated before the entity was created). Apply lower AND upper bounds explicitly. State what the probes showed.`;
