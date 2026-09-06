// The answer slot's grammar (AGENT-UX section 2 item 3, DESIGN rule 14). The
// anatomy already carries the data: the grid holds the rows, the SQL row the
// query, the chips the assumptions. Whatever the model wrote about those is
// dropped here; what it wrote AS the answer becomes blocks the slot renders
// in its own registers (W5: a lead-in, bullets, a quote, a code block, and a
// table only when there is no run to restate). The raw text is untouched: the
// trace shows it as written.
//
// Pure: no React, no DOM. The renderer (ask/AnswerText.tsx) owns the elements,
// this file owns the grammar, so the parser can be tested at the speed of a
// streamed delta: parseBlocks runs on every one.
//
// Streaming-safe: every rule works on a prefix of the final text. Blocks
// before the last one are SETTLED, their kind and text never change as more
// text arrives; the LAST block is the one still being written, and it alone
// may still become another kind (a pipe line is prose until its separator
// lands, a langless fence is code until its first word turns out to be SQL,
// a table grows until a blank line ends it).
// No rule reads backwards across a completed line, which is what makes that
// true, and the prefix property test is what keeps it true.

import { secondsText } from "../lib/duration";

/** One rendered thing. `text` keeps its inline markers (`**bold**`, backticks,
 * links): inlineTokens reads them, the projection flattens them. */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "lead"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

/** the mandated `Assumptions:` line, plain or bold, however it was bulleted */
const ASSUMPTIONS_AT = /^[ \t>*_-]*assumptions[*_]*[ \t]*:/i;

