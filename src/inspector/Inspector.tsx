import { useEffect, useState } from "react";
import {
  ChevronDown,
  Code,
  Copy,
  ListTree,
  Lock,
  PanelRightClose,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "../ipc/commands";
import { editKey, useEdits } from "../stores/edits";
import { useInspector } from "../stores/inspector";
import { useResults } from "../stores/results";
import { JsonTree } from "./JsonTree";
import { JsonField } from "./JsonField";
import { isArrayType, jsToPgArray, structuredValue } from "./format";
import "./inspector.css";

/** copy button: click copies formatted; the caret opens raw / formatted */
function CopySplit({ raw, pretty }: { raw: string; pretty: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="insp-copy">
      <button className="insp-tool insp-copy-main" title="Copy formatted" onClick={() => void writeText(pretty)}>
        <Copy size={14} />
      </button>
      <button className="insp-tool insp-copy-caret" title="Copy options" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={11} />
      </button>
      {open && <div className="insp-copy-backdrop" onMouseDown={() => setOpen(false)} />}
      {open && (
        <div className="insp-copy-menu">
          <button onClick={() => { void writeText(pretty); setOpen(false); }}>Copy formatted</button>
          <button onClick={() => { void writeText(raw); setOpen(false); }}>Copy raw</button>
        </div>
      )}
    </div>
  );
}

export function Inspector() {
  const target = useInspector((s) => s.target);
  const toggle = useInspector((s) => s.toggle);
  const fullValue = useInspector((s) => s.fullValue);
  const fullValueFor = useInspector((s) => s.fullValueFor);
  const statements = useResults((s) => s.statements);
  const pending = useEdits((s) => s.pending);
  const maps = useEdits((s) => s.maps);

  const [mode, setMode] = useState<"auto" | "raw">("auto");
  const [editingText, setEditingText] = useState<string | null>(null);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const editSeq = useInspector((s) => s.editSeq);

  const stmt = target ? statements.find((s) => s.index === target.stmtIndex) : null;
  const colMeta = target && stmt ? stmt.columns[target.col] : null;

  const k = target ? editKey(target.stmtIndex, target.row, target.col) : null;
  const pendingEdit = k ? pending[k] : undefined;
  const truncated = target && stmt ? stmt.truncated.has(`${target.row}:${target.col}`) : false;
  const rawCell =
    target && stmt ? (pendingEdit ? pendingEdit.value : stmt.rows[target.row]?.[target.col]) : null;
  const value = truncated && fullValueFor === k ? fullValue : rawCell;

  const editMap = target ? maps[target.stmtIndex] : undefined;
  const editMeta =
    editMap && editMap !== "loading" && editMap !== "unavailable" && target
      ? editMap.columns[target.col]
      : undefined;

  useEffect(() => {
    if (!truncated || !target || !stmt || fullValueFor === k) return;
    if (!editMap || editMap === "loading" || editMap === "unavailable") return;
    const meta = editMap.columns[target.col];
    if (!meta || meta.table_oid === 0) return;
    const pkCols = editMap.pk_cols[meta.table_oid];
    const table = editMap.tables[meta.table_oid];
    if (!pkCols || !table) return;
    const sessionId = useResults.getState().executedSessionId;
    if (!sessionId) return;
    const colName = stmt.columns[target.col].name;
    const wheres = pkCols
      .map((pc) => {
        const pkName = stmt.columns[pc].name;
        const pv = stmt.rows[target.row]?.[pc];
        return pv === null || pv === undefined
          ? `"${pkName}" IS NULL`
          : `"${pkName}" = '${pv.replace(/'/g, "''")}'`;
      })
      .join(" AND ");
    const [schema, name] = table.split(".");
    const q = `SELECT "${colName}"::text FROM "${schema}"."${name}" WHERE ${wheres} LIMIT 1`;
    void ipc.execute(sessionId, q).then((out) => {
      const v = out.statements[0]?.rows[0]?.[0] ?? null;
      if (k) useInspector.getState().setFullValue(k, v);
    });
  }, [truncated, target, stmt, editMap, k, fullValueFor]);

  // reset edit state when the focused cell changes
  useEffect(() => {
    setEditingText(null);
    setRawDraft(null);
    setJsonError(null);
    setMode("auto");
  }, [k]);

  // grid double-click on a structured cell lands here ready to edit
  useEffect(() => {
    if (editSeq === 0 || value == null) return;
    if (structuredValue(value, editMeta?.type_name) !== undefined) setMode("raw");
    else setEditingText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSeq]);

  if (!target || !stmt) {
    return (
      <div className="inspector">
        <div className="insp-top">
          <span className="insp-col muted">Inspector</span>
          <button className="insp-icon" title="Hide ⌘I" onClick={toggle}>
            <PanelRightClose size={15} />
          </button>
        </div>
        <div className="insp-empty">Select a cell to inspect</div>
      </div>
    );
  }

  const structured = value != null ? structuredValue(value, editMeta?.type_name) : undefined;
  const isStructured = structured !== undefined;
  const pretty = isStructured ? JSON.stringify(structured, null, 2) : (value ?? "");
  const isArr = isArrayType(editMeta?.type_name);
  const structuredEditable = !!editMeta?.editable && isStructured;

  const stage = (v: string) =>
    useEdits.getState().setEdit({
      stmtIndex: target.stmtIndex,
      row: target.row,
      col: target.col,
      value: v,
      original: stmt.rows[target.row]?.[target.col] ?? null,
    });
  // arrays stage as a PG array literal; JSON stages as JSON text
  const serialize = (v: unknown) => (isArr ? jsToPgArray(v) : JSON.stringify(v));

  const rawDirty = rawDraft !== null && rawDraft !== pretty;
  const saveRaw = () => {
    if (rawDraft === null) return;
    try {
      stage(serialize(JSON.parse(rawDraft)));
      setRawDraft(null);
      setJsonError(null);
    } catch (e) {
      setJsonError((e as Error).message);
    }
  };

  return (
    <div className="inspector">
      <div className="insp-top">
        <div className="insp-id">
          <span className="insp-col" title={colMeta?.name ?? `col ${target.col}`}>
            {colMeta?.name ?? `col ${target.col}`}
          </span>
          {editMeta && <span className="insp-type">{editMeta.type_name}</span>}
        </div>
        <span className="insp-rownum">row {target.row + 1}</span>
        <button className="insp-icon" title="Hide ⌘I" onClick={toggle}>
          <PanelRightClose size={15} />
        </button>
      </div>

      {editMeta && !editMeta.editable && editMeta.reason && (
        <div className="insp-chip ro">
          <Lock size={12} /> {editMeta.reason}
        </div>
      )}
      {editMeta?.editable && editMeta.warn && (
        <div className="insp-chip warn">
          <TriangleAlert size={12} /> {editMeta.warn}
        </div>
      )}
      {pendingEdit && (
        <div className="insp-chip pend">
          <Pencil size={12} /> Pending edit — ⌘S to commit
        </div>
      )}
      {truncated && fullValueFor !== k && <div className="insp-chip">Loading full value…</div>}

      {editingText === null && value != null && (
        <div className="insp-tools">
          {isStructured ? (
            <>
              <CopySplit raw={value} pretty={pretty} />
              <button
                className="insp-tool"
                title={mode === "auto" ? "Raw JSON" : "Tree"}
                onClick={() => setMode(mode === "auto" ? "raw" : "auto")}
              >
                {mode === "auto" ? <Code size={14} /> : <ListTree size={14} />}
              </button>
            </>
          ) : (
            <>
              <button className="insp-tool" title="Copy" onClick={() => void writeText(value)}>
                <Copy size={14} />
              </button>
              {editMeta?.editable && (
                <button className="insp-tool" title="Edit value" onClick={() => setEditingText(value)}>
                  <Pencil size={14} />
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="insp-body">
        {editingText !== null ? (
          <div className="insp-edit">
            <textarea
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  stage(editingText);
                  setEditingText(null);
                } else if (e.key === "Escape") {
                  setEditingText(null);
                }
              }}
              spellCheck={false}
            />
            <div className="insp-editactions">
              <button onClick={() => setEditingText(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  stage(editingText);
                  setEditingText(null);
                }}
              >
                Stage edit
              </button>
            </div>
          </div>
        ) : value === null || value === undefined ? (
          <div className="insp-null">
            NULL
            {editMeta?.editable && (
              <button className="insp-null-edit" onClick={() => setEditingText("")}>
                set value
              </button>
            )}
          </div>
        ) : isStructured && mode === "auto" ? (
          <JsonTree json={structured as never} editable={structuredEditable} onChange={(n) => stage(serialize(n))} />
        ) : isStructured ? (
          <div className="insp-edit">
            <JsonField
              value={rawDraft ?? pretty}
              readOnly={!structuredEditable}
              onChange={(v) => {
                setRawDraft(v);
                try {
                  JSON.parse(v);
                  setJsonError(null);
                } catch (err) {
                  setJsonError((err as Error).message);
                }
              }}
              onSave={saveRaw}
              onCancel={() => {
                setRawDraft(null);
                setJsonError(null);
              }}
            />
            {jsonError && rawDirty && <div className="insp-jsonerror">{jsonError}</div>}
            {rawDirty && (
              <div className="insp-editactions">
                <button onClick={() => { setRawDraft(null); setJsonError(null); }}>Discard</button>
                <button className="primary" disabled={!!jsonError} onClick={saveRaw}>
                  Stage edit
                </button>
              </div>
            )}
          </div>
        ) : (
          <pre className="insp-text">{value}</pre>
        )}
      </div>
    </div>
  );
}
