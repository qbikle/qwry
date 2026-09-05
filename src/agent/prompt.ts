// Frozen prompt text (AGENT-SPEC section 6). Ported from the BASE_PROMPT and
// the hybrid VARIANT_PROMPT of qwry-agent-lab/agent_cc.py, which measured
// 23/23 on the 202-table staging schema.
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
export const PROMPT_VERSION = "v1";

const BASE_PROMPT = `You are a PostgreSQL data analyst agent. You have tools to inspect the database and run read-only queries.
Answer the user's question about the data. Work method:
- Inspect only what you need (tables, columns, real stored values) before writing SQL.
- Run your SQL with run_sql; if it errors or returns something suspicious, fix and re-run.
- Finish with a short answer AND the final SQL in a \`\`\`sql code block. Return exactly the columns the question asks for.`;

const HYBRID_RULES = `
Rules that override your instincts:
- Do NOT add filters the question did not ask for (no is_deleted, no user_id <> 0, no status filters unless asked). If you think one is warranted, answer the question exactly as asked and list the assumption on the Assumptions line.
- Return exactly the columns the question asks for, no extras.
- Tables marked LEGACY are never the answer.
Work plan (aim for two turns):
1. FIRST turn: call describe_tables for every table you will use AND peek_values for every text/enum/status column you will filter on, all in the same turn.
2. SECOND turn: run_sql. If the question came with a RISK CHECK, run the check queries in the same turn as (or before) the final query and act on what they show.
3. Answer with the final SQL in a \`\`\`sql block, then one line starting with "Assumptions:" listing every interpretation you made that the question did not state, separated by semicolons. Write "Assumptions: none" when you made none.`;

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
 * and ask for more), and the RISK CHECK block when section 4.4 fires. */
export function askMessage(args: {
  question: string;
  index: string;
  totalTables: number;
  risky?: boolean;
}): string {
  const risky = args.risky ?? isRisky(args.question);
  return (
    `${args.question}\n\nCANDIDATE TABLES (pre-selected from ${args.totalTables} tables; ` +
    `if none fit, call list_tables):\n${args.index}` +
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
