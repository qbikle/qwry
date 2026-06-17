import { useEdits } from "../stores/edits";
import { useResults } from "../stores/results";
import { EditPreview } from "./EditPreview";
import { Grid } from "./Grid";
import "./grid.css";

export function ResultsPane({ browser = false }: { browser?: boolean }) {
  const statements = useResults((s) => s.statements);
  const active = useResults((s) => s.activeStatement);
  const setActive = useResults((s) => s.setActiveStatement);
  const running = useResults((s) => s.running);
  const totalMs = useResults((s) => s.totalMs);
  const globalError = useResults((s) => s.globalError);

  if (globalError)
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
      <div className="grid-msg">{running ? "Running…" : "Run a query to see results"}</div>
    );

  const stmt = statements.find((s) => s.index === active) ?? statements[0];

  return (
    <div className="results-pane-inner">
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

      <div className="stmt-body">
        {stmt.error ? (
          <div className="grid-error">
            <div className="ge-title">
              {stmt.error.code ? `Error ${stmt.error.code}` : "Error"}
              {stmt.error.position != null && ` · position ${stmt.error.position}`}
            </div>
            <div className="ge-msg">{stmt.error.message}</div>
          </div>
        ) : stmt.columns.length > 0 ? (
          <Grid statement={stmt} insertable={browser} />
        ) : (
          <div className="grid-msg">
            {stmt.done ? `OK · ${stmt.affected ?? 0} rows affected` : "Running…"}
          </div>
        )}
      </div>

      <div className="status-bar">
        {running && <span className="status-running">⏳ running</span>}
        {stmt.columns.length > 0 && (
          <span>
            {stmt.rows.length.toLocaleString()}
            {stmt.capped && ` of ${stmt.rowCount.toLocaleString()} (capped)`} rows
          </span>
        )}
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

function PendingEditsStatus() {
  const count = useEdits((s) => Object.keys(s.pending).length);
  const lastError = useEdits((s) => s.lastError);
  const discardAll = useEdits((s) => s.discardAll);
  const openPreview = useEdits((s) => s.openPreview);
  if (count === 0 && !lastError) return null;
  return (
    <span className="status-edits">
      {lastError && <span className="status-edit-error">{lastError}</span>}
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
