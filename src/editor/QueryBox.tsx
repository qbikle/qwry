import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { Kbd } from "../design/Kbd";
import { SqlEditor, editorRunText } from "./SqlEditor";
import "./editor.css";

/** selection if any, else statement under caret — matches ⌘↩ */
const runTarget = () => editorRunText.current?.();

export function QueryBox() {
  const connectError = useConnections((s) => s.error);
  // a profile is active — run() auto-reconnects if the session has dropped
  const connected = useConnections((s) => s.activeProfileId !== null);
  const sql = useConnections((s) => s.sql);
  const run = useResults((s) => s.run);
  const cancel = useResults((s) => s.cancel);
  const running = useResults((s) => s.running);
  const cancelling = useResults((s) => s.cancelling);
  const connecting = useResults((s) => s.connecting);

  return (
    <div className="query-box">
      <SqlEditor />
      <div className="qb-bar">
        {connectError && <span className="qb-conn-error">{connectError.message}</span>}
        <button
          className="qb-explain btnish"
          onClick={() =>
            void import("../stores/explain").then(({ useExplain }) =>
              useExplain.getState().run(runTarget()?.text),
            )
          }
          disabled={!connected || !sql.trim()}
        >
          Explain <Kbd chord="cmd+e" />
        </button>
        {running ? (
          // both faces stay mounted stacked in one grid cell — the button is
          // as wide as the wider label, so Cancel → Cancelling… can't jump
          <button className="qb-cancel" onClick={() => cancel()} disabled={cancelling}>
            <span className="qb-cancel-face" data-hidden={cancelling || undefined}>
              Cancel <Kbd chord="cmd+period" />
            </span>
            <span className="qb-cancel-face" data-hidden={!cancelling || undefined}>
              Cancelling…
            </span>
          </button>
        ) : connecting ? (
          <button className="qb-run btnish primary" disabled>
            Connecting…
          </button>
        ) : (
          <button
            className="qb-run btnish primary"
            onClick={() => {
              const t = runTarget();
              void run(t?.text, t?.offset);
            }}
            disabled={!connected || !sql.trim()}
          >
            Run <Kbd chord="cmd+return" />
          </button>
        )}
      </div>
    </div>
  );
}
