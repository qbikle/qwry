// Query-context extraction: walks the lezer token stream of the statement
// under the cursor to find (a) which clause we're in, (b) the tables in scope
// (FROM/JOIN/UPDATE/INSERT INTO/DELETE FROM) with their aliases.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export type Clause =
  | "select"
  | "from"
  | "join" // immediately after JOIN keyword — expecting a table
  | "on"
  | "where"
  | "group"
  | "having"
  | "order"
  | "set"
  | "into" // after INSERT INTO — expecting a table
  | "update" // after UPDATE — expecting a table
  | "values"
  | "returning"
  | "start"; // beginning of a statement

export interface TableRef {
  schema: string | null;
  name: string;
  alias: string;
}

export interface QueryCtx {
  clause: Clause;
  /** tables in scope, in FROM order */
  tables: TableRef[];
  /** the table most recently joined (for ON suggestions) */
  lastJoined: TableRef | null;
  /** identifier before a trailing dot at the cursor, e.g. `u` in `u.na|` */
  qualifier: string | null;
}

interface Tok {
  text: string;
  from: number;
  to: number;
  ident: boolean;
}

const CLAUSE_KEYWORDS: Record<string, Clause> = {
  select: "select",
  from: "from",
  join: "join",
  on: "on",
  where: "where",
  group: "group",
  having: "having",
  order: "order",
  set: "set",
  values: "values",
  returning: "returning",
  update: "update",
  limit: "where", // column-ish context is fine
  by: "group",
};

// words that end a table list within FROM
const FROM_TERMINATORS = new Set([
  "where", "group", "order", "having", "limit", "offset", "on", "set",
  "returning", "values", "union", "intersect", "except", "window",
]);
const JOIN_MODIFIERS = new Set(["left", "right", "inner", "outer", "full", "cross", "lateral"]);
const NOT_ALIAS = new Set([
  ...FROM_TERMINATORS, ...JOIN_MODIFIERS, "join", "as", "using", "natural", "tablesample",
]);

function tokenize(state: EditorState, from: number, to: number): Tok[] {
  const toks: Tok[] = [];
  const tree = syntaxTree(state);
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.from >= node.to) return;
      const name = node.type.name;
      if (name === "Identifier" || name === "QuotedIdentifier" || name === "CompositeIdentifier" || name === "Keyword") {
        toks.push({
          text: state.sliceDoc(node.from, node.to),
          from: node.from,
          to: node.to,
          ident: name !== "Keyword",
        });
        return false;
      }
      if (name === "Punctuation" || name === "Operator" || name === "Semi" ||
          name === "String" || name === "Number" || name === "Parens" ||
          name === "Brackets" || name === "Whitespace") {
        if (name !== "Parens" && name !== "Brackets") {
          toks.push({ text: state.sliceDoc(node.from, node.to), from: node.from, to: node.to, ident: false });
          return false;
        }
      }
      return undefined;
    },
  });
  return toks;
}

// Bound on how much statement text gets tokenized per keystroke. A statement
// bigger than this (giant VALUES/IN paste) is windowed around the cursor:
// completion inside a >200KB single statement may miss tables defined outside
// the window — accepted; statements under the cap tokenize identically.
const MAX_SCAN = 200_000;
const HALF_SCAN = 100_000;

/** last ";" at or before pos-1, scanned backward in bounded chunks — never
 * materializes the doc. -1 when none within HALF_SCAN (or the doc start). */
function lastSemi(state: EditorState, pos: number): number {
  const lo = Math.max(0, pos - HALF_SCAN);
  for (let end = pos; end > lo; ) {
    const start = Math.max(lo, end - 4096);
    const idx = state.sliceDoc(start, end).lastIndexOf(";");
    if (idx !== -1) return start + idx;
    end = start;
  }
  // scan capped mid-doc: treat the window edge as the statement start
  return lo === 0 ? -1 : lo - 1;
}

/** first ";" at or after pos, scanned forward in bounded chunks. -1 when none
 * within HALF_SCAN (or the doc end). */
function nextSemi(state: EditorState, pos: number): number {
  const hi = Math.min(state.doc.length, pos + HALF_SCAN);
  for (let start = pos; start < hi; ) {
    const end = Math.min(hi, start + 4096);
    const idx = state.sliceDoc(start, end).indexOf(";");
    if (idx !== -1) return start + idx;
    start = end;
  }
  return hi === state.doc.length ? -1 : hi;
}

