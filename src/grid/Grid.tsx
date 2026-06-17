// Virtualized results grid — rows and columns both windowed (DOM cells, P2).
// Perf checkpoint vs Glide Data Grid happens at the end of P2 (see ROADMAP).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { menuIn } from "../design/springs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useResults, type StatementState } from "../stores/results";
import { editKey, useEdits } from "../stores/edits";
import * as ipc from "../ipc/commands";
import type { EditabilityMap } from "../ipc/types";
import { formatCells, type CopyFormat } from "./clipboard";
import { useSelection, type DragMode, type SelRect } from "./useSelection";
import { typeIcon } from "./typeIcon";
import { useBrowser } from "../stores/browser";
import { Plus } from "lucide-react";
import "./grid.css";

/** registered by TableBrowser for infinite scroll; null in plain editor mode */
export const nearEndHook: { current: (() => void) | null } = { current: null };

const ROW_H = 26;
const HEADER_H = 30;
const DRAFT_H = 32;
const ROWNUM_W = 52;
const MIN_COL_W = 64;
const MAX_COL_W = 480;
const CHAR_W = 7.3; // SF Mono 12px approximation

function estimateWidths(st: StatementState): number[] {
  return st.columns.map((col, ci) => {
    let max = col.name.length;
    const sample = Math.min(st.rows.length, 100);
    for (let r = 0; r < sample; r++) {
      const v = st.rows[r][ci];
      if (v) max = Math.max(max, Math.min(v.length, 64));
    }
    return Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.round(max * CHAR_W + 24)));
  });
}

function CellEditor({
  x,
  y,
  width,
  draft,
  onDraft,
  onSave,
  onNull,
  onCancel,
}: {
  x: number;
  y: number;
  width: number;
  draft: string;
  onDraft: (d: string) => void;
  onSave: () => void;
  onNull: () => void;
  onCancel: () => void;
}) {
  // Esc must discard WITHOUT the unmount-blur saving the draft
  const cancelled = useRef(false);
  return (
    <div
      className="vgrid-celledit"
      style={{
        transform: `translate(${x + ROWNUM_W}px, ${y + HEADER_H}px)`,
        width: Math.max(width, 220),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          // never let grid-level handlers see editor keys (Enter would re-open)
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            onCancel();
          } else if (e.key === "Backspace" && e.metaKey && e.shiftKey) {
            e.preventDefault();
            cancelled.current = true; // onNull closes the editor; blur must not double-save
            onNull();
          }
        }}
        onBlur={() => {
          // click-outside = save; Esc/∅ already handled
          if (!cancelled.current) onSave();
        }}
      />
      <button
        className="vgrid-nullbtn"
        title="Set NULL (⌘⇧⌫)"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = true;
          onNull();
        }}
      >
        ∅
      </button>
    </div>
  );
}

