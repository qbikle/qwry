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
import { toks } from "./context";
import { parseDefinition } from "./definitions";
import type { HistoryPair, KnowledgeKind, KnowledgeRow, Synonym } from "./types";

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
  /** the KNOWLEDGE block, header included, when the connection has one (A2
   * item 4). Standing reference, so it sits with the candidates it talks
   * about, above what this one question tagged and above the risk block. */
  knowledge?: string;
  /** the EARLIER ANSWERS block, header included */
  history?: string;
}): string {
  const risky = args.risky ?? isRisky(args.question);
  return (
    `${args.question}\n\nCANDIDATE TABLES (pre-selected from ${args.totalTables} tables; ` +
    `if none fit, call list_tables):\n${args.index}` +
    (args.knowledge ? `\n\n${args.knowledge}` : "") +
    (args.history ? `\n\n${args.history}` : "") +
    (args.context ? `\n\nTAGGED BY THE USER:\n${args.context}` : "") +
    (risky ? RISK_BLOCK : "")
  );
}

/** The small tier's single user message: the candidates' DDL and the
 * question, and nothing else. The tags do not ride it and neither do the A2
 * blocks (AGENT-SPEC 4.2): a fired synonym still reaches this tier as a
 * must-include candidate, but the tier's one call stays the minimal message
 * it was measured as. */
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

/** A4 (2026-09-06): appended to the USER message when the connection's edits
 * switch is on (`useSettings.agentWrites`, AGENT-UX section 13.1), and to
 * nothing else. `SYSTEM_PROMPT` and `PROMPT_VERSION` do not move for it: the
 * eval drives no connection with edits on, so its bytes are the measured ones
 * and every baseline row in EVAL.md still names the run that produced it
 * (EVAL section 4, the A4 bullet; a loop test pins the untagged, edits-off
 * message byte for byte).
 *
 * It rides last, after the RISK CHECK block when both fire: the risk block
 * instructs the probes of the NEXT turn, this one instructs the final fence,
 * which is the last thing the model writes.
 *
 * The statement is proposed, never run: `run_sql` is read-only on every
 * connection (AGENT-SPEC section 8.7), so a model that tries one there is
 * refused and has spent a turn. Saying so here is what keeps it out.
 *
 * B1 (2026-09-08): it also says what the APP does with the statement, because
 * a model that does not know is polite about it, and the politeness is wrong
 * in three ways at once. `Copy and run this statement in your PostgreSQL
 * client` sends the user out of the app that is about to run it for them;
 * `Here's the INSERT statement` narrates a fence the reader can see, which is
 * the same fact in two slots (DESIGN rule 14); `Perfect!` is filler. The
 * block now names the surface (a preview of the affected rows under a Run
 * button) and asks for the one sentence the prose slot is for. */
export function writesMessage(): string {
  return `
WRITES: the user has allowed changes to this database. If the question asks to change data, finish with exactly ONE INSERT, UPDATE or DELETE
statement in the final \`\`\`sql block, with a WHERE clause that names the rows it touches. Do NOT call run_sql with it: run_sql runs reads only.
qwry renders that statement as a preview of the rows it affects, under a Run button the user presses, so never tell anyone to run, copy or paste
it anywhere, never announce the statement, and never open with filler: write one sentence of what will change and why, then the fence. Anything
the question only asks about is read-only work as before.`;
}

// ---- what this connection knows (A2 item 4) --------------------------------
//
// Two blocks, both in the USER message, both absent when the profile has
// nothing to add: SYSTEM_PROMPT and PROMPT_VERSION do not move, and the eval,
// which passes no profile, measures the same bytes it always did (a loop test
// pins that). Each renders the fact in its own grammar and nothing else: a
// hint is the object then the sentence, a synonym is the word then the object
// it names, a definition is the term then its meaning. Both cap by dropping
// whole entries, never by cutting one: a halved hint reads as a whole one and
// is followed as one (LESSONS 9).

/** the KNOWLEDGE block's cap, in characters, header included */
export const KNOWLEDGE_CAP = 1200;
/** the EARLIER ANSWERS block's cap, in characters, header included */
export const HISTORY_CAP = 1500;
/** how many earlier answers travel at most, however well they score */
export const HISTORY_MAX = 3;

