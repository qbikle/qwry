import { useEffect, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "../ipc/commands";
import { editKey, useEdits } from "../stores/edits";
import { useInspector } from "../stores/inspector";
import { useResults } from "../stores/results";
import { JsonTree } from "./JsonTree";
import "./inspector.css";

function tryParseJson(v: string): unknown | undefined {
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function HideButton() {
  const toggle = useInspector((s) => s.toggle);
  return (
    <button className="insp-hide" title="Hide inspector ⌘I" onClick={toggle}>
      <PanelRightClose size={14} />
    </button>
  );
}

export function Inspector() {
  const target = useInspector((s) => s.target);
  const fullValue = useInspector((s) => s.fullValue);
  const fullValueFor = useInspector((s) => s.fullValueFor);
  const statements = useResults((s) => s.statements);
  const pending = useEdits((s) => s.pending);
  const maps = useEdits((s) => s.maps);

  const [mode, setMode] = useState<"auto" | "raw">("auto");
  const [editingJson, setEditingJson] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const editSeq = useInspector((s) => s.editSeq);

  const stmt = target ? statements.find((s) => s.index === target.stmtIndex) : null;
  const colMeta = target && stmt ? stmt.columns[target.col] : null;

  const k = target ? editKey(target.stmtIndex, target.row, target.col) : null;
  const pendingEdit = k ? pending[k] : undefined;

  const truncated =
    target && stmt ? stmt.truncated.has(`${target.row}:${target.col}`) : false;

  const rawCell =
    target && stmt ? (pendingEdit ? pendingEdit.value : stmt.rows[target.row]?.[target.col]) : null;
  const value = truncated && fullValueFor === k ? fullValue : rawCell;

  const editMap = target ? maps[target.stmtIndex] : undefined;
  const editMeta =
    editMap && editMap !== "loading" && editMap !== "unavailable" && target
      ? editMap.columns[target.col]
      : undefined;

  // fetch full value for truncated cells when the PK is available
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

  useEffect(() => {
    setEditingJson(null);
    setEditingText(null);
    setJsonError(null);
  }, [k]);

  // grid double-click on a JSON cell lands here in edit mode
  useEffect(() => {
    if (editSeq === 0 || value == null) return;
    const p = tryParseJson(value);
    if (p !== undefined) {
      setEditingJson(JSON.stringify(p, null, 2));
      setJsonError(null);
    } else {
      setEditingText(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSeq]);

  if (!target || !stmt) {
    return (
      <div className="inspector">
        <HideButton />
        <div className="insp-empty">Select a cell to inspect</div>
      </div>
    );
  }

  // parse regardless of mode — buttons must survive Raw mode
  const parsed = value != null ? tryParseJson(value) : undefined;
  const json = mode === "auto" ? parsed : undefined;

  const saveJsonEdit = () => {
    if (editingJson === null) return;
    try {
      const normalized = JSON.stringify(JSON.parse(editingJson));
      useEdits.getState().setEdit({
        stmtIndex: target.stmtIndex,
        row: target.row,
        col: target.col,
        value: normalized,
        original: stmt.rows[target.row]?.[target.col] ?? null,
      });
      setEditingJson(null);
      setJsonError(null);
    } catch (e) {
      setJsonError((e as Error).message);
    }
  };

  // live tree edits (edit a leaf/key in the tree) stage immediately
  const stageTreeEdit = (next: unknown) => {
    useEdits.getState().setEdit({
      stmtIndex: target.stmtIndex,
      row: target.row,
      col: target.col,
      value: JSON.stringify(next),
      original: stmt.rows[target.row]?.[target.col] ?? null,
    });
  };

  return (
    <div className="inspector">
      <HideButton />
      <div className="insp-header">
        <span className="insp-col">{colMeta?.name ?? `col ${target.col}`}</span>
        <span className="insp-meta">
          row {target.row + 1}
          {editMeta && ` · ${editMeta.type_name}`}
          {truncated && fullValueFor !== k && " · loading full value…"}
        </span>
      </div>

      {editMeta && !editMeta.editable && editMeta.reason && (
        <div className="insp-readonly">{editMeta.reason}</div>
      )}
      {editMeta?.editable && editMeta.warn && (
        <div className="insp-warn">⚠ {editMeta.warn}</div>
      )}
      {pendingEdit && <div className="insp-pending">✎ pending edit shown — ⌘S to commit</div>}

      <div className="insp-actions">
        <button onClick={() => value != null && void writeText(value)}>Copy</button>
        {parsed !== undefined && (
          <button
            onClick={() =>
              value != null && void writeText(JSON.stringify(JSON.parse(value), null, 2))
            }
          >
            Copy pretty
          </button>
        )}
        {parsed !== undefined && (
          <button onClick={() => setMode(mode === "auto" ? "raw" : "auto")}>
            {mode === "auto" ? "Raw" : "Tree"}
          </button>
        )}
        {parsed !== undefined && editMeta?.editable && editingJson === null && (
          <button onClick={() => setEditingJson(JSON.stringify(JSON.parse(value!), null, 2))}>
            Edit JSON
          </button>
        )}
        {parsed === undefined && editMeta?.editable && editingText === null && (
          <button onClick={() => setEditingText(value ?? "")}>Edit</button>
        )}
      </div>

      <div className="insp-body">
        {editingText !== null ? (
          <div className="insp-jsonedit">
            <textarea
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              spellCheck={false}
            />
            <div className="insp-jsonactions">
              <button onClick={() => setEditingText(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  useEdits.getState().setEdit({
                    stmtIndex: target.stmtIndex,
                    row: target.row,
                    col: target.col,
                    value: editingText,
                    original: stmt.rows[target.row]?.[target.col] ?? null,
                  });
                  setEditingText(null);
                }}
              >
                Stage edit
              </button>
            </div>
          </div>
        ) : editingJson !== null ? (
          <div className="insp-jsonedit">
            <textarea
              value={editingJson}
              onChange={(e) => {
                setEditingJson(e.target.value);
                try {
                  JSON.parse(e.target.value);
                  setJsonError(null);
                } catch (err) {
                  setJsonError((err as Error).message);
                }
              }}
              spellCheck={false}
            />
            {jsonError && <div className="insp-jsonerror">{jsonError}</div>}
            <div className="insp-jsonactions">
              <button onClick={() => setEditingJson(null)}>Cancel</button>
              <button className="primary" disabled={!!jsonError} onClick={saveJsonEdit}>
                Stage edit
              </button>
            </div>
          </div>
        ) : value === null || value === undefined ? (
          <div className="insp-null">NULL</div>
        ) : json !== undefined ? (
          <JsonTree
            json={json as never}
            editable={!!editMeta?.editable}
            onChange={stageTreeEdit}
          />
        ) : (
          <pre className="insp-text">{value}</pre>
        )}
      </div>
    </div>
  );
}
