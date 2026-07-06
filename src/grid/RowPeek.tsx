// Transposed single-row view (Space) — a 60-column row is unreadable
// horizontally; this shows it vertically with ↑/↓ walking the result set.
// Structured values (json/jsonb/arrays) render PRETTY-PRINTED. Editing opens
// a POP-OUT value editor (Postico-style) so the peek never reflows — the
// pop-out sits above this modal in the overlay stack, so Esc naturally closes
// only the editor first. Stages through the normal ⌘S flow.
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Pencil } from "lucide-react";
import { popIn } from "../design/springs";
import { Modal } from "../app/overlay/Overlay";
import type { StatementState } from "../stores/results";
import { editKey, useEdits } from "../stores/edits";
import type { ColumnEditMeta } from "../ipc/types";
import { isArrayType, jsToPgArray, structuredValue } from "../inspector/format";
import { JsonField } from "../inspector/JsonField";
import { typeIcon } from "./typeIcon";
import "./grid.css";

const LOSSY_NUMS = /(?:^|[\s:,[])-?\d{16,}(?:[\s,}\]]|$)/;

export function RowPeek({
  statement,
  viewRow,
  rowAt,
  colAt,
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

  if (!row) return null;

  const prettyOf = (i: number): string | null => {
    const k = editKey(statement.index, dataR, i);
    const v = pending[k] ? pending[k].value : row[i];
    if (v == null) return v;
    const structured = structuredValue(v, typeOf(i));
    if (structured !== undefined && !LOSSY_NUMS.test(v)) {
      return JSON.stringify(structured, null, 2);
    }
    return v;
  };

  const stagePop = (i: number, draft: string): string | null => {
    const tn = typeOf(i);
    const isJson = tn === "json" || tn === "jsonb";
    const isArr = isArrayType(tn);
    let value = draft;
    if (isJson || isArr) {
      try {
        const parsed = JSON.parse(draft);
        if (isArr) {
          if (!Array.isArray(parsed)) {
            return "this column is a Postgres array — provide a JSON array [ … ]";
          }
          value = jsToPgArray(parsed);
        }
        // json/jsonb: parse is VALIDATION only — the typed text stages verbatim
      } catch (e) {
        return (e as Error).message;
      }
    }
    useEdits.getState().setEdit({
      stmtIndex: statement.index,
      row: dataR,
      col: i,
      value,
      original: statement.rows[dataR][i],
    });
    return null;
  };

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
            {statement.columns.map((_, view) => {
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

/** Pop-out single-value editor — its own overlay-stack entry, so Esc closes
 * IT first and the row peek underneath never moves. */
function ValuePop({
  colName,
  typeName,
  initial,
  onStage,
  onClose,
}: {
  colName: string;
  typeName: string | undefined;
  initial: string;
  onStage: (draft: string) => string | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // json/jsonb/arrays edit in a syntax-highlighted CodeMirror; free text
  // stays a plain textarea (no JSON tokens to color)
  const structured =
    typeName === "json" || typeName === "jsonb" || isArrayType(typeName);

  // caret AFTER the value, not before it (textarea path; CM handles its own)
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const stage = () => setErr(onStage(draft));

  const autoFormat = () => {
    try {
      setDraft(JSON.stringify(JSON.parse(draft), null, 2));
      setErr(null);
    } catch (ex) {
      setErr(`not valid JSON: ${(ex as Error).message}`);
    }
  };

  return (
    <Modal
      onClose={onClose}
      onKey={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          stage();
        }
      }}
    >
      <motion.div
        className="valuepop"
        {...popIn}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="valuepop-head">
          <span className="valuepop-title">{colName}</span>
          {typeName && <span className="valuepop-type">{typeName}</span>}
        </div>
        {structured ? (
          <div className="valuepop-cm">
            <JsonField
              value={draft}
              autoFocus
              onChange={setDraft}
              onSave={stage}
              onCancel={onClose}
            />
          </div>
        ) : (
          <textarea
            ref={taRef}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
        {err && <div className="valuepop-err">{err}</div>}
        <div className="valuepop-actions">
          {structured && (
            <button className="valuepop-format" onClick={autoFormat} title="Pretty-print JSON">
              Format
            </button>
          )}
          <button onClick={onClose}>
            Cancel <span className="insp-key">esc</span>
          </button>
          <button className="primary" onClick={stage}>
            Stage edit <span className="insp-key">⌘↵</span>
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
