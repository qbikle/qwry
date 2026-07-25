import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { Kbd } from "../design/Kbd";
import { SqlEditor, editorRunText } from "./SqlEditor";
import "./editor.css";

/** selection if any, else statement under caret (matches ⌘↩) */
const runTarget = () => editorRunText.current?.();

export function QueryBox() {
  const connectError = useConnections((s) => s.error);
  // a profile is active: run() auto-reconnects if the session has dropped
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
        {/* ONE action slot, constant size across every mode: all faces stay
            mounted stacked in a grid cell, and the faces are EQUALIZED by
            copy ("Cancelling"/"Connecting" drop the progress …, a width-
            over-register call, scoped here) so the reservation costs ~1ch
            instead of a fat button. Explain never moves; the button never
            resizes; only its skin changes with state. */}
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
              Cancelling
            </span>
          </button>
          <button
            className="qb-run btnish primary"
            data-off={running || !connecting || undefined}
            disabled
          >
            Connecting
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
