import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
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
import { useRefresh } from "../stores/refresh";
import { humanSessionError, withLiveSession } from "../stores/liveSession";
import { useResults } from "../stores/results";
import { useSchema } from "../stores/schema";
import { Kbd } from "../design/Kbd";
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
      <button
        className="iconbtn iconbtn-lg bordered insp-copy-main"
        title="Copy formatted"
        onClick={() => void copyCue(pretty)}
      >
        <Copy size={14} />
      </button>
      <button
        className="iconbtn iconbtn-lg bordered insp-copy-caret"
        title="Copy options"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={12} />
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
  // the inspector shows a cell of the result the main body is refetching, so
  // it follows that body's landing rather than keeping its own clock (E2 R3);
  // the store starts it on its own reach and the value it shows is re-aimed
  // at the same row by the swap (R4)
  const cycling = useRefresh((s) => !!s.cycling.inspector);
  const bodyRef = useRef<HTMLDivElement>(null);
  // R3's same geometry, measured rather than described: the bars stand on the
  // lines the value stood on, and the value is still on screen (fading) in
  // the commit the cycle begins on
  const skel = useSkeletonBox(bodyRef, cycling);

  const [mode, setMode] = useState<"auto" | "raw">("auto");
  const [editingText, setEditingText] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // the raw-mode JsonField's live CM view: non-null EXACTLY while raw mode
  // shows a searchable field, which is the whole mode gate for the ⌘F claim
  const rawViewRef = useRef<EditorView | null>(null);
  // ⌘F in raw mode: JsonTree (which owns the tree-mode claim) is unmounted
  // here, so the shell mirrors its exact gates: open inspector, focus
  // within the panel, nobody upstream claimed the event. When the CM itself
  // has focus its own searchKeymap handles ⌘F first (defaultPrevented).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey && !e.shiftKey && e.key.toLowerCase() === "f")) return;
      const view = rawViewRef.current;
      if (!view) return;
      if (!useInspector.getState().open) return;
      const within = (el: unknown) =>
        el instanceof Element && !!el.closest(".inspector-fixed");
      if (!within(e.target) && !within(document.activeElement)) return;
      e.preventDefault();
      openSearchPanel(view);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const editSeq = useInspector((s) => s.editSeq);

  // subscriptions are narrowed to THIS cell's slice (scalars / stable refs):
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
  // a staged edit always wins over the fetched DB value: the inspector must
  // show what ⌘S will write, not what the DB still holds
  const value =
    pendingEdit !== undefined
      ? pendingEdit.value
      : truncated && fullValueFor === k
        ? fullValue
        : dbCell;
  // truncated cells may only be edited once the FULL value is here: staging
  // the 8KB prefix and committing it would destroy everything past the cap
  const fullLoaded = !truncated || fullValueFor === k || pendingEdit !== undefined;

  const editMap = useEdits((s) => (target ? s.maps[target.stmtIndex] : undefined));
  const editMeta =
    editMap && editMap !== "loading" && editMap !== "unavailable" && target
      ? editMap.columns[target.col]
      : undefined;

  // full-value fetch retry: bumping the seq re-fires the fetch effect. One
  // automatic retry ~1.5s after the FIRST failure (transient tunnel blips),
  // then the chip's Retry button, never an automatic loop.
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
    const tabId = res.active;
    const sql = res.executedSql;
    if (!tabId || !sql) return;
    // server-side SQL generation (fetch_cell): real column names via the map
    // (result aliases don't leak into the WHERE), proper ident quoting,
    // dot-safe table identity; zero catalog trips with a warm mapping
    const locator: [number, string | null][] = pkCols.map((pc) => [
      pc,
      stmt.rows[target.row]?.[pc] ?? null,
    ]);
    // ctid rows move under UPDATE/VACUUM FULL: AND in the same old-value
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
    void withLiveSession(tabId, (sid) =>
      ipc.fetchCell(sid, sql, target.stmtIndex, target.col, locator, hint),
    )
      .then((v) => {
        if (!stale && k) useInspector.getState().setFullValue(k, v);
      })
      .catch((e) => {
        if (stale) return;
        useInspector.getState().setFullValueError(humanSessionError(e).message);
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

  // raw-mode JSON validation is debounced (150ms): a full parse of a multi-MB
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
    // retrySeq is a monotonic effect trigger: resetting it would double-fire
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
      <div
        className={`inspector${narrow ? " narrow" : ""}`}
        data-refresh-surface="inspector"
      >
        <div className="insp-top">
          <span className="insp-col muted">Inspector</span>
        </div>
        <div className="insp-empty">
          <span className="insp-empty-hint">
            <Kbd chord="cmd+i" caps /> toggles this panel
          </span>
          <span>Select a cell to inspect</span>
        </div>
      </div>
    );
  }

  // parse + pretty + lossy-number detection come from the bounded LRU
  // (parseCache.ts): O(1) on re-render instead of re-parsing the full cell
  const parsed = value != null ? parsedCell(value, editMeta?.type_name) : undefined;
  const structured = parsed?.structured;
  const isStructured = structured !== undefined;
  const lossyNums = parsed?.lossyNums ?? false;
  const pretty = parsed?.pretty ?? (value ?? "");
  const isArr = isArrayType(editMeta?.type_name);
  const canEdit = !!editMeta?.editable && fullLoaded;
  // `json` (not jsonb) preserves exact text: tree edits re-serialize the doc
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
          setJsonError("this column is a Postgres array. Provide a JSON array [ … ]");
          return;
        }
        stage(jsToPgArray(parsed));
      } else {
        // stage the raw text VERBATIM: parse is validation only. A
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
    <div
      className={`inspector${narrow ? " narrow" : ""}${cycling ? " cycling" : ""}`}
      data-refresh-surface="inspector"
    >
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
          <Pencil size={12} /> Pending edit{pendingEdit.useDefault ? " · SET DEFAULT" : ""} · ⌘S to
          commit
        </div>
      )}
      {truncated && !fullLoaded && (
        <div className={`insp-chip${fullValueError ? " ro" : ""}`}>
          {fullValueError ? (
            <>
              full value fetch failed: {fullValueError}
              <button className="linkish insp-chip-retry" onClick={() => setRetrySeq((s) => s + 1)}>
                Retry
              </button>
            </>
          ) : editMap === "unavailable" || (editMeta && editMeta.table_oid === 0) ? (
            "showing first 8KB · full value unavailable · result not mapped to a table"
          ) : (
            "Loading full value… editing disabled until loaded"
          )}
        </div>
      )}
      {lossyNums && (
        <div className="insp-chip warn">
          <TriangleAlert size={12} /> numbers beyond JS precision · tree editing off, use raw mode
        </div>
      )}

      {editingText === null && value != null && (
        <div className="insp-tools">
          {truncated && !fullLoaded ? (
            // copying now would ship the 8KB prefix as if it were the value
            <button
              className="iconbtn iconbtn-lg bordered"
              disabled
              title="Copy disabled. Only the first 8KB is loaded (full value unavailable for this result)"
            >
              <Copy size={14} />
            </button>
          ) : isStructured ? (
            <>
              <CopySplit raw={value} pretty={pretty} />
              <button
                className="iconbtn iconbtn-lg bordered"
                title={mode === "auto" ? "Raw JSON" : "Tree"}
                onClick={() => setMode(mode === "auto" ? "raw" : "auto")}
              >
                {mode === "auto" ? <Code size={14} /> : <ListTree size={14} />}
              </button>
              {mode === "raw" && rawDirty && (
                <div className="insp-editactions insp-tools-actions">
                  <button
                    className="btnish"
                    onClick={() => {
                      clearValidateTimer();
                      setRawDraft(null);
                      setJsonError(null);
                    }}
                  >
                    Discard <Kbd chord="esc" />
                  </button>
                  <button className="btnish primary" disabled={!!jsonError} onClick={saveRaw}>
                    Stage Edit <Kbd chord="cmd+return" />
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <button
                className="iconbtn iconbtn-lg bordered"
                title="Copy"
                onClick={() => void copyCue(value)}
              >
                <Copy size={14} />
              </button>
              {canEdit && (
                <button
                  className="iconbtn iconbtn-lg bordered"
                  title="Edit value"
                  onClick={() => setEditingText(value)}
                >
                  <Pencil size={14} />
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div
        ref={bodyRef}
        className={`insp-body${
          editingText === null && value != null && isStructured && mode === "raw" ? " raw-fill" : ""
        }`}
        style={skel ?? undefined}
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
                  // ⌘↩ is also the Run accelerator: claim it or staging
                  // could ALSO run the active statement
                  e.preventDefault();
                  const shell = e.currentTarget.closest(".inspector-fixed") as HTMLElement | null;
                  stage(editingText);
                  setEditingText(null);
                  if (shell) requestAnimationFrame(() => shell.focus({ preventScroll: true }));
                } else if (e.key === "Escape") {
                  // refocus the shell, not body: ⌘F must keep inspector scope
                  const shell = e.currentTarget.closest(".inspector-fixed") as HTMLElement | null;
                  setEditingText(null);
                  if (shell) requestAnimationFrame(() => shell.focus({ preventScroll: true }));
                }
              }}
              spellCheck={false}
              autoFocus
            />
            <div className="insp-editactions">
              <button className="btnish" onClick={() => setEditingText(null)}>
                Cancel <Kbd chord="esc" />
              </button>
              <button
                className="btnish primary"
                onClick={() => {
                  stage(editingText);
                  setEditingText(null);
                }}
              >
                Stage Edit <Kbd chord="cmd+return" />
              </button>
            </div>
          </div>
        ) : value === null || value === undefined ? (
          <div className="insp-null">
            {pendingEdit?.useDefault ? "DEFAULT" : "NULL"}
            {editMeta?.editable && (
              <button className="btnish insp-null-edit" onClick={() => setEditingText("")}>
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
              searchable
              onView={(v) => {
                rawViewRef.current = v;
              }}
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
            onDoubleClick={() => canEdit && setEditingText(value)}
          >
            {value}
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the inspector's skeleton stands: the TEXT box of the value being
 * replaced — inside its card's border and padding — and the line rhythm that
 * text is set on. Read in a layout effect, so the bars paint in the same frame
 * the value starts fading, off the value itself rather than off a second
 * description of it (E2 R3, DESIGN rule 14). One line of mono gets one bar;
 * a seven-line JSON tree gets seven. Null when there is nothing to stand in
 * for, and the CSS then draws nothing rather than a pane of invented rows. */
function useSkeletonBox(
  ref: { current: HTMLElement | null },
  cycling: boolean,
): CSSProperties | null {
  const [box, setBox] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!cycling) return;
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el) {
      setBox(null);
      return;
    }
    const cs = getComputedStyle(el);
    const num = (v: string) => parseFloat(v) || 0;
    const w = el.clientWidth - num(cs.paddingLeft) - num(cs.paddingRight);
    const h = el.clientHeight - num(cs.paddingTop) - num(cs.paddingBottom);
    const line = num(cs.lineHeight) || 18;
    setBox(
      w > 0 && h > 0
        ? ({
            "--insp-skel-top": `${el.offsetTop + num(cs.borderTopWidth) + num(cs.paddingTop)}px`,
            "--insp-skel-left": `${el.offsetLeft + num(cs.borderLeftWidth) + num(cs.paddingLeft)}px`,
            "--insp-skel-w": `${w}px`,
            "--insp-skel-h": `${h}px`,
            "--skel-line-gap": `${line}px`,
          } as CSSProperties)
        : null,
    );
  }, [cycling, ref]);
  return cycling ? box : null;
}
