// The diff face (A3 item 5): the block's own statement, run READ-ONLY on a
// sibling connection, the two results paired by their label columns. It takes
// the TABLE face's place while the comparison stands (the table's cells are
// the diff's A cells, DESIGN rule 14), so the flip cycle stays three faces.
//
// Every numeric cell reads `731 · 748 · +2.3%`: A and B exactly as each
// database printed them, the separators decoration (tier 3), and Δ the signed
// RELATIVE change at one decimal, because an absolute difference would
// restate two numbers already standing in the cell. A row present on one side
// only wears the warn glyph on its label and `∅` for the side it lacks, and
// carries no Δ.
//
// Which two connections these are, and how long each took, is the status
// line's under the block (`6 rows · staging 412.6 ms · prod 388.1 ms`): the
// face never names them twice (LESSONS 4, DESIGN rule 14). Over the cap there
// is no grid at all and that status line IS the face, so this renders nothing.
//
// The grid is the results grid's register drawn statically (200 rows is the
// cap, so there is nothing here for the virtualizer): the raised header, the
// 52px row-number gutter, 26px rows, mono cells.

import { TriangleAlert } from "lucide-react";
import type { Diff, DiffCell } from "../stores/canvas";

/** rows the face shows before it scrolls inside the block (the result
 * block's own window, ResultBlock's GRID_ROWS_SHOWN) */
const ROWS_SHOWN = 6;
const ROW_H = 26;
const HEADER_H = 30;

const delta = (d: number) => `${d >= 0 ? "+" : "-"}${Math.abs(d).toFixed(1)}%`;

/** one cell: both sides and the change, or `∅` for a side with no row */
function Tri({ cell }: { cell: DiffCell }) {
  return (
    <span className="dg-tri">
      {cell.a === null ? <b className="dg-none">∅</b> : cell.a}
      <i>·</i>
      {cell.b === null ? <b className="dg-none">∅</b> : cell.b}
      {cell.delta !== null && (
        <>
          <i>·</i>
          {delta(cell.delta)}
        </>
      )}
    </span>
  );
}

export function DiffFace({ diff }: { diff: Diff }) {
  if (diff.capped) return null;
  // ONE grid for the whole face, its rows `display: contents`: a grid per row
  // resolves `max-content` per row, and columns that shift from row to row are
  // not a grid. The labels and every numeric column but the last size to their
  // content; the last takes the slack, so a narrow diff fills the block and a
  // wide one scrolls inside it (the results grid's own bargain)
  const cols = diff.labelColumns.length + diff.numericColumns.length;
  const template = `52px ${"max-content ".repeat(Math.max(0, cols - 1))}minmax(max-content, 1fr)`;
  return (
    <div
      className="cv-diff"
      style={{
        gridTemplateColumns: template,
        maxHeight: HEADER_H + Math.min(diff.rows.length, ROWS_SHOWN) * ROW_H,
      }}
    >
      <span className="dg-h dg-n" />
      {[...diff.labelColumns, ...diff.numericColumns].map((c) => (
        <span className="dg-h dg-c" key={c}>
          {c}
        </span>
      ))}
      {diff.rows.map((row, i) => (
        <div className={`dg-r${row.only ? " warn" : ""}`} key={`${row.labels.join(" ")}-${i}`}>
          <span className="dg-n">{i + 1}</span>
          {row.labels.map((v, li) => (
            <span className={`dg-c${li === 0 ? " dg-key" : ""}`} key={diff.labelColumns[li]}>
              {li === 0 && row.only && <TriangleAlert size={12} />}
              {v}
            </span>
          ))}
          {row.cells.map((cell, ci) => (
            <span className="dg-c" key={diff.numericColumns[ci]}>
              <Tri cell={cell} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
