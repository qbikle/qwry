// P1 placeholder editor — replaced by CodeMirror SqlEditor in P3.
import { useConnections } from "../stores/connections";
import "./editor.css";

export function QueryBox() {
  const sql = useConnections((s) => s.sql);
  const setSql = useConnections((s) => s.setSql);
  const run = useConnections((s) => s.run);
  const cancelRun = useConnections((s) => s.cancelRun);
  const running = useConnections((s) => s.running);
  const connected = useConnections(
    (s) => s.activeProfileId !== null && !!s.sessions[s.activeProfileId],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey && e.key === "Enter") {
      e.preventDefault();
      run();
    }
    if (e.metaKey && e.key === ".") {
      e.preventDefault();
      cancelRun();
    }
  };

  return (
    <div className="query-box">
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={connected ? "SELECT … (⌘↵ to run)" : "Connect to a database first"}
        spellCheck={false}
      />
      <div className="qb-bar">
        {running ? (
          <button className="qb-cancel" onClick={cancelRun}>
            Cancel ⌘.
          </button>
        ) : (
          <button className="qb-run" onClick={run} disabled={!connected || !sql.trim()}>
            Run ⌘↵
          </button>
        )}
      </div>
    </div>
  );
}
