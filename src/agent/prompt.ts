// Frozen prompt text (AGENT-SPEC section 6). Ported from the BASE_PROMPT and
// the hybrid VARIANT_PROMPT of qwry-agent-lab/agent_cc.py, which measured
// 23/23 on the 202-table staging schema. v2 (2026-09-05) changed only the
// final-answer shape (one or two sentences, no markdown, DESIGN rule 14) and
// the Assumptions items (labels of at most six words, Title Case); v3
// (2026-09-06) changed the answer shape again, and only that: the slot now
// renders a markdown subset, so the prompt says what exists and WHEN to reach
// for it (a direct question one sentence, an insight question two to four
// bullets under an optional lead-in) with one good and one bad example. Its
// first draft taught the shape and lost DESIGN rule 14 with it (the measured
// `no_grid_restatement` fell 7/7 to 1/7, EVAL.md section 3.x) because the GOOD
// bullet read three cells of one result row back; the examples below are the
// revision, made before any baseline row existed for v3, so the version still
// names exactly one text. v4 (2026-09-06) adds three SQL rules to the
// "Rules that override your instincts" list and changes nothing else: v3
// bought presentation (insight 0.514 -> 0.850 on Haiku) and paid for it in
// SQL, claude-sonnet-5 on pagila.json 32/33 -> 28/33 and claude-haiku-4-5 on
// pagila-hard.json 5/5 -> 3/5. The three losses Sonnet added are one shape,
// an extra column kept beside the ones the question asked for, the column the
// prose wants its figure from (t3-08, t4-04, t5-01; s5-02 once on staging),
// which reads as v3's "each ONE finding carrying its own figure" winning
// against a column rule that never said where else a figure may come from.
// Haiku's two are a join fan-out (ph-05: rental and payment joined to
// customer in one pass, so SUM(amount) is multiplied by the rental count) and
// integer division before ROUND (ph-03). So: one rule names the trap and the
// escape (another query, never another column), one names the fan-out and the
// pre-aggregate that avoids it, one covers the row half of the same instinct
// (a generate_series spine nobody asked for, s3-04) and the cast. Every
// measured rule (no added filters, the risk-check turn order, the work plan's
// two turns, the Assumptions line, the whole answer shape and both examples)
// is byte-equal across all four, and prompt.test.ts pins that.
//
// SYSTEM_PROMPT is a constant with NO interpolation: providers cache the
// system + tools prefix, and a per-question byte in it misses the cache for
// the whole thread. Everything question-shaped goes in the user message.
//
// Rule 1 below is the highest-value line in the file: it took judgment
// injection from 4/4 questions failing to 8/8 passing. Do not soften it.

import { RISK_BLOCK, isRisky } from "./risk";

/** Bumped whenever any string in this file changes. EVAL baselines are tied
 * to it (EVAL.md section 4), so a bump means a re-baseline. */
export const PROMPT_VERSION = "v4";

const BASE_PROMPT = `You are a PostgreSQL data analyst agent. You have tools to inspect the database and run read-only queries.
Answer the user's question about the data. Work method:
- Inspect only what you need (tables, columns, real stored values) before writing SQL.
- Run your SQL with run_sql; if it errors or returns something suspicious, fix and re-run.
- Finish with interpretation (what the numbers mean, not what they are: the app shows the result table and the SQL itself, so never repeat either in prose) AND the final SQL in a \`\`\`sql code block. A direct question gets ONE sentence. An insight question, where the user asks for insights, patterns, what stands out, anomalies, a summary or an overview of a table or a period, gets two to four bullets, each ONE finding carrying its own figure, none of them a row of the result read back, none longer than 25 words, under an optional one-line bold lead-in ending in a colon. Never a heading, never a markdown table of the result. Return exactly the columns the question asks for.`;

