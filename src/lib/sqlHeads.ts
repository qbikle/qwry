/** Which SQL a refresh may run a second time (E2 R4).
 *
 * A refresh never asks whether the text is valid: it asks whether running it
 * again changes the database. That verdict is a property of the statement
 * HEADS, read on the same splitter the editor and the runner already use
 * (DESIGN rule 15) rather than a regex over the buffer, which cannot tell a
 * word in a string literal from a keyword.
 *
 * Two heads lie about themselves and are opened here: `EXPLAIN ANALYZE`
 * executes the statement it explains, and a WITH clause can hold an INSERT
 * that runs whether or not the outer statement selects.
 */
import { headToken, parseCtes, splitStatementSpans } from "../editor/statements";

const READ_ONLY = new Set(["select", "with", "explain", "show", "values", "table"]);

/** EXPLAIN's own grammar: `EXPLAIN [ ( option [, …] ) ] [ANALYZE] [VERBOSE] stmt`.
 * The bare-word form is the legacy one PG still accepts. */
const EXPLAIN_PREFIX = /^\s*explain\s*(?:\([^)]*\)\s*)?(?:(?:analyze|analyse|verbose)\s+)*/i;

/** a CTE body that writes: its rows land whatever the outer statement does */
const CTE_READ_ONLY = new Set(["select", "values", "table", "with"]);

function withIsReadOnly(stmt: string): boolean {
  const parse = parseCtes(stmt);
  if (!parse || parse.ctes.length === 0) return false;
  for (const cte of parse.ctes) {
    if (!CTE_READ_ONLY.has(headToken(stmt.slice(cte.bodyFrom, cte.bodyTo)))) return false;
  }
  // `WITH x AS (SELECT …) DELETE FROM …` wears a read-only head over a write
  const tail = stmt.slice(parse.ctes[parse.ctes.length - 1].defTo);
  return CTE_READ_ONLY.has(headToken(tail));
}

function statementIsReadOnly(stmt: string): boolean {
  const head = headToken(stmt);
  if (!READ_ONLY.has(head)) return false;
  if (head === "with") return withIsReadOnly(stmt);
  if (head !== "explain") return true;
  const m = EXPLAIN_PREFIX.exec(stmt);
  // a comment-prefixed EXPLAIN reaches here unmatched: refuse rather than
  // re-run something that may be an ANALYZE over a DELETE
  return m ? statementIsReadOnly(stmt.slice(m[0].length)) : false;
}

/** true when every statement in `sql` is safe to run again. Empty text is
 * false: there is nothing to rerun, which is not the same as a green light. */
export function readOnlyHeads(sql: string): boolean {
  const spans = splitStatementSpans(sql);
  if (spans.length === 0) return false;
  return spans.every((s) => statementIsReadOnly(sql.slice(s.from, s.to)));
}