const KNOWLEDGE_HEAD = "KNOWLEDGE:";
const HISTORY_HEAD = "EARLIER ANSWERS ON THIS DATABASE:";

/** A block as sent, and the names that survived its cap: the trace's label
 * counts THESE, so what it says is what the model got (LESSONS 13). */
export interface KnowledgeBlock {
  /** the block, header included; empty when nothing travelled */
  text: string;
  /** hint targets, in the block's order */
  hints: string[];
  /** the terms of the definitions that fired */
  definitions: string[];
  /** the words that fired, without their targets */
  synonyms: string[];
}

export interface HistoryBlock {
  text: string;
  /** the questions of the pairs that travelled, oldest first */
  questions: string[];
}

/** one line of a block, with what the cap needs to know about it */
interface Entry {
  line: string;
  /** the name the trace prints for it */
  name: string;
  kind: KnowledgeKind;
  /** how old the fact is: the row's place in the store's list, which loads
   * oldest first. The block groups by kind, so the cap cannot read its own
   * order and reads this one. */
  age: number;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Entries under the cap, oldest dropped first. Whole lines only: the block
 * is a list of facts and half a fact is a wrong one. */
function fitBlock(head: string, entries: readonly Entry[], cap: number): {
  text: string;
  kept: Entry[];
} {
  const out = new Set(entries.map((_, i) => i));
  const kept = () => entries.filter((_, i) => out.has(i));
  const render = () => `${head}\n${kept().map((e) => e.line).join("\n")}`;
  const oldestFirst = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.age - b.e.age || a.i - b.i);
  let text = render();
  for (const { i } of oldestFirst) {
    if (text.length <= cap) break;
    out.delete(i);
    text = render();
  }
  return out.size === 0 || text.length > cap ? { text: "", kept: [] } : { text, kept: kept() };
}

/** `term` and `meaning` out of one definition row. The palette writes
 * `term = meaning` into `text` and leaves `target` null; a row that carries
 * its term in `target` instead is read the same way rather than dropped
 * (LESSONS 5: what is stored may inform, never refuse). */
function definitionParts(row: KnowledgeRow): { term: string; meaning: string } | null {
  const raw = oneLine(row.text);
  if (!raw) return null;
  if (row.target) return { term: oneLine(row.target), meaning: raw };
  return parseDefinition(raw);
}

/** The name the MESSAGE gives a hint's or a synonym's object, or null when
 * the message never named it: a hint on a table the model cannot see is
 * noise. A target is stored schema-qualified while the model sees the display
 * name (bare whenever it is unique), so the answer is the display name and a
 * column's is its owner's plus the column, and the block prints the same name
 * the candidates do (context.ts `candidateNames`, DESIGN rule 14). */
function candidateName(target: string, names: Readonly<Record<string, string>>): string | null {
  const self = names[target];
  if (self) return self;
  const dot = target.lastIndexOf(".");
  if (dot <= 0) return null;
  const owner = names[target.slice(0, dot)];
  return owner ? `${owner}${target.slice(dot)}` : null;
}

/** The KNOWLEDGE block: hints on the candidate tables and their columns, the
 * synonyms that fired, the definitions whose term the question's words carry.
 * Order is the order the sketch draws it, objects before vocabulary. */
