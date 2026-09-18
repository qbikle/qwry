import { EditorView } from "@codemirror/view";
import type { FormatOptionsWithLanguage } from "sql-formatter";
import { useSettings } from "../stores/settings";
import { formatPostgres, postgresDialect } from "./sqlDialect";

/** curated formatter styles: each is a full sql-formatter option set; the
 * keyword-case setting is layered on top of whichever preset runs */
export const FORMAT_PRESETS: {
  id: string;
  label: string;
  /** one-line description shown in Settings */
  blurb: string;
  opts: Omit<FormatOptionsWithLanguage, "language">;
}[] = [
  {
    id: "standard",
    label: "Standard",
    blurb: "2-space indent, break at ~50 cols",
    opts: { tabWidth: 2, expressionWidth: 50 },
  },
  {
    id: "compact",
    label: "Compact",
    blurb: "wide wrap, no spaces around operators",
    opts: { tabWidth: 2, expressionWidth: 120, denseOperators: true },
  },
  {
    id: "expanded",
    label: "Expanded",
    blurb: "one expression per line, AND/OR leading",
    opts: { tabWidth: 2, expressionWidth: 1, logicalOperatorNewline: "before" },
  },
  {
    id: "tabular-left",
    label: "Tabular Left",
    blurb: "keywords aligned in a left column",
    opts: { indentStyle: "tabularLeft", expressionWidth: 50 },
  },
  {
    id: "tabular-right",
    label: "Tabular Right",
    blurb: "keywords right-aligned to the river",
    opts: { indentStyle: "tabularRight", expressionWidth: 50 },
  },
];

export type KeywordCase = "upper" | "lower" | "preserve";

function buildOptions(presetId: string): FormatOptionsWithLanguage {
  const { formatKeywordCase } = useSettings.getState();
  const preset = FORMAT_PRESETS.find((p) => p.id === presetId) ?? FORMAT_PRESETS[0];
  return {
    language: "postgresql",
    keywordCase: formatKeywordCase,
    dataTypeCase: formatKeywordCase,
    functionCase: formatKeywordCase === "preserve" ? "preserve" : "lower",
    ...preset.opts,
  };
}

/** collapse a statement to (near) one line. Hand-rolled lexer: strings,
 * dollar-quotes, quoted identifiers and comments pass through verbatim; a line
 * comment keeps its newline (eating it would swallow the rest of the SQL). */
export function minifySql(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let pendingSpace = false;
  const emit = (chunk: string) => {
    if (pendingSpace && out && !out.endsWith("\n")) out += " ";
    pendingSpace = false;
    out += chunk;
  };
  while (i < n) {
    const c = src[i];
    // whitespace run → one space (or nothing at start/after newline)
    if (/\s/.test(c)) {
      while (i < n && /\s/.test(src[i])) i++;
      pendingSpace = true;
      continue;
    }
    // line comment: verbatim, newline preserved
    if (c === "-" && src[i + 1] === "-") {
      const end = src.indexOf("\n", i);
      emit(end === -1 ? src.slice(i) : src.slice(i, end));
      out += "\n";
      i = end === -1 ? n : end + 1;
      continue;
    }
    // block comment: verbatim (may be a hint / anything)
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      emit(end === -1 ? src.slice(i) : src.slice(i, end + 2));
      i = end === -1 ? n : end + 2;
      continue;
    }
    // quoted string / identifier ('' and "" escapes are just two tokens)
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) j++;
      emit(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    // dollar-quoted string $tag$…$tag$
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        emit(src.slice(i, stop));
        i = stop;
        continue;
      }
    }
    // plain run up to the next interesting char
    let j = i;
    while (j < n && !/[\s'"$]/.test(src[j]) && !(src[j] === "-" && src[j + 1] === "-") && !(src[j] === "/" && src[j + 1] === "*")) {
      j++;
    }
    if (j === i) j++; // lone $ that wasn't a dollar-quote
    emit(src.slice(i, j));
    i = j;
  }
  return out.trim();
}

