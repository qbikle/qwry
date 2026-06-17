import { useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { TriangleAlert, X } from "lucide-react";
import { popIn } from "../design/springs";
import { useConnections } from "../stores/connections";

/** global toast for connect failures (auth, network) — shows on any view,
 * including the dashboard where the inline editor error isn't mounted */
export function ConnToast() {
  const error = useConnections((s) => s.error);
  const errorProfileId = useConnections((s) => s.errorProfileId);
  const clearError = useConnections((s) => s.clearError);
  const profiles = useConnections((s) => s.profiles);
  const editConnection = useConnections((s) => s.editConnection);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 8000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  const profile = errorProfileId ? profiles.find((p) => p.id === errorProfileId) : null;

  return (
    <AnimatePresence>
      {error && (
        <motion.div className="conn-toast" {...popIn}>
          <TriangleAlert size={15} className="conn-toast-icon" />
          <div className="conn-toast-body">
            <div className="conn-toast-title">
              Couldn’t connect{profile ? ` to ${profile.name || profile.host}` : ""}
            </div>
            <div className="conn-toast-msg">{error.message}</div>
          </div>
          {profile && (
            <button
              className="conn-toast-action"
              onClick={() => {
                clearError();
                editConnection(profile);
              }}
            >
              Edit
            </button>
          )}
          <button className="conn-toast-close" title="Dismiss" onClick={clearError}>
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