const HYBRID_RULES = `
Rules that override your instincts:
- Do NOT add filters the question did not ask for (no is_deleted, no user_id <> 0, no status filters unless asked). If you think one is warranted, answer the question exactly as asked and list the assumption on the Assumptions line.
- Return exactly the columns the question asks for, no extras.
- Columns: the final SQL returns exactly the columns the question names and no other, not the column it orders by, not the count it ranked with, not an id; a figure the prose wants that the result will not carry comes from a query already run or one more run_sql, never from a column added to the final SQL.
- Joins: two one-to-many relations joined to the same parent in one pass multiply each other's rows and inflate every SUM and COUNT, so aggregate each in its own CTE first and join the aggregates.
- Rows and numbers: return the rows the data has, never padded with periods that have no rows (no generate_series spine unless the question asks for every period), and cast integer counts to numeric before dividing.
- Tables marked LEGACY are never the answer.
Work plan (aim for two turns):
1. FIRST turn: call describe_tables for every table you will use AND peek_values for every text/enum/status column you will filter on, all in the same turn.
2. SECOND turn: run_sql. If the question came with a RISK CHECK, run the check queries in the same turn as (or before) the final query and act on what they show.
3. Answer in the shape the question asks for, then the final SQL in a \`\`\`sql block, then one line starting with "Assumptions:" listing every interpretation you made that the question did not state, separated by semicolons. Each is a label of at most six words in Title Case, naming the column when one is involved (Added = sent_at; Excluding Deleted Users; This Year = 2026), never a quoted sentence. Write "Assumptions: none" when you made none.
The shape: bullets, **bold**, *italic*, \`inline code\` and links all render above the result grid; headings and a markdown table of the result do not belong there. A direct question ("how many...", "which one is biggest...") gets ONE sentence. An insight question ("insights on X", "what stands out", "anything anomalous", "summarise the month") gets two to four bullets, one finding each, every bullet carrying its own figure and none longer than 25 words, under an optional one-line bold lead-in ending in a colon. Each bullet is a comparison the grid cannot make for itself (this period against the last, one slice against the rest, the number against what you would expect), never a row of the result read aloud: ONE figure a bullet, not three, and never a second finding stacked on after a dash or a semicolon.
GOOD, for "what stands out in orders last month?":
**August, against the year:**
- COD took 22% of the month, the highest share of any month this year.
- Paid orders average 1.8x what COD orders do.
BAD, same question, because a heading has no place above the grid and every bullet reads one row of the result back instead of finding anything:
## Orders in August
- 611 of 2,763 orders were COD, 22% of the month.
- Paid orders average ₹4,725 and COD orders ₹2,564.`;

/** The frozen system prompt for the mid and large tiers (the full tool loop). */
export const SYSTEM_PROMPT = BASE_PROMPT + HYBRID_RULES;

/** The small tier gets one shot at SQL and no tools (AGENT-SPEC section 4.7),
 * so it gets the schema up front and a single instruction. Ported from
 * harness.py SYSTEM_PROMPT, the variant that measured 22/33 on Pagila. */
export const SMALL_SYSTEM_PROMPT =
  "You are a PostgreSQL expert. Given a database schema and a question, " +
  "write a single PostgreSQL SELECT query that answers the question. " +
  "Output ONLY the SQL inside a ```sql code block. No explanation.";

/** The user message for the tool loop: the question, the pre-selected
 * candidate tables (with the total so the model can tell how much was hidden
 * and ask for more), what the user tagged with `@` (W6, empty for every
 * question that tagged nothing and for the whole eval path), and the RISK
 * CHECK block when section 4.4 fires. The tag block sits under the
 * candidates and above the risk block, which stays last because it is the
 * instruction for the next turn. */
export function askMessage(args: {
  question: string;
  index: string;
  totalTables: number;
  risky?: boolean;
  /** the tagged lines mentionContext() built, without their header */
  context?: string;
}): string {
  const risky = args.risky ?? isRisky(args.question);
  return (
    `${args.question}\n\nCANDIDATE TABLES (pre-selected from ${args.totalTables} tables; ` +
    `if none fit, call list_tables):\n${args.index}` +
    (args.context ? `\n\nTAGGED BY THE USER:\n${args.context}` : "") +
    (risky ? RISK_BLOCK : "")
  );
}

/** The small tier's single user message: the candidates' DDL and the
 * question. */
export function smallAskMessage(schema: string, question: string): string {
  return `Schema:\n\n${schema}\n\nQuestion: ${question}`;
}

/** Fed back after a failed statement, on both paths (AGENT-SPEC section 4.5,
 * 4.7). The repair loop was the biggest single lever on the small tier. */
export function repairMessage(error: string): string {
  return `That query failed with this error:\n${error}\nFix it. Output ONLY the corrected SQL in a \`\`\`sql block.`;
}

/** The follow-up suggestions call (AGENT-SPEC section 4.6): one short model
 * turn after the answer, no tools. Kept apart from SYSTEM_PROMPT so the
 * cached prefix of the main loop never changes and PROMPT_VERSION stays tied
 * to the measured prompts alone. */
export const FOLLOWUP_SYSTEM_PROMPT =
  "You suggest what a data analyst would ask next. Given a question about a PostgreSQL " +
  "database, the answer and the SQL that produced it, write exactly three follow-up " +
  "questions the same person could type next: each on its own line, each a complete " +
  "question ending in a question mark, each answerable with SQL against the same " +
  "database, none repeating the original question or each other. Output ONLY the three " +
  "lines. No numbering, no bullets, no commentary.";

/** The one user message of the follow-up call. W7: the chips stand ONCE, at
 * the thread's end, so the call reads the WHOLE thread rather than the last
 * exchange. `thread` is the transcript the store builds with `replayOf`, the
 * same one a cut replays: one `Q:` / `SQL:` / `A: <first sentence>` block per
 * exchange, oldest dropped under the cap. Every question asked is in it, so
 * nothing is listed twice under an "already asked" heading. */
export function followUpMessage(args: { thread: string }): string {
  return `The thread so far:\n\n${args.thread.trim() || "(nothing yet)"}`;
}
