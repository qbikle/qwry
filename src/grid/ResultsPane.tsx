import { useBrowser } from "../stores/browser";
import { useGridStats } from "../stores/gridStats";
import { useGridFilter } from "../stores/gridFilter";
import { RotateCw } from "lucide-react";
import { skey, useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import * as ipc from "../ipc/commands";
import { ListFilter, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEdits } from "../stores/edits";
import { useFind } from "../stores/find";
import { useResults } from "../stores/results";
import { EditPreview } from "./EditPreview";
import { FindBar } from "./FindBar";
import { Grid } from "./Grid";
import "./grid.css";

export function ResultsPane({ browser = false }: { browser?: boolean }) {
  const statements = useResults((s) => s.statements);
  const active = useResults((s) => s.activeStatement);
  const activeTab = useResults((s) => s.active);
  const setActive = useResults((s) => s.setActiveStatement);
  const running = useResults((s) => s.running);
  const connecting = useResults((s) => s.connecting);
  const totalMs = useResults((s) => s.totalMs);
  const globalError = useResults((s) => s.globalError);
  const notices = useResults((s) => s.notices);
  const findOpen = useFind((s) => s.open);

  // a late error (mid-stream connection drop) must NOT wipe already-streamed
  // rows off the screen — full error pane only when there's nothing to show
  if (globalError && statements.length === 0)
    return (
      <div className="grid-error">
        <div className="ge-title">
          {globalError.code ? `Error ${globalError.code}` : "Error"}
        </div>
        <div className="ge-msg">{globalError.message}</div>
      </div>
    );

  if (statements.length === 0)
    return (
      <div className="grid-msg">
        {running ? "Running…" : connecting ? "Connecting…" : "Run a query to see results"}
      </div>
    );

  const stmt = statements.find((s) => s.index === active) ?? statements[0];

  return (
    <div className="results-pane-inner">
      {globalError && (
        <div className="ge-banner" title={globalError.message}>
          {globalError.code ? `Error ${globalError.code}: ` : "Error: "}
          {globalError.message}
        </div>
      )}
      {statements.length > 1 && (
        <div className="stmt-chips">
          {statements.map((s) => (
            <button
              key={s.index}
              className={`stmt-chip${s.index === stmt.index ? " active" : ""}${s.error ? " error" : ""}`}
              onClick={() => setActive(s.index)}
              title={s.sql}
            >
              {s.index + 1}
              {s.error ? " ✕" : s.columns.length > 0 ? ` · ${s.rowCount || s.rows.length}` : " · ok"}
            </button>
          ))}
        </div>
      )}

      {findOpen && stmt.columns.length > 0 && !stmt.error && <FindBar stmt={stmt} />}

      <div className="stmt-body">
        {stmt.error ? (
          <div className="grid-error">
            <div className="ge-title">
              {stmt.error.code ? `Error ${stmt.error.code}` : "Error"}
              {stmt.error.position != null && ` · position ${stmt.error.position}`}
            </div>
            <div className="ge-msg">{stmt.error.message}</div>
            {stmt.error.detail && <div className="ge-detail">DETAIL: {stmt.error.detail}</div>}
            {stmt.error.hint && <div className="ge-hint">HINT: {stmt.error.hint}</div>}
          </div>
        ) : stmt.columns.length > 0 ? (
          // keyed per tab+statement: switching tabs or statement chips swaps
          // the DATA under a mounted grid — selection/editor state carrying
          // over targeted phantom rows in the other result (wrong-row copy /
          // Set-NULL / delete class)
          <Grid key={`${activeTab}:${stmt.index}`} statement={stmt} insertable={browser} />
        ) : (
          <div className="grid-msg">
            {stmt.done ? `OK · ${stmt.affected ?? 0} rows affected` : "Running…"}
          </div>
        )}
      </div>

      {notices.length > 0 && (
        <div className="notice-strip">
          {notices.slice(-4).map((n, i) => (
            <div key={i} className="notice-line">
              <span className="notice-sev">{n.severity}</span> {n.message}
            </div>
          ))}
          {notices.length > 4 && (
            <div className="notice-line notice-more">… {notices.length - 4} earlier</div>
          )}
        </div>
      )}
      <div className="status-bar">
        {!running && !connecting && <RerunBtn />}
        {running && <span className="status-running">⏳ running</span>}
        {connecting && !running && <span className="status-running">🔌 connecting…</span>}
        {!browser && stmt.columns.length > 0 && !stmt.error && <QuickFilter />}
        {stmt.columns.length > 0 && <RowCount stmt={stmt} browser={browser} />}
        <SelectionStatsChip />
        <TxChip />
        {stmt.ms != null && <span>{stmt.ms.toFixed(1)} ms</span>}
        {totalMs != null && statements.length > 1 && (
          <span>total {totalMs.toFixed(1)} ms</span>
        )}
        <PendingEditsStatus />
      </div>
      <EditPreview />
    </div>
  );
}

/** funnel toggle + inline input: view-level filter over the LOADED rows.
 * The input keeps LOCAL text and publishes to the store on an ~80ms debounce
 * (Enter flushes immediately) — the grid's match scan used to run on every
 * keystroke. Closing/clearing unmounts the input, so local state can't drift. */
function QuickFilter() {
  const open = useGridFilter((s) => s.open);
  const inputRef = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState(() => useGridFilter.getState().text);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const push = (v: string) => {
    setLocal(v);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      useGridFilter.getState().setText(v);
    }, 80);
  };
  const flush = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    useGridFilter.getState().setText(local);
  };
  return (
    <span className={`status-qf${open ? " on" : ""}`}>
      <button
        className="status-qf-btn"
        title={open ? "Clear quick filter" : "Quick-filter loaded rows"}
        onClick={() => useGridFilter.getState().setOpen(!open)}
      >
        {open ? <X size={11} /> : <ListFilter size={11} />}
      </button>
      {open && (
        <input
          ref={inputRef}
          placeholder="filter rows…"
          value={local}
          onChange={(e) => push(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") useGridFilter.getState().clear();
            if (e.key === "Enter") flush();
          }}
        />
      )}
    </span>
  );
}

