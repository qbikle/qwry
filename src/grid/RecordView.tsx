// Record view (Space): THE transposed single-row modal (columns as rows:
// name / type icon / value) with prev/next row navigation (‹ › buttons +
// ⌘↑/⌘↓) and IN-PLACE editing that stages through the normal edits pipeline
// (same keys, staged dots appear in the grid behind it). Read-only cells
// show their reason; truncated cells route to the inspector (the grid value
// is only the 8KB prefix: editing it inline would commit the prefix over
// the full value). Absorbed the old RowPeek (Space): one row-view concept,
// one gesture; two near-identical modals needed every guard fix twice.
//
// Dual-column DIFF mode (context menu "Compare 2 rows"): two value columns,
// differing values tinted, identical values dimmed. Viewing only.
//
// Esc layering: inline editors and the structured-value pop-out each push
// their own overlay-stack entry, so Esc closes the editor first and the
// record view underneath never moves.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ChevronLeft, ChevronRight, Lock, Pencil } from "lucide-react";
import { popIn } from "../design/springs";
import { Modal, useOverlayLayer } from "../app/overlay/Overlay";
import type { StatementState } from "../stores/results";
import { editKey, useEdits } from "../stores/edits";
import { useInspector } from "../stores/inspector";
import { useConnections } from "../stores/connections";
import { useSchema } from "../stores/schema";
import type { ColumnEditMeta } from "../ipc/types";
import { isArrayType } from "../inspector/format";
import { JsonField } from "../inspector/JsonField";
import { typeIcon } from "./typeIcon";
import { Kbd } from "../design/Kbd";
import { prettyCellValue, stageCellDraft, ValuePop } from "./ValuePop";
import { diffMask } from "./spelunkLogic";
import "./grid.css";

interface EditState {
  col: number;
  kind: "text" | "bool" | "enum";
  enumLabels?: string[];
  initial: string;
  /** cell was NULL when the editor opened: untouched close must NOT stage '' */
  startedNull: boolean;
}

