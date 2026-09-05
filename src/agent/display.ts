// The display strip between the model's last text block and the answer slot
// (AGENT-UX section 2 item 3, DESIGN rule 14). The anatomy already carries
// the data: the grid holds the rows, the SQL row the query, the chips the
// assumptions. Whatever the model wrote about those is stripped here before
// it renders; bold and inline code render, headings, lists, tables, fences
// and links never. The raw text is untouched: the trace shows it as written.
//
// Streaming-safe: every rule works on a prefix of the final text, so an
// unterminated fence or a half-arrived table row disappears as soon as its
// first character does, never after.

import { createElement, type ReactNode } from "react";
import { secondsText } from "../lib/duration";

/** a fenced block, closed or still streaming */
const FENCE = /```[\s\S]*?(?:```|$)/g;
/** the mandated `Assumptions:` line, plain or bold, however it was bulleted */
const ASSUMPTIONS_LINE = /^[ \t>*_-]*assumptions[*_]*\s*:/im;
/** a heading at line start, or glued to the sentence before it (W2 shipped
 * `breakdown.## Answer`: two blocks concatenated without a newline) */
const HEADING_LINE = /^[ \t]*#{1,6}[ \t]+[^\n]*/gm;
const HEADING_GLUED = /(?<=[.!?:])[ \t]*#{1,6}[ \t]+[^\n]*/g;
const HR = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;
const TABLE_ROW = /^[ \t]*\|/;
const LIST_MARK = /^([ \t]*)(?:[-*+•]|\d+[.)])[ \t]+/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;

/** From an `Assumptions:` line to the next blank line, fence or the end: the
 * span parseAssumptions reads, so a stated assumption appears once, as a
 * chip, and never also as prose. Every such line goes, not only the first
 * one the chips are parsed from: a repeated line is still not an answer. */
function stripAssumptions(text: string): string {
  let out = text;
  for (let m = ASSUMPTIONS_LINE.exec(out); m; m = ASSUMPTIONS_LINE.exec(out)) {
    const tail = out.slice(m.index);
    const blank = tail.search(/\n[ \t]*\n/);
    const ends = [blank, tail.indexOf("```")].filter((i) => i !== -1);
    const end = ends.length > 0 ? Math.min(...ends) : tail.length;
    out = out.slice(0, m.index) + tail.slice(end);
  }
  return out;
}

function isTableSep(line: string): boolean {
  return line.includes("-") && TABLE_SEP.test(line) && !HR.test(line);
}

/** The text the answer slot shows. Empty when the block held nothing but
 * data the anatomy already renders. */
export function answerText(raw: string): string {
  let text = raw.replace(FENCE, "\n");
  text = stripAssumptions(text);
  text = text.replace(HEADING_LINE, "").replace(HEADING_GLUED, "");
  text = text.replace(IMAGE, "").replace(LINK, "$1");

  const lines = text.split("\n");
  const kept: string[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableSep(line)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (line.trim() === "") inTable = false;
      else if (line.includes("|")) continue;
      else inTable = false;
    }
    if (TABLE_ROW.test(line)) continue;
    // a pipe-bearing line right above a separator is the table's header row
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) continue;
    if (HR.test(line)) continue;
    kept.push(line.replace(LIST_MARK, "$1").trimEnd());
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** the footer's status fragment: `1 turn · 20.4 s · Sonnet 5`. Turns and time
 * are hidden at zero (a reloaded thread has neither, LESSONS 9: never print a
 * number the app does not know); the model name keeps its own case inside the
 * status register (AGENT-UX section 11). */
export function footerStatus(turns: number, ms: number, model: string): string {
  const parts: string[] = [];
  if (turns > 0) parts.push(`${turns} ${turns === 1 ? "turn" : "turns"}`);
  if (ms > 0) parts.push(secondsText(ms));
  parts.push(model);
  return parts.join(" · ");
}

const INLINE = /(\*\*[^*\n]+?\*\*|`[^`\n]+`)/g;

/** `**bold**` and `` `code` `` as elements; everything else is plain text.
 * Returns no nodes for an empty string, so an empty answer slot stays :empty. */
export function renderInline(text: string): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    out.push(
      tok.startsWith("**")
        ? createElement("b", { key: key++ }, tok.slice(2, -2))
        : createElement("code", { key: key++ }, tok.slice(1, -1)),
    );
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