export function Grid({
  statement,
  insertable = false,
}: {
  statement: StatementState;
  insertable?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const widthsInitialized = useRef(false);

  useEffect(() => {
    widthsInitialized.current = false;
  }, [statement.index, statement.columns]);

  useEffect(() => {
    if (!widthsInitialized.current && statement.rows.length > 0) {
      widthsInitialized.current = true;
      setWidths(estimateWidths(statement));
    }
  }, [statement]);

  const cols = statement.columns;
  const rows = statement.rows;
  const colWidths = useMemo(
    () => (widths.length === cols.length ? widths : cols.map(() => 120)),
    [widths, cols],
  );

  const rowVirt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const colVirt = useVirtualizer({
    horizontal: true,
    count: cols.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i],
    overscan: 4,
  });

  useEffect(() => {
    colVirt.measure();
  }, [colWidths, colVirt]);

  const sel = useSelection(rows.length, cols.length);

  // editability map fetched once the statement is done
  const editMap = useEdits((s) => s.maps[statement.index]);
  const pending = useEdits((s) => s.pending);
  const flash = useEdits((s) => s.flash);
  const ensureMap = useEdits((s) => s.ensureMap);
  useEffect(() => {
    if (statement.done && !statement.error) ensureMap(statement.index);
  }, [statement.done, statement.error, statement.index, ensureMap]);

  // pg type per result column (from the editability map; undefined until it loads)
  const colType = (i: number): string | undefined =>
    editMap && editMap !== "loading" && editMap !== "unavailable"
      ? editMap.columns[i]?.type_name
      : undefined;

  // inline new-row draft (table browser only)
  const draftRow = useBrowser((s) => s.draftRow);
  const draftError = useBrowser((s) => s.draftError);
  const setDraftCell = useBrowser((s) => s.setDraftCell);
  const commitDraft = useBrowser((s) => s.commitDraft);
  const cancelDraft = useBrowser((s) => s.cancelDraft);
  const showDraft = insertable && draftRow !== null;
  const draftH = showDraft ? DRAFT_H : 0;
  const firstDraftCol = cols.findIndex((c) => c.name !== "ctid");

  const [editing, setEditing] = useState<{ r: number; c: number; draft: string } | null>(null);

  // focused cell drives the inspector
  useEffect(() => {
    if (sel.focus) {
      void import("../stores/inspector").then(({ useInspector }) =>
        useInspector
          .getState()
          .setTarget({ stmtIndex: statement.index, row: sel.focus!.r, col: sel.focus!.c }),
      );
    }
  }, [sel.focus, statement.index]);

  const colEditMeta = (c: number) =>
    editMap && editMap !== "loading" && editMap !== "unavailable"
      ? editMap.columns[c]
      : undefined;

  const startEdit = useCallback(
    (r: number, c: number) => {
      const meta = colEditMeta(c);
      if (!meta?.editable) return;
      const k = editKey(statement.index, r, c);
      const current = pending[k] ? pending[k].value : rows[r][c];
      // JSON cells edit in the inspector — a one-line input is hostile UX
      const isJson =
        meta.type_name === "jsonb" ||
        meta.type_name === "json" ||
        (current != null && /^\s*[[{]/.test(current));
      if (isJson && current != null) {
        void import("../stores/inspector").then(({ useInspector }) =>
          useInspector.getState().requestEdit({ stmtIndex: statement.index, row: r, col: c }),
        );
        return;
      }
      setEditing({ r, c, draft: current ?? "" });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editMap, pending, rows, statement.index],
  );

  const saveEdit = useCallback(
    (value: string | null) => {
      if (!editing) return;
      useEdits.getState().setEdit({
        stmtIndex: statement.index,
        row: editing.r,
        col: editing.c,
        value,
        original: rows[editing.r][editing.c],
      });
      setEditing(null);
      containerRef.current?.focus();
    },
    [editing, rows, statement.index],
  );

  const copySelection = useCallback(
    (format: CopyFormat) => {
      const rect: SelRect | null = sel.rect;
      if (!rect) return;
      const selCols = cols.slice(rect.c0, rect.c1 + 1);
      const selRows: (string | null)[][] = [];
      for (let r = rect.r0; r <= rect.r1; r++) {
        selRows.push(rows[r].slice(rect.c0, rect.c1 + 1));
      }
      // tauri plugin, not navigator.clipboard — dev origin is insecure-context
      writeText(formatCells(selCols, selRows, format)).catch(console.error);
    },
    [sel.rect, cols, rows],
  );

  // preventDefault on mousedown kills native text selection but also focus —
  // refocus the container manually so keyboard nav keeps working.
  const beginDrag = useCallback(
    (e: React.MouseEvent, pos: { r: number; c: number }, mode: DragMode) => {
      if (e.button !== 0) return;
      e.preventDefault();
      containerRef.current?.focus();
      sel.startDrag(pos, e.shiftKey, mode);
    },
    [sel],
  );

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return; // cell editor owns the keyboard
      const meta = e.metaKey;
      if (meta && e.key === "c") {
        e.preventDefault();
        copySelection("tsv");
        return;
      }
      if (meta && e.key === "a") {
        e.preventDefault();
        sel.selectAll();
        return;
      }
      const moves: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        const next = sel.moveFocus(
          meta && mv[0] !== 0 ? mv[0] * rows.length : mv[0],
          meta && mv[1] !== 0 ? mv[1] * cols.length : mv[1],
          e.shiftKey,
        );
        rowVirt.scrollToIndex(next.r);
        colVirt.scrollToIndex(next.c);
        return;
      }
      if (e.key === "Enter" && sel.focus) {
        e.preventDefault();
        startEdit(sel.focus.r, sel.focus.c);
      }
    },
    [copySelection, sel, rows.length, cols.length, rowVirt, colVirt, startEdit, editing],
  );

  /** stage NULL or empty-string for every editable cell in the selection */
  const setSelectionValue = useCallback(
    (value: string | null) => {
      const rect = sel.rect;
      if (!rect) return;
      const st = useEdits.getState();
      for (let c = rect.c0; c <= rect.c1; c++) {
        if (!colEditMeta(c)?.editable) continue;
        for (let r = rect.r0; r <= rect.r1; r++) {
          st.setEdit({
            stmtIndex: statement.index,
            row: r,
            col: c,
            value,
            original: rows[r][c],
          });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel.rect, editMap, rows, statement.index],
  );

  const selectionHasEditable = useMemo(() => {
    const rect = sel.rect;
    if (!rect) return false;
    for (let c = rect.c0; c <= rect.c1; c++) {
      if (colEditMeta(c)?.editable) return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.rect, editMap]);

  // a result row is deletable iff exactly one source table has a locator
  // (PK or ctid) in the result — ambiguous for multi-table JOINs.
  const deletableTableOid = useMemo(() => {
    if (!editMap || editMap === "loading" || editMap === "unavailable") return null;
    const oids = Object.keys(editMap.pk_cols).map(Number);
    return oids.length === 1 ? oids[0] : null;
  }, [editMap]);

  const deleteSelectedRows = useCallback(async () => {
    const rect = sel.rect;
    if (!rect || deletableTableOid == null) return;
    const map = editMap as EditabilityMap;
    const pkCols = map.pk_cols[deletableTableOid];
    if (!pkCols?.length) return;

    const locators: [number, string | null][][] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      locators.push(pkCols.map((pc) => [pc, rows[r][pc]] as [number, string | null]));
    }
    const tableName = map.tables[deletableTableOid] ?? "table";
    const n = locators.length;
    const preview = locators
      .slice(0, 8)
      .map(
        (loc) =>
          `WHERE ${loc
            .map(([c, v]) => `${cols[c]?.name ?? `col${c}`} = ${v ?? "NULL"}`)
            .join(" AND ")}`,
      )
      .join("\n");

    const { confirmDanger } = await import("../stores/danger");
    const ok = await confirmDanger(
      `Delete ${n} row${n > 1 ? "s" : ""} from ${tableName}?`,
      `This cannot be undone.\n\n${preview}${n > 8 ? `\n… and ${n - 8} more` : ""}`,
    );
    if (!ok) return;

    const { executedSql, executedSessionId: sessionId } = useResults.getState();
    if (!sessionId || !executedSql) return;
    try {
      await ipc.deleteRows(sessionId, executedSql, statement.index, deletableTableOid, locators);
      // re-run the exact query so the grid reflects the delete
      void useResults.getState().run(executedSql);
    } catch (e) {
      useResults.setState({
        globalError: { message: (e as { message?: string }).message ?? String(e), position: null, code: null },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.rect, deletableTableOid, editMap, rows, statement.index]);

  const resizing = useRef<{ col: number; startX: number; startW: number } | null>(null);
  const onResizeStart = (col: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = { col, startX: e.clientX, startW: colWidths[col] };
    const onMove = (me: MouseEvent) => {
      const r = resizing.current;
      if (!r) return;
      const w = Math.max(MIN_COL_W, r.startW + (me.clientX - r.startX));
      setWidths((prev) => prev.map((pw, i) => (i === r.col ? w : pw)));
    };
    const onUp = () => {
      resizing.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const inRect = (r: number, c: number, rect: SelRect | null) =>
    !!rect && r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;

  return (
    <div
      ref={containerRef}
      className="vgrid"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseUp={sel.endDrag}
      onContextMenu={(e) => {
        e.preventDefault();
        if (sel.rect) setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div
        ref={scrollRef}
        className="vgrid-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (
            nearEndHook.current &&
            el.scrollTop + el.clientHeight > el.scrollHeight - 800
          ) {
            nearEndHook.current();
          }
        }}
      >
        <div
          className="vgrid-inner"
          style={{
            width: colVirt.getTotalSize() + ROWNUM_W,
            height: rowVirt.getTotalSize() + HEADER_H + draftH,
          }}
        >
          {/* header: sticky top; scrolls horizontally with content */}
          <div className="vgrid-header" style={{ height: HEADER_H }}>
            <div
              className="vgrid-corner"
              style={{ width: ROWNUM_W, height: HEADER_H }}
              title="Select all"
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                containerRef.current?.focus();
                sel.selectAll();
              }}
            />
            {colVirt.getVirtualItems().map((vc) => {
              const tn = colType(vc.index);
              const glyph = typeIcon(tn);
              return (
                <div
                  key={vc.key}
                  className="vgrid-hcell"
                  style={{
                    transform: `translateX(${vc.start + ROWNUM_W}px)`,
                    width: vc.size,
                    height: HEADER_H,
                  }}
                  onMouseDown={(e) => beginDrag(e, { r: 0, c: vc.index }, "col")}
                  onMouseEnter={() => sel.dragOver({ r: 0, c: vc.index })}
                >
                  {glyph && (
                    <span className="vgrid-htype" style={{ color: glyph.color }} title={tn}>
                      <glyph.Icon size={12} strokeWidth={2.2} />
                    </span>
                  )}
                  <span className="vgrid-hname">{cols[vc.index].name}</span>
                  <span
                    className="vgrid-resize"
                    onMouseDown={(e) => onResizeStart(vc.index, e)}
                  />
                </div>
              );
            })}
          </div>

          {/* inline draft (new) row: sticky band pinned under the header */}
          {showDraft && (
            <div
              className="vgrid-draft"
              style={{ top: HEADER_H, height: DRAFT_H }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelDraft();
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void commitDraft();
                }
              }}
            >
              <div
                className="vgrid-draft-corner"
                style={{ width: ROWNUM_W, height: DRAFT_H }}
                title="⌘↵ insert · Esc cancel"
              >
                <Plus size={13} />
              </div>
              {colVirt.getVirtualItems().map((vc) => {
                const name = cols[vc.index].name;
                const isCtid = name === "ctid";
                const cell = draftRow?.[name] ?? { text: "", isNull: false };
                return (
                  <div
                    key={vc.key}
                    className="vgrid-draftcell"
                    style={{
                      transform: `translateX(${vc.start + ROWNUM_W}px)`,
                      width: vc.size,
                      height: DRAFT_H,
                    }}
                  >
                    {isCtid ? (
                      <span className="vgrid-draft-auto">auto</span>
                    ) : (
                      <>
                        <input
                          className="vgrid-draft-input"
                          value={cell.isNull ? "" : cell.text}
                          placeholder={cell.isNull ? "NULL" : "DEFAULT"}
                          disabled={cell.isNull}
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autoFocus={vc.index === firstDraftCol}
                          spellCheck={false}
                          onChange={(e) =>
                            setDraftCell(name, { text: e.target.value, isNull: false })
                          }
                        />
                        <button
                          type="button"
                          className={`vgrid-draft-null${cell.isNull ? " on" : ""}`}
                          title="Set NULL"
                          onClick={() => setDraftCell(name, { text: "", isNull: !cell.isNull })}
                        >
                          ∅
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* row numbers: sticky left wrapper, absolute children */}
          <div className="vgrid-rownums" style={{ width: ROWNUM_W }}>
            {rowVirt.getVirtualItems().map((vr) => (
              <div
                key={vr.key}
                className="vgrid-rownum"
                style={{ top: vr.start, width: ROWNUM_W, height: ROW_H }}
                onMouseDown={(e) => beginDrag(e, { r: vr.index, c: 0 }, "row")}
                onMouseEnter={() => sel.dragOver({ r: vr.index, c: 0 })}
              >
                {vr.index + 1}
              </div>
            ))}
          </div>

          {/* cells */}
          {rowVirt.getVirtualItems().map((vr) =>
            colVirt.getVirtualItems().map((vc) => {
              const k = editKey(statement.index, vr.index, vc.index);
              const pendingEdit = pending[k];
              const v = pendingEdit ? pendingEdit.value : rows[vr.index][vc.index];
              const selected = inRect(vr.index, vc.index, sel.rect);
              const focused = sel.focus?.r === vr.index && sel.focus?.c === vc.index;
              const truncated = statement.truncated.has(`${vr.index}:${vc.index}`);
              const meta = colEditMeta(vc.index);
              const readonlyReason = meta && !meta.editable ? meta.reason : null;
              const warn = meta?.editable ? meta.warn : null;
              return (
                <div
                  key={`${vr.key}:${vc.key}`}
                  className={`vgrid-cell${v === null ? " null" : ""}${selected ? " sel" : ""}${focused ? " focus" : ""}${pendingEdit ? " dirty" : ""}${flash.has(k) ? " flash" : ""}${warn ? " ctid-warn" : ""}`}
                  style={{
                    transform: `translate(${vc.start + ROWNUM_W}px, ${vr.start + HEADER_H + draftH}px)`,
                    width: vc.size,
                    height: ROW_H,
                  }}
                  title={readonlyReason ?? warn ?? undefined}
                  onMouseDown={(e) => beginDrag(e, { r: vr.index, c: vc.index }, "cell")}
                  onMouseEnter={() => sel.dragOver({ r: vr.index, c: vc.index })}
                  onDoubleClick={() => startEdit(vr.index, vc.index)}
                >
                  {v === null ? "NULL" : v}
                  {pendingEdit && <span className="vgrid-dirty-badge">✎</span>}
                  {truncated && <span className="vgrid-trunc">…⧉</span>}
                </div>
              );
            }),
          )}

          {/* in-place cell editor */}
          {editing && (
            <CellEditor
              x={colVirt.getVirtualItems().find((v) => v.index === editing.c)?.start ?? 0}
              y={(rowVirt.getVirtualItems().find((v) => v.index === editing.r)?.start ?? 0) + draftH}
              width={colWidths[editing.c] ?? 160}
              draft={editing.draft}
              onDraft={(d) => setEditing((e) => (e ? { ...e, draft: d } : e))}
              onSave={() => saveEdit(editing.draft)}
              onNull={() => saveEdit(null)}
              onCancel={() => {
                setEditing(null);
                containerRef.current?.focus();
              }}
            />
          )}
        </div>
      </div>

      {menu && (
        <div
          className="vgrid-menu-backdrop"
          onMouseDown={(e) => {
            // close only on true outside clicks — a mousedown on the menu's
            // buttons must survive long enough for their onClick to fire
            if (e.target === e.currentTarget) setMenu(null);
          }}
        >
          <motion.div className="vgrid-menu" style={{ left: menu.x, top: menu.y }} {...menuIn}>
            {(["tsv", "csv", "json", "markdown", "insert"] as CopyFormat[]).map((f) => (
              <button
                key={f}
                onClick={() => {
                  copySelection(f);
                  setMenu(null);
                }}
              >
                Copy as {f.toUpperCase()}
              </button>
            ))}
            {selectionHasEditable && (
              <>
                <div className="vgrid-menu-sep" />
                <button
                  onClick={() => {
                    setSelectionValue(null);
                    setMenu(null);
                  }}
                >
                  Set NULL
                </button>
                <button
                  onClick={() => {
                    setSelectionValue("");
                    setMenu(null);
                  }}
                >
                  Set EMPTY
                </button>
              </>
            )}
            {deletableTableOid != null && (
              <>
                <div className="vgrid-menu-sep" />
                <button
                  className="danger"
                  onClick={() => {
                    setMenu(null);
                    void deleteSelectedRows();
                  }}
                >
                  Delete {sel.rect && sel.rect.r1 > sel.rect.r0
                    ? `${sel.rect.r1 - sel.rect.r0 + 1} rows`
                    : "row"}
                </button>
              </>
            )}
          </motion.div>
        </div>
      )}

      {showDraft && draftError && <div className="vgrid-draft-error">{draftError}</div>}
    </div>
  );
}
