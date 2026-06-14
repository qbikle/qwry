import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { SqlEditor, editorRunText } from "./SqlEditor";
import "./editor.css";

/** selection if any, else the whole buffer — matches ⌘↵ */
const runText = () => editorRunText.current?.();

export function QueryBox() {
  const connectError = useConnections((s) => s.error);
  // a profile is active — run() auto-reconnects if the session has dropped
  const connected = useConnections((s) => s.activeProfileId !== null);
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
              useExplain.getState().run(runText()),
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
            onClick={() => run(runText())}
            disabled={!connected || !sql.trim()}
          >
            Run ⌘↵
          </button>
        )}
      </div>
    </div>
  );
}
