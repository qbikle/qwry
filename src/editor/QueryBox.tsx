// P1 placeholder editor — replaced by CodeMirror SqlEditor in P3.
import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import "./editor.css";

export function QueryBox() {
  const sql = useConnections((s) => s.sql);
  const setSql = useConnections((s) => s.setSql);
  const connectError = useConnections((s) => s.error);
  const connected = useConnections(
    (s) => s.activeProfileId !== null && !!s.sessions[s.activeProfileId],
  );
  const run = useResults((s) => s.run);
  const cancel = useResults((s) => s.cancel);
  const running = useResults((s) => s.running);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey && e.key === "Enter") {
      e.preventDefault();
      run();
    }
    if (e.metaKey && e.key === ".") {
      e.preventDefault();
      cancel();
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
        {connectError && <span className="qb-conn-error">{connectError.message}</span>}
        {running ? (
          <button className="qb-cancel" onClick={cancel}>
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
