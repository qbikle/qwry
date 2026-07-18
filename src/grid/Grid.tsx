// Virtualized results grid — rows and columns both windowed (DOM cells, P2).
// Perf checkpoint vs Glide Data Grid happens at the end of P2 (see ROADMAP).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { useResults, type StatementState } from "../stores/results";
import { ctidGuardPairs, editKey, useEdits } from "../stores/edits";
import * as ipc from "../ipc/commands";
import type { EditabilityMap } from "../ipc/types";
import { formatCells, type CopyFormat } from "./clipboard";
import { useSelection, type DragMode, type SelRect } from "./useSelection";
import { typeIcon } from "./typeIcon";
import { useBrowser } from "../stores/browser";
import { useTabs } from "../stores/tabs";
import { qualify, qi } from "../lib/sqlIdent";
import { useConnections } from "../stores/connections";
import { useInspector } from "../stores/inspector";
import { useSchema } from "../stores/schema";
import { RowPeek } from "./RowPeek";
import { hitKey, useFind } from "../stores/find";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import { useGridStats } from "../stores/gridStats";
import { useGridFilter } from "../stores/gridFilter";
import { useSettings } from "../stores/settings";
import { ChevronUp, ChevronsUpDown, Plus } from "lucide-react";
import "./grid.css";

/** registered by TableBrowser for infinite scroll; null in plain editor mode */
export const nearEndHook: { current: (() => void) | null } = { current: null };

const DENSITY_ROW_H = { compact: 22, normal: 26, comfortable: 32 } as const;
const HEADER_H = 30;
const DRAFT_H = 32;
const ROWNUM_W = 52;
const MIN_COL_W = 64;
const MAX_COL_W = 480;
const CHAR_W = 7.3; // SF Mono 12px approximation

const NUMERIC_TYPES = new Set([
  "int2", "int4", "int8", "float4", "float8", "numeric", "oid", "money",
]);

// ⌘C selections at/above this cell count build their TSV in rAF-yielded
// slices — a 50k-row ⌘A+⌘C built a >100MB string synchronously (seconds of
// beachball). Below it the copy stays fully synchronous (zero added latency).
const COPY_ASYNC_CELLS = 16_000;
const COPY_SLICE_ROWS = 4_000;

// flash a read-only reason through the status bar's existing message slot —
// double-click/Enter/type-to-edit on an uneditable cell must never no-op mute
let reasonTimer: ReturnType<typeof setTimeout> | undefined;
function flashReadOnlyReason(msg: string) {
  useEdits.setState({ lastError: msg });
  clearTimeout(reasonTimer);
  reasonTimer = setTimeout(() => {
    if (useEdits.getState().lastError === msg) useEdits.setState({ lastError: null });
  }, 2500);
}

// chunked-copy slice scheduling: rAF stalls while the window is occluded
// (WKWebView suspends rAF) — race it against a timeout, first wins, cancel
// the loser, so a background build still finishes
function nextCopyTick(fn: () => void) {
  let done = false;
  const raf = requestAnimationFrame(() => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fn();
  });
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    fn();
  }, 32);
}

/** One data cell — memoized on primitive props so an arrow key / drag step /
 * stream flush repaints only the handful of cells whose state changed, not
 * the whole visible window (the grid's single biggest perf lever). Mouse
 * handling is DELEGATED to the container via data-r/data-c, so cells carry
 * no per-render closures at all. */
const Cell = memo(function Cell(p: {
  r: number;
  c: number;
  v: string | null;
  x: number;
  y: number;
  width: number;
  selected: boolean;
  focused: boolean;
  dirty: boolean;
  flash: boolean;
  warn: boolean;
  truncated: boolean;
  hit: boolean;
  curHit: boolean;
  num: boolean;
  isDefault: boolean;
  title: string | undefined;
}) {
  return (
    <div
      data-r={p.r}
      data-c={p.c}
      className={`vgrid-cell${p.v === null ? " null" : ""}${p.selected ? " sel" : ""}${p.focused ? " focus" : ""}${p.dirty ? " dirty" : ""}${p.flash ? " flash" : ""}${p.warn ? " ctid-warn" : ""}${p.hit ? " find-hit" : ""}${p.curHit ? " find-cur" : ""}${p.num ? " num" : ""}`}
      style={{
        transform: `translate(${p.x}px, ${p.y}px)`,
        width: p.width,
        height: "var(--grid-rh, 26px)",
      }}
      title={p.title}
    >
      {/* the grid must never lie: real NULL renders as a chip element, '' as a
          dim marker — the literal text "NULL" stays visually distinct */}
      {p.isDefault ? (
        <span className="vgrid-defaultchip">DEFAULT</span>
      ) : p.v === null ? (
        <span className="vgrid-nullchip">NULL</span>
      ) : p.v === "" ? (
        <span className="vgrid-emptychip">∅ empty</span>
      ) : (
        p.v
      )}
      {p.dirty && <span className="vgrid-dirty-badge">✎</span>}
      {p.truncated && <span className="vgrid-trunc">…⧉</span>}
    </div>
  );
});

// ---- column-width persistence -------------------------------------------
// keyed by the result's column-name signature (localStorage, LRU-capped) so a
// re-run — or reopening the same table/query tomorrow — keeps hand-set widths
const COLW_KEY = "qwry.colWidths";
const COLW_CAP = 300;
const colSig = (cols: { name: string }[]) => cols.map((c) => c.name).join("\u0001");

function loadStoredWidths(sig: string, n: number): number[] | null {
  try {
    const all = JSON.parse(localStorage.getItem(COLW_KEY) ?? "{}") as Record<string, number[]>;
    const w = all[sig];
    return Array.isArray(w) && w.length === n ? w : null;
  } catch {
    return null;
  }
}

