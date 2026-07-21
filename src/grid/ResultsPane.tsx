import { useBrowser } from "../stores/browser";
import { overlayOpen } from "../app/overlay/escStack";
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
import { lastErrorKind } from "./flashReason";
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
        {running ? (
          "Running…"
        ) : connecting ? (
          "Connecting…"
        ) : browser ? (
          "Loading table…"
        ) : (
          <span>
            Run a query to see results · <kbd>⌘↵</kbd> runs the statement under the caret
          </span>
        )}
      </div>
    );

  const stmt = statements.find((s) => s.index === active) ?? statements[0];

  return (
    <div className="results-pane-inner">
      <OriginBanner />
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
          <>
            <Grid key={`${activeTab}:${stmt.index}`} statement={stmt} insertable={browser} />
            <ZeroRows stmt={stmt} browser={browser} />
          </>
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
        {running && browser && (
          // browse tabs have no QueryBox — this is their only cancel affordance
          <button
            className="status-link"
            onClick={() => void useResults.getState().cancel()}
          >
            Cancel ⌘.
          </button>
        )}
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

/** the rows on screen came from a DIFFERENT connection than the rail
 * selection (pinned tab ran elsewhere): edits/imports commit to the ORIGIN
 * while Run executes on the rail — say so, tinted with the origin's color.
 * Sits beside the other strips OUTSIDE .stmt-body so grid geometry
 * (HEADER_H anchors, virtualizer measures) is untouched. */
function OriginBanner() {
  const originPid = useResults((s) => s.executedProfileId);
  const railPid = useConnections((s) => s.activeProfileId);
  const profiles = useConnections((s) => s.profiles);
  if (!originPid || originPid === railPid) return null;
  const origin = profiles.find((p) => p.id === originPid);
  const rail = profiles.find((p) => p.id === railPid);
  const originName = origin ? origin.name || origin.host : "a deleted connection";
  const railName = rail ? rail.name || rail.host : "the active connection";
  return (
    <div
      className="origin-banner"
      style={{ "--origin-color": origin?.color || "var(--accent)" } as React.CSSProperties}
    >
      <span className="origin-banner-dot" />
      <span className="origin-banner-text">
        rows from <strong>{originName}</strong> — edits &amp; imports commit there · Run executes
        on <strong>{railName}</strong>
      </span>
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
          placeholder="Filter rows…"
          value={local}
          onChange={(e) => push(e.target.value)}
          onKeyDown={(e) => {
            // typing keys only — ⌘/⌃ chords must reach the window handler
            if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
            if (e.key === "Escape") useGridFilter.getState().clear();
            if (e.key === "Enter") flush();
          }}
        />
      )}
    </span>
  );
}

/** zero-result statement: say "0 rows" with the statement timing under the
 * column headers instead of a blank void; in browse mode point at add-row
 * (hidden while the draft band is open — it sits in the same space) */
function ZeroRows({
  stmt,
  browser,
}: {
  stmt: { rows: unknown[]; done: boolean; ms: number | null };
  browser: boolean;
}) {
  const drafting = useBrowser((s) => !!s.draftRow);
  if (!stmt.done || stmt.rows.length > 0 || (browser && drafting)) return null;
  return (
    <div className="grid-zero">
      <div className="grid-zero-title">0 rows</div>
      <div className="grid-zero-sub">
        {stmt.ms != null && `completed in ${stmt.ms.toFixed(1)} ms`}
        {browser && (
          <>
            {stmt.ms != null && " · "}
            <kbd>⌘⇧I</kbd> adds a row
          </>
        )}
      </div>
    </div>
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
        {n.toLocaleString()} of {stmt.rowCount.toLocaleString()} rows · capped
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
      title="Refresh this query"
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

/** explicit transaction open on one of this tab's sessions → chip + one-click
 * ROLLBACK. The tx can live on the tab's ORIGIN session (rows ran on another
 * connection) as well as the rail's — prefer origin (writes live there); any
 * other session-tx for the tab still resolves so ROLLBACK always targets the
 * session that actually holds it. */
function TxChip() {
  const activeTab = useTabs((s) => s.activeId);
  const running = useResults((s) => s.running);
  const originPid = useResults((s) => s.executedProfileId);
  const txPid = useConnections((s) => {
    if (!activeTab) return null;
    if (originPid && s.txTabs[skey(originPid, activeTab)]) return originPid;
    if (s.activeProfileId && s.txTabs[skey(s.activeProfileId, activeTab)])
      return s.activeProfileId;
    const hit = Object.entries(s.txTabs).find(([k, v]) => v && k.endsWith(`::${activeTab}`));
    return hit ? hit[0].split("::")[0] : null;
  });
  if (!txPid) return null;
  const rollback = async () => {
    const { tabSessions, setTxTab } = useConnections.getState();
    const tabId = useTabs.getState().activeId;
    if (!tabId) return;
    const key = skey(txPid, tabId);
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
        title={running ? "Waiting for the running query — cancel it first (⌘.)" : "Roll back this tab’s open transaction"}
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
  const undoOffer = useEdits((s) => s.undoOffer);
  const undoing = useEdits((s) => s.undoing);
  const activeTab = useEdits((s) => s.active);
  // inverse-SQL undo offer belongs to the tab (and session) that committed
  const offer = undoOffer && undoOffer.tabId === activeTab ? undoOffer : null;

  // ⌘⇧Z while the offer is visible. defaultPrevented yields to the grid's
  // staged-edit redo and the editor's text redo — the toast only claims the
  // chord when nothing focused wanted it.
  useEffect(() => {
    if (!offer) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // never claim redo from text editing (inputs/contenteditable) or from
      // under an overlay — this chord reverts a DB commit, not a keystroke
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      if (overlayOpen()) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void useEdits.getState().undoLastCommit();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [offer]);

  if (count === 0 && !lastError && !offer) return null;
  return (
    <span className="status-edits">
      {lastError && (
        // honesty notes ("no changes") and copy progress share the slot with
        // real errors — classify so they render neutral, not danger-red
        // (notes reuse the progress class: same --fg-muted styling)
        <span
          className={
            lastErrorKind(lastError) === "error" ? "status-edit-error" : "status-edit-progress"
          }
          title={lastError}
        >
          {lastError}
        </span>
      )}
      {offer && (
        <>
          <span className="status-edit-count" title={`Committed: ${offer.description}`}>
            ✓ {offer.description}
          </span>
          <button
            className="status-link"
            disabled={undoing}
            title="Revert this commit through the verified pipeline — a stale undo rolls back"
            onClick={() => void useEdits.getState().undoLastCommit()}
          >
            {undoing ? "Undoing…" : "Undo ⌘⇧Z"}
          </button>
        </>
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
