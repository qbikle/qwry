/** Client-side statement spans — mirrors the Rust splitter's token rules
 * (strings, quoted idents, dollar-quotes, comments) so ⌘↵ can run just the
 * statement under the caret. Spans are [from, to) char offsets into `src`. */
export interface StmtSpan {
  from: number;
  to: number;
}

const isWordChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$]/.test(ch);

/** scan past a quoted token starting at the opening quote: doubled quotes
 * ('' / "") stay inside; backslash escapes count only when `backslash` (E'…') */
function skipQuoted(src: string, i: number, quote: string, backslash: boolean): number {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (backslash && ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) {
      if (src[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n; // unterminated — consume the rest
}

export function splitStatementSpans(src: string): StmtSpan[] {
  const spans: StmtSpan[] = [];
  const n = src.length;
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    // trim whitespace off the span so "between statements" is unambiguous
    let a = start;
    let b = end;
    while (a < b && /\s/.test(src[a])) a++;
    while (b > a && /\s/.test(src[b - 1])) b--;
    if (b > a) spans.push({ from: a, to: b });
  };
  while (i < n) {
    const j = skipToken(src, i);
    if (j !== -1) {
      i = j;
      continue;
    }
    if (src[i] === ";") {
      push(i + 1); // keep the terminator inside the statement
      i++;
      start = i;
      continue;
    }
    i++;
  }
  push(n);
  return spans;
}

/** the span the caret sits in — or the nearest one before it when the caret
 * is in the gap between statements (matches psql/DataGrip intuition) */
export function spanAtCursor(src: string, pos: number): StmtSpan | null {
  const spans = splitStatementSpans(src);
  if (spans.length === 0) return null;
  for (const s of spans) {
    if (pos >= s.from && pos <= s.to) return s;
    if (pos < s.from) return s; // gap before this span → next statement
  }
  return spans[spans.length - 1];
}

/** skip past a string / quoted ident / comment / dollar-quote starting at i —
 * returns the index after the token, or -1 if src[i] starts none of them */
export function skipToken(src: string, i: number): number {
  const c = src[i];
  const n = src.length;
  if (c === "'") {
    // E'…' takes backslash escapes — but only when the E is its own token
    // (WHERE_E'x' is an identifier followed by a plain string)
    const prev = src[i - 1];
    const isE = (prev === "e" || prev === "E") && !isWordChar(src[i - 2]);
    return skipQuoted(src, i, "'", isE);
  }
  if (c === '"') return skipQuoted(src, i, '"', false);
  if (c === "-" && src[i + 1] === "-") {
    const end = src.indexOf("\n", i);
    return end === -1 ? n : end + 1;
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? n : end + 2;
  }
  if (c === "$") {
    // tags are identifier-shaped: $$, $q$, $q1$ — but never $1 (a parameter)
    const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
    if (m) {
      const end = src.indexOf(m[0], i + m[0].length);
      return end === -1 ? n : end + m[0].length;
    }
  }
  return -1;
}

/** first bare keyword of a statement, skipping leading comments (lowercased;
 * "" when none) — head checks on raw regexes miss comment-prefixed statements */
export function headToken(stmt: string): string {
  const n = stmt.length;
  let i = 0;
  for (;;) {
    while (i < n && /\s/.test(stmt[i])) i++;
    if (
      i < n &&
      ((stmt[i] === "-" && stmt[i + 1] === "-") || (stmt[i] === "/" && stmt[i + 1] === "*"))
    ) {
      i = skipToken(stmt, i);
      continue;
    }
    break;
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(stmt.slice(i));
  return m ? m[0].toLowerCase() : "";
}

export interface CteDef {
  /** name as written (keeps quoting) */
  name: string;
  /** full `name [ (cols) ] AS [MATERIALIZED] ( body )` span within the statement */
  defFrom: number;
  defTo: number;
  /** body span (inside the parens) — used to hit-test the caret */
  bodyFrom: number;
  bodyTo: number;
}

export interface CteParse {
  recursive: boolean;
  ctes: CteDef[];
}

/** parse the WITH-clause of one statement (offsets relative to `stmt`).
 * Returns null when the statement has no leading WITH. Tolerant lexer — on
 * anything unexpected it returns what it parsed so far. */
export function parseCtes(stmt: string): CteParse | null {
  const n = stmt.length;
  let i = 0;
  const skipWs = () => {
    for (;;) {
      while (i < n && /\s/.test(stmt[i])) i++;
      const j = skipToken(stmt, i);
      // only comments are skippable whitespace here
      if (j !== -1 && (stmt[i] === "-" || stmt[i] === "/")) i = j;
      else return;
    }
  };
  skipWs();
  if (!/^with\b/i.test(stmt.slice(i))) return null;
  i += 4;
  skipWs();
  let recursive = false;
  if (/^recursive\b/i.test(stmt.slice(i))) {
    recursive = true;
    i += 9;
    skipWs();
  }
  const ctes: CteDef[] = [];
  for (;;) {
    skipWs();
    const defFrom = i;
    // name: quoted or plain identifier
    let name: string;
    if (stmt[i] === '"') {
      const j = skipToken(stmt, i);
      name = stmt.slice(i, j);
      i = j;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(stmt.slice(i));
      if (!m) break;
      name = m[0];
      i += m[0].length;
    }
    skipWs();
    // optional column list before AS
    if (stmt[i] === "(") {
      let depth = 0;
      while (i < n) {
        const j = skipToken(stmt, i);
        if (j !== -1) {
          i = j;
          continue;
        }
        if (stmt[i] === "(") depth++;
        if (stmt[i] === ")") {
          depth--;
          i++;
          if (depth === 0) break;
          continue;
        }
        i++;
      }
      skipWs();
    }
    if (!/^as\b/i.test(stmt.slice(i))) break;
    i += 2;
    skipWs();
    if (/^not\b/i.test(stmt.slice(i))) {
      i += 3;
      skipWs();
    }
    if (/^materialized\b/i.test(stmt.slice(i))) {
      i += 12;
      skipWs();
    }
    if (stmt[i] !== "(") break;
    const bodyFrom = i + 1;
    let depth = 0;
    while (i < n) {
      const j = skipToken(stmt, i);
      if (j !== -1) {
        i = j;
        continue;
      }
      if (stmt[i] === "(") depth++;
      if (stmt[i] === ")") {
        depth--;
        i++;
        if (depth === 0) break;
        continue;
      }
      i++;
    }
    const bodyTo = i - 1;
    ctes.push({ name, defFrom, defTo: i, bodyFrom, bodyTo });
    skipWs();
    if (stmt[i] === ",") {
      i++;
      continue;
    }
    break;
  }
  return ctes.length > 0 ? { recursive, ctes } : null;
}

/** SQL that runs one CTE standalone: keeps every definition up to and
 * including it (dependencies), selects from it */
export function cteStandaloneSql(stmt: string, parse: CteParse, idx: number): string {
  const defs = parse.ctes
    .slice(0, idx + 1)
    .map((c) => stmt.slice(c.defFrom, c.defTo))
    .join(",\n");
  const kw = parse.recursive ? "WITH RECURSIVE" : "WITH";
  return `${kw} ${defs}\nSELECT * FROM ${parse.ctes[idx].name} LIMIT 100`;
}
