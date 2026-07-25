import { EditorView } from "@codemirror/view";
import type { FormatOptionsWithLanguage } from "sql-formatter";
import { useSettings } from "../stores/settings";

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

/** format with a specific preset (context-menu submenu). sql-formatter is
 * loaded on first use: it's ~an eighth of the whole bundle and ⇧⌘F is rare;
 * the buffer snapshot is taken AFTER the load so a keystroke typed during the
 * import is never clobbered by a format of stale text */
export async function formatWithPreset(view: EditorView, presetId: string): Promise<void> {
  const { format } = await import("sql-formatter");
  applyToBuffer(view, (src) => format(src, buildOptions(presetId)));
}

/** ⇧⌘F / menu: the user's default preset */
export function formatDefault(view: EditorView): Promise<void> {
  return formatWithPreset(view, useSettings.getState().formatPreset);
}

export function minifyBuffer(view: EditorView): boolean {
  return applyToBuffer(view, minifySql);
}
