import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { SqlEditor, editorRunText } from "./SqlEditor";
import "./editor.css";

/** selection if any, else statement under caret — matches ⌘↵ */
const runTarget = () => editorRunText.current?.();

export function QueryBox() {
  const connectError = useConnections((s) => s.error);
  // a profile is active — run() auto-reconnects if the session has dropped
  const connected = useConnections((s) => s.activeProfileId !== null);
  const sql = useConnections((s) => s.sql);
  const run = useResults((s) => s.run);
  const cancel = useResults((s) => s.cancel);
  const running = useResults((s) => s.running);
  const connecting = useResults((s) => s.connecting);

  return (
    <div className="query-box">
      <SqlEditor />
      <div className="qb-bar">
        {connectError && <span className="qb-conn-error">{connectError.message}</span>}
        <button
          className="qb-explain"
          onClick={() =>
            void import("../stores/explain").then(({ useExplain }) =>
              useExplain.getState().run(runTarget()?.text),
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
        ) : connecting ? (
          <button className="qb-run" disabled>
            Connecting…
          </button>
        ) : (
          <button
            className="qb-run"
            onClick={() => {
              const t = runTarget();
              void run(t?.text, t?.offset);
            }}
            disabled={!connected || !sql.trim()}
          >
            Run ⌘↵
          </button>
        )}
      </div>
    </div>
  );
}
