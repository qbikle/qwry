/** Client-side statement spans — mirrors the Rust splitter's token rules
 * (strings, quoted idents, dollar-quotes, comments) so ⌘↩ can run just the
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

/** one changed region of a document edit, in CodeMirror iterChangedRanges
 * shape: [fromA,toA) in the old doc replaced by [fromB,toB) in the new */
export interface ChangedRange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** minimal read surface of a CodeMirror Text (kept structural so this module
 * stays dependency-free and bun-testable) */
interface DocText {
  readonly length: number;
  sliceString(from: number, to: number): string;
}

/** incremental splitStatementSpans: keep the spans before the edit, re-lex a
 * bounded window around it, re-attach the (shifted) spans after it once the
 * lexer re-synchronizes on a statement boundary. Grows the window (up to the
 * whole tail) when the edit resists adoption, RESUMING from the lexer's
 * position — never wrong, only slower.
 * Restart boundaries are only span ends of NON-final spans: those are always
 * terminated by a top-level `;` (the `;` branch of the splitter is the only
 * way a non-final span is pushed). The final span is never one — it may be
 * unterminated, and can even HAPPEN to end in a `;` that sits inside an
 * unterminated comment/string — so it is always re-lexed. */
export function updateStatementSpans(
  old: StmtSpan[],
  ranges: readonly ChangedRange[],
  doc: DocText,
): StmtSpan[] {
  if (ranges.length === 0) return old;
  let fromA = Infinity;
  let toA = -1;
  let toB = -1;
  let delta = 0;
  for (const r of ranges) {
    if (r.fromA < fromA) fromA = r.fromA;
    if (r.toA > toA) toA = r.toA;
    if (r.toB > toB) toB = r.toB;
    delta += r.toB - r.fromB - (r.toA - r.fromA);
  }
  let p = 0;
  const maxPrefix = old.length - 1;
  while (p < maxPrefix && old[p].to < fromA) p++;
  const prefix = old.slice(0, p);
  const base = p > 0 ? old[p - 1].to : 0;
  // spans wholly after the edit stay valid shifted by delta; adopt the first
  // one whose (shifted) start the re-lex lands on exactly
  const candidates = new Map<number, number>();
  for (let i = old.length - 1; i >= 0 && old[i].from >= toA; i--) {
    candidates.set(old[i].from + delta, i);
  }
  const minAdopt = Math.max(toB, base);
  const tail = lexTail(doc, base, candidates, minAdopt, old, delta);
  return prefix.length ? prefix.concat(tail) : tail;
}

/** lex statement spans from `base` until suffix adoption or doc end. Starts
 * on a bounded window and grows it ×4 whenever the edge is reached without a
 * decision — the lexer RESUMES where it stopped (the window text is only
 * appended to), so growth re-lexes at most the one token the previous edge
 * clipped, never the whole window. The final span is only trusted once the
 * window covers the doc end. Mirrors splitStatementSpans exactly. */
function lexTail(
  doc: DocText,
  base: number,
  candidates: Map<number, number>,
  minAdopt: number,
  old: StmtSpan[],
  delta: number,
): StmtSpan[] {
  let hi = Math.min(doc.length, minAdopt + 65536);
  let text = doc.sliceString(base, hi);
  let n = text.length;
  let isFinal = hi === doc.length;
  const grow = () => {
    hi = Math.min(doc.length, base + (hi - base) * 4);
    text += doc.sliceString(base + n, hi);
    n = text.length;
    isFinal = hi === doc.length;
  };
  const out: StmtSpan[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) out.push({ from: base + a, to: base + b });
  };
  while (i < n || !isFinal) {
    if (i >= n) {
      grow();
      continue;
    }
    const j = skipToken(text, i);
    if (j !== -1) {
      // a token that runs to the window edge may be clipped, not
      // unterminated — grow and re-lex it from its start
      if (j >= n && !isFinal) {
        grow();
        continue;
      }
      i = j;
      continue;
    }
    const c = text[i];
    // a token STARTER clipped by the edge lexes as plain chars (`-` of `--`,
    // `/` of `/*`, a `$tag` prefix) — the restart-from-base loop discarded
    // such misreads implicitly; a resuming lexer must not consume them until
    // the window proves them plain
    if (!isFinal && (c === "-" || c === "/" || c === "$") && clippedStarter(text, i, n)) {
      grow();
      continue;
    }
    if (c === ";") {
      push(i + 1);
      i++;
      start = i;
      // boundary: peek at the next statement start for suffix adoption
      let k = i;
      for (;;) {
        while (k < n && /\s/.test(text[k])) k++;
        if (k < n || isFinal) break;
        grow();
      }
      if (k < n) {
        const idx = candidates.get(base + k);
        if (idx !== undefined && base + k >= minAdopt) {
          for (let x = idx; x < old.length; x++) {
            out.push({ from: old[x].from + delta, to: old[x].to + delta });
          }
          return out;
        }
      }
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

/** true when text[i..n) could be the clipped PREFIX of a token starter that
 * skipToken would recognize given more text: `-` (of `--`), `/` (of a block
 * comment) at the last position, or `$` + tag chars running to the edge with
 * the closing `$` beyond it. `$` + digit is never a tag ($1 is a parameter). */
function clippedStarter(text: string, i: number, n: number): boolean {
  const c = text[i];
  if (c === "-" || c === "/") return i + 1 >= n;
  if (i + 1 < n && !/[A-Za-z_]/.test(text[i + 1])) return false;
  for (let k = i + 2; k < n; k++) {
    if (!/[A-Za-z0-9_]/.test(text[k])) return false;
  }
  return true;
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
