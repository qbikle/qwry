import { create } from "zustand";

interface DangerState {
  prompt: { id: number; title: string; detail: string; confirmLabel: string } | null;
  resolver: ((ok: boolean) => void) | null;
  resolve: (ok: boolean) => void;
}

export const useDanger = create<DangerState>((set, get) => ({
  prompt: null,
  resolver: null,
  resolve: (ok) => {
    get().resolver?.(ok);
    set({ prompt: null, resolver: null });
  },
}));

let promptSeq = 0;

/** async confirm for destructive operations (window.confirm is a WKWebView stub).
 * `confirmLabel` names the ACTION ("Discard", "Delete", "Quit") — a generic
 * label on a destructive button makes users misread what they're agreeing to. */
export function confirmDanger(
  title: string,
  detail: string,
  confirmLabel = "Run Anyway",
): Promise<boolean> {
  return confirmDangerLive(title, detail, confirmLabel).done;
}

/** confirm whose detail can be UPDATED while it's open — the no-WHERE prompt
 * opens immediately with "estimating…" and streams planner estimates in
 * (blocking the modal on an EXPLAIN that may be lock-stuck made ⌘↵ hang).
 * `update` silently no-ops once this prompt is resolved or displaced. */
export function confirmDangerLive(
  title: string,
  detail: string,
  confirmLabel = "Run Anyway",
): { done: Promise<boolean>; update: (detail: string) => void } {
  const id = ++promptSeq;
  const done = new Promise<boolean>((resolve) => {
    // a new prompt displacing an open one must not orphan the old caller's
    // promise — resolve it false (treated as "cancelled")
    useDanger.getState().resolver?.(false);
    useDanger.setState({ prompt: { id, title, detail, confirmLabel }, resolver: resolve });
  });
  const update = (next: string) => {
    const cur = useDanger.getState().prompt;
    if (cur?.id !== id) return; // resolved or displaced — a late estimate is noise
    useDanger.setState({ prompt: { ...cur, detail: next } });
  };
  return { done, update };
}

import { parseCtes, skipToken, splitStatementSpans } from "../editor/statements";

const isWordChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

/** index of the first code character at/after i (comments count as whitespace) */
function skipWsComments(stmt: string, i: number): number {
  const n = stmt.length;
  for (;;) {
    while (i < n && /\s/.test(stmt[i])) i++;
    if (
      i < n &&
      ((stmt[i] === "-" && stmt[i + 1] === "-") || (stmt[i] === "/" && stmt[i + 1] === "*"))
    ) {
      i = skipToken(stmt, i);
      continue;
    }
    return i;
  }
}

/** a bare keyword from `i` on, outside strings/comments/dollar-quotes;
 * `topLevel` restricts to paren depth 0 — a WHERE inside a subselect doesn't
 * make the outer DML safe */
function hasKeyword(stmt: string, i: number, word: string, topLevel: boolean): boolean {
  const n = stmt.length;
  let depth = 0;
  while (i < n) {
    const j = skipToken(stmt, i);
    if (j !== -1) {
      i = j;
      continue;
    }
    const ch = stmt[i];
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (isWordChar(ch)) {
      let k = i + 1;
      while (k < n && isWordChar(stmt[k])) k++;
      if (
        (!topLevel || depth === 0) &&
        k - i === word.length &&
        stmt.slice(i, k).toLowerCase() === word
      ) {
        return true;
      }
      i = k;
      continue;
    }
    i++;
  }
  return false;
}

/** head keyword of a statement, skipping leading comments AND a WITH clause
 * (WITH … AS (…) DELETE FROM x heads at DELETE). Lowercased; "" when none. */
function headAfterWith(stmt: string): { word: string; end: number } {
  let i = skipWsComments(stmt, 0);
  if (/^with\b/i.test(stmt.slice(i))) {
    const parse = parseCtes(stmt);
    if (!parse) return { word: "", end: i };
    i = skipWsComments(stmt, parse.ctes[parse.ctes.length - 1].defTo);
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(stmt.slice(i));
  return m ? { word: m[0].toLowerCase(), end: i + m[0].length } : { word: "", end: i };
}

/** the statement (or one of its data-modifying CTE bodies) is an UPDATE or
 * DELETE with no top-level WHERE, a MERGE with no WHERE anywhere (its guards
 * live in ON/WHEN subclauses), or a TRUNCATE (no WHERE form exists) */
function dmlWithoutWhere(stmt: string): boolean {
  const parse = parseCtes(stmt);
  if (parse) {
    for (const cte of parse.ctes) {
      if (dmlWithoutWhere(stmt.slice(cte.bodyFrom, cte.bodyTo))) return true;
    }
  }
  const { word, end } = headAfterWith(stmt);
  if (word === "truncate") return true;
  if (word === "merge") return !hasKeyword(stmt, end, "where", false);
  if (word !== "update" && word !== "delete") return false;
  return !hasKeyword(stmt, end, "where", true);
}

/** UPDATE or DELETE statements with no WHERE clause — real statement
 * boundaries (a `;` inside a string/dollar-quote no longer splits), leading
 * comments and CTE chains skipped, and only a TOP-LEVEL WHERE counts */
export function dangerousStatements(sql: string): string[] {
  return splitStatementSpans(sql)
    .map((sp) => sql.slice(sp.from, sp.to))
    .filter(dmlWithoutWhere)
    .map((s) => s.trim());
}

const MUTATING = new Set([
  "insert", "update", "delete", "merge", "truncate", "drop", "alter", "create", "call", "do",
]);

/** EXPLAIN ANALYZE executes the statement — anything that can write must warn.
 * COPY mutates only in its FROM form; SELECT … INTO creates a table. */
export const isMutating = (sql: string): boolean => {
  const { word, end } = headAfterWith(sql);
  if (MUTATING.has(word)) return true;
  if (word === "copy" && hasKeyword(sql, end, "from", true)) return true;
  if (word === "select" && hasKeyword(sql, end, "into", true)) return true;
  // a data-modifying CTE executes its writes even when the outer head is SELECT
  const parse = parseCtes(sql);
  return !!parse && parse.ctes.some((c) => isMutating(sql.slice(c.bodyFrom, c.bodyTo)));
};
