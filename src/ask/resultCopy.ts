// What the result block's Copy puts on the clipboard (W7 item 1), kept as
// pure functions beside the block that calls them (the mentionRows.ts
// precedent): the component reaches the settings store and the grid, and
// neither is any part of these three.

import type { AgentRun } from "../agent/types";
import { formatCells } from "../grid/clipboard";

/** the finished form of a statement: exactly one trailing semicolon. The
 * gate keeps the bare form, every surface shows the finished one (a model's
 * one-liner pasted as a statement that did not end) */
export const finished = (sql: string) => `${sql.trim().replace(/;+$/, "")};`;

/** the rows the block holds, in the grid's own TSV. The block's Copy IS the
 * grid's Copy over the whole result (formatCells, no header), so one result
 * copied from either place pastes the same bytes and parseTsv reads both
 * (LESSONS 1); the grid's single-cell rule travels too, because TSV quoting
 * reads as garbage in an input field */
export function resultTsv(run: AgentRun): string {
  if (run.rows.length === 1 && run.columns.length === 1) {
    const v = run.rows[0][0] ?? "";
    return /[\t\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }
  const columns = run.columns.map((name, i) => ({ name, type_oid: 0, table_oid: 0, attnum: i + 1 }));
  return formatCells(columns, run.rows, "tsv");
}

/** the cue names what landed on the clipboard: the rows the block HOLDS, the
 * number the status line prints, never the six in the viewport */
export const copiedRowsCue = (rows: number) =>
  `Copied ${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"}`;
