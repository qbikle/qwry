import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { SqlEditor } from "./SqlEditor";
import "./editor.css";

export function QueryBox() {
  const connectError = useConnections((s) => s.error);
  const connected = useConnections(
    (s) => s.activeProfileId !== null && !!s.sessions[s.activeProfileId],
  );
  const sql = useConnections((s) => s.sql);
  const run = useResults((s) => s.run);
  const cancel = useResults((s) => s.cancel);
  const running = useResults((s) => s.running);

  return (
    <div className="query-box">
      <SqlEditor />
      <div className="qb-bar">
        {connectError && <span className="qb-conn-error">{connectError.message}</span>}
        <button
          className="qb-explain"
          onClick={() =>
            void import("../stores/explain").then(({ useExplain }) =>
              useExplain.getState().run(),
            )
          }
          disabled={!connected || !sql.trim()}
        >
          Explain ⌘E
        </button>
        {running ? (
          <button className="qb-cancel" onClick={() => cancel()}>
            Cancel ⌘.
          </button>
        ) : (
          <button
            className="qb-run"
            onClick={() => run()}
            disabled={!connected || !sql.trim()}
          >
            Run ⌘↵
          </button>
        )}
      </div>
    </div>
  );
}
