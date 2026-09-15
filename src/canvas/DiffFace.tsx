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
// Which two connections these are, and how long each took, are two CHIPS
// inside the face, above the grid (D2 item 5): the origin as a plain chip, the
// compared one wearing the `×` that clears the comparison, each carrying its
// own connection's 8px dot and its own run's time. They were the status line's
// until now; a side's name in the chip and again in the line is one fact in two
// slots (DESIGN rule 14), so the line drops both and reads `6 rows · assumed
// …`. The costume is the tool chip's (`.tchip`: raised, pill, no border),
// because a bordered chip is the toggle species and a chip that answers no
// click is a control costume on a non-control (rule 8's inverse, the reason
// AGENT-UX 16a folded the assumption chips into the status line). Over the cap
// there is no grid at all and the block's status line IS the face, so this
// renders nothing.
//
// The grid is the results grid's register drawn statically (200 rows is the
// cap, so there is nothing here for the virtualizer): the raised header, the
// 52px row-number gutter, 26px rows, mono cells.
//
// D1: every column gives way where the element cannot hold it, so the cells
// ellipsize and the grid scrolls inside its own box; a six-column compare
// against prod used to draw 937px of grid inside a 482px element. What a
// narrowed cell then cannot finish saying, its tooltip says in full, through
// the one formatter that also prints the marks (`triText`).

import { useContext } from "react";
import { TriangleAlert, X } from "lucide-react";
import type { Profile } from "../ipc/types";
import { useCanvas, type Diff, type DiffCell, type DiffSide } from "../stores/canvas";
import { useConnections } from "../stores/connections";
import { avatarColor } from "../design/avatarColor";
import { msText } from "../lib/duration";
import { Widget } from "./widget";

/** rows the face shows before it scrolls inside the block (the result
 * block's own window, ResultBlock's GRID_ROWS_SHOWN) */
const ROWS_SHOWN = 6;
const ROW_H = 26;
const HEADER_H = 30;

const delta = (d: number) => `${d >= 0 ? "+" : "-"}${Math.abs(d).toFixed(1)}%`;

/** the triple as TEXT: `731 · 748 · +2.3%`, the same three parts the cell
 * draws, in the same order, with the same separator. It is what the cell's own
 * tooltip says, because a cell narrow enough to ellipsize is a cell whose
 * numbers a reader cannot finish reading (D1 item 9), and a formatter is what
 * keeps `[object Object]` untypeable there. One derivation, so the tooltip and
 * the marks can never disagree (DESIGN rule 14) */
export function triText(cell: DiffCell): string {
  const parts = [cell.a ?? "∅", cell.b ?? "∅"];
  if (cell.delta !== null) parts.push(delta(cell.delta));
  return parts.join(" · ");
}

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

/** a side's own 8px dot, in that connection's identity colour: the titlebar's
 * and the answer footer's provenance mark, the one documented exception to the
 * icon trio (DESIGN rule 5). A connection no longer saved keeps its chip and
 * loses the colour, rather than the chip losing its side */
const dotColour = (profiles: readonly Profile[], id: string): string => {
  const p = profiles.find((x) => x.id === id);
  return p ? avatarColor(p) : "var(--border-strong)";
};

/** one side, as a chip: its dot, its name at tier 1, its own run's time at
 * tier 2, a side's facts together and once. `onClear` is the COMPARED side's
 * alone: clearing takes the second side away and leaves the first standing
 * exactly where it is, so the origin chip carries no × */
function Chip({ side, colour, onClear }: { side: DiffSide; colour: string; onClear?: () => void }) {
  return (
    <span className={`tchip cchip${onClear ? " cleared" : ""}`}>
      <span className="cchip-dot" style={{ background: colour }} aria-hidden />
      <span className="cchip-name">{side.name}</span>
      <span className="cchip-ms">{msText(side.ms)}</span>
      {onClear && (
        <button
          type="button"
          className="cchip-x"
          title="Clear Comparison"
          aria-label="Clear Comparison"
          onClick={onClear}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

export function DiffFace({ diff }: { diff: Diff }) {
  // the cells this face stands in: what the × clears. Null in the pane, where
  // no block holds a comparison and neither chip is drawn
  const widget = useContext(Widget);
  const colourA = useConnections((s) => dotColour(s.profiles, diff.a.profileId));
  const colourB = useConnections((s) => dotColour(s.profiles, diff.b.profileId));
  if (diff.capped) return null;
  // ONE grid for the whole face, its rows `display: contents`: a grid per row
  // resolves `max-content` per row, and columns that shift from row to row are
  // not a grid. The labels and every numeric column but the last size to their
  // content; the last takes the slack, so a narrow diff fills the block and a
  // wide one scrolls inside it (the results grid's own bargain)
  // every column is `minmax(0, max-content)`: it takes what its content needs
  // and, where the element cannot give it that, it gives WAY, so the cells
  // ellipsize and the grid scrolls inside its own box. A bare `max-content`
  // has no lower bound, which is what let a six-column compare against prod
  // draw 937px of grid inside a 482px element (D1 item 9)
  const cols = diff.labelColumns.length + diff.numericColumns.length;
  const template = `52px ${"minmax(0, max-content) ".repeat(Math.max(0, cols - 1))}minmax(0, 1fr)`;
  return (
    <div className="cv-diff-face">
      {widget && (
        <div className="cchips">
          <Chip side={diff.a} colour={colourA} />
          <Chip
            side={diff.b}
            colour={colourB}
            onClear={() => useCanvas.getState().clearCompare(widget.canvasId, widget.blockId)}
          />
        </div>
      )}
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
            <span className="dg-t">{c}</span>
          </span>
        ))}
        {diff.rows.map((row, i) => (
          <div className={`dg-r${row.only ? " warn" : ""}`} key={`${row.labels.join(" ")}-${i}`}>
            <span className="dg-n">{i + 1}</span>
            {row.labels.map((v, li) => (
              <span className={`dg-c${li === 0 ? " dg-key" : ""}`} key={diff.labelColumns[li]}>
                {li === 0 && row.only && <TriangleAlert size={12} />}
                <span className="dg-t">{v}</span>
              </span>
            ))}
            {row.cells.map((cell, ci) => (
              <span className="dg-c" key={diff.numericColumns[ci]} title={triText(cell)}>
                <Tri cell={cell} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
