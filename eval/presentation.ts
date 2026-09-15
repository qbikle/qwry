// The presentation score (EVAL.md section 3.x). Execution accuracy says
// whether the rows are right; it says nothing about whether the prose beside
// them can be read. This is the second number, and it is deliberately code,
// not a judge: five heuristics, each 0/1, averaged, over the SAME parse the
// answer slot renders (src/agent/display.ts), so a check can never reward
// something the app does not draw.
//
// It scores only the insight-style questions (`tags: ["insight"]`, gold null).
// A direct question wants one sentence and would fail `bullets_in_range` by
// design; scoring it here would push the prompt toward bulleting everything.

import { parseBlocks, inlineTokens, type Block } from "../src/agent/display";

export interface PresentationScore {
  score: number;
  checks: Record<string, 0 | 1>;
}

/** The result the answer sat beside, as the score needs it: the grid the
 * reader can already see. `null` when the answer had no run. */
export interface RunShape {
  columns: string[];
  rows: unknown[][];
}

/** A finding is a list item. Two to four of them is the shape prompt v3 asks
 * for: one is a sentence wearing a bullet, five is a wall with markers. */
const MIN_FINDINGS = 2;
const MAX_FINDINGS = 4;

/** Words past which a sentence stops being read and starts being skimmed. */
const MAX_WORDS = 30;

/** A cell shorter than this is not evidence of anything: `1`, `G` and `NC`
 * appear in any English sentence about them. */
const MIN_CELL_CHARS = 3;

const flag = (ok: boolean): 0 | 1 => (ok ? 1 : 0);

/** Every list item of the answer, in order, across every list block. */
function findings(blocks: ReturnType<typeof parseBlocks>): string[] {
  return blocks.flatMap((b) => (b.kind === "list" ? b.items : []));
}

/** The answer's prose, one unit per thing a reader reads as a unit: a
 * paragraph, a lead-in, a quote, each list item. Read off the BLOCKS and not
 * off `answerText`, whose flat projection cannot tell a paragraph's soft wrap
 * from the newline between two bullets, and so would score a hard-wrapped
 * wall of prose as a column of short sentences. Code and tables are not
 * prose. */
function prose(blocks: readonly Block[]): string[] {
  return blocks.flatMap((b) => {
    if (b.kind === "list") return b.items;
    if (b.kind === "p" || b.kind === "lead" || b.kind === "quote") return [b.text];
    return [];
  });
}

/** Sentences as a reader meets them: each prose unit split at terminal
 * punctuation followed by space. `4.99` and `1,861.9 ms` survive, because the
 * split needs whitespace after the stop. */
function sentences(units: readonly string[]): string[] {
  return units
    .flatMap((unit) => unit.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

/** A figure as the RENDERER finds one: emphasis is a register, not a leaf, so
 * AnswerText re-tokenizes bold, italic and link text and draws the number
 * inside at tier 1 (DESIGN rule 3, "whether or not the model bolded them").
 * A score that stopped at the top level would call a bullet figureless while
 * the app was drawing its figure. */
function carriesFigure(text: string, depth = 0): boolean {
  return inlineTokens(text).some((t) => {
    if (t.kind === "figure") return true;
    const emphasis = t.kind === "bold" || t.kind === "italic" || t.kind === "link";
    return emphasis && depth < 2 && t.text !== text && carriesFigure(t.text, depth + 1);
  });
}

/** Digits regrouped and case dropped, so `2,763` in prose and `2763` in the
 * cell are one string on both sides of the comparison. */
const flatten = (s: string) => s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ").trim();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `needle` stand as its own token in `hay`? A bare `includes` counts
 * `47` inside `4725` as a hit. */
function mentions(hay: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escape(needle)}([^a-z0-9]|$)`, "i").test(hay);
}

/** DESIGN rule 14, as a number: the grid holds the rows, so a bullet that
 * reads two cells of one grid row back to the reader is a second slot for one
 * fact. One value is a figure the finding is about; two distinct ones are the
 * row restated. */
function restatesGrid(items: string[], run: RunShape | null): boolean {
  if (!run) return false;
  return items.some((item) => {
    const hay = flatten(item);
    return run.rows.some((row) => {
      // by DISTINCT value and not by cell: a count carried twice across a row
      // (orders = paid orders, gross = net) is one figure in two columns, and
      // a bullet that names it once has named one fact
      const named = new Set<string>();
      for (const cell of row) {
        if (cell === null || cell === undefined) continue;
        const needle = flatten(String(cell));
        if (needle.length < MIN_CELL_CHARS) continue;
        if (mentions(hay, needle)) named.add(needle);
        if (named.size >= 2) return true;
      }
      return false;
    });
  });
}

/** The five checks and their mean. `answer` is the model's RAW final text:
 * the score reads exactly what the answer slot would render from it, fence,
 * Assumptions line and all, stripped by the same parser. */
export function presentationScore(answer: string, run: RunShape | null): PresentationScore {
  const blocks = parseBlocks(answer, { hasRun: run !== null });
  const items = findings(blocks);
  const leads = blocks.filter((b) => b.kind === "lead");
  const adjacentLeads = blocks.some(
    (b, i) => b.kind === "lead" && blocks[i + 1]?.kind === "lead",
  );

  const checks: Record<string, 0 | 1> = {
    bullets_in_range: flag(items.length >= MIN_FINDINGS && items.length <= MAX_FINDINGS),
    sentences_short: flag(sentences(prose(blocks)).every((s) => words(s) <= MAX_WORDS)),
    // vacuously true over no findings would pay a wall of prose for having no
    // bullets to spoil, so this check wants findings the same way the one
    // above does
    figure_per_finding: flag(items.length > 0 && items.every((item) => carriesFigure(item))),
    no_grid_restatement: flag(!restatesGrid(items, run)),
    one_lead_in_at_most: flag(leads.length <= 1 && !adjacentLeads),
  };

  const values = Object.values(checks);
  const mean = values.reduce((a: number, b) => a + b, 0) / values.length;
  return { score: Math.round(mean * 100) / 100, checks };
}

/** The run's one number, for the summary line and the gate. `null` when the
 * bench had no insight question, which is not a zero. */
export function presentationMean(scores: readonly PresentationScore[]): number | null {
  if (scores.length === 0) return null;
  const sum = scores.reduce((a, s) => a + s.score, 0);
  return Math.round((sum / scores.length) * 1000) / 1000;
}
