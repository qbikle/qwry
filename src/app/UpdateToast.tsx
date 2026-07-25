// Update-available toast: rides the conn-toast layout with an accent skin.
// One per new version; Later silences it until the next launch.
import { motion, AnimatePresence } from "motion/react";
import { RefreshCw, X } from "lucide-react";
import { popIn } from "../design/springs";
import { useUpdater } from "../stores/updater";

export function UpdateToast() {
  const phase = useUpdater((s) => s.phase);
  const version = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);
  const installing = useUpdater((s) => s.installing);
  const error = useUpdater((s) => s.error);
  const dismiss = useUpdater((s) => s.dismiss);
  const install = useUpdater((s) => s.install);

  const pct = Math.round(progress * 100);
  // no bytes yet (or size unknown) = indeterminate slide; installing = the
  // eventless unpack tail, bar holds full and pulses
  const indeterminate = progress === 0 && !installing;

  return (
    <AnimatePresence>
      {phase !== "idle" && (
        <motion.div className="conn-toast update-toast" {...popIn}>
          <RefreshCw size={16} className="update-toast-icon" />
          <div className="conn-toast-body">
            {phase === "available" && (
              <>
                <div className="conn-toast-title">Update available</div>
                <div className="conn-toast-msg">qwry {version} is ready to install</div>
              </>
            )}
            {phase === "downloading" && (
              <>
                <div className="conn-toast-title update-dl-head">
                  <span>Updating qwry</span>
                  <span className="update-dl-pct">
                    {installing ? "installing…" : progress > 0 ? `${pct}%` : "downloading…"}
                  </span>
                </div>
                <div
                  className={`update-bar${indeterminate ? " indeterminate" : ""}${installing ? " installing" : ""}`}
                >
                  <span
                    className="update-bar-fill"
                    style={indeterminate || installing ? undefined : { width: `${Math.max(pct, 2)}%` }}
                  />
                </div>
              </>
            )}
            {phase === "installed" && (
              <>
                <div className="conn-toast-title">Update installed</div>
                <div className="conn-toast-msg">restart qwry to finish</div>
              </>
            )}
            {phase === "error" && (
              <>
                <div className="conn-toast-title">Update failed</div>
                <div className="conn-toast-msg">{error}</div>
              </>
            )}
          </div>
          {phase === "available" && (
            <button className="conn-toast-action btnish primary" onClick={() => void install()}>
              Update
            </button>
          )}
          {phase !== "downloading" && (
            <button
              className="conn-toast-close iconbtn"
              title={phase === "available" ? "Later" : "Dismiss"}
              onClick={dismiss}
            >
              <X size={14} />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
