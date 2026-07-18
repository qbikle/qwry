// Pop-out single-value editor shared by the row peek and the record view —
// its own overlay-stack entry, so Esc closes IT first and the modal
// underneath never moves. Also home of the shared display/stage helpers so
// both transposed views render and stage values identically.
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { Modal } from "../app/overlay/Overlay";
import { useEdits } from "../stores/edits";
import { isArrayType, jsToPgArray, structuredValue } from "../inspector/format";
import { JsonField } from "../inspector/JsonField";
import "./grid.css";

/** JSON.parse would silently round-trip 16+-digit ints through float64 —
 * pretty-printing such values would lie about the stored digits */
export const LOSSY_NUMS = /(?:^|[\s:,[])-?\d{16,}(?:[\s,}\]]|$)/;

/** structured values (json/jsonb/arrays) pretty-printed for display; anything
 * else (or precision-lossy JSON) verbatim */
export function prettyCellValue(v: string | null, typeName: string | undefined): string | null {
  if (v == null) return v;
  const structured = structuredValue(v, typeName);
  if (structured !== undefined && !LOSSY_NUMS.test(v)) {
    return JSON.stringify(structured, null, 2);
  }
  return v;
}

/** validate + stage one cell draft through the normal edits pipeline (same
 * keys the grid uses, so staged dots appear everywhere). Returns an error
 * message instead of staging when the draft can't honestly become the
 * column's type (bad JSON, non-array for an array column). */
export function stageCellDraft(a: {
  stmtIndex: number;
  row: number;
  col: number;
  draft: string;
  typeName: string | undefined;
  original: string | null;
}): string | null {
  const isJson = a.typeName === "json" || a.typeName === "jsonb";
  const isArr = isArrayType(a.typeName);
  let value = a.draft;
  if (isJson || isArr) {
    try {
      const parsed = JSON.parse(a.draft);
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
    stmtIndex: a.stmtIndex,
    row: a.row,
    col: a.col,
    value,
    original: a.original,
  });
  return null;
}

export function ValuePop({
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