/** apply a transform to the selection (if any) else the whole buffer:
 * ONE dispatch so ⌘Z restores the pre-format text exactly */
function applyToBuffer(view: EditorView, transform: (src: string) => string): boolean {
  const sel = view.state.selection.main;
  const whole = sel.empty;
  const src = whole ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
  if (!src.trim()) return true;
  let out: string;
  try {
    out = transform(src);
  } catch {
    return true; // unparseable fragment: leave the text alone
  }
  if (out === src) return true;
  view.dispatch({
    changes: whole
      ? { from: 0, to: view.state.doc.length, insert: out }
      : { from: sel.from, to: sel.to, insert: out },
    userEvent: "format",
  });
  return true;
}

/** format with a specific preset (context-menu submenu). The formatter is
 * loaded on first use: it's ~an eighth of the whole bundle and ⇧⌘F is rare;
 * the buffer snapshot is taken AFTER the load so a keystroke typed during the
 * import is never clobbered by a format of stale text. The same curated
 * Postgres dialect as formatSqlText (sqlDialect.ts), so an alias like
 * `AS month` keeps its case in the editor as it does in the Ask row */
export async function formatWithPreset(view: EditorView, presetId: string): Promise<void> {
  const mod = await import("./formatterChunk");
  const { language: _language, ...opts } = buildOptions(presetId);
  applyToBuffer(view, (src) => mod.formatDialect(src, { ...opts, dialect: postgresDialect(mod) }));
}

/** format a bare SQL string with a preset (default: the user's), through the
 * curated Postgres dialect (sqlDialect.ts: an alias like `AS month` keeps the
 * model's case, so the Ask row and Copy SQL agree with the grid header). A
 * statement the formatter rejects comes back unchanged. Private: read-only
 * surfaces go through `formattedSql` below, so no caller can format the same
 * statement twice by reaching past the cache. */
async function formatSqlText(src: string, presetId?: string): Promise<string> {
  const { language: _language, ...opts } = buildOptions(presetId ?? useSettings.getState().formatPreset);
  try {
    return await formatPostgres(src, opts);
  } catch {
    return src;
  }
}

/** one format per (statement, preset), kept for the session. A thread of
 * results shows the same statement on a flip back, in a second block and
 * again through Copy; formatting it once means a face-swap pays nothing and
 * only the first read pays the 0.7 ms. Bounded, because a session's
 * statements are not: the oldest entry goes first (insertion order) and a
 * dropped one costs exactly one reformat. A pending format sits in the map as
 * its own promise, so two blocks on one statement make one call */
const FORMATTED_CAP = 200;
const formatted = new Map<string, string | Promise<string>>();
const formattedKey = (src: string, presetId: string) => `${presetId}\n${src}`;

/** the formatted text if it is already in hand, else null: a caller can paint
 * the bare statement in the same frame instead of a microtask later */
export function formattedSqlPeek(src: string, presetId?: string): string | null {
  const hit = formatted.get(formattedKey(src, presetId ?? useSettings.getState().formatPreset));
  return typeof hit === "string" ? hit : null;
}

/** formatSqlText through that cache; the fallback (a statement the formatter
 * rejects comes back unchanged) is memoized with everything else */
export function formattedSql(src: string, presetId?: string): Promise<string> {
  const preset = presetId ?? useSettings.getState().formatPreset;
  const key = formattedKey(src, preset);
  const hit = formatted.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (formatted.size >= FORMATTED_CAP) {
    const oldest = formatted.keys().next().value;
    if (oldest !== undefined) formatted.delete(oldest);
  }
  const pending = formatSqlText(src, preset).then((out) => {
    formatted.set(key, out);
    return out;
  });
  formatted.set(key, pending);
  return pending;
}

/** ⇧⌘F / menu: the user's default preset */
export function formatDefault(view: EditorView): Promise<void> {
  return formatWithPreset(view, useSettings.getState().formatPreset);
}

export function minifyBuffer(view: EditorView): boolean {
  return applyToBuffer(view, minifySql);
}