/** honest row count: a browse page must never read as the whole table */
function RowCount({
  stmt,
  browser,
}: {
  stmt: { rows: unknown[]; rowCount: number; capped: boolean; done: boolean };
  browser: boolean;
}) {
  const limit = useBrowser((s) => s.limit);
  const filterMatches = useGridFilter((s) => s.matches);
  const n = stmt.rows.length;
  if (filterMatches !== null && !browser)
    return (
      <span>
        {filterMatches.toLocaleString()} of {n.toLocaleString()} rows match
      </span>
    );
  if (stmt.capped)
    return (
      <span>
        {n.toLocaleString()} of {stmt.rowCount.toLocaleString()} rows (capped)
      </span>
    );
  if (browser && stmt.done && n >= limit)
    return <span>first {n.toLocaleString()} rows — scroll for more</span>;
  if (browser && stmt.done) return <span>all {n.toLocaleString()} rows</span>;
  return <span>{n.toLocaleString()} rows</span>;
}

/** count · sum · avg · min · max of the selected cells (numeric where parseable) */
function SelectionStatsChip() {
  const stats = useGridStats((s) => s.stats);
  if (!stats) return null;
  if (stats.tooBig)
    return <span className="status-stats">{stats.cells.toLocaleString()} cells selected</span>;
  const fmt = (n: number) => {
    if (!Number.isFinite(n)) return "–";
    const a = Math.abs(n);
    if (a !== 0 && (a >= 1e15 || a < 1e-4)) return n.toExponential(4);
    return Number(n.toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 6 });
  };
  return (
    <span className="status-stats">
      {stats.nonNull.toLocaleString()}
      {stats.cells !== stats.nonNull ? `/${stats.cells.toLocaleString()}` : ""} cells
      {stats.numeric > 1 && (
        <>
          {" · "}Σ {fmt(stats.sum)} · avg {fmt(stats.sum / stats.numeric)} · min{" "}
          {fmt(stats.min)} · max {fmt(stats.max)}
        </>
      )}
    </span>
  );
}

/** re-run the exact SQL this result came from (staged-edit guard rides run()) */
function RerunBtn() {
  const executedSql = useResults((s) => s.executedSql);
  if (!executedSql) return null;
  return (
    <button
      className="status-rerun"
      title="Re-run this query"
      onClick={() => {
        const st = useResults.getState();
        // keep the original buffer offset — the error squiggle stays honest
        void st.run(executedSql, st.executedOffset);
      }}
    >
      <RotateCw size={11} />
    </button>
  );
}

/** explicit transaction open on this tab's session → chip + one-click ROLLBACK */
function TxChip() {
  const activeTab = useTabs((s) => s.activeId);
  const running = useResults((s) => s.running);
  const inTx = useConnections((s) => {
    const pid = s.activeProfileId;
    return pid && activeTab ? !!s.txTabs[skey(pid, activeTab)] : false;
  });
  if (!inTx) return null;
  const rollback = async () => {
    const { activeProfileId: pid, tabSessions, setTxTab } = useConnections.getState();
    const tabId = useTabs.getState().activeId;
    if (!pid || !tabId) return;
    const key = skey(pid, tabId);
    const sid = tabSessions[key];
    if (!sid) return;
    try {
      // straight on the session — running it through run() would wipe the
      // result grid the user is probably inspecting mid-transaction
      await ipc.execute(sid, "ROLLBACK");
      setTxTab(key, false);
    } catch {
      /* session died — the closed event resets tx state */
    }
  };
  return (
    <span className="status-tx">
      TX OPEN
      <button
        className="status-link danger"
        // tokio-postgres serializes on the single session connection — a
        // ROLLBACK behind a running query would silently queue ("frozen app")
        disabled={running}
        title={running ? "Waiting for the running query — cancel it first (⌘.)" : "Roll back this tab's open transaction"}
        onClick={() => void rollback()}
      >
        ROLLBACK
      </button>
    </span>
  );
}

function PendingEditsStatus() {
  const count = useEdits((s) => Object.keys(s.pending).length);
  const lastError = useEdits((s) => s.lastError);
  const discardAll = useEdits((s) => s.discardAll);
  const openPreview = useEdits((s) => s.openPreview);
  if (count === 0 && !lastError) return null;
  return (
    <span className="status-edits">
      {lastError && (
        // "building copy…" is progress, not a failure — render it neutral,
        // not in the danger-red error styling (prefix convention, no store field)
        <span
          className={
            lastError.startsWith("building copy…") ? "status-edit-progress" : "status-edit-error"
          }
        >
          {lastError}
        </span>
      )}
      {count > 0 && (
        <>
          <span className="status-edit-count">
            ✎ {count} pending edit{count === 1 ? "" : "s"}
          </span>
          <button className="status-link" onClick={() => void openPreview()}>
            Commit ⌘S
          </button>
          <button className="status-link danger" onClick={discardAll}>
            Discard ⌘⇧D
          </button>
        </>
      )}
    </span>
  );
}