/** statement range containing pos (Statement node, else whole doc) */
function statementRange(state: EditorState, pos: number): { from: number; to: number } {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(pos, -1);
  while (node.parent) {
    if (node.type.name === "Statement") return { from: node.from, to: node.to };
    node = node.parent;
  }
  // fallback: split on semicolons textually (bounded — this path used to
  // toString() the whole doc on every keystroke at a statement boundary)
  const from = lastSemi(state, pos) + 1;
  let to = nextSemi(state, pos);
  if (to === -1) to = state.doc.length;
  return { from, to };
}

const unquote = (s: string) =>
  s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase();

function parseTableRef(parts: string[]): { schema: string | null; name: string } {
  if (parts.length >= 2) return { schema: unquote(parts[0]), name: unquote(parts[1]) };
  return { schema: null, name: unquote(parts[0]) };
}

export function queryContext(state: EditorState, pos: number): QueryCtx {
  let { from, to } = statementRange(state, pos);
  // pathological single statements get a MAX_SCAN window around the cursor
  // (see note above) — anything smaller tokenizes in full, byte-identically
  if (to - from > MAX_SCAN) {
    from = Math.max(from, pos - HALF_SCAN);
    to = Math.min(to, pos + HALF_SCAN);
  }
  // IMPORTANT: tokenize the WHOLE statement — in `SELECT col| FROM t` the
  // tables live after the cursor. Clause detection is cursor-bounded below.
  const toks = tokenize(state, from, to);

  // qualifier: ident '.' [partial] right before cursor
  let qualifier: string | null = null;
  const before = state.sliceDoc(Math.max(from, pos - 80), pos);
  const qm = /([A-Za-z_][\w$]*|"(?:[^"]|"")*")\.([A-Za-z_][\w$]*)?$/.exec(before);
  if (qm) qualifier = unquote(qm[1]);

  // pass 1: tables in scope (full statement)
  const tables: TableRef[] = [];
  let lastJoined: TableRef | null = null;
  {
    let i = 0;
    let pendingInsert = false;
    while (i < toks.length) {
      const t = toks[i];
      const lower = t.text.toLowerCase();
      if (!t.ident) {
        if (lower === "insert") pendingInsert = true;
        if (lower === "into" && pendingInsert) {
          i = consumeTableList(toks, i + 1, tables, (r) => (lastJoined = r), true);
          pendingInsert = false;
          continue;
        }
        if (lower === "update" && tables.length === 0) {
          i = consumeTableList(toks, i + 1, tables, (r) => (lastJoined = r), true);
          continue;
        }
        if (lower === "from" || lower === "join") {
          i = consumeTableList(toks, i + 1, tables, (r) => (lastJoined = r), false);
          continue;
        }
      }
      i++;
    }
  }

  // pass 2: clause at cursor (tokens strictly before pos)
  let clause: Clause = "start";
  {
    let pendingInsert = false;
    let first = true;
    for (const t of toks) {
      if (t.from >= pos) break;
      const lower = t.text.toLowerCase();
      if (!t.ident) {
        if (lower === "insert") pendingInsert = true;
        if (lower === "into" && pendingInsert) {
          clause = "into";
          pendingInsert = false;
          continue;
        }
        if (lower === "update" && first) {
          clause = "update";
          continue;
        }
        const cl = CLAUSE_KEYWORDS[lower];
        if (cl && !JOIN_MODIFIERS.has(lower)) clause = cl;
      }
      first = false;
    }
  }

  return { clause, tables, lastJoined, qualifier };
}

/** parse `t1 [AS] [a1], t2 a2 ...` until terminator; returns next index */
function consumeTableList(
  toks: Tok[],
  start: number,
  out: TableRef[],
  onTable: (r: TableRef) => void,
  single: boolean,
): number {
  let i = start;
  for (;;) {
    // skip join modifiers between JOIN keywords
    while (i < toks.length && JOIN_MODIFIERS.has(toks[i].text.toLowerCase())) i++;
    if (i >= toks.length || !toks[i].ident) return i;

    // table name (possibly composite "a.b" or split tokens a . b)
    const parts = toks[i].text.includes(".")
      ? toks[i].text.split(".")
      : [toks[i].text];
    i++;
    while (i + 1 < toks.length && toks[i].text === "." && toks[i + 1].ident) {
      parts.push(toks[i + 1].text);
      i += 2;
    }
    const { schema, name } = parseTableRef(parts);

    // optional AS / alias
    let alias = name;
    if (i < toks.length && toks[i].text.toLowerCase() === "as") i++;
    if (i < toks.length && toks[i].ident && !NOT_ALIAS.has(toks[i].text.toLowerCase())) {
      alias = unquote(toks[i].text);
      i++;
    }

    const ref: TableRef = { schema, name, alias };
    out.push(ref);
    onTable(ref);

    if (single) return i;
    if (i < toks.length && toks[i].text === ",") {
      i++;
      continue;
    }
    return i;
  }
}