function saveStoredWidths(sig: string, widths: number[]) {
  try {
    const all = JSON.parse(localStorage.getItem(COLW_KEY) ?? "{}") as Record<string, number[]>;
    delete all[sig]; // re-insert at the end = most recently used
    all[sig] = widths;
    const keys = Object.keys(all);
    for (let i = 0; i < keys.length - COLW_CAP; i++) delete all[keys[i]];
    localStorage.setItem(COLW_KEY, JSON.stringify(all));
  } catch {
    /* quota/parse — widths just won't persist */
  }
}
// ---------------------------------------------------------------------------

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
  placeholder,
  kind,
  enumLabels,
  onDraft,
  onSave,
  onCommit,
  onNull,
  onCancel,
}: {
  x: number;
  y: number;
  width: number;
  draft: string;
  placeholder?: string;
  kind: "text" | "bool" | "enum";
  enumLabels?: string[];
  onDraft: (d: string) => void;
  /** advance moves focus after staging: true = down (Enter), "right" = Tab */
  onSave: (advance?: boolean | "right") => void;
  /** stage an explicit value (bool picker — bypasses the async draft state) */
  onCommit: (value: string, advance?: boolean) => void;
  onNull: () => void;
  onCancel: () => void;
}) {
  // Esc must discard WITHOUT the unmount-blur saving the draft
  const cancelled = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };
  useEffect(grow, [draft]);
  // caret must land AFTER the type-to-edit seed char, not before it
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const n = el.value.length;
    el.setSelectionRange(n, n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keyGuard = (e: React.KeyboardEvent) => {
    // never let grid-level handlers see editor keys (Enter would re-open)
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancelled.current = true;
      onCancel();
      return true;
    }
    if (e.key === "Backspace" && e.metaKey && e.shiftKey) {
      e.preventDefault();
      cancelled.current = true; // onNull closes the editor; blur must not double-save
      onNull();
      return true;
    }
    return false;
  };

  return (
    <div
      className="vgrid-celledit"
      style={{
        transform: `translate(${x + ROWNUM_W}px, ${y + HEADER_H}px)`,
        width: Math.max(width, 220),
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {kind === "bool" ? (
        <div className="vgrid-boolpick" onKeyDown={keyGuard}>
          {(
            [
              ["t", "true"],
              ["f", "false"],
            ] as const
          ).map(([wire, label]) => (
            <button
              key={wire}
              autoFocus={wire === "t"}
              className={draft === wire || draft === label ? "on" : ""}
              onClick={() => {
                cancelled.current = true;
                // commit the WIRE text ('t'/'f') — PG returns bools as t/f, so
                // picking the current value stays a no-op instead of dirtying
                onCommit(wire, true);
              }}
            >
              {label}
            </button>
          ))}
          <button
            className={draft === "" ? "on" : ""}
            onClick={() => {
              cancelled.current = true;
              onNull();
            }}
          >
            NULL
          </button>
        </div>
      ) : kind === "enum" ? (
        <select
          autoFocus
          className="vgrid-enumpick"
          value={draft}
          onKeyDown={(e) => {
            if (keyGuard(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              onSave(true);
            }
          }}
          onChange={(e) => onDraft(e.target.value)}
          onBlur={() => {
            if (!cancelled.current) onSave();
          }}
        >
          {draft === "" && <option value="">(pick)</option>}
          {enumLabels?.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      ) : (
        <textarea
          ref={taRef}
          rows={1}
          placeholder={placeholder}
          value={draft}
          spellCheck={false}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (keyGuard(e)) return;
            // Enter saves-and-advances; ⌥/⇧-Enter inserts a real newline —
            // multiline values are finally editable inline
            if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
              e.preventDefault();
              onSave(); // commit in place — advancing on Enter surprised more than it helped
            }
            // Tab follows the grid's own grammar: commit + move right —
            // the browser default blurred into the ∅ button instead
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              cancelled.current = true; // onSave closes; blur must not double-save
              onSave("right");
            }
          }}
          onBlur={() => {
            // click-outside = save; Esc/∅ already handled
            if (!cancelled.current) onSave();
          }}
        />
      )}
      {kind !== "bool" && (
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
      )}
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
  const gridDensity = useSettings((s) => s.gridDensity);
  const ROW_H = DENSITY_ROW_H[gridDensity];
  useLayoutEffect(() => {
    // the memoized Cell reads height from this var (matches estimateSize px);
    // layout effect: rownum inline heights update in the SAME frame
    document.documentElement.style.setProperty("--grid-rh", `${ROW_H}px`);
  }, [ROW_H]);
  const [widths, setWidths] = useState<number[]>([]);
  const widthsInitialized = useRef(false);

  useEffect(() => {
    widthsInitialized.current = false;
  }, [statement.index, statement.columns]);

  useEffect(() => {
    if (widthsInitialized.current) return;
    // hand-set widths for this column shape win over content estimation —
    // and apply immediately, before any rows have streamed in
    const stored = loadStoredWidths(colSig(statement.columns), statement.columns.length);
    if (stored) {
      widthsInitialized.current = true;
      setWidths(stored);
      return;
    }
    if (statement.rows.length > 0) {
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
  // resize-commit reads the latest widths without waiting on a re-render
  const widthsRef = useRef(colWidths);
  widthsRef.current = colWidths;

  // (virtualizers + selection are created AFTER the view-mapping block —
  // the quick-filter changes the VIEW row count they must be sized by)
  const colAtRef = useRef<(view: number) => number>((v) => v);

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

  const isNumericCol = (i: number) => {
    const t = colType(i);
    return !!t && NUMERIC_TYPES.has(t);
  };

  // ---- view mappings ---------------------------------------------------
  // Sort and column reorder are VIEW-level index maps over untouched data.
  // Everything data-keyed (staged edits, truncated markers, find hits,
  // editability) stays on UNDERLYING indexes — sorting after staging an edit
  // must never make ⌘S write through the wrong row.
  const [clientSort, setClientSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [colOrder, setColOrder] = useState<number[] | null>(null);
  /** DATA indexes of hidden columns (view-level, like sort/reorder) */
  const [hiddenCols, setHiddenCols] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    setClientSort(null);
    setColOrder(null);
    setHiddenCols(new Set());
  }, [statement.index, cols.length]);
  // an open inline editor holds VIEW coords — a sort/reorder under it would
  // make save resolve through the NEW maps and stage onto the wrong cell
  useEffect(() => {
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientSort, colOrder, statement.index]);

  /** view→data column list: reorder permutation minus hidden columns */
  const viewCols = useMemo(() => {
    const base = colOrder ?? cols.map((_, i) => i);
    return hiddenCols.size ? base.filter((d) => !hiddenCols.has(d)) : base;
  }, [colOrder, hiddenCols, cols]);
  const viewColLen = viewCols.length;
  const colAt = useCallback(
    (view: number) => viewCols[view] ?? view,
    [viewCols],
  );
  colAtRef.current = colAt;

  // quick-filter over LOADED rows (view-level, same contract as client sort;
  // browser excluded — filtering one server page would lie). Perf shape:
  // lowercase per-row haystacks are built ONCE per rows identity (not per
  // keystroke — the naive scan re-lowercased rows×cols every keypress), and a
  // query that extends the previous one only re-tests the previous matches.
  // Cells are joined with NUL (untypeable) so a match can never span cells.
  const rawFilter = useGridFilter((st) => st.text);
  const filterText = insertable ? "" : rawFilter.trim().toLowerCase();
  const haystackRef = useRef<{ rows: typeof rows; hay: string[] } | null>(null);
  const prevFilterRef = useRef<{ rows: typeof rows; text: string; idx: number[] } | null>(null);
  const filterIdx = useMemo(() => {
    if (!filterText) {
      haystackRef.current = null; // don't hold a lowercased copy of 50k rows
      prevFilterRef.current = null;
      return null;
    }
    let hs = haystackRef.current;
    if (!hs || hs.rows !== rows) {
      const hay = new Array<string>(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let s = "";
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v !== null) s += "\u0000" + v.toLowerCase();
        }
        hay[i] = s;
      }
      hs = { rows, hay };
      haystackRef.current = hs;
    }
    const prev = prevFilterRef.current;
    const narrowable =
      prev && prev.rows === rows && prev.text.length > 0 && filterText.startsWith(prev.text);
    const idx: number[] = [];
    if (narrowable) {
      for (const i of prev.idx) if (hs.hay[i].includes(filterText)) idx.push(i);
    } else {
      for (let i = 0; i < rows.length; i++) if (hs.hay[i].includes(filterText)) idx.push(i);
    }
    prevFilterRef.current = { rows, text: filterText, idx };
    return idx;
  }, [filterText, rows]);

  // client-side sort over LOADED rows — editor results only; the browser's
  // paged data sorts server-side (a client sort of one page would lie)
  const rowOrder = useMemo(() => {
    if ((!clientSort || insertable) && !filterIdx) return null;
    const base = filterIdx ?? rows.map((_, i) => i);
    if (!clientSort || insertable) return base;
    const { col, dir } = clientSort;
    const numeric = isNumericCol(col);
    const mul = dir === "asc" ? 1 : -1;
    const idx = [...base];
    idx.sort((a, b) => {
      const va = rows[a][col];
      const vb = rows[b][col];
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // NULLs always last in the view
      if (vb === null) return -1;
      if (numeric) {
        const na = Number(va);
        const nb = Number(vb);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * mul;
      }
      return va < vb ? -mul : va > vb ? mul : 0;
    });
    return idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientSort, filterIdx, rows, insertable, editMap]);

  const rowAt = useCallback(
    (view: number) => (rowOrder ? (rowOrder[view] ?? view) : view),
    [rowOrder],
  );
  const rowViewOf = useMemo(() => {
    if (!rowOrder) return null;
    // sized by DATA rows — filtered-out rows have no view slot (undefined)
    const inv = new Array<number | undefined>(rows.length);
    rowOrder.forEach((dataR, view) => (inv[dataR] = view));
    return inv;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowOrder, rows.length]);
  const colViewOf = useMemo(() => {
    if (!colOrder && hiddenCols.size === 0) return null;
    // sized by DATA cols — hidden ones have no view slot (undefined)
    const inv = new Array<number | undefined>(cols.length);
    viewCols.forEach((dataC, view) => (inv[dataC] = view));
    return inv;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colOrder, hiddenCols, viewCols, cols.length]);

  /** VIEW row count — differs from rows.length while the quick-filter is on */
  const viewLen = rowOrder ? rowOrder.length : rows.length;

  const rowVirt = useVirtualizer({
    count: viewLen,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  useLayoutEffect(() => {
    rowVirt.measure(); // density change resizes every row — same frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ROW_H]);
  const colVirt = useVirtualizer({
    horizontal: true,
    count: viewColLen,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[colAtRef.current(i)],
    overscan: 4,
  });
  useEffect(() => {
    colVirt.measure();
  }, [colWidths, colOrder, hiddenCols, colVirt]);

  const sel = useSelection(viewLen, viewColLen);

  // ANY view remap (quick-filter, sort, column reorder) invalidates an open
  // editor and the range selection — both hold VIEW coords, and batch actions
  // (Set NULL, fill down, paste, delete) re-resolve them through the NEW maps
  // onto different data rows. Drop both on every remap.
  useEffect(() => {
    setEditing(null);
    sel.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawFilter, clientSort, colOrder, hiddenCols]);
  // publish the match count for the status bar's "n of m" readout
  useEffect(() => {
    useGridFilter.getState().setMatches(filterIdx ? filterIdx.length : null);
  }, [filterIdx]);
  // FindBar computes hits over data columns — it needs the hidden set so a
  // "current hit" can't sit in a column the grid can't scroll to
  useEffect(() => {
    useGridFilter.getState().setHiddenCols(hiddenCols);
  }, [hiddenCols]);
  useEffect(() => () => useGridFilter.getState().setHiddenCols(new Set()), [statement.index]);
  // leaving this grid (tab switch / new result) resets the filter — carrying
  // it into a different result set would silently hide rows there
  useEffect(() => () => useGridFilter.getState().clear(), [statement.index]);

  // find-in-results highlighting (⌘F): hit set + current hit for this grid
  const findSet = useFind((s) => (s.open ? s.hitSet : null));
  const findCur = useFind((s) => (s.open && s.hits.length > 0 ? s.hits[s.idx] : null));

  // prefix x-offsets of view columns (reorder-aware) for pointer hit-tests
  const viewOffsets = useMemo(() => {
    const off = new Array<number>(viewColLen + 1);
    off[0] = 0;
    for (let i = 0; i < viewColLen; i++) off[i + 1] = off[i] + colWidths[colAt(i)];
    return off;
  }, [viewColLen, colWidths, colAt]);
  const viewColFromX = useCallback(
    (x: number): number | null => {
      if (viewColLen === 0) return null;
      if (x <= 0) return 0;
      if (x >= viewOffsets[viewColLen]) return viewColLen - 1;
      let lo = 0;
      let hi = viewColLen - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (viewOffsets[mid + 1] <= x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [viewColLen, viewOffsets],
  );

  // ⌘F current hit is data-indexed — map into view space before scrolling
  useEffect(() => {
    if (!findCur) return;
    const vr = rowViewOf ? rowViewOf[findCur.r] : findCur.r;
    if (vr === undefined) return; // hit lives in a quick-filtered-out row
    const vc = colViewOf ? colViewOf[findCur.c] : findCur.c;
    if (vc === undefined) return; // hit lives in a hidden column
    rowVirt.scrollToIndex(Math.min(vr, Math.max(0, viewLen - 1)));
    colVirt.scrollToIndex(Math.min(vc, Math.max(0, viewColLen - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findCur, rowViewOf, colViewOf]);
  // ------------------------------------------------------------------------

  // inline new-row draft (table browser only)
  const draftRow = useBrowser((s) => s.draftRow);
  const draftError = useBrowser((s) => s.draftError);
  const setDraftCell = useBrowser((s) => s.setDraftCell);
  const commitDraft = useBrowser((s) => s.commitDraft);
  const cancelDraft = useBrowser((s) => s.cancelDraft);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const snapshot = useSchema((s) =>
    activeProfileId ? s.snapshots[activeProfileId] : undefined,
  );
  const showDraft = insertable && draftRow !== null;
  const draftH = showDraft ? DRAFT_H : 0;
  // trackpad-scroll a long value inside a draft input: wheel must pan the
  // INPUT's overflow, not the grid behind it. preventDefault needs a
  // non-passive listener, so it's attached natively via callback ref.
  const draftWheelRef = useCallback((band: HTMLDivElement | null) => {
    if (!band) return;
    band.addEventListener(
      "wheel",
      (e) => {
        const t = e.target as HTMLElement;
        if (!(t instanceof HTMLInputElement)) return;
        if (t.scrollWidth <= t.clientWidth) return;
        t.scrollLeft += e.deltaX !== 0 ? e.deltaX : e.deltaY;
        e.preventDefault(); // keep the grid scroller still
      },
      { passive: false },
    );
  }, []);
  // first VISIBLE non-ctid column — data order broke autofocus when the
  // first data column was hidden (no rendered draft cell matched)
  const firstDraftCol = viewCols.find((d) => cols[d]?.name !== "ctid") ?? -1;

  const [editing, setEditing] = useState<{
    r: number;
    c: number;
    draft: string;
    /** cell was NULL when the editor opened — an untouched close must NOT stage '' */
    startedNull: boolean;
    /** type-aware editor variant */
    kind: "text" | "bool" | "enum";
    enumLabels?: string[];
  } | null>(null);
  /** transposed single-row viewer (Space) */
  const [peekRow, setPeekRow] = useState<number | null>(null);

  // focused cell drives the inspector — debounced so holding an arrow key
  // doesn't re-render (and re-parse) the inspector on every step
  useEffect(() => {
    if (!sel.focus) return;
    const t = setTimeout(() => {
      useInspector.getState().setTarget({
        stmtIndex: statement.index,
        row: rowAt(sel.focus!.r),
        col: colAt(sel.focus!.c),
      });
    }, 60);
    return () => clearTimeout(t);
  }, [sel.focus, statement.index, rowAt, colAt]);

  const colEditMeta = (c: number) =>
    editMap && editMap !== "loading" && editMap !== "unavailable"
      ? editMap.columns[c]
      : undefined;

  /** open the inline editor for a VIEW cell (sort/reorder-aware) */
  const startEdit = useCallback(
    (viewR: number, viewC: number, seed?: string) => {
      const r = rowAt(viewR);
      const c = colAt(viewC);
      const meta = colEditMeta(c);
      if (!meta?.editable) {
        flashReadOnlyReason(
          editMap === "loading"
            ? "editability still loading — try again in a moment"
            : editMap === "unavailable" || !editMap
              ? "read-only: no editability metadata for this result"
              : `read-only: ${meta?.reason ?? "column is not editable"}`,
        );
        return;
      }
      // a truncated cell's grid value is only the 8KB prefix — editing it
      // inline would commit the prefix over the full value. Route to the
      // inspector, which fetches (and gates editing on) the full value.
      if (statement.truncated.has(`${r}:${c}`)) {
        useInspector.getState().requestEdit({ stmtIndex: statement.index, row: r, col: c });
        return;
      }
      const k = editKey(statement.index, r, c);
      const current = pending[k] ? pending[k].value : rows[r][c];
      // JSON cells edit in the inspector — a one-line input is hostile UX.
      // Routing is by column TYPE only: a text cell that merely looks like
      // JSON must edit as plain text (the '[draft]' corruption class).
      const isJson = meta.type_name === "jsonb" || meta.type_name === "json";
      if (isJson && current != null) {
        useInspector.getState().requestEdit({ stmtIndex: statement.index, row: r, col: c });
        return;
      }
      // type-aware editor: bool toggle / enum picker instead of a text box
      let kind: "text" | "bool" | "enum" = "text";
      let enumLabels: string[] | undefined;
      if (meta.type_name === "bool") kind = "bool";
      else {
        const pid = useConnections.getState().activeProfileId;
        const snap = pid ? useSchema.getState().snapshots[pid] : undefined;
        const en = snap?.enums.find((x) => x.name === meta.type_name);
        if (en) {
          kind = "enum";
          enumLabels = en.labels;
        }
      }
      setEditing({
        r: viewR,
        c: viewC,
        // typing a printable char replaces the content (spreadsheet grammar)
        draft: seed ?? (current ?? ""),
        startedNull: current === null,
        kind,
        enumLabels,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editMap, pending, rows, statement.index, statement.truncated, rowAt, colAt],
  );

  const saveEdit = useCallback(
    (value: string | null, advance: boolean | "right" = false) => {
      if (!editing) return;
      const finish = () => {
        setEditing(null);
        containerRef.current?.focus();
        if (advance === "right") {
          const next = sel.moveFocus(0, 1, false);
          colVirt.scrollToIndex(next.c);
        } else if (advance) {
          const next = sel.moveFocus(1, 0, false);
          rowVirt.scrollToIndex(next.r);
        }
      };
      // opened on NULL and left empty → still NULL, stage nothing (empty
      // string is only reachable explicitly via Set EMPTY)
      if (value === "" && editing.startedNull) {
        finish();
        return;
      }
      const dataR = rowAt(editing.r);
      const dataC = colAt(editing.c);
      // rows can be replaced/shrunk under an open editor (browser re-run) —
      // never stage against a row that no longer exists
      if (!rows[dataR]) {
        finish();
        return;
      }
      useEdits.getState().setEdit({
        stmtIndex: statement.index,
        row: dataR,
        col: dataC,
        value,
        original: rows[dataR][dataC],
      });
      finish();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, rows, statement.index, rowAt, colAt, sel.moveFocus, rowVirt, colVirt],
  );

  // monotonically bumped per copy — a newer copy (or unmount) abandons any
  // in-flight chunked build so it can't overwrite a later copy's clipboard
  const copyRun = useRef(0);
  /** runId of the chunked build in flight (null = none) — abandon detection
   * can't lean on the progress message, which a real error may displace */
  const copyBuildRun = useRef<number | null>(null);
  useEffect(
    () => () => {
      copyRun.current++;
      if (copyBuildRun.current != null) {
        // remount/unmount mid-build (statement chip, tab switch): the OLD
        // clipboard content survives — never abandon without saying so
        // (flash is a store write, it outlives this component)
        copyBuildRun.current = null;
        flashReadOnlyReason("copy cancelled — result changed before it finished");
      }
    },
    [],
  );

  const copySelection = useCallback(
    (format: CopyFormat) => {
      const rect: SelRect | null = sel.rect;
      if (!rect) return;
      copyRun.current++;
      if (copyBuildRun.current != null) {
        // a superseded chunked build leaves its progress message behind —
        // the new copy takes the slot over, no cancel flash (the user asked)
        copyBuildRun.current = null;
        const cur = useEdits.getState().lastError;
        if (cur?.startsWith("building copy…")) useEdits.setState({ lastError: null });
      }
      // truncated cells copy as their 8KB prefix — count the ones inside the
      // selection (walk the truncated set, not the rect: the set stays small)
      // and flash so the prefix never ships silently as the full value
      let truncCount = 0;
      for (const key of statement.truncated) {
        const sep = key.indexOf(":");
        const vr0 = rowViewOf ? rowViewOf[Number(key.slice(0, sep))] : Number(key.slice(0, sep));
        if (vr0 === undefined || vr0 < rect.r0 || vr0 > rect.r1) continue;
        const vc0 = colViewOf ? colViewOf[Number(key.slice(sep + 1))] : Number(key.slice(sep + 1));
        if (vc0 === undefined || vc0 < rect.c0 || vc0 > rect.c1) continue;
        truncCount++;
      }
      const truncFlash = () => {
        if (truncCount > 0)
          flashReadOnlyReason(
            `${truncCount} truncated cell${truncCount === 1 ? "" : "s"} copied as 8KB prefix — open in inspector for full values`,
          );
      };
      // the selection rect is view-space — resolve through the sort/reorder
      // maps so what's copied is exactly what's on screen
      const dataCs: number[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) dataCs.push(colAt(c));
      const selCols = dataCs.map((dc) => cols[dc]);
      // copy-as-INSERT gets the REAL table name (single-source results) and
      // drops locator ctid columns — an INSERT with ctid is invalid SQL
      const map = editMap && editMap !== "loading" && editMap !== "unavailable" ? editMap : null;
      const tableOids = map ? Object.keys(map.tables) : [];
      const table = map && tableOids.length === 1 ? map.tables[Number(tableOids[0])] : undefined;
      const ctidCols = map
        ? new Set(
            dataCs
              .map((dc, i) => (map.columns[dc]?.is_ctid ? i : -1))
              .filter((i) => i >= 0),
          )
        : undefined;

      const totalRows = rect.r1 - rect.r0 + 1;
      // big TSV copies build in rAF-yielded slices, progress through the
      // status-bar message slot. Fidelity contract: formatCells joins TSV rows
      // with \n and adds no header, so stitching per-slice outputs with \n is
      // byte-identical to one full formatCells call.
      if (format === "tsv" && totalRows * dataCs.length >= COPY_ASYNC_CELLS) {
        const runId = copyRun.current;
        copyBuildRun.current = runId;
        const parts: string[] = [];
        let r = rect.r0;
        const step = () => {
          if (copyRun.current !== runId) return; // superseded — abandon
          const slice: (string | null)[][] = [];
          const end = Math.min(rect.r1, r + COPY_SLICE_ROWS - 1);
          for (; r <= end; r++) {
            const row = rows[rowAt(r)];
            if (!row) continue; // selection outlived a shrunk result
            slice.push(dataCs.map((dc) => row[dc]));
          }
          if (slice.length > 0)
            parts.push(formatCells(selCols, slice, format, { table, ctidCols }));
          if (r <= rect.r1) {
            // a progress tick may only overwrite an empty slot or its own
            // previous tick — never a real error that landed mid-build
            const cur = useEdits.getState().lastError;
            if (cur === null || cur.startsWith("building copy…"))
              useEdits.setState({
                lastError: `building copy… ${Math.round(((r - rect.r0) / totalRows) * 100)}%`,
              });
            nextCopyTick(step);
            return;
          }
          writeText(parts.join("\n"))
            .catch(console.error)
            .finally(() => {
              if (copyBuildRun.current === runId) copyBuildRun.current = null;
              if (copyRun.current !== runId) return;
              const cur = useEdits.getState().lastError;
              if (cur?.startsWith("building copy…")) useEdits.setState({ lastError: null });
              truncFlash();
            });
        };
        step();
        return;
      }

      const selRows: (string | null)[][] = [];
      for (let r = rect.r0; r <= rect.r1; r++) {
        const row = rows[rowAt(r)];
        if (!row) continue; // selection outlived a shrunk result — never crash ⌘C
        selRows.push(dataCs.map((dc) => row[dc]));
      }
      // a SINGLE cell copies raw — TSV quoting ("" doubling, wrapping) is for
      // multi-cell spreadsheet paste and reads as garbage in an input field
      if (format === "tsv" && selRows.length === 1 && selRows[0].length === 1) {
        writeText(selRows[0][0] ?? "").catch(console.error);
        truncFlash();
        return;
      }
      // tauri plugin, not navigator.clipboard — dev origin is insecure-context
      writeText(formatCells(selCols, selRows, format, { table, ctidCols })).catch(console.error);
      truncFlash();
    },
    [sel.rect, cols, rows, editMap, rowAt, colAt, statement.truncated, rowViewOf, colViewOf],
  );

  /** export loaded rows (or the selection when it spans >1 cell) to a file
   * via the native save dialog. Exports what the grid HOLDS — a capped result
   * exports the loaded rows, never a silent refetch. */
  const exportRows = useCallback(
    async (format: CopyFormat) => {
      const rect = sel.rect;
      const useSel = !!rect && !(rect.r0 === rect.r1 && rect.c0 === rect.c1);
      // selection → view-mapped slice; else every loaded row in view order
      const dataCs: number[] = [];
      if (useSel && rect) for (let c = rect.c0; c <= rect.c1; c++) dataCs.push(colAt(c));
      else for (let c = 0; c < viewColLen; c++) dataCs.push(colAt(c));
      const r0 = useSel && rect ? rect.r0 : 0;
      // VIEW extent, not rows.length — under the quick-filter, view indexes
      // past rowOrder fall back to identity and would export duplicate rows
      const r1 = useSel && rect ? rect.r1 : viewLen - 1;
      const outCols = dataCs.map((dc) => cols[dc]);
      const outRows: (string | null)[][] = [];
      for (let r = r0; r <= r1; r++) {
        const dataR = rowAt(r);
        if (rows[dataR]) outRows.push(dataCs.map((dc) => rows[dataR][dc]));
      }
      const map = editMap && editMap !== "loading" && editMap !== "unavailable" ? editMap : null;
      const tableOids = map ? Object.keys(map.tables) : [];
      const table = map && tableOids.length === 1 ? map.tables[Number(tableOids[0])] : undefined;
      const ctidCols = map
        ? new Set(dataCs.map((dc, i) => (map.columns[dc]?.is_ctid ? i : -1)).filter((i) => i >= 0))
        : undefined;
      const ext = format === "insert" ? "sql" : format === "markdown" ? "md" : format;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          defaultPath: `${table?.split(".").pop() ?? "qwry-export"}.${ext}`,
          filters: [{ name: format.toUpperCase(), extensions: [ext] }],
        });
        if (!path) return; // dialog cancelled
        const text = formatCells(outCols, outRows, format, { table, ctidCols });
        await invoke("write_text_file", { path, contents: text });
      } catch (e) {
        useResults.setState({
          globalError: {
            message: `export failed: ${(e as { message?: string }).message ?? String(e)}`,
            position: null,
            code: null,
          },
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel.rect, cols, rows, viewLen, viewColLen, editMap, rowAt, colAt],
  );

  // status-bar selection stats — computed here because the view→data maps
  // live here. Wire text throughout: numeric-ness is per-value (strict
  // decimal/scientific shape; a numeric-typed col can still hold NULLs).
  useEffect(() => {
    const rect = sel.rect;
    const publish = useGridStats.getState().set;
    if (!rect || (rect.r0 === rect.r1 && rect.c0 === rect.c1)) {
      publish(null);
      return;
    }
    const cells = (rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1);
    if (cells > 200_000) {
      publish({ cells, nonNull: 0, numeric: 0, sum: 0, min: 0, max: 0, tooBig: true });
      return;
    }
    const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
    let nonNull = 0;
    let numeric = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row = rows[rowAt(r)];
      if (!row) continue;
      for (let c = rect.c0; c <= rect.c1; c++) {
        const v = row[colAt(c)];
        if (v === null || v === undefined) continue;
        nonNull++;
        if (NUM.test(v)) {
          const n = Number(v);
          numeric++;
          sum += n;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
    }
    publish({ cells, nonNull, numeric, sum, min, max, tooBig: false });
  }, [sel.rect, rows, rowAt, colAt]);
  // grid unmounts (tab switch, new result) → stale stats must not linger
  useEffect(() => () => useGridStats.getState().set(null), []);

  // preventDefault on mousedown kills native text selection but also focus —
  // refocus the container manually so keyboard nav keeps working.
  const beginDrag = useCallback(
    (e: React.MouseEvent, pos: { r: number; c: number }, mode: DragMode) => {
      if (e.button !== 0) return;
      e.preventDefault();
      containerRef.current?.focus();
      sel.startDrag(pos, e.shiftKey, mode);
      // seed from the EVENT — pointer.current is stale until the first
      // mousemove, which would fake instant "movement" and false-arm the loop
      pointer.current = { x: e.clientX, y: e.clientY };
      startAutoScroll();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel],
  );

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; dataC: number } | null>(
    null,
  );

  // ---- delegated cell mouse handling (cells carry no listeners) ----
  const cellAt = (e: React.MouseEvent): { r: number; c: number } | null => {
    const el = (e.target as HTMLElement).closest?.("[data-r]") as HTMLElement | null;
    if (!el) return null;
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    return Number.isFinite(r) && Number.isFinite(c) ? { r, c } : null;
  };

  // drag-select coalesced to one store write per frame — mouseover previously
  // fired a full-grid re-render per cell crossed
  const dragRaf = useRef<number | null>(null);
  const dragPos = useRef<{ r: number; c: number } | null>(null);
  const dragOverThrottled = useCallback(
    (p: { r: number; c: number }) => {
      dragPos.current = p;
      if (dragRaf.current != null) return;
      dragRaf.current = requestAnimationFrame(() => {
        dragRaf.current = null;
        if (dragPos.current) sel.dragOver(dragPos.current);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel.dragOver],
  );

  // ---- edge autoscroll while drag-selecting ----
  // dragging past the viewport edge scrolls the grid and keeps extending the
  // selection toward the pointer (previously selection stopped dead at the
  // visible edge). All loop inputs live in refs so the rAF callback is stable.
  const pointer = useRef({ x: 0, y: 0 });
  const dragLive = useRef(false);
  /** where the drag STARTED — autoscroll arms only after real movement, so
   * click-and-hold on a cell near an edge doesn't creep the grid away */
  const dragStart = useRef({ x: 0, y: 0 });
  const dragMoved = useRef(false);
  const autoRaf = useRef<number | null>(null);
  const loopEnv = useRef({ rowsLen: 0, draftH: 0, viewColFromX, dragOver: sel.dragOver });
  loopEnv.current = { rowsLen: viewLen, draftH, viewColFromX, dragOver: sel.dragOver };

  useEffect(() => {
    const mm = (e: MouseEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", mm);
    return () => window.removeEventListener("mousemove", mm);
  }, []);

  const startAutoScroll = () => {
    dragLive.current = true;
    dragStart.current = { ...pointer.current };
    dragMoved.current = false;
    if (autoRaf.current != null) return;
    const loop = () => {
      autoRaf.current = null;
      if (!dragLive.current) return;
      // arm only once the pointer actually travelled — holding still (even in
      // the edge zone) is a click, not a drag
      if (!dragMoved.current) {
        const dxm = pointer.current.x - dragStart.current.x;
        const dym = pointer.current.y - dragStart.current.y;
        if (dxm * dxm + dym * dym < 25) {
          autoRaf.current = requestAnimationFrame(loop);
          return;
        }
        dragMoved.current = true;
      }
      const scroller = scrollRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const M = 24; // edge threshold
        const MAX = 28; // px per frame
        const { x, y } = pointer.current;
        let dx = 0;
        let dy = 0;
        if (y < rect.top + HEADER_H + M) dy = -Math.min(MAX, rect.top + HEADER_H + M - y);
        else if (y > rect.bottom - M) dy = Math.min(MAX, y - (rect.bottom - M));
        if (x < rect.left + ROWNUM_W + M) dx = -Math.min(MAX, rect.left + ROWNUM_W + M - x);
        else if (x > rect.right - M) dx = Math.min(MAX, x - (rect.right - M));
        if (dx !== 0 || dy !== 0) {
          scroller.scrollBy(dx, dy);
          const env = loopEnv.current;
          const localY =
            Math.min(Math.max(y, rect.top + HEADER_H + env.draftH), rect.bottom) - rect.top;
          const localX = Math.min(Math.max(x, rect.left + ROWNUM_W), rect.right) - rect.left;
          const viewR = Math.max(
            0,
            Math.min(
              env.rowsLen - 1,
              Math.floor((scroller.scrollTop + localY - HEADER_H - env.draftH) / ROW_H),
            ),
          );
          const viewC = env.viewColFromX(scroller.scrollLeft + localX - ROWNUM_W) ?? 0;
          env.dragOver({ r: viewR, c: viewC });
        }
      }
      autoRaf.current = requestAnimationFrame(loop);
    };
    autoRaf.current = requestAnimationFrame(loop);
  };

  // releasing the button (anywhere, incl. outside the window) ends the drag
  useEffect(() => {
    const up = () => {
      dragLive.current = false;
      sel.endDrag();
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.endDrag]);


  /** stage a value (or NULL/DEFAULT) for every editable cell in the selection
   * — ONE batched store write, ONE undo step */
  const setSelectionValue = useCallback(
    (value: string | null, useDefault = false) => {
      const rect = sel.rect;
      if (!rect) return;
      const batch = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        const dataC = colAt(c);
        if (!colEditMeta(dataC)?.editable) continue;
        for (let r = rect.r0; r <= rect.r1; r++) {
          const dataR = rowAt(r);
          if (!rows[dataR]) continue;
          batch.push({
            stmtIndex: statement.index,
            row: dataR,
            col: dataC,
            value,
            useDefault,
            original: rows[dataR][dataC],
          });
        }
      }
      useEdits.getState().setEditsBatch(batch);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel.rect, editMap, rows, statement.index, rowAt, colAt],
  );

  /** revert every staged edit inside the selection — one undo step */
  const revertSelection = useCallback(() => {
    const rect = sel.rect;
    if (!rect) return;
    const st = useEdits.getState();
    const batch = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      const dataC = colAt(c);
      for (let r = rect.r0; r <= rect.r1; r++) {
        const dataR = rowAt(r);
        const k = editKey(statement.index, dataR, dataC);
        if (st.pending[k]) {
          // value === original removes the pending entry in the batch path
          batch.push({
            stmtIndex: statement.index,
            row: dataR,
            col: dataC,
            value: rows[dataR][dataC],
            original: rows[dataR][dataC],
          });
        }
      }
    }
    st.setEditsBatch(batch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.rect, rows, statement.index, rowAt, colAt]);

  const selectionHasPending = useMemo(() => {
    const rect = sel.rect;
    if (!rect) return false;
    for (let c = rect.c0; c <= rect.c1; c++) {
      const dataC = colAt(c);
      for (let r = rect.r0; r <= rect.r1; r++) {
        if (pending[editKey(statement.index, rowAt(r), dataC)]) return true;
      }
    }
    return false;
  }, [sel.rect, pending, statement.index, rowAt, colAt]);

  /** ⌘D: the selection's top row fills every row below it (per column) */
  const fillDown = useCallback(() => {
    const rect = sel.rect;
    if (!rect || rect.r1 === rect.r0) return;
    const batch = [];
    for (let c = rect.c0; c <= rect.c1; c++) {
      const dataC = colAt(c);
      if (!colEditMeta(dataC)?.editable) continue;
      const topR = rowAt(rect.r0);
      const topK = editKey(statement.index, topR, dataC);
      const src = pending[topK] ? pending[topK].value : rows[topR][dataC];
      for (let r = rect.r0 + 1; r <= rect.r1; r++) {
        const dataR = rowAt(r);
        if (!rows[dataR]) continue;
        batch.push({
          stmtIndex: statement.index,
          row: dataR,
          col: dataC,
          value: src,
          original: rows[dataR][dataC],
        });
      }
    }
    useEdits.getState().setEditsBatch(batch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.rect, pending, rows, statement.index, rowAt, colAt, editMap]);

  /** ⌘V: paste a TSV block (Excel/Sheets) anchored at the selection's
   * top-left, or a single value into the whole selection — STAGED, so ⌘S
   * previews the generated SQL before anything touches the DB */
  const pasteIntoSelection = useCallback((text: string) => {
    const rect = sel.rect;
    if (!rect || !text) return;
    const batch = [];
    const isBlock = text.includes("\t") || text.includes("\n");
    if (isBlock) {
      const grid = text
        .replace(/\r/g, "")
        .split("\n")
        .filter((l, i, a) => !(i === a.length - 1 && l === ""))
        .map((l) => l.split("\t"));
      for (let dr = 0; dr < grid.length; dr++) {
        const viewR = rect.r0 + dr;
        if (viewR >= viewLen) break;
        for (let dc = 0; dc < grid[dr].length; dc++) {
          const viewC = rect.c0 + dc;
          if (viewC >= viewColLen) break;
          const dataC = colAt(viewC);
          if (!colEditMeta(dataC)?.editable) continue;
          const dataR = rowAt(viewR);
          if (!rows[dataR]) continue;
          batch.push({
            stmtIndex: statement.index,
            row: dataR,
            col: dataC,
            value: grid[dr][dc],
            original: rows[dataR][dataC],
          });
        }
      }
    } else {
      for (let c = rect.c0; c <= rect.c1; c++) {
        const dataC = colAt(c);
        if (!colEditMeta(dataC)?.editable) continue;
        for (let r = rect.r0; r <= rect.r1; r++) {
          const dataR = rowAt(r);
          if (!rows[dataR]) continue;
          batch.push({
            stmtIndex: statement.index,
            row: dataR,
            col: dataC,
            value: text,
            original: rows[dataR][dataC],
          });
        }
      }
    }
    useEdits.getState().setEditsBatch(batch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.rect, rows, viewColLen, statement.index, rowAt, colAt, editMap]);

  const selectionHasEditable = useMemo(() => {
    const rect = sel.rect;
    if (!rect) return false;
    for (let c = rect.c0; c <= rect.c1; c++) {
      if (colEditMeta(colAt(c))?.editable) return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.rect, editMap]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return; // cell editor owns the keyboard
      if (peekRow !== null) return; // row peek modal owns the keyboard
      // embedded inputs (draft band, future controls) own their keys — the
      // grammar was eating Backspace/Tab/arrows and staging NULLs while typing
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const meta = e.metaKey;
      const go = (dr: number, dc: number, extend = e.shiftKey) => {
        const next = sel.moveFocus(dr, dc, extend);
        rowVirt.scrollToIndex(next.r);
        colVirt.scrollToIndex(next.c);
      };
      if (e.key === "Escape" && copyBuildRun.current != null) {
        // cancel an in-flight chunked ⌘C — the clipboard still holds the OLD
        // content, same honesty flash as the remount-abandon path
        e.preventDefault();
        copyRun.current++;
        copyBuildRun.current = null;
        flashReadOnlyReason("copy cancelled — result changed before it finished");
        return;
      }
      if (e.key === "Escape" && showDraft) {
        // grid-focused Esc: an EMPTY draft band closes; one with typed values
        // refocuses instead — a stray Esc must never eat half-typed data
        // (discarding stays a deliberate act: Esc inside the band)
        const hasContent = Object.values(useBrowser.getState().draftRow ?? {}).some(
          (c) => c.isNull || c.touched || c.text !== "",
        );
        e.preventDefault();
        if (hasContent) {
          // all columns NULL-toggled → every input is disabled; fall back to a
          // ∅ button so the keyboard path still lands inside the band
          const el =
            containerRef.current?.querySelector<HTMLElement>(
              ".vgrid-draft-input:not(:disabled)",
            ) ?? containerRef.current?.querySelector<HTMLElement>(".vgrid-draft-null");
          el?.focus();
        } else {
          cancelDraft();
        }
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelection("tsv");
        return;
      }
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        sel.selectAll();
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void import("@tauri-apps/plugin-clipboard-manager").then(({ readText }) =>
          readText().then((t) => t && pasteIntoSelection(t)).catch(() => {}),
        );
        return;
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        useEdits.getState().undo();
        return;
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        useEdits.getState().redo();
        return;
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        fillDown();
        return;
      }
      // ⌘⇧D (discard staged edits) belongs to the window handler — fall through

      const moves: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        go(
          meta && mv[0] !== 0 ? mv[0] * viewLen : mv[0],
          meta && mv[1] !== 0 ? mv[1] * viewColLen : mv[1],
        );
        return;
      }
      const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 2);
      if (e.key === "PageDown") {
        e.preventDefault();
        go(page, 0);
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        go(-page, 0);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        go(meta ? -viewLen : 0, meta ? 0 : -viewColLen);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        go(meta ? viewLen : 0, meta ? 0 : viewColLen);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        go(0, e.shiftKey ? -1 : 1, false);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !meta) {
        e.preventDefault();
        setSelectionValue(null); // stage NULL over the selection (undoable)
        return;
      }
      if (e.key === " " && sel.focus && !meta) {
        e.preventDefault();
        setPeekRow((p) => (p === null ? sel.focus!.r : null));
        return;
      }
      if ((e.key === "Enter" || e.key === "F2") && sel.focus) {
        e.preventDefault();
        startEdit(sel.focus.r, sel.focus.c);
        return;
      }
      // type-to-edit: a printable char opens the editor seeded with it
      if (
        sel.focus &&
        e.key.length === 1 &&
        !meta &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        startEdit(sel.focus.r, sel.focus.c, e.key);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [copySelection, sel, viewLen, viewColLen, rowVirt, colVirt, startEdit, editing, fillDown, pasteIntoSelection, setSelectionValue, showDraft, cancelDraft],
  );

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

    // ctid locators get the same row-movement guard as edits: pin identity
    // with the row's old values (untruncated same-table columns, deduped)
    const isCtid = map.columns[pkCols[0]]?.is_ctid;
    const locators: [number, string | null][][] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const dataR = rowAt(r);
      const row = rows[dataR];
      if (!row) continue; // never build a locator from a phantom row
      // a truncated locator cell is only the display prefix — a WHERE built
      // from it matches 0 rows and fails with a misleading message
      if (pkCols.some((pc) => statement.truncated.has(`${dataR}:${pc}`))) {
        flashReadOnlyReason("locator value is truncated — cannot safely identify this row");
        return;
      }
      const loc = pkCols.map((pc) => [pc, row[pc]] as [number, string | null]);
      if (isCtid) loc.push(...ctidGuardPairs(map, deletableTableOid, statement, dataR));
      locators.push(loc);
    }
    if (locators.length === 0) return;
    const tableName = map.tables[deletableTableOid] ?? "table";
    const n = locators.length;
    const preview = locators
      .slice(0, 8)
      .map((loc) => {
        const parts = loc
          .slice(0, 4)
          .map(([c, v]) => `${cols[c]?.name ?? `col${c}`} = ${v ?? "NULL"}`);
        if (loc.length > 4) parts.push(`… +${loc.length - 4} identity checks`);
        return `WHERE ${parts.join(" AND ")}`;
      })
      .join("\n");

    const { confirmDanger } = await import("../stores/danger");
    const ok = await confirmDanger(
      `Delete ${n} row${n > 1 ? "s" : ""} from ${tableName}?`,
      `This cannot be undone.\n\n${preview}${n > 8 ? `\n… and ${n - 8} more` : ""}`,
      "Delete",
    );
    if (!ok) return;

    const { executedSql, executedSessionId: sessionId, executedProfileId } = useResults.getState();
    if (!sessionId || !executedSql) return;
    try {
      // cached-mapping feed: the backend plans the DELETEs with zero catalog
      // round trips; a stale hint errors or mismatches → whole batch rolls
      // back. Names come from the snapshot of the profile the RESULT ran on
      // (never the rail-active one — cross-database oids could collide).
      const { buildEditMapHint } = await import("../lib/editHints");
      const resSnap = executedProfileId
        ? useSchema.getState().snapshots[executedProfileId]
        : undefined;
      const mapHint = buildEditMapHint(map, resSnap);
      const outcome = await ipc.deleteRows(sessionId, executedSql, statement.index, deletableTableOid, locators, mapHint);
      if (!outcome.committed) {
        // backend rolled the batch back (a locator matched ≠ 1 row) — nothing changed
        const msgs = [...new Set(outcome.results.filter((r) => !r.ok).map((r) => r.message).filter(Boolean))];
        useEdits.setState({ lastError: `delete rolled back — ${msgs.join("; ")}` });
        return;
      }
      // re-run the exact query so the grid reflects the delete
      void useResults.getState().run(executedSql);
    } catch (e) {
      useResults.setState({
        globalError: { message: (e as { message?: string }).message ?? String(e), position: null, code: null },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.rect, deletableTableOid, editMap, rows, statement.index, statement.truncated, rowAt]);

  // planner row estimates for the "Referenced by" submenu — fired when the
  // context menu opens (labels read them by src key). EXPLAIN uses per-value
  // stats (MCV/histogram), so "≈ 1,240" is the estimate FOR THIS cell value.
  const [fkEstimates, setFkEstimates] = useState<Record<string, number>>({});
  useEffect(() => {
    setFkEstimates({});
    if (!menu) return;
    const f = sel.focus;
    const map = editMap && editMap !== "loading" && editMap !== "unavailable" ? editMap : null;
    if (!f || !map || !snapshot) return;
    const dataC = colAt(f.c);
    const meta = map.columns[dataC];
    const dotted = meta ? map.tables[meta.table_oid] : undefined;
    const value = rows[rowAt(f.r)]?.[dataC];
    if (!dotted || value == null) return;
    const di = dotted.indexOf(".");
    const sch = di === -1 ? "public" : dotted.slice(0, di);
    const tbl = di === -1 ? dotted : dotted.slice(di + 1);
    const colName = cols[dataC].name;
    const inbound = snapshot.foreign_keys
      .filter(
        (k) =>
          k.dst_schema === sch &&
          k.dst_table === tbl &&
          k.dst_cols.length === 1 &&
          k.dst_cols[0] === colName,
      )
      .slice(0, 8); // context menus shouldn't fire a query storm
    if (inbound.length === 0) return;
    const sessionId = useResults.getState().executedSessionId;
    if (!sessionId) return;
    const lit = `'${value.replace(/'/g, "''")}'`;
    let stale = false;
    for (const k of inbound) {
      const key = `${k.src_schema}.${k.src_table}.${k.src_cols[0]}`;
      const sql = `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${qualify(k.src_schema, k.src_table)} WHERE ${qi(k.src_cols[0])} = ${lit}`;
      void ipc
        .execute(sessionId, sql)
        .then((out) => {
          if (stale) return;
          const txt = out.statements[0]?.rows[0]?.[0];
          const n = txt
            ? (JSON.parse(txt) as { Plan?: { "Plan Rows"?: number } }[])[0]?.Plan?.["Plan Rows"]
            : undefined;
          if (typeof n === "number") setFkEstimates((prev) => ({ ...prev, [key]: n }));
        })
        .catch(() => {});
    }
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  /** FK navigation for the focused cell: forward jump + reverse lookup */
  const fkMenuItems = (): MenuNode[] => {
    const f = sel.focus;
    const map = editMap && editMap !== "loading" && editMap !== "unavailable" ? editMap : null;
    if (!f || !map || !snapshot) return [];
    const dataR = rowAt(f.r);
    const dataC = colAt(f.c);
    const meta = map.columns[dataC];
    const dotted = meta ? map.tables[meta.table_oid] : undefined;
    const value = rows[dataR]?.[dataC];
    if (!dotted || value == null) return [];
    const di = dotted.indexOf(".");
    const sch = di === -1 ? "public" : dotted.slice(0, di);
    const tbl = di === -1 ? dotted : dotted.slice(di + 1);
    const colName = cols[dataC].name;
    const openFkQuery = (t: { schema: string; name: string }, col: string) => {
      const lit = `'${value.replace(/'/g, "''")}'`;
      const sql = `SELECT * FROM ${qualify(t.schema, t.name)} WHERE ${qi(col)} = ${lit} LIMIT 100`;
      useTabs.getState().newTab(sql, t.name);
      void useResults.getState().run(sql);
    };
    const items: MenuNode[] = [];
    const fk = snapshot.foreign_keys.find(
      (k) =>
        k.src_schema === sch &&
        k.src_table === tbl &&
        k.src_cols.length === 1 &&
        k.src_cols[0] === colName,
    );
    if (fk) {
      const target = snapshot.tables.find(
        (t) => t.schema === fk.dst_schema && t.name === fk.dst_table,
      );
      if (target) {
        items.push({
          kind: "item",
          label: `Open referenced ${fk.dst_table} →`,
          onSelect: () => openFkQuery(target, fk.dst_cols[0]),
        });
      }
    }
    const inbound = snapshot.foreign_keys.filter(
      (k) =>
        k.dst_schema === sch &&
        k.dst_table === tbl &&
        k.dst_cols.length === 1 &&
        k.dst_cols[0] === colName,
    );
    if (inbound.length > 0) {
      items.push({
        kind: "submenu",
        label: "Referenced by",
        items: inbound.map((k): MenuNode => {
          const src = snapshot.tables.find(
            (t) => t.schema === k.src_schema && t.name === k.src_table,
          );
          const est = fkEstimates[`${k.src_schema}.${k.src_table}.${k.src_cols[0]}`];
          return {
            kind: "item",
            label: `${k.src_table}.${k.src_cols[0]}`,
            hint: est !== undefined ? `≈ ${est.toLocaleString()}` : undefined,
            disabled: !src,
            onSelect: () => src && openFkQuery(src, k.src_cols[0]),
          };
        }),
      });
    }
    return items;
  };

  /** browser: duplicate the focused row into the draft band, PK/ctid cleared */
  const duplicateRow = () => {
    const f = sel.focus;
    const table = useBrowser.getState().table;
    if (!f || !table) return;
    const dataR = rowAt(f.r);
    const prefill: Record<string, { text: string; isNull: boolean; touched?: boolean }> = {};
    // a truncated cell holds only the display prefix — silently inserting it
    // would corrupt the copy; leave those columns untouched (= DEFAULT) and say so
    const skippedCols: string[] = [];
    cols.forEach((c, i) => {
      if (c.name === "ctid" || table.pk.includes(c.name)) return;
      if (statement.truncated.has(`${dataR}:${i}`)) {
        skippedCols.push(c.name);
        return;
      }
      const v = rows[dataR][i];
      // prefilled values are deliberate — a duplicated '' must insert '', not DEFAULT
      prefill[c.name] =
        v === null ? { text: "", isNull: true } : { text: v, isNull: false, touched: true };
    });
    useBrowser.getState().beginDraft(prefill);
    if (skippedCols.length > 0) {
      flashReadOnlyReason(
        `truncated column${skippedCols.length === 1 ? "" : "s"} not copied (left as DEFAULT): ${skippedCols.join(", ")}`,
      );
    }
  };

  const resizing = useRef<{ col: number; startX: number; startW: number } | null>(null);
  // resize drags are rAF-coalesced: one width write per frame off cached start
  // metrics — a raw mousemove handler re-rendered the grid per pointer event
  const resizeRaf = useRef<number | null>(null);
  const resizeX = useRef(0);
  const onResizeStart = (viewCol: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const col = colAt(viewCol); // widths are stored per UNDERLYING column
    resizing.current = { col, startX: e.clientX, startW: colWidths[col] };
    resizeX.current = e.clientX;
    const onMove = (me: MouseEvent) => {
      resizeX.current = me.clientX;
      if (resizeRaf.current != null) return;
      resizeRaf.current = requestAnimationFrame(() => {
        resizeRaf.current = null;
        const r = resizing.current;
        if (!r) return;
        const w = Math.max(MIN_COL_W, r.startW + (resizeX.current - r.startX));
        setWidths((prev) => prev.map((pw, i) => (i === r.col ? w : pw)));
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (resizeRaf.current != null) {
        cancelAnimationFrame(resizeRaf.current);
        resizeRaf.current = null;
      }
      const r = resizing.current;
      resizing.current = null;
      if (!r) return;
      // apply the final width synchronously — a pending frame may not have
      // flushed, and the persisted array must match what's on screen
      const w = Math.max(MIN_COL_W, r.startW + (resizeX.current - r.startX));
      const final = widthsRef.current.map((pw, i) => (i === r.col ? w : pw));
      setWidths(final);
      saveStoredWidths(colSig(cols), final);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ---- header gestures: click = sort · drag = reorder · ⌘/⇧-click = select column ----
  const browserSort = useBrowser((s) => s.sort);
  const [reorderFrom, setReorderFrom] = useState<number | null>(null);
  /** x-offset (content space) of the insertion boundary while reordering */
  const [dropLine, setDropLine] = useState<number | null>(null);
  const headerDrag = useRef<{
    fromView: number;
    startX: number;
    moved: boolean;
    toView: number | null;
  } | null>(null);
  const dropRaf = useRef<number | null>(null);

  /** where a drop at clientX would land: target view col + the boundary line
   * x matching the splice semantics (left edge when moving left, right edge
   * when moving right) */
  const computeDrop = useCallback(
    (clientX: number, fromView: number): { toView: number; lineX: number } | null => {
      const scroller = scrollRef.current;
      if (!scroller) return null;
      const x = clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft - ROWNUM_W;
      const toView = viewColFromX(x);
      if (toView == null) return null;
      const lineX =
        toView < fromView
          ? viewOffsets[toView]
          : toView > fromView
            ? viewOffsets[toView + 1]
            : viewOffsets[fromView]; // over itself — line sits at its own edge
      return { toView, lineX };
    },
    [viewColFromX, viewOffsets],
  );

  /** header-menu direct sort/clear (cycle-free variants of toggleSort) */
  const toggleSortTo = (dataC: number, dir: "asc" | "desc") => {
    const name = cols[dataC]?.name;
    if (!name) return;
    if (insertable) useBrowser.getState().setSort({ col: name, dir: dir.toUpperCase() as "ASC" | "DESC" });
    else setClientSort({ col: dataC, dir });
  };
  const clearSort = () => {
    if (insertable) useBrowser.getState().setSort(null);
    else setClientSort(null);
  };

  const toggleSort = (dataC: number) => {
    const name = cols[dataC]?.name;
    if (!name) return;
    if (insertable) {
      // browser data is paged — sort must be a real ORDER BY on the server
      const b = useBrowser.getState();
      const cur = b.sort;
      if (!cur || cur.col !== name) b.setSort({ col: name, dir: "ASC" });
      else if (cur.dir === "ASC") b.setSort({ col: name, dir: "DESC" });
      else b.setSort(null);
    } else {
      setClientSort((cur) =>
        !cur || cur.col !== dataC
          ? { col: dataC, dir: "asc" }
          : cur.dir === "asc"
            ? { col: dataC, dir: "desc" }
            : null,
      );
    }
  };

  const onHeaderMouseDown = (viewC: number, e: React.MouseEvent) => {
    // macOS ctrl+click is a context click — never a drag/select gesture
    if (e.ctrlKey) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.shiftKey) {
      // modifier-click keeps the old column-selection gesture
      beginDrag(e, { r: 0, c: viewC }, "col");
      return;
    }
    e.preventDefault();
    containerRef.current?.focus();
    headerDrag.current = { fromView: viewC, startX: e.clientX, moved: false, toView: null };
    const onMove = (me: MouseEvent) => {
      const hd = headerDrag.current;
      if (!hd) return;
      if (!hd.moved && Math.abs(me.clientX - hd.startX) > 4) {
        hd.moved = true;
        setReorderFrom(hd.fromView);
      }
      if (!hd.moved) return;
      // live insertion indicator — the drop uses the SAME computation, so the
      // line is always exactly where the column will land
      if (dropRaf.current != null) return;
      dropRaf.current = requestAnimationFrame(() => {
        dropRaf.current = null;
        const cur = headerDrag.current;
        if (!cur?.moved) return;
        const drop = computeDrop(me.clientX, cur.fromView);
        if (!drop) return;
        cur.toView = drop.toView;
        setDropLine(drop.toView === cur.fromView ? null : drop.lineX);
      });
    };
    const onUp = (me: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const hd = headerDrag.current;
      headerDrag.current = null;
      setReorderFrom(null);
      setDropLine(null);
      if (!hd) return;
      if (!hd.moved) {
        // plain click selects the column; sorting lives on the arrow button
        sel.startDrag({ r: 0, c: hd.fromView }, false, "col");
        sel.endDrag();
        return;
      }
      const toView = hd.toView ?? computeDrop(me.clientX, hd.fromView)?.toView ?? null;
      if (toView == null || toView === hd.fromView) return;
      setColOrder((prev) => {
        // colOrder stays a FULL permutation; the gesture speaks VIEW (visible)
        // indexes — map through viewCols so hidden columns keep their place
        const full = prev ?? cols.map((_, i) => i);
        const fromData = viewCols[hd.fromView];
        if (fromData === undefined) return prev;
        const without = full.filter((d) => d !== fromData);
        const visibleWithout = viewCols.filter((d) => d !== fromData);
        const anchorData = visibleWithout[toView]; // undefined = past the end
        const at = anchorData === undefined ? without.length : without.indexOf(anchorData);
        without.splice(at, 0, fromData);
        return without;
      });
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
      // ⌘V arrives as a native paste event (the app menu owns the accelerator,
      // so a keydown handler would never see it)
      onPaste={(e) => {
        // a paste INTO the draft band (or any embedded control) bubbles up
        // here — swallowing it killed the input paste AND staged the clipboard
        // over the grid selection
        const tag = (e.target as HTMLElement).tagName;
        if (editing || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        if (text) pasteIntoSelection(text);
      }}
      onMouseUp={sel.endDrag}
      onContextMenu={(e) => {
        e.preventDefault();
        setHeaderMenu(null); // one menu at a time
        // right-click OUTSIDE the selection retargets it to the hit cell —
        // the menu must act on the cell under the pointer, never on a
        // leftover selection somewhere else (and a bare right-click on a
        // cell now selects it instead of showing nothing)
        const p = cellAt(e);
        if (p && !inRect(p.r, p.c, sel.rect)) {
          sel.startDrag(p, false, "cell");
          sel.endDrag();
        }
        if (p || sel.rect) setMenu({ x: e.clientX, y: e.clientY });
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
          onMouseDown={(e) => {
            const p = cellAt(e);
            if (p) beginDrag(e, p, "cell");
          }}
          onMouseOver={(e) => {
            const p = cellAt(e);
            if (p) dragOverThrottled(p);
          }}
          onDoubleClick={(e) => {
            const p = cellAt(e);
            if (p) startEdit(p.r, p.c);
          }}
        >
          {/* column-drop insertion guide while reordering */}
          {dropLine != null && (
            <div
              className="vgrid-dropline"
              style={{
                transform: `translateX(${dropLine + ROWNUM_W}px)`,
                height: rowVirt.getTotalSize() + HEADER_H + draftH,
              }}
            />
          )}

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
              const dataC = colAt(vc.index);
              const tn = colType(dataC);
              const glyph = typeIcon(tn);
              const name = cols[dataC].name;
              const sortDir = insertable
                ? browserSort && browserSort.col === name
                  ? browserSort.dir.toLowerCase()
                  : null
                : clientSort && clientSort.col === dataC
                  ? clientSort.dir
                  : null;
              return (
                <div
                  key={vc.key}
                  className={`vgrid-hcell${reorderFrom === vc.index ? " reordering" : ""}${sortDir ? " sorted" : ""}`}
                  style={{
                    transform: `translateX(${vc.start + ROWNUM_W}px)`,
                    width: vc.size,
                    height: HEADER_H,
                  }}
                  title={`${name}${tn ? ` · ${tn}` : ""}\nclick: select column · drag: reorder · right-click: menu`}
                  onMouseDown={(e) => onHeaderMouseDown(vc.index, e)}
                  onMouseEnter={() => sel.dragOver({ r: 0, c: vc.index })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation(); // not the cell menu
                    setMenu(null); // one menu at a time
                    setHeaderMenu({ x: e.clientX, y: e.clientY, dataC });
                  }}
                >
                  {glyph && (
                    <span className="vgrid-htype" style={{ color: glyph.color }}>
                      <glyph.Icon size={12} strokeWidth={2.2} />
                    </span>
                  )}
                  <span className="vgrid-hname">{name}</span>
                  <button
                    className={`vgrid-sortbtn${sortDir ? " on" : ""}${sortDir === "desc" ? " desc" : ""}`}
                    title={
                      sortDir === "asc"
                        ? "Sorted ascending — click for descending"
                        : sortDir === "desc"
                          ? "Sorted descending — click to clear"
                          : "Sort"
                    }
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      // never start a reorder/select from the sort affordance
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSort(dataC);
                    }}
                  >
                    {sortDir ? (
                      <ChevronUp size={12} strokeWidth={2.6} className="chev" />
                    ) : (
                      <ChevronsUpDown size={11} strokeWidth={2} className="chev" />
                    )}
                  </button>
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
              ref={draftWheelRef}
              className="vgrid-draft"
              style={{ top: HEADER_H, height: DRAFT_H }}
              // focus moving into the band clears the grid selection — a row
              // left highlighted behind the draft reads as "that row is live"
              onFocusCapture={() => sel.reset()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation(); // one layer only — the grid handler would re-fire
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
                const name = cols[colAt(vc.index)].name;
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
                          // untouched = DEFAULT; a touched-but-empty field is a
                          // real '' and must not read as DEFAULT anymore
                          placeholder={cell.isNull ? "NULL" : cell.touched ? "" : "DEFAULT"}
                          disabled={cell.isNull}
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autoFocus={colAt(vc.index) === firstDraftCol}
                          spellCheck={false}
                          onChange={(e) =>
                            setDraftCell(name, {
                              text: e.target.value,
                              isNull: false,
                              touched: true,
                            })
                          }
                          onPaste={(e) => {
                            const text = e.clipboardData.getData("text/plain");
                            // single-line text → native single-input paste
                            if (!text.includes("\t") && !text.includes("\n")) return;
                            e.preventDefault();
                            // tabs → a copied grid/spreadsheet ROW: spread
                            // across the draft cells from this column on.
                            // Empty fields stay untouched (= DEFAULT) — the
                            // spreadsheet convention; a deliberate '' is still
                            // reachable by typing in the cell
                            if (text.includes("\t")) {
                              const values = text.replace(/\n+$/, "").split(/\r?\n/)[0].split("\t");
                              let vi = 0;
                              for (let view = vc.index; view < viewColLen && vi < values.length; view++) {
                                const cn = cols[colAt(view)].name;
                                if (cn === "ctid") continue;
                                const v = values[vi];
                                vi++;
                                if (v === "") continue;
                                setDraftCell(cn, {
                                  text: v,
                                  isNull: false,
                                  touched: true,
                                });
                              }
                              return;
                            }
                            // multiline, no tabs = ONE value. The input would
                            // keep only the first line (WebKit drops the rest);
                            // pretty JSON compacts to a single line — identical
                            // jsonb semantics; anything else lands in the draft
                            // state verbatim, newlines intact
                            const trimmed = text.trim();
                            let value = text;
                            if (/^[[{]/.test(trimmed)) {
                              try {
                                value = JSON.stringify(JSON.parse(trimmed));
                              } catch {
                                /* not JSON — verbatim */
                              }
                            }
                            setDraftCell(name, { text: value, isNull: false, touched: true });
                          }}
                        />
                        <button
                          type="button"
                          tabIndex={-1}
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

          {/* cells — memoized; mouse events delegated to the container.
              vr/vc are VIEW positions (data-r/data-c feed the view-space
              selection); values and edit state resolve through the maps. */}
          {rowVirt.getVirtualItems().map((vr) =>
            colVirt.getVirtualItems().map((vc) => {
              const dataR = rowAt(vr.index);
              const dataC = colAt(vc.index);
              const k = editKey(statement.index, dataR, dataC);
              const pendingEdit = pending[k];
              const v = pendingEdit ? pendingEdit.value : rows[dataR][dataC];
              const isDefault = !!pendingEdit?.useDefault;
              const meta = colEditMeta(dataC);
              const warn = meta?.editable ? meta.warn : null;
              return (
                <Cell
                  key={`${vr.key}:${vc.key}`}
                  r={vr.index}
                  c={vc.index}
                  v={v}
                  x={vc.start + ROWNUM_W}
                  y={vr.start + HEADER_H + draftH}
                  width={vc.size}
                  selected={inRect(vr.index, vc.index, sel.rect)}
                  focused={sel.focus?.r === vr.index && sel.focus?.c === vc.index}
                  dirty={!!pendingEdit}
                  flash={flash.has(k)}
                  warn={!!warn}
                  truncated={statement.truncated.has(`${dataR}:${dataC}`)}
                  hit={findSet?.has(hitKey(dataR, dataC)) ?? false}
                  curHit={findCur?.r === dataR && findCur?.c === dataC}
                  num={isNumericCol(dataC)}
                  isDefault={isDefault}
                  title={(meta && !meta.editable ? meta.reason : warn) ?? undefined}
                />
              );
            }),
          )}

          {/* in-place cell editor */}
          {editing && (
            <CellEditor
              x={colVirt.getVirtualItems().find((v) => v.index === editing.c)?.start ?? 0}
              y={(rowVirt.getVirtualItems().find((v) => v.index === editing.r)?.start ?? 0) + draftH}
              width={colWidths[colAt(editing.c)] ?? 160}
              draft={editing.draft}
              placeholder={editing.startedNull ? "NULL" : undefined}
              kind={editing.kind}
              enumLabels={editing.enumLabels}
              onDraft={(d) => setEditing((e) => (e ? { ...e, draft: d } : e))}
              onSave={(advance) => saveEdit(editing.draft, advance)}
              onCommit={(v, advance) => saveEdit(v, advance)}
              onNull={() => saveEdit(null)}
              onCancel={() => {
                setEditing(null);
                containerRef.current?.focus();
              }}
            />
          )}
        </div>
      </div>

      {headerMenu && (
        <ContextMenu
          point={headerMenu}
          onClose={() => setHeaderMenu(null)}
          layerClassName="vgrid-menu-backdrop"
          items={[
            {
              kind: "item",
              label: `Copy name  ${cols[headerMenu.dataC]?.name ?? ""}`,
              onSelect: () => void writeText(cols[headerMenu.dataC]?.name ?? ""),
            },
            { kind: "sep" },
            {
              kind: "item",
              label: `Sort ${cols[headerMenu.dataC]?.name ?? ""} ascending`,
              onSelect: () => toggleSortTo(headerMenu.dataC, "asc"),
            },
            {
              kind: "item",
              label: "Sort descending",
              onSelect: () => toggleSortTo(headerMenu.dataC, "desc"),
            },
            ...(clientSort || (insertable && browserSort)
              ? ([
                  { kind: "item", label: "Clear sort", onSelect: clearSort },
                ] as MenuNode[])
              : []),
            { kind: "sep" },
            {
              kind: "item",
              label: `Hide column ${cols[headerMenu.dataC]?.name ?? ""}`,
              // hiding the LAST visible column would leave an unusable grid
              disabled: viewColLen <= 1,
              onSelect: () => {
                // an invisible active sort is undiscoverable — clear it
                if (!insertable && clientSort?.col === headerMenu.dataC) setClientSort(null);
                setHiddenCols((prev) => new Set([...prev, headerMenu.dataC]));
              },
            },
            ...(hiddenCols.size > 0
              ? ([
                  {
                    kind: "submenu",
                    label: `Show hidden (${hiddenCols.size})`,
                    items: [
                      ...[...hiddenCols].map((d): MenuNode => ({
                        kind: "item",
                        label: cols[d]?.name ?? `col ${d}`,
                        onSelect: () =>
                          setHiddenCols((prev) => {
                            const next = new Set(prev);
                            next.delete(d);
                            return next;
                          }),
                      })),
                      { kind: "sep" },
                      {
                        kind: "item",
                        label: "Show all",
                        onSelect: () => setHiddenCols(new Set()),
                      },
                    ],
                  },
                ] as MenuNode[])
              : []),
          ]}
        />
      )}
      {menu && (
        <ContextMenu
          point={menu}
          onClose={() => setMenu(null)}
          layerClassName="vgrid-menu-backdrop"
          items={[
            { kind: "item", label: "Copy", hint: "⌘C", onSelect: () => copySelection("tsv") },
            {
              kind: "submenu",
              label: "Copy as",
              items: (["tsv", "csv", "json", "markdown", "insert"] as CopyFormat[]).map(
                (f): MenuNode => ({
                  kind: "item",
                  label: f.toUpperCase(),
                  onSelect: () => copySelection(f),
                }),
              ),
            },
            {
              kind: "submenu",
              label:
                sel.rect && !(sel.rect.r0 === sel.rect.r1 && sel.rect.c0 === sel.rect.c1)
                  ? "Export selection to file"
                  : "Export to file",
              items: (["csv", "tsv", "json", "markdown", "insert"] as CopyFormat[]).map(
                (f): MenuNode => ({
                  kind: "item",
                  label: f === "insert" ? "SQL INSERTs…" : `${f.toUpperCase()}…`,
                  onSelect: () => void exportRows(f),
                }),
              ),
            },
            { kind: "sep" },
            {
              kind: "item",
              label: "Find in results…",
              hint: "⌘F",
              onSelect: () => useFind.getState().openFind(),
            },
            {
              kind: "item",
              label: "Row details",
              hint: "space",
              onSelect: () => sel.focus && setPeekRow(sel.focus.r),
            },
            ...fkMenuItems(),
            ...(insertable && sel.focus
              ? ([
                  {
                    kind: "item",
                    label: "Duplicate row…",
                    onSelect: duplicateRow,
                  },
                ] as MenuNode[])
              : []),
            ...(selectionHasEditable
              ? ([
                  { kind: "sep" },
                  { kind: "item", label: "Set NULL", onSelect: () => setSelectionValue(null) },
                  { kind: "item", label: "Set EMPTY", onSelect: () => setSelectionValue("") },
                  {
                    kind: "item",
                    label: "Set DEFAULT",
                    onSelect: () => setSelectionValue(null, true),
                  },
                  { kind: "item", label: "Fill down", hint: "⌘D", onSelect: fillDown },
                ] as MenuNode[])
              : []),
            ...(selectionHasPending
              ? ([
                  {
                    kind: "item",
                    label: "Revert edits in selection",
                    onSelect: revertSelection,
                  },
                ] as MenuNode[])
              : []),
            ...(deletableTableOid != null
              ? ([
                  { kind: "sep" },
                  {
                    kind: "item",
                    label: `Delete ${
                      sel.rect && sel.rect.r1 > sel.rect.r0
                        ? `${sel.rect.r1 - sel.rect.r0 + 1} rows`
                        : "row"
                    }`,
                    danger: true,
                    onSelect: () => void deleteSelectedRows(),
                  },
                ] as MenuNode[])
              : []),
          ]}
        />
      )}

      {peekRow !== null && (
        <RowPeek
          statement={statement}
          viewRow={peekRow}
          rowAt={rowAt}
          colAt={colAt}
          rowCount={viewLen}
          typeOf={colType}
          editMetaOf={colEditMeta}
          onStep={(dir) =>
            setPeekRow((p) => (p === null ? p : Math.max(0, Math.min(viewLen - 1, p + dir))))
          }
          onClose={() => {
            setPeekRow(null);
            containerRef.current?.focus();
          }}
        />
      )}

      {showDraft && draftError && <div className="vgrid-draft-error">{draftError}</div>}
    </div>
  );
}