const FENCE_AT = /^[ \t]*```/;
const FENCE_LANG = /^[ \t]*```+[ \t]*([^\s`]*)/;
const HEADING = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** a lead-in the model marked: `**Across 2,763 orders:**`, colon in or out */
const BOLD_LEAD = /^[ \t]*\*\*(.+?)\*\*[ \t]*(:?)[ \t]*$/;
const HR = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;
const LIST_MARK = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/;
/** a marker with nothing after it yet: the item is still being typed */
const PART_MARK = /^[ \t]*(?:[-*+•]|\d+[.)]?)[ \t]*$/;
const QUOTE_AT = /^[ \t]*>/;
const QUOTE_MARK = /^[ \t]*>[ \t]?/;
const INDENTED = /^[ \t]{2,}\S/;
const IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;

/** A fence the SQL row already owns. The lang says so; a langless fence whose
 * first word is a statement says so too, and models write plenty of those. */
const SQL_LANG = new Set(["sql", "postgres", "postgresql", "pgsql"]);
const SQL_HEAD = /^\s*(?:with|select|insert|update|delete|create|alter|drop|explain|truncate)\b/i;

const SPACE = (c: number): boolean => c === 32 || c === 9;

/** A block glued to the sentence before it: W2 shipped `breakdown.## Answer`,
 * and models glue a fence to its lead-in the same way. Hand-scanned rather
 * than a lookbehind regex: this runs on every streamed delta, and a lookbehind
 * over 4k characters costs more than the whole line loop. */
function unglue(text: string, mark: string, heading: boolean): string {
  let at = text.indexOf(mark);
  if (at < 0) return text;
  let out = "";
  let from = 0;
  while (at >= 0) {
    let n = 1;
    if (heading) {
      while (n < 6 && text.charCodeAt(at + n) === 35) n++;
      const after = text.charCodeAt(at + n);
      if (!SPACE(after)) {
        at = text.indexOf(mark, at + n);
        continue;
      }
    } else n = mark.length;
    let k = at;
    while (k > from && SPACE(text.charCodeAt(k - 1))) k--;
    const prev = k > 0 ? text[k - 1] : "\n";
    if (prev !== "\n" && (!heading || prev === "." || prev === "!" || prev === "?" || prev === ":")) {
      out += `${text.slice(from, k)}\n`;
      from = at;
    }
    at = text.indexOf(mark, at + n);
  }
  return from === 0 ? text : out + text.slice(from);
}

function isTableSep(line: string): boolean {
  return line.includes("-") && TABLE_SEP.test(line) && !HR.test(line);
}

/** index of the line's first glyph; the length when the line is blank */
function firstGlyph(line: string): number {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return i;
}

/** an image has no slot in the anatomy, so it never reaches a block */
const clean = (s: string): string => (s.includes("![") ? s.replace(IMAGE, "") : s).trimEnd();

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => clean(c).trim());

/** The blocks the answer slot renders, in order. `hasRun` is false only when
 * the turn produced no result: with a grid on screen a markdown table is the
 * grid restated (rule 14) and never renders; without one it is the model's
 * own comparison, which nothing else carries. */
export function parseBlocks(raw: string, opts: { hasRun: boolean }): Block[] {
  if (!raw) return [];
  let text = raw.indexOf("\r") === -1 ? raw : raw.replace(/\r\n?/g, "\n");
  text = unglue(unglue(text, "#", true), "```", false);

  const lines = text.split("\n");
  const out: Block[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length === 0) return;
    const t = para.join("\n").trim();
    para = [];
    if (t) out.push({ kind: "p", text: t });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = firstGlyph(line);
    if (at === line.length) {
      flush();
      continue;
    }
    const c = line[at];

    // From the `Assumptions:` line to the next blank line or fence: the span
    // parseAssumptions reads, so a stated assumption appears once, as a chip,
    // and never also as prose. Every such line goes, not only the first one
    // the chips are parsed from: a repeated line is still not an answer.
    if (ASSUMPTIONS_AT.test(line)) {
      flush();
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (firstGlyph(l) === l.length || l.includes("```")) break;
      }
      i = j - 1;
      continue;
    }

    // a fence: its body is verbatim, its close is the next fence line, and an
    // unterminated one is a code block still streaming
    if (c === "`" && FENCE_AT.test(line)) {
      flush();
      const lang = (FENCE_LANG.exec(line)?.[1] ?? "").toLowerCase();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !FENCE_AT.test(lines[j]); j++) body.push(lines[j]);
      const code = body.join("\n").replace(/\s+$/, "");
      if (code && !(SQL_LANG.has(lang) || (lang === "" && SQL_HEAD.test(code)))) {
        out.push({ kind: "code", lang, text: code });
      }
      i = j;
      continue;
    }

    if (c === "#") {
      const h = HEADING.exec(line);
      if (h) {
        flush();
        const t = clean(h[1]).trim();
        if (t) out.push({ kind: "lead", text: t });
        continue;
      }
    }

    if (c === ">") {
      flush();
      let j = i;
      const parts: string[] = [];
      for (; j < lines.length && QUOTE_AT.test(lines[j]); j++) parts.push(clean(lines[j].replace(QUOTE_MARK, "")));
      const t = parts.join("\n").trim();
      if (t) out.push({ kind: "quote", text: t });
      i = j - 1;
      continue;
    }

    if (line.includes("|")) {
      // a header row, a separator row, one body row at least; anything less is
      // prose (a lone pipe line) or a table under construction (dropped, so it
      // never renders as the sentence it is not)
      if (i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const header = cells(line);
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (firstGlyph(l) === l.length || isTableSep(l)) break;
          if (!l.includes("|")) {
            // a row has no pipe until its first cell is typed, so the LAST
            // line of a prefix cannot end the table: it would settle a row
            // short with a stray paragraph under it, and the row would jump
            // into the grid. The span takes the line, the table stays the
            // last block, and a blank line is what ends a table: a sentence
            // glued under the last row is in the span and does not render.
            if (j < lines.length - 1) break;
            j++;
            break;
          }
          const row = cells(l);
          row.length = header.length;
          rows.push(Array.from(row, (v) => v ?? ""));
        }
        if (rows.length > 0 && !opts.hasRun) out.push({ kind: "table", header, rows });
        i = j - 1;
        continue;
      }
      if (isTableSep(line)) {
        flush();
        continue;
      }
    }

    if (HR.test(line)) {
      flush();
      continue;
    }

    if (c === "*") {
      const b = BOLD_LEAD.exec(line);
      if (b && !b[1].includes("**")) {
        const inner = b[1].trimEnd();
        const t = clean(inner.endsWith(":") ? inner : b[2] === ":" ? `${inner}:` : "").trim();
        if (t) {
          flush();
          out.push({ kind: "lead", text: t });
          continue;
        }
      }
    }

    if (LIST_MARK.test(line)) {
      flush();
      // one level: a nested marker is an item of the same list, an indented
      // line without one continues the item above it, and a line back at the
      // margin ends the list. The FIRST marker decides the register, so a
      // model that drifts between `-` and `1.` still writes one list.
      const ordered = /\d/.test(line[at]);
      const items: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (firstGlyph(l) === l.length) break;
        const m = LIST_MARK.exec(l);
        if (m) items.push(clean(l.slice(m[0].length)).trim());
        else if (INDENTED.test(l) && items.length > 0) items[items.length - 1] += ` ${clean(l).trim()}`;
        // the last line of a prefix is the one being typed: a bare marker is
        // the next item arriving, not the end of the list (streaming)
        else if (j === lines.length - 1 && PART_MARK.test(l)) continue;
        else break;
      }
      const kept = items.filter((t) => t.length > 0);
      if (kept.length > 0) out.push({ kind: "list", ordered, items: kept });
      i = j - 1;
      continue;
    }

    para.push(clean(line));
  }
  flush();
  return out;
}

