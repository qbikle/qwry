// Tolerant extraction of the SQL, the assumptions and the code-detected
// filters out of a model's final text (AGENT-SPEC section 4.6).
//
// `extractSql` is ported from qwry-agent-lab/harness.py. Its tolerance alone
// was worth 22 points on a small model: it accepts a tool-call literal, a
// ```sql fence, a bare fence, or raw text, and it strips the special tokens a
// local runtime leaks into its own answer. Do not tighten it. Every branch is
// named in the return value so the trace can say which one matched.

import type { Assumption } from "./types";

export type ExtractHow = "tool-call" | "sql-fence" | "fence" | "raw" | "none";

export interface Extracted {
  sql: string | null;
  how: ExtractHow;
}

const TOOL_CALL = /\[sql\(\s*(['"])([\s\S]*)\1\s*\)\]/;
const SQL_FENCE = /```sql\s*([\s\S]*?)```/i;
const BARE_FENCE = /```\s*([\s\S]*?)```/;
/** `<|tool_call_start|>` and friends: chat-template scaffolding the model
 * emitted into its own answer text. */
const SPECIAL = /<\|[^|]*\|>/g;

const tidy = (s: string): string | null =>
  s.trim().replace(/;+$/, "").trim() || null;

export function extractSql(text: string | null | undefined): Extracted {
  if (!text) return { sql: null, how: "none" };

  const call = TOOL_CALL.exec(text);
  if (call) {
    const raw = call[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
    return { sql: tidy(raw), how: "tool-call" };
  }

  let m = SQL_FENCE.exec(text);
  let how: ExtractHow = "sql-fence";
  if (!m) {
    m = BARE_FENCE.exec(text);
    how = m ? "fence" : "raw";
  }
  return { sql: tidy((m ? m[1] : text).replace(SPECIAL, " ")), how };
}

// ---- assumptions -----------------------------------------------------------

const ASSUMPTIONS_LINE = /^[ \t>*-]*assumptions\s*:/im;
const BULLET = /^[-*•\s]+|^\d+[.)]\s*/;

/** The mandated `Assumptions:` line, split into one chip per interpretation.
 * Items are separated by semicolons or newlines; "none" yields no chips. */
export function parseAssumptions(text: string | null | undefined): string[] {
  if (!text) return [];
  const m = ASSUMPTIONS_LINE.exec(text);
  if (!m) return [];
  let tail = text.slice(m.index + m[0].length);
  const fence = tail.indexOf("```");
  if (fence !== -1) tail = tail.slice(0, fence);
  const blank = tail.search(/\n[ \t]*\n/);
  if (blank !== -1) tail = tail.slice(0, blank);
  return tail
    .split(/[;\n]/)
    .map((s) => s.replace(BULLET, "").trim().replace(/[.]+$/, "").trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== "none");
}

// ---- code-detected filters -------------------------------------------------

/** A filter the SQL applies that the question never asked for. Each becomes a
 * chip: a hidden filter is a wrong answer that looks right (AGENT-UX 3). */
interface Detected {
  id: string;
  label: string;
  fragment: string;
}

const DELETED_FLAG = /\b(?:[\w"]+\.)?is_deleted\b(?:\s*=\s*\w+|\s+is\s+(?:not\s+)?\w+)?/i;
const DELETED_AT = /\b(?:[\w"]+\.)?deleted_at\b\s+is\s+(?:not\s+)?null/i;
const NOT_ZERO = /\b(?:[\w"]+\.)?([a-z_][\w]*)\s*(?:<>|!=)\s*0(?!\.)\b/i;
const STATUS_EQ = /\b(?:[\w"]+\.)?([a-z_][\w]*(?:status|state))\s*=\s*'([^']*)'/gi;

/** Does the question actually mention this identifier? An underscored name
 * counts as mentioned when every segment of three characters or more appears,
 * so `payment_status` is not "mentioned" by a question that only says paid. */
function mentions(question: string, name: string): boolean {
  const q = question.toLowerCase();
  if (q.includes(name.toLowerCase())) return true;
  const parts = name.toLowerCase().split("_").filter((p) => p.length >= 3);
  return parts.length > 0 && parts.every((p) => new RegExp(`\\b${p}`, "i").test(q));
}

/** Filters found in the final SQL that the question did not ask for:
 * `is_deleted`, `deleted_at IS NULL`, `<> 0`, and status or state equality.
 * The measured failure this exists for is agents adding these unprompted. */
export function detectFilters(sql: string, question: string): Detected[] {
  const out: Detected[] = [];
  const seen = new Set<string>();
  const push = (d: Detected) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    out.push(d);
  };
  const asksDeleted = /delet|remov|archiv/i.test(question);

  const flag = DELETED_FLAG.exec(sql);
  if (flag && !asksDeleted) {
    push({ id: "detected:is_deleted", label: "Excluding Deleted Rows", fragment: flag[0] });
  }
  const at = DELETED_AT.exec(sql);
  if (at && !asksDeleted) {
    push({ id: "detected:deleted_at", label: "Excluding Deleted Rows", fragment: at[0] });
  }
  const zero = NOT_ZERO.exec(sql);
  if (zero && !/\bzero\b|[^\d]0\b/.test(question)) {
    push({ id: "detected:not_zero", label: "Excluding Zero Ids", fragment: zero[0] });
  }
  for (const m of sql.matchAll(STATUS_EQ)) {
    const [fragment, column, value] = m;
    if (mentions(question, column) && mentions(question, value)) continue;
    push({ id: `detected:${column.toLowerCase()}=${value}`, label: fragment.trim(), fragment });
  }
  return out;
}

/** Every chip for one answer: the model's own stated assumptions first, then
 * the ones code found in the SQL. All start active, because all of them are
 * in effect in the query that just ran. */
export function buildAssumptions(args: {
  text: string | null;
  sql: string | null;
  question: string;
}): Assumption[] {
  const chips: Assumption[] = parseAssumptions(args.text).map((label, i) => ({
    id: `model:${i}`,
    label,
    source: "model" as const,
    active: true,
  }));
  const stated = new Set(chips.map((c) => c.label.toLowerCase()));
  for (const d of args.sql ? detectFilters(args.sql, args.question) : []) {
    if (stated.has(d.label.toLowerCase())) continue;
    chips.push({
      id: d.id,
      label: d.label,
      source: "detected",
      active: true,
      fragment: d.fragment,
    });
  }
  return chips;
}