export function RecordView({
  statement,
  viewRows,
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
  /** one view row = record mode; two = diff mode (view-only) */
  viewRows: readonly [number] | readonly [number, number];
  rowAt: (view: number) => number;
  /** view→data column map so columns list in the GRID's order */
  colAt: (view: number) => number;
  /** TRUE view column count: colAt past it falls back to identity, which
   * would leak hidden columns (and duplicate the last one) */
  viewColLen: number;
  rowCount: number;
  typeOf: (dataCol: number) => string | undefined;
  editMetaOf: (dataCol: number) => ColumnEditMeta | undefined;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const pending = useEdits((s) => s.pending);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [popCol, setPopCol] = useState<number | null>(null);
  const [reasonCol, setReasonCol] = useState<number | null>(null);

  const diff = viewRows.length === 2;
  const dataRs = viewRows.map((v) => rowAt(v));
  const rowsData = dataRs.map((r) => statement.rows[r]);

  // walking to another row abandons an open editor / reason note
  const rowSig = dataRs.join(":");
  useEffect(() => {
    setEdit(null);
    setPopCol(null);
    setReasonCol(null);
  }, [rowSig]);

  /** effective (pending-overlaid) value of one cell */
  const effVal = (side: number, i: number): string | null => {
    const k = editKey(statement.index, dataRs[side], i);
    const pe = pending[k];
    return pe ? pe.value : (rowsData[side]?.[i] ?? null);
  };

  const nCols = statement.columns.length;
  const mask = useMemo(() => {
    if (!diff) return null;
    const a: (string | null)[] = [];
    const b: (string | null)[] = [];
    for (let i = 0; i < nCols; i++) {
      a.push(effVal(0, i));
      b.push(effVal(1, i));
    }
    return diffMask(a, b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, rowSig, pending, statement.rows, nCols]);
  // header count speaks VISIBLE columns only, same scope as the listing
  let differCount = 0;
  if (mask) for (let v = 0; v < viewColLen; v++) if (mask[colAt(v)]) differCount++;

  // rows can be replaced/shrunk under the open modal (browser re-run): a
  // gone row must CLOSE the record, not render null: the grid still holds
  // record ≠ null and would silently keep routing the keyboard here
  const rowGone = rowsData.some((r) => !r);
  useEffect(() => {
    if (rowGone) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowGone]);
  if (rowGone) return null;

  const openEdit = (i: number) => {
    const meta = editMetaOf(i);
    const truncated = statement.truncated.has(`${dataRs[0]}:${i}`);
    if (truncated) {
      // full value lives behind the inspector's on-demand fetch
      onClose();
      if (meta?.editable) {
        useInspector.getState().requestEdit({ stmtIndex: statement.index, row: dataRs[0], col: i });
      } else {
        const insp = useInspector.getState();
        insp.setTarget({ stmtIndex: statement.index, row: dataRs[0], col: i });
        if (!insp.open) insp.toggle();
      }
      return;
    }
    if (!meta?.editable) {
      setReasonCol((c) => (c === i ? null : i)); // read-only cells show their reason, in the modal
      return;
    }
    const tn = typeOf(i);
    if (tn === "json" || tn === "jsonb" || isArrayType(tn)) {
      setPopCol(i);
      return;
    }
    const current = effVal(0, i);
    if (tn === "bool") {
      setEdit({ col: i, kind: "bool", initial: current ?? "", startedNull: current === null });
      return;
    }
    const pid = useConnections.getState().activeProfileId;
    const snap = pid ? useSchema.getState().snapshots[pid] : undefined;
    const en = snap?.enums.find((x) => x.name === tn);
    setEdit({
      col: i,
      kind: en ? "enum" : "text",
      enumLabels: en?.labels,
      initial: current ?? "",
      startedNull: current === null,
    });
  };

  const stageInline = (i: number, value: string | null) => {
    // opened on NULL and left empty → still NULL (the grid's grammar)
    if (edit && value === "" && edit.startedNull) {
      setEdit(null);
      return;
    }
    useEdits.getState().setEdit({
      stmtIndex: statement.index,
      row: dataRs[0],
      col: i,
      value,
      original: statement.rows[dataRs[0]][i],
    });
    setEdit(null);
  };

  const renderValue = (v: string | null, pretty: string | null, dirtyDefault: boolean) => {
    if (dirtyDefault) return <span className="vgrid-defaultchip">DEFAULT</span>;
    if (v === null) return <span className="vgrid-nullchip">NULL</span>;
    if (v === "") return <span className="vgrid-emptychip">∅ empty</span>;
    if (!diff && pretty !== null && pretty !== v && pretty.includes("\n")) {
      return <JsonField value={pretty} readOnly />;
    }
    return pretty ?? v;
  };

  return (
    <>
      <Modal
        label={diff ? "Compare Rows" : "Record View"}
        onClose={() => {
          // layered close: an open inline editor absorbs the first Esc/
          // outside-click (its own overlay entry handles Esc; this covers the
          // backdrop path), never both in one gesture
          if (edit) setEdit(null);
          else onClose();
        }}
        onKey={(e) => {
          if (diff) return;
          // Space closes what Space opened (Quick Look grammar), unless a
          // focused control (nav button, editor) claims it for activation.
          // Editors are safe by construction anyway: RvInlineEdit/ValuePop
          // push their own overlay layer, so this handler isn't topmost then
          if (e.key === " ") {
            if ((e.target as HTMLElement).closest("button, select, textarea, input")) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            onClose();
            return;
          }
          if (!e.metaKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          onStep(e.key === "ArrowDown" ? 1 : -1);
        }}
      >
        <motion.div
          className={`recordview${diff ? " rv-cmp" : ""}`}
          {...popIn}
          // portals bubble through the REACT tree: without this, keys typed
          // here reach the grid underneath and seed type-to-edit. ⌘/⌃
          // chords bubble on: the window shortcuts own those (LESSONS.md)
          onKeyDown={(e) => {
            if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
          }}
        >
          <div className="rv-head">
            <span className="rv-title">
              {diff ? (
                <>
                  Compare Rows {viewRows[0] + 1} · {(viewRows[1] ?? 0) + 1}{" "}
                  <span className="rv-of">
                    {differCount} of {viewColLen} visible column{viewColLen === 1 ? "" : "s"}{" "}
                    differ
                  </span>
                </>
              ) : (
                <>
                  Record · Row {viewRows[0] + 1}{" "}
                  <span className="rv-of">of {rowCount.toLocaleString()}</span>
                </>
              )}
            </span>
            {diff ? (
              <span className="rv-keys">
                viewing only · <Kbd chord="esc" /> close
              </span>
            ) : (
              <span className="rv-nav">
                <span className="rv-keys">
                  double-click value to edit · <Kbd chord="cmd+up" /> <Kbd chord="cmd+down" />{" "}
                  walk
                </span>
                <span className="rv-step">
                  <button
                    className="rv-navbtn"
                    disabled={viewRows[0] <= 0}
                    title="Previous Row ⌘↑"
                    onClick={() => onStep(-1)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    className="rv-navbtn"
                    disabled={viewRows[0] >= rowCount - 1}
                    title="Next Row ⌘↓"
                    onClick={() => onStep(1)}
                  >
                    <ChevronRight size={14} />
                  </button>
                </span>
              </span>
            )}
          </div>
          <div className="rv-body">
            {Array.from({ length: viewColLen }, (_, view) => {
              const i = colAt(view); // data index: everything below is data-keyed
              const c = statement.columns[i];
              const tn = typeOf(i);
              const glyph = typeIcon(tn);
              const meta = editMetaOf(i);
              const k0 = editKey(statement.index, dataRs[0], i);
              const pe0 = pending[k0];
              const truncated0 = statement.truncated.has(`${dataRs[0]}:${i}`);
              const editable = !diff && !!meta?.editable && !truncated0;

              const label = (
                <span className="rv-col" title={tn}>
                  {glyph && (
                    <span className="rv-type" style={{ color: glyph.color }}>
                      <glyph.Icon size={12} strokeWidth={2.2} />
                    </span>
                  )}
                  {c.name}
                  {!diff && pe0 && <span className="rv-dirty">✎</span>}
                  {!diff && meta && !meta.editable && (
                    <span className="rv-lock" title={meta.reason ?? "read-only"}>
                      <Lock size={12} strokeWidth={2.2} />
                    </span>
                  )}
                </span>
              );

              if (diff) {
                const differs = mask?.[i] ?? false;
                return (
                  <div key={i} className="rv-row rv-cmprow">
                    {label}
                    {[0, 1].map((side) => {
                      const v = effVal(side, i);
                      const peS = pending[editKey(statement.index, dataRs[side], i)];
                      const trunc = statement.truncated.has(`${dataRs[side]}:${i}`);
                      return (
                        <span
                          key={side}
                          className={`rv-val rv-side${differs ? " rv-diff" : " rv-same"}`}
                        >
                          {/* same renderValue path as record mode: a staged
                              Set-DEFAULT must show DEFAULT, never lie as NULL */}
                          {renderValue(v, null, !!peS?.useDefault)}
                          {trunc && (
                            <span
                              className="vgrid-trunc"
                              title="Truncated, the diff sees only the 8KB prefix"
                            >
                              {" "}…⧉ <span className="rv-trunchint">compared on 8KB prefix</span>
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              }

              const v = effVal(0, i);
              const pretty = prettyCellValue(v, tn);
              const editingThis = edit?.col === i;
              // multiline structured value renders as a JsonField box (same
              // predicate as renderValue): the pencil anchors inside its corner
              const boxed = pretty !== null && pretty !== v && pretty.includes("\n");
              return (
                <div key={i} className={`rv-row${pe0 ? " dirty" : ""}`}>
                  {label}
                  {editingThis ? (
                    <RvInlineEdit
                      kind={edit.kind}
                      enumLabels={edit.enumLabels}
                      initial={edit.initial}
                      onStage={(draft) => stageInline(i, draft)}
                      onNull={() => stageInline(i, null)}
                      onCancel={() => setEdit(null)}
                    />
                  ) : (
                    <span
                      className={`rv-val${pretty !== v ? " structured" : ""}${editable ? " editable" : ""}`}
                      // no "Double-click to edit" title: the header hint + the
                      // pencil carry it, and a native tooltip trailing the
                      // cursor across a JSON box reads as debris
                      title={meta && !meta.editable ? (meta.reason ?? undefined) : undefined}
                      // double-click opens the editor (the grid/inspector
                      // convention); single click keeps the read-only-reason
                      // toggle and the truncated → inspector route
                      onClick={editable ? undefined : () => openEdit(i)}
                      onDoubleClick={editable ? () => openEdit(i) : undefined}
                    >
                      {renderValue(v, pretty, !!pe0?.useDefault)}
                      {truncated0 && (
                        <span className="vgrid-trunc rv-truncbtn" title="Truncated, open the full value in the Inspector">
                          {" "}…⧉
                        </span>
                      )}
                      {editable && (
                        <button
                          className={`iconbtn rv-pencil${boxed ? " bordered rv-pencil-box" : ""}`}
                          aria-label="Edit value"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(i);
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                    </span>
                  )}
                  {reasonCol === i && !meta?.editable && (
                    <div className="rv-reason">
                      read-only:{" "}
                      {meta
                        ? (meta.reason ?? "column is not editable")
                        : "no editability metadata for this result"}
                    </div>
                  )}
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
          initial={prettyCellValue(effVal(0, popCol), typeOf(popCol)) ?? ""}
          onStage={(draft) => {
            const err = stageCellDraft({
              stmtIndex: statement.index,
              row: dataRs[0],
              col: popCol,
              draft,
              typeName: typeOf(popCol),
              original: statement.rows[dataRs[0]][popCol],
            });
            if (err === null) setPopCol(null);
            return err;
          }}
          onClose={() => setPopCol(null)}
        />
      )}
    </>
  );
}

/** In-place value editor for one record row: its own overlay-stack entry so
 * Esc closes it (not the record view). Enter stages; blur stages; ∅ = NULL. */
function RvInlineEdit({
  kind,
  enumLabels,
  initial,
  onStage,
  onNull,
  onCancel,
}: {
  kind: "text" | "bool" | "enum";
  enumLabels?: string[];
  initial: string;
  onStage: (draft: string) => void;
  onNull: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // this layer is topmost while open, which suspends the parent Modal's Tab
  // trap: trap Tab at the editor's own edge or focus walks out of the modal
  useOverlayLayer(
    () => {
      done.current = true;
      onCancel();
    },
    (e) => {
      if (e.key !== "Tab") return;
      const root = rootRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>("button, select, textarea, input"),
      ).filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? items[(idx <= 0 ? items.length : idx) - 1]
        : items[(idx + 1) % items.length];
      next?.focus();
    },
  );

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(grow, [draft]);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  if (kind === "bool") {
    return (
      <div
        className="vgrid-boolpick rv-edit"
        ref={rootRef}
        // ⇧⌘⌫ = NULL here too: the ∅ button advertises the chord, and the
        // grid's own boolpick honors it (keyboard parity across both editors)
        onKeyDown={(e) => {
          if (e.key === "Backspace" && e.metaKey && e.shiftKey) {
            e.preventDefault();
            finish(onNull);
          }
        }}
      >
        {(
          [
            ["t", "true"],
            ["f", "false"],
          ] as const
        ).map(([wire, label]) => (
          <button
            key={wire}
            autoFocus={wire === "t"}
            className={draft === wire || draft === label ? "active" : ""}
            onClick={() => finish(() => onStage(wire))}
          >
            {label}
          </button>
        ))}
        <button className={draft === "" ? "active" : ""} onClick={() => finish(onNull)}>
          NULL
        </button>
      </div>
    );
  }

  if (kind === "enum") {
    return (
      <div className="rv-edit" ref={rootRef}>
        <select
          autoFocus
          className="vgrid-enumpick"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // ⇧⌘⌫ = stage NULL and close (the grid cell editor's chord)
            if (e.key === "Backspace" && e.metaKey && e.shiftKey) {
              e.preventDefault();
              finish(onNull);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              finish(() => onStage(draft));
            }
          }}
          onBlur={() => finish(() => onStage(draft))}
        >
          {draft === "" && <option value="">Pick a value…</option>}
          {enumLabels?.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button
          className="vgrid-nullbtn"
          title="Set NULL ⇧⌘⌫"
          onMouseDown={(e) => {
            e.preventDefault();
            finish(onNull);
          }}
        >
          ∅
        </button>
      </div>
    );
  }

  return (
    <div className="rv-edit">
      <textarea
        ref={taRef}
        rows={1}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // ⇧⌘⌫ = stage NULL and close (the grid cell editor's chord)
          if (e.key === "Backspace" && e.metaKey && e.shiftKey) {
            e.preventDefault();
            finish(onNull);
            return;
          }
          // Enter stages; ⌥/⇧-Enter inserts a real newline (grid grammar)
          if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            finish(() => onStage(draft));
          }
        }}
        onBlur={() => finish(() => onStage(draft))}
      />
      <button
        className="vgrid-nullbtn"
        title="Set NULL ⇧⌘⌫"
        onMouseDown={(e) => {
          e.preventDefault();
          finish(onNull);
        }}
      >
        ∅
      </button>
    </div>
  );
}