export function knowledgeMessage(args: {
  rows: readonly KnowledgeRow[];
  /** every name the message's tables answer to, against the one the model
   * sees (context.ts `candidateNames`): a hint's target is stored qualified
   * and a pick is bare whenever it can be, and the block prints the pick's
   * own name */
  names: Readonly<Record<string, string>>;
  /** the question's tokens, stemmed (context.ts questionTokens) */
  tokens: ReadonlySet<string>;
  /** the synonyms this question fired, computed once by the caller */
  fired: readonly Synonym[];
}): KnowledgeBlock {
  const named = args.names;
  const hints: Entry[] = [];
  const definitions: Entry[] = [];
  // the row each fired word came from, so a synonym is as old as its row
  const wordAge = new Map<string, number>();
  args.rows.forEach((row, age) => {
    if (row.kind === "synonym") {
      const word = row.text.trim().toLowerCase();
      if (word && !wordAge.has(word)) wordAge.set(word, age);
      return;
    }
    if (row.kind === "hint") {
      const target = row.target?.trim();
      const text = oneLine(row.text);
      const name = target ? candidateName(target, named) : null;
      if (!name || !text) return;
      hints.push({ line: `${name}  -- ${text}`, name, kind: "hint", age });
      return;
    }
    const parts = definitionParts(row);
    if (!parts) return;
    const term = [...toks(parts.term)];
    if (term.length === 0 || !term.every((t) => args.tokens.has(t))) return;
    definitions.push({
      line: `${parts.term}: ${parts.meaning}`,
      name: parts.term,
      kind: "definition",
      age,
    });
  });
  const synonyms: Entry[] = args.fired
    // a synonym whose target this message never named fired for nothing, and
    // teaching the model a name for a table it cannot see is worse than
    // silence (LESSONS 5)
    .map((s) => ({ word: s.word, name: candidateName(s.target, named) }))
    .filter((s): s is { word: string; name: string } => s.name !== null)
    .map((s) => ({
      line: `${s.word} -> ${s.name}`,
      name: s.word,
      kind: "synonym",
      age: wordAge.get(s.word) ?? args.rows.length,
    }));

  const entries = [...hints, ...synonyms, ...definitions];
  if (entries.length === 0) return { text: "", hints: [], definitions: [], synonyms: [] };
  const { text, kept } = fitBlock(KNOWLEDGE_HEAD, entries, KNOWLEDGE_CAP);
  const names = (kind: KnowledgeKind) => kept.filter((e) => e.kind === kind).map((e) => e.name);
  return {
    text,
    hints: names("hint"),
    definitions: names("definition"),
    synonyms: names("synonym"),
  };
}

/** The EARLIER ANSWERS block: at most three questions this connection already
 * answered, the ones whose words this question shares, oldest first so the
 * pair reads as a conversation. Scored with the prefilter's own vocabulary
 * (stemmed tokens, IDF over the candidates), so a word every past question
 * carries counts for nothing. The question being asked is never its own
 * earlier answer: a Restart would read its own last statement back and write
 * it again instead of looking at the database (AGENT-SPEC section 9). */
export function historyMessage(
  question: string,
  pairs: readonly HistoryPair[],
): HistoryBlock {
  const q = toks(question);
  const asked = oneLine(question).toLowerCase();
  const usable = pairs.filter(
    (p) => p.question.trim() && p.sql.trim() && oneLine(p.question).toLowerCase() !== asked,
  );
  if (usable.length === 0 || q.size === 0) return { text: "", questions: [] };

  const toksOf = usable.map((p) => toks(p.question));
  const df = new Map<string, number>();
  for (const set of toksOf) for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(usable.length / (df.get(w) ?? 1)) + 0.1;

  const scored = usable
    .map((pair, i) => {
      let score = 0;
      for (const w of toksOf[i]) if (q.has(w)) score += idf(w);
      return { pair, score, i };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, HISTORY_MAX);
  // the cap takes the least relevant pair first, the oldest of a tie: what
  // survives is what this question has most to do with
  const dropFirst = new Map(
    [...scored]
      .sort((a, b) => a.score - b.score || b.i - a.i)
      .map((s, rank) => [s.i, rank] as const),
  );

  const entries: Entry[] = scored
    // the pairs arrive newest first, so the highest index is the oldest, and
    // the most relevant reads last, next to the question it is context for
    .sort((a, b) => b.i - a.i)
    .map(({ pair, i }) => ({
      line: `Q: ${oneLine(pair.question)}\nSQL: ${oneLine(pair.sql)}`,
      name: oneLine(pair.question),
      kind: "hint",
      age: dropFirst.get(i) ?? 0,
    }));
  if (entries.length === 0) return { text: "", questions: [] };
  const { text, kept } = fitBlock(HISTORY_HEAD, entries, HISTORY_CAP);
  return { text, questions: kept.map((e) => e.name) };
}
