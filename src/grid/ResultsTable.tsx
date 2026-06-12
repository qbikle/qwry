// P1 placeholder grid — replaced by the virtualized Grid in P2.
import { useConnections } from "../stores/connections";
import "./grid.css";

const ROW_CAP = 2000; // P1 plain-DOM table; virtualization lands in P2

export function ResultsTable() {
  const result = useConnections((s) => s.result);
  const error = useConnections((s) => s.error);
  const running = useConnections((s) => s.running);

  if (running) return <div className="grid-msg">Running…</div>;
  if (error)
    return (
      <div className="grid-error">
        <div className="ge-title">
          {error.code ? `Error ${error.code}` : "Error"}
          {error.position != null && ` · position ${error.position}`}
        </div>
        <div className="ge-msg">{error.message}</div>
      </div>
    );
  if (!result) return <div className="grid-msg">Run a query to see results</div>;

  return (
    <div className="results-scroll">
      {result.statements.map((stmt) => (
        <div key={stmt.index} className="stmt-block">
          {stmt.columns.length > 0 ? (
            <table className="results-table">
              <thead>
                <tr>
                  <th className="rownum" />
                  {stmt.columns.map((c, i) => (
                    <th key={i}>{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stmt.rows.slice(0, ROW_CAP).map((row, ri) => (
                  <tr key={ri}>
                    <td className="rownum">{ri + 1}</td>
                    {row.map((v, ci) => (
                      <td key={ci} className={v === null ? "null" : ""}>
                        {v === null ? "NULL" : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="stmt-noresult">OK</div>
          )}
          <div className="stmt-status">
            {stmt.columns.length > 0
              ? `${stmt.rows.length}${stmt.rows.length > ROW_CAP ? ` (showing ${ROW_CAP})` : ""} rows`
              : `${stmt.affected ?? 0} affected`}
            {" · "}
            {stmt.ms.toFixed(1)} ms
          </div>
        </div>
      ))}
    </div>
  );
}
