// Transposed single-row view (Space) — a 60-column row is unreadable
// horizontally; this shows it vertically with ↑/↓ walking the result set.
// Structured values (json/jsonb/arrays) render PRETTY-PRINTED. Editing opens
// a POP-OUT value editor (Postico-style) so the peek never reflows — the
// pop-out sits above this modal in the overlay stack, so Esc naturally closes
// only the editor first. Stages through the normal ⌘S flow.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Pencil } from "lucide-react";
import { popIn } from "../design/springs";
import { Modal } from "../app/overlay/Overlay";
import type { StatementState } from "../stores/results";
import { editKey, useEdits } from "../stores/edits";
import type { ColumnEditMeta } from "../ipc/types";
import { JsonField } from "../inspector/JsonField";
import { typeIcon } from "./typeIcon";
import { prettyCellValue, stageCellDraft, ValuePop } from "./ValuePop";
import "./grid.css";

export function RowPeek({
  statement,
  viewRow,
  rowAt,
  colAt,
  viewColLen,
  rowCount,
  typeOf,
  editMetaOf,
  onStep,
  onClose,
}: {
  statement: StatementState;
  viewRow: number;
  rowAt: (view: number) => number;
  /** view→data column map so the peek lists columns in the GRID's order */
  colAt: (view: number) => number;
  /** TRUE view column count — colAt past it falls back to identity, which
   * would leak hidden columns (and duplicate the last one) */
  viewColLen: number;
  rowCount: number;
  typeOf: (dataCol: number) => string | undefined;
  editMetaOf: (dataCol: number) => ColumnEditMeta | undefined;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const pending = useEdits((s) => s.pending);
  const [popCol, setPopCol] = useState<number | null>(null);

  const dataR = rowAt(viewRow);
  const row = statement.rows[dataR];

  // walking to another row abandons an open pop-out
  useEffect(() => setPopCol(null), [dataR]);

  // rows can be replaced/shrunk under the open modal — a gone row must CLOSE
  // the peek, not render null: the grid still holds peekRow ≠ null and would
  // silently keep routing the keyboard here
  const rowGone = !row;
  useEffect(() => {
    if (rowGone) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowGone]);
  if (!row) return null;

  const prettyOf = (i: number): string | null => {
    const k = editKey(statement.index, dataR, i);
    const v = pending[k] ? pending[k].value : row[i];
    return prettyCellValue(v, typeOf(i));
  };

  const stagePop = (i: number, draft: string): string | null =>
    stageCellDraft({
      stmtIndex: statement.index,
      row: dataR,
      col: i,
      draft,
      typeName: typeOf(i),
      original: statement.rows[dataR][i],
    });

  return (
    <>
      <Modal
        onClose={onClose}
        onKey={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== " ") return;
          e.preventDefault();
          e.stopImmediatePropagation();
          if (e.key === " ") onClose();
          else onStep(e.key === "ArrowDown" ? 1 : -1);
        }}
      >
        <motion.div
        className="rowpeek"
        {...popIn}
        // portals bubble through the REACT tree — without this, keys typed in
        // the peek reach the grid underneath and seed type-to-edit
        onKeyDown={(e) => e.stopPropagation()}
      >
          <div className="rowpeek-head">
            <span className="rowpeek-title">
              Row {viewRow + 1}{" "}
              <span className="rowpeek-of">of {rowCount.toLocaleString()}</span>
            </span>
            <span className="rowpeek-keys">↑↓ walk rows · dbl-click edit · esc close</span>
          </div>
          <div className="rowpeek-body">
            {Array.from({ length: viewColLen }, (_, view) => {
              const i = colAt(view); // data index — everything below is data-keyed
              const c = statement.columns[i];
              const k = editKey(statement.index, dataR, i);
              const pendingEdit = pending[k];
              const v = pendingEdit ? pendingEdit.value : row[i];
              const tn = typeOf(i);
              const glyph = typeIcon(tn);
              const truncated = statement.truncated.has(`${dataR}:${i}`);
              const meta = editMetaOf(i);
              const editable = !!meta?.editable && !truncated;
              const pretty = prettyOf(i);

              return (
                <div key={i} className={`rowpeek-row${pendingEdit ? " dirty" : ""}`}>
                  <span className="rowpeek-col" title={tn}>
                    {glyph && (
                      <span className="rowpeek-type" style={{ color: glyph.color }}>
                        <glyph.Icon size={11} strokeWidth={2.2} />
                      </span>
                    )}
                    {c.name}
                    {pendingEdit && <span className="rowpeek-dirty">✎</span>}
                  </span>
                  <span
                    className={`rowpeek-val${v === null ? " null" : ""}${pretty !== v ? " structured" : ""}${editable ? " editable" : ""}`}
                    title={
                      editable
                        ? "Double-click to edit"
                        : meta && !meta.editable
                          ? (meta.reason ?? undefined)
                          : undefined
                    }
                    onDoubleClick={() => editable && setPopCol(i)}
                  >
                    {pendingEdit?.useDefault ? (
                      <span className="vgrid-defaultchip">DEFAULT</span>
                    ) : v === null ? (
                      <span className="vgrid-nullchip">NULL</span>
                    ) : v === "" ? (
                      <span className="vgrid-emptychip">∅ empty</span>
                    ) : pretty !== v && pretty !== null && pretty.includes("\n") ? (
                      // structured (json/array) → syntax-highlighted viewer
                      <JsonField value={pretty} readOnly />
                    ) : (
                      pretty
                    )}
                    {truncated && <span className="vgrid-trunc"> …⧉</span>}
                    {editable && (
                      <span className="rowpeek-pencil">
                        <Pencil size={11} />
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </motion.div>
      </Modal>

      {popCol !== null && (
        <ValuePop
          colName={statement.columns[popCol].name}
          typeName={typeOf(popCol)}
          initial={prettyOf(popCol) ?? ""}
          onStage={(draft) => {
            const err = stagePop(popCol, draft);
            if (err === null) setPopCol(null);
            return err;
          }}
          onClose={() => setPopCol(null)}
        />
      )}
    </>
  );
}
