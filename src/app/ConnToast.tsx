import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { TriangleAlert, X } from "lucide-react";
import { popIn } from "../design/springs";
import { useConnections } from "../stores/connections";

/** global toast for connect failures (auth, network): shows on any view,
 * including the dashboard where the inline editor error isn't mounted */
export function ConnToast() {
  const error = useConnections((s) => s.error);
  const errorProfileId = useConnections((s) => s.errorProfileId);
  const clearError = useConnections((s) => s.clearError);
  const profiles = useConnections((s) => s.profiles);
  const editConnection = useConnections((s) => s.editConnection);
  // session-death toasts render straight from the store: markDisconnected
  // decides which deaths are toast-worthy (it knows which branch fired), so
  // nothing here depends on listener registration order
  const closed = useConnections((s) => s.closedToast);
  const clearClosedToast = useConnections((s) => s.clearClosedToast);
  /** app-db rows skipped at load (appdb-warning event from the backend) */
  const [warn, setWarn] = useState<{ table: string; skipped: number } | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 8000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  useEffect(() => {
    if (!closed) return;
    const t = setTimeout(clearClosedToast, 8000);
    return () => clearTimeout(t);
  }, [closed, clearClosedToast]);

  useEffect(() => {
    if (!warn) return;
    const t = setTimeout(() => setWarn(null), 8000);
    return () => clearTimeout(t);
  }, [warn]);

  useEffect(() => {
    // StrictMode double-mounts: a listen() resolving after the first mount's
    // cleanup must unregister itself, not leak a duplicate listener
    let disposed = false;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ table: string; skipped: number }>("appdb-warning", (e) => {
        setWarn(e.payload);
      }).then((u) => {
        if (disposed) u();
        else un = u;
      }),
    );
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const profile = errorProfileId ? profiles.find((p) => p.id === errorProfileId) : null;
  const closedProfile = closed ? profiles.find((p) => p.id === closed.profileId) : null;

  return (
    <AnimatePresence>
      {!error && !closed && warn && (
        <motion.div className="conn-toast" {...popIn}>
          <TriangleAlert size={16} className="conn-toast-icon" />
          <div className="conn-toast-body">
            <div className="conn-toast-title">Some saved data couldn’t be loaded</div>
            <div className="conn-toast-msg">
              {warn.skipped} saved {warn.table} {warn.skipped === 1 ? "entry" : "entries"}{" "}
              couldn’t be read and {warn.skipped === 1 ? "was" : "were"} skipped
            </div>
          </div>
          <button className="conn-toast-close iconbtn" title="Dismiss" onClick={() => setWarn(null)}>
            <X size={14} />
          </button>
        </motion.div>
      )}
      {!error && closed && (
        <motion.div className="conn-toast" {...popIn}>
          <TriangleAlert size={16} className="conn-toast-icon" />
          <div className="conn-toast-body">
            <div className="conn-toast-title">
              Connection lost
              {closedProfile ? ` · ${closedProfile.name || closedProfile.host}` : ""}
            </div>
            <div className="conn-toast-msg">{closed.reason}</div>
          </div>
          <button className="conn-toast-close iconbtn" title="Dismiss" onClick={clearClosedToast}>
            <X size={14} />
          </button>
        </motion.div>
      )}
      {error && (
        <motion.div className="conn-toast" {...popIn}>
          <TriangleAlert size={16} className="conn-toast-icon" />
          <div className="conn-toast-body">
            <div className="conn-toast-title">
              Couldn’t connect{profile ? ` to ${profile.name || profile.host}` : ""}
            </div>
            <div className="conn-toast-msg">{error.message}</div>
          </div>
          {profile && (
            <button
              className="conn-toast-action btnish"
              onClick={() => {
                clearError();
                editConnection(profile);
              }}
            >
              Edit
            </button>
          )}
          <button className="conn-toast-close iconbtn" title="Dismiss" onClick={clearError}>
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
