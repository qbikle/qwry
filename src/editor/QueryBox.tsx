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
        {/* all three action states stay mounted in one grid slot — the slot
            is as wide as the widest face, so Explain never shifts sideways
            across idle → connecting → running. visibility:hidden faces take
            no clicks and leave the a11y tree */}
        <span className="qb-action-slot">
          <button
            className="qb-cancel"
            data-off={!running || undefined}
            onClick={() => cancel()}
            disabled={cancelling}
          >
            <span className="qb-cancel-face" data-hidden={cancelling || undefined}>
              Cancel <Kbd chord="cmd+period" />
            </span>
            <span className="qb-cancel-face" data-hidden={!cancelling || undefined}>
              Cancelling…
            </span>
          </button>
          <button
            className="qb-run btnish primary"
            data-off={running || !connecting || undefined}
            disabled
          >
            Connecting…
          </button>
          <button
            className="qb-run btnish primary"
            data-off={running || connecting || undefined}
            onClick={() => {
              const t = runTarget();
              void run(t?.text, t?.offset);
            }}
            disabled={!connected || !sql.trim()}
          >
            Run <Kbd chord="cmd+return" />
          </button>
        </span>
      </div>
    </div>
  );
}
