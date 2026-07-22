import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Code,
  Copy,
  ListTree,
  Lock,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import * as ipc from "../ipc/commands";
import { buildEditMapHint } from "../lib/editHints";
import { copyCue } from "../lib/copyCue";
import { ctidGuardPairs, editKey, useEdits } from "../stores/edits";
import { useInspector } from "../stores/inspector";
import { useResults } from "../stores/results";
import { useSchema } from "../stores/schema";
import { JsonTree } from "./JsonTree";
import { JsonField } from "./JsonField";
import { isArrayType, jsToPgArray } from "./format";
import { parsedCell } from "./parseCache";
import "./inspector.css";

/** copy button: click copies formatted; the caret opens raw / formatted */
function CopySplit({ raw, pretty }: { raw: string; pretty: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="insp-copy">
      <button className="insp-tool insp-copy-main" title="Copy formatted" onClick={() => void copyCue(pretty)}>
        <Copy size={14} />
      </button>
      <button className="insp-tool insp-copy-caret" title="Copy options" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={11} />
      </button>
      {open && <div className="insp-copy-backdrop" onMouseDown={() => setOpen(false)} />}
      {open && (
        <div className="insp-copy-menu">
          <button onClick={() => { void copyCue(pretty); setOpen(false); }}>Copy Formatted</button>
          <button onClick={() => { void copyCue(raw); setOpen(false); }}>Copy Raw</button>
        </div>
      )}
    </div>
  );
}