const flat = (s: string): string => (s.includes("](") ? s.replace(LINK, "$1") : s).trim();

/** The plain-text projection of the blocks: what the slot says, with no
 * markup of its own. loop.ts asks it whether a text block said anything, the
 * thread list takes its first sentence, and the eval scores it, so its shape
 * is a contract: blocks joined by a blank line, list items one to a line,
 * links flattened to their text, bold and code markers left as written.
 * Tables are never in it: the grid or the model's own comparison renders
 * them, and neither is prose. */
export function answerText(raw: string): string {
  const parts: string[] = [];
  for (const b of parseBlocks(raw, { hasRun: true })) {
    if (b.kind === "table") continue;
    const t =
      b.kind === "list" ? b.items.map(flat).filter(Boolean).join("\n") : b.kind === "code" ? b.text.trim() : flat(b.text);
    if (t) parts.push(t);
  }
  return parts.join("\n\n").trim();
}

// ---- inline ----------------------------------------------------------------

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "figure"; text: string }
  | { kind: "link"; text: string; href: string; code?: boolean };

// A figure is a quantity: a number, with its sign, its thousands separators,
// its decimals, its currency mark, its percent or magnitude suffix, or a unit
// it wears in the status register (`412.6 ms`). A date, an id or a version is
// NOT one: `2026-08`, `t1-01`, `v2` are names that happen to hold digits, and
// setting them in the figure face would light up the wrong words. The rule is
// the boundary: a run of digits glued to a word character, or continuing into
// `-`, `:`, `/` or another decimal point, is text.
const FIG_SRC =
  "(?<![\\w.,:/$₹€£-])[+-]?[₹$€£]?\\d+(?:,\\d{3})*(?:\\.\\d+)?(?:%|[kKMBx](?![\\w]))?" +
  "(?:[ \\u00a0](?:ms|s|kb|mb|gb)(?![\\w]))?(?![\\w]|[-:/.]\\d)";
const FIGURE = new RegExp(FIG_SRC, "g");
const WHOLE_FIGURE = new RegExp(`^${FIG_SRC}$`);

const INLINE =
  /(?<code>`[^`\n]+`)|(?<img>!\[[^\]\n]*\]\([^)\n]*\))|\[(?<ltext>[^\]\n]*)\]\((?<href>[^)\n]*)\)|\*\*(?<bold>[^*\n]+?)\*\*|\*(?<ital>[^*\n]+?)\*/g;

function pushText(out: InlineToken[], text: string): void {
  if (!text) return;
  FIGURE.lastIndex = 0;
  let last = 0;
  for (let m = FIGURE.exec(text); m; m = FIGURE.exec(text)) {
    if (m.index > last) plain(out, text.slice(last, m.index));
    out.push({ kind: "figure", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) plain(out, text.slice(last));
}

function plain(out: InlineToken[], text: string): void {
  const prev = out[out.length - 1];
  if (prev && prev.kind === "text") prev.text += text;
  else out.push({ kind: "text", text });
}

/** Inline spans of one block's text. Emphasis whose whole span is a figure
 * IS the figure: the app has one face for a quantity and the model's bold is
 * not it (the sketch's `never bold`). Code spans are opaque, so a quantity
 * inside one keeps the editor register. An image renders as nothing. */
export function inlineTokens(text: string): InlineToken[] {
  if (!text) return [];
  const out: InlineToken[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) pushText(out, text.slice(last, m.index));
    last = m.index + m[0].length;
    const g = m.groups as Record<string, string | undefined>;
    if (g.code !== undefined) out.push({ kind: "code", text: g.code.slice(1, -1) });
    else if (g.img !== undefined) continue;
    else if (g.href !== undefined) {
      const t = g.ltext ?? "";
      const mono = t.length > 2 && t.startsWith("`") && t.endsWith("`") && !t.slice(1, -1).includes("`");
      // link text keeps whatever register the model gave it: `[\`date_trunc\`](url)`
      // is an identifier and stays mono, plain link text is prose
      out.push(mono ? { kind: "link", text: t.slice(1, -1), href: g.href, code: true } : { kind: "link", text: t || g.href, href: g.href });
    } else if (g.bold !== undefined) emphasis(out, "bold", g.bold);
    else if (g.ital !== undefined) emphasis(out, "italic", g.ital);
  }
  if (last < text.length) pushText(out, text.slice(last));
  return out;
}

function emphasis(out: InlineToken[], kind: "bold" | "italic", inner: string): void {
  const t = inner.trim();
  if (WHOLE_FIGURE.test(t)) out.push({ kind: "figure", text: t });
  else out.push({ kind, text: inner });
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
