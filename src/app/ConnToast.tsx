import { useEffect, useState } from "react";
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
  /** a live session died with a driver-known reason (session-closed event) */
  const [closed, setClosed] = useState<{ profileId: string; reason: string } | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 8000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  useEffect(() => {
    if (!closed) return;
    const t = setTimeout(() => setClosed(null), 8000);
    return () => clearTimeout(t);
  }, [closed]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ session_id: string; profile_id: string; reason: string | null }>(
        "session-closed",
        (e) => {
          const { session_id, profile_id, reason } = e.payload;
          if (!reason) return;
          // a spare dying quietly (bastion idle-drop) is routine — only toast
          // sessions the user actually holds (primary/tab), or a primary death
          // the store already registered (listener-order race)
          const conn = useConnections.getState();
          const known =
            conn.sessions[profile_id] === session_id ||
            Object.values(conn.tabSessions).includes(session_id);
          if (!known && conn.connState[profile_id] !== "disconnected") return;
          setClosed({ profileId: profile_id, reason });
        },
      ).then((u) => {
        un = u;
      }),
    );
    return () => un?.();
  }, []);

  const profile = errorProfileId ? profiles.find((p) => p.id === errorProfileId) : null;
  const closedProfile = closed ? profiles.find((p) => p.id === closed.profileId) : null;

  return (
    <AnimatePresence>
      {!error && closed && (
        <motion.div className="conn-toast" {...popIn}>
          <TriangleAlert size={15} className="conn-toast-icon" />
          <div className="conn-toast-body">
            <div className="conn-toast-title">
              Connection lost
              {closedProfile ? ` — ${closedProfile.name || closedProfile.host}` : ""}
            </div>
            <div className="conn-toast-msg">{closed.reason}</div>
          </div>
          <button className="conn-toast-close" title="Dismiss" onClick={() => setClosed(null)}>
            <X size={14} />
          </button>
        </motion.div>
      )}
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