export function Inspector() {
  const target = useInspector((s) => s.target);
  const fullValue = useInspector((s) => s.fullValue);
  const fullValueFor = useInspector((s) => s.fullValueFor);
  const fullValueError = useInspector((s) => s.fullValueError);
  // hints yield below 280px. Boolean selector so rehydration and the resize
  // handler's threshold-cross writes re-render, everything else stays quiet
  const narrow = useInspector((s) => s.width < 280);

  const [mode, setMode] = useState<"auto" | "raw">("auto");
  const [editingText, setEditingText] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const editSeq = useInspector((s) => s.editSeq);

  // subscriptions are narrowed to THIS cell's slice (scalars / stable refs) —
  // subscribing to whole statements/pending re-rendered (and re-parsed) the
  // inspector on every streamed batch of an unrelated result
  const k = target ? editKey(target.stmtIndex, target.row, target.col) : null;
  const stmtExists = useResults((s) =>
    target ? s.statements.some((st) => st.index === target.stmtIndex) : false,
  );
  const colMeta = useResults((s) => {
    if (!target) return null;
    const st = s.statements.find((x) => x.index === target.stmtIndex);
    return st?.columns[target.col] ?? null;
  });
  const truncated = useResults((s) => {
    if (!target) return false;
    const st = s.statements.find((x) => x.index === target.stmtIndex);
    return st ? st.truncated.has(`${target.row}:${target.col}`) : false;
  });
  const dbCell = useResults((s) => {
    if (!target) return null;
    const st = s.statements.find((x) => x.index === target.stmtIndex);
    return st?.rows[target.row]?.[target.col] ?? null;
  });
  const pendingEdit = useEdits((s) => (k ? s.pending[k] : undefined));
  // a staged edit always wins over the fetched DB value — the inspector must
  // show what ⌘S will write, not what the DB still holds
  const value =
    pendingEdit !== undefined
      ? pendingEdit.value
      : truncated && fullValueFor === k
        ? fullValue
        : dbCell;
  // truncated cells may only be edited once the FULL value is here — staging
  // the 8KB prefix and committing it would destroy everything past the cap
  const fullLoaded = !truncated || fullValueFor === k || pendingEdit !== undefined;

  const editMap = useEdits((s) => (target ? s.maps[target.stmtIndex] : undefined));
  const editMeta =
    editMap && editMap !== "loading" && editMap !== "unavailable" && target
      ? editMap.columns[target.col]
      : undefined;

  // full-value fetch retry: bumping the seq re-fires the fetch effect. One
  // automatic retry ~1.5s after the FIRST failure (transient tunnel blips),
  // then the chip's Retry button — never an automatic loop.
  const [retrySeq, setRetrySeq] = useState(0);
  const autoRetried = useRef(false);

  useEffect(() => {
    if (!truncated || !target || fullValueFor === k) return;
    if (!editMap || editMap === "loading" || editMap === "unavailable") return;
    const meta = editMap.columns[target.col];
    if (!meta || meta.table_oid === 0) return;
    const pkCols = editMap.pk_cols[meta.table_oid];
    if (!pkCols?.length) return;
    const res = useResults.getState();
    const stmt = res.statements.find((x) => x.index === target.stmtIndex);
    if (!stmt) return;
    const sessionId = res.executedSessionId;
    const sql = res.executedSql;
    if (!sessionId || !sql) return;
    // server-side SQL generation (fetch_cell): real column names via the map
    // (result aliases don't leak into the WHERE), proper ident quoting,
    // dot-safe table identity; zero catalog trips with a warm mapping
    const locator: [number, string | null][] = pkCols.map((pc) => [
      pc,
      stmt.rows[target.row]?.[pc] ?? null,
    ]);
    // ctid rows move under UPDATE/VACUUM FULL — AND in the same old-value
    // guard as edits so a moved row shows matched ≠ 1, never a wrong value
    if (editMap.columns[pkCols[0]]?.is_ctid) {
      locator.push(...ctidGuardPairs(editMap, meta.table_oid, stmt, target.row));
    }
    const snap = res.executedProfileId
      ? useSchema.getState().snapshots[res.executedProfileId]
      : undefined;
    const hint = buildEditMapHint(editMap, snap);
    let stale = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    ipc
      .fetchCell(sessionId, sql, target.stmtIndex, target.col, locator, hint)
      .then((v) => {
        if (!stale && k) useInspector.getState().setFullValue(k, v);
      })
      .catch((e) => {
        if (stale) return;
        useInspector
          .getState()
          .setFullValueError((e as { message?: string }).message ?? String(e));
        if (!autoRetried.current) {
          autoRetried.current = true;
          retryTimer = setTimeout(() => setRetrySeq((s) => s + 1), 1500);
        }
      });
    return () => {
      stale = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [truncated, target, editMap, k, fullValueFor, retrySeq]);

  // raw-mode JSON validation is debounced (150ms) — a full parse of a multi-MB
  // doc per keystroke froze typing. Validation-only: staging still re-parses.
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearValidateTimer = () => {
    if (validateTimer.current !== null) {
      clearTimeout(validateTimer.current);
      validateTimer.current = null;
    }
  };
  useEffect(() => clearValidateTimer, []);

  // reset edit state when the focused cell changes
  const wantEdit = useRef(false);
  useEffect(() => {
    setEditingText(null);
    setRawDraft(null);
    setJsonError(null);
    setMode("auto");
    wantEdit.current = false;
    // retrySeq is a monotonic effect trigger — resetting it would double-fire
    // the fetch on cell change; only the one-auto-retry latch resets per cell
    autoRetried.current = false;
    clearValidateTimer();
  }, [k]);

  // grid double-click on a structured/truncated cell lands here ready to edit;
  // for a still-loading truncated cell, remember the intent and enter edit
  // when the full value arrives
  useEffect(() => {
    if (editSeq === 0 || value == null) return;
    if (!fullLoaded) {
      wantEdit.current = true;
      return;
    }
    if (parsedCell(value, editMeta?.type_name).structured !== undefined) setMode("raw");
    else setEditingText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSeq]);
  useEffect(() => {
    if (!fullLoaded || !wantEdit.current || value == null) return;
    wantEdit.current = false;
    if (parsedCell(value, editMeta?.type_name).structured !== undefined) setMode("raw");
    else setEditingText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullLoaded]);

  // scalar editor auto-grows to its content (one line for an int, more for prose)
  // so it never balloons to the full panel height
  const growTextarea = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 38), window.innerHeight * 0.4)}px`;
  };
  useLayoutEffect(() => {
    if (editingText !== null) growTextarea();
  }, [editingText !== null]);

  if (!target || !stmtExists) {
    return (
      <div className={`inspector${narrow ? " narrow" : ""}`}>
        <div className="insp-top">
          <span className="insp-col muted">Inspector</span>
        </div>
        <div className="insp-empty">Select a cell to inspect</div>
      </div>
    );
  }

  // parse + pretty + lossy-number detection come from the bounded LRU
  // (parseCache.ts) — O(1) on re-render instead of re-parsing the full cell
  const parsed = value != null ? parsedCell(value, editMeta?.type_name) : undefined;
  const structured = parsed?.structured;
  const isStructured = structured !== undefined;
  const lossyNums = parsed?.lossyNums ?? false;
  const pretty = parsed?.pretty ?? (value ?? "");
  const isArr = isArrayType(editMeta?.type_name);
  const canEdit = !!editMeta?.editable && fullLoaded;
  // `json` (not jsonb) preserves exact text — tree edits re-serialize the doc
  // (minify, key reorder), so json columns edit through raw mode only
  const structuredEditable =
    canEdit && isStructured && !lossyNums && editMeta?.type_name !== "json";

  const stage = (v: string) => {
    const st = useResults
      .getState()
      .statements.find((x) => x.index === target.stmtIndex);
    useEdits.getState().setEdit({
      stmtIndex: target.stmtIndex,
      row: target.row,
      col: target.col,
      value: v,
      original: st?.rows[target.row]?.[target.col] ?? null,
    });
  };
  // arrays stage as a PG array literal; JSON stages as JSON text
  const serialize = (v: unknown) => (isArr ? jsToPgArray(v) : JSON.stringify(v));

  const rawDirty = rawDraft !== null && rawDraft !== pretty;
  const saveRaw = () => {
    if (rawDraft === null) return;
    try {
      const parsed = JSON.parse(rawDraft);
      if (isArr) {
        if (!Array.isArray(parsed)) {
          setJsonError("this column is a Postgres array — provide a JSON array [ … ]");
          return;
        }
        stage(jsToPgArray(parsed));
      } else {
        // stage the raw text VERBATIM — parse is validation only. A
        // parse→re-serialize round trip would minify `json` columns and
        // silently round >2^53 numbers the user never touched.
        stage(rawDraft);
      }
      clearValidateTimer();
      setRawDraft(null);
      setJsonError(null);
    } catch (e) {
      clearValidateTimer();
      setJsonError((e as Error).message);
    }
  };

  return (
    <div className={`inspector${narrow ? " narrow" : ""}`}>
      <div className="insp-top">
        <div className="insp-id">
          <span className="insp-col" title={colMeta?.name ?? `col ${target.col}`}>
            {colMeta?.name ?? `col ${target.col}`}
          </span>
          {editMeta && <span className="insp-type">{editMeta.type_name}</span>}
        </div>
        <span className="insp-rownum">source row {target.row + 1}</span>
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
          <Pencil size={12} /> Pending edit{pendingEdit.useDefault ? " · SET DEFAULT" : ""} — ⌘S to
          commit
        </div>
      )}
      {truncated && !fullLoaded && (
        <div className={`insp-chip${fullValueError ? " ro" : ""}`}>
          {fullValueError ? (
            <>
              full value fetch failed: {fullValueError}
              <button className="insp-chip-retry" onClick={() => setRetrySeq((s) => s + 1)}>
                Retry
              </button>
            </>
          ) : editMap === "unavailable" || (editMeta && editMeta.table_oid === 0) ? (
            "showing first 8KB — full value unavailable · result not mapped to a table"
          ) : (
            "Loading full value… editing disabled until loaded"
          )}
        </div>
      )}
      {lossyNums && (
        <div className="insp-chip warn">
          <TriangleAlert size={12} /> numbers beyond JS precision — tree editing off, use raw mode
        </div>
      )}

      {editingText === null && value != null && (
        <div className="insp-tools">
          {truncated && !fullLoaded ? (
            // copying now would ship the 8KB prefix as if it were the value
            <button
              className="insp-tool"
              disabled
              title="Copy disabled — only the first 8KB is loaded (full value unavailable for this result)"
            >
              <Copy size={14} />
            </button>
          ) : isStructured ? (
            <>
              <CopySplit raw={value} pretty={pretty} />
              <button
                className="insp-tool"
                title={mode === "auto" ? "Raw JSON" : "Tree"}
                onClick={() => setMode(mode === "auto" ? "raw" : "auto")}
              >
                {mode === "auto" ? <Code size={14} /> : <ListTree size={14} />}
              </button>
              {mode === "raw" && rawDirty && (
                <div className="insp-editactions insp-tools-actions">
                  <button
                    onClick={() => {
                      clearValidateTimer();
                      setRawDraft(null);
                      setJsonError(null);
                    }}
                  >
                    Discard <span className="insp-key">esc</span>
                  </button>
                  <button className="primary" disabled={!!jsonError} onClick={saveRaw}>
                    Stage Edit <span className="insp-key">⌘↵</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <button className="insp-tool" title="Copy" onClick={() => void copyCue(value)}>
                <Copy size={14} />
              </button>
              {canEdit && (
                <button className="insp-tool" title="Edit value" onClick={() => setEditingText(value)}>
                  <Pencil size={14} />
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div
        className={`insp-body${
          editingText === null && value != null && isStructured && mode === "raw" ? " raw-fill" : ""
        }`}
      >
        {editingText !== null ? (
          <div className="insp-edit scalar">
            <textarea
              ref={taRef}
              value={editingText}
              onChange={(e) => {
                setEditingText(e.target.value);
                growTextarea();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  // ⌘↵ is also the Run accelerator — claim it or staging
                  // could ALSO run the active statement
                  e.preventDefault();
                  const shell = e.currentTarget.closest(".inspector-fixed") as HTMLElement | null;
                  stage(editingText);
                  setEditingText(null);
                  if (shell) requestAnimationFrame(() => shell.focus({ preventScroll: true }));
                } else if (e.key === "Escape") {
                  // refocus the shell, not body — ⌘F must keep inspector scope
                  const shell = e.currentTarget.closest(".inspector-fixed") as HTMLElement | null;
                  setEditingText(null);
                  if (shell) requestAnimationFrame(() => shell.focus({ preventScroll: true }));
                }
              }}
              spellCheck={false}
              autoFocus
            />
            <div className="insp-editactions">
              <button onClick={() => setEditingText(null)}>
                Cancel <span className="insp-key">esc</span>
              </button>
              <button
                className="primary"
                onClick={() => {
                  stage(editingText);
                  setEditingText(null);
                }}
              >
                Stage Edit <span className="insp-key">⌘↵</span>
              </button>
            </div>
          </div>
        ) : value === null || value === undefined ? (
          <div className="insp-null">
            {pendingEdit?.useDefault ? "DEFAULT" : "NULL"}
            {editMeta?.editable && (
              <button className="insp-null-edit" onClick={() => setEditingText("")}>
                Set Value
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
                clearValidateTimer();
                validateTimer.current = setTimeout(() => {
                  validateTimer.current = null;
                  try {
                    JSON.parse(v);
                    setJsonError(null);
                  } catch (err) {
                    setJsonError((err as Error).message);
                  }
                }, 150);
              }}
              onSave={saveRaw}
              onCancel={() => {
                clearValidateTimer();
                setRawDraft(null);
                setJsonError(null);
              }}
            />
            {jsonError && rawDirty && <div className="insp-jsonerror">{jsonError}</div>}
          </div>
        ) : (
          <div
            className={`insp-value${canEdit ? " editable" : ""}`}
            title={canEdit ? "Double-click to edit" : undefined}
            onDoubleClick={() => canEdit && setEditingText(value)}
          >
            {value}
          </div>
        )}
      </div>
    </div>
  );
}
