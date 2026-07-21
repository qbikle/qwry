import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Clock, Pencil, Plus, TriangleAlert } from "lucide-react";
import { panelIn } from "../design/springs";
import { confirmTxRollback, useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { Avatar } from "../sidebar/avatar";
import { blankProfile } from "../sidebar/ConnectionRail";
import { ContextMenu } from "../app/overlay/ContextMenu";
import { connectionMenu } from "../sidebar/connectionMenu";
import * as ipc from "../ipc/commands";
import type { HistoryRow, Profile } from "../ipc/types";
import "./home.css";

function relTime(ranAt: string): string {
  const t = new Date(ranAt.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Dashboard() {
  const profiles = useConnections((s) => s.profiles);
  const connState = useConnections((s) => s.connState);
  const connect = useConnections((s) => s.connect);
  const setActive = useConnections((s) => s.setActive);
  const setHome = useConnections((s) => s.setHome);
  const editConnection = useConnections((s) => s.editConnection);
  const profilesError = useConnections((s) => s.profilesError);
  const loadProfiles = useConnections((s) => s.loadProfiles);
  const [recent, setRecent] = useState<HistoryRow[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);

  useEffect(() => {
    void ipc.historyRecent(8).then(setRecent).catch(() => setRecent([]));
  }, []);

  // already connected (green) → open the work view instantly; else connect —
  // a reconnect drops the profile's tab sessions, so open transactions gate it
  const openConn = (id: string) => {
    if ((connState[id] ?? "disconnected") === "connected") {
      setActive(id);
      setHome(null);
    } else {
      void (async () => {
        if (await confirmTxRollback(id, "Connect")) void connect(id);
      })();
    }
  };

  const openRecent = async (row: HistoryRow) => {
    const c = useConnections.getState();
    // already connected → just switch; the old unconditional reconnect killed
    // every tab session (and any open transaction) on the profile for nothing
    if (c.connState[row.profile_id] !== "connected") {
      if (!(await confirmTxRollback(row.profile_id, "Connect"))) return;
      await connect(row.profile_id);
      if (useConnections.getState().connState[row.profile_id] !== "connected") return;
    } else {
      setActive(row.profile_id);
      setHome(null);
    }
    useTabs.getState().newTab(row.sql, "recent");
  };

  return (
    <motion.div className="dash" {...panelIn}>
      <div className="dash-head">
        <span className="dash-title">Connections</span>
      </div>

      {profilesError && (
        <div className="dash-error">
          <TriangleAlert size={14} />
          <span>Couldn’t load saved connections: {profilesError}</span>
          <button className="dash-error-retry" onClick={() => void loadProfiles()}>
            Retry
          </button>
        </div>
      )}

      {profiles.length === 0 && !profilesError ? (
        // first-run / empty state: a real CTA, not a lonely "+" tile
        <div className="dash-hero">
          <div className="dash-hero-title">No connections yet</div>
          <div className="dash-hero-sub">
            Connect to a PostgreSQL database to start querying.
          </div>
          <button className="dash-hero-btn" onClick={() => editConnection(blankProfile())}>
            <Plus size={15} /> Add Your First Connection
          </button>
          <div className="dash-hero-hint">
            <kbd>⌘K</kbd> opens the command palette anytime
          </div>
        </div>
      ) : (
        <div className="dash-grid">
          {profiles.map((p, i) => {
            const state = connState[p.id] ?? "disconnected";
            return (
              <div
                key={p.id}
                className="dash-card"
                onClick={() => openConn(p.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, profile: p });
                }}
                title={state === "connected" ? `Open ${p.name || p.host}` : `Connect to ${p.name || p.host}`}
              >
                <Avatar profile={p} index={i} size={44} />
                <div className="dash-card-body">
                  <div className="dash-card-name">
                    {p.name || p.host}
                    {p.is_prod && <span className="badge badge-danger">PROD</span>}
                  </div>
                  <div className="dash-card-sub">
                    {p.host}:{p.port} · {p.dbname}
                  </div>
                </div>
                <span className={`dash-state ${state}`} />
                <button
                  className="dash-edit"
                  title="Edit connection"
                  onClick={(e) => {
                    e.stopPropagation();
                    editConnection(p);
                  }}
                >
                  <Pencil size={13} />
                </button>
              </div>
            );
          })}

          <button className="dash-card dash-new" onClick={() => editConnection(blankProfile())}>
            <span className="dash-new-icon">
              <Plus size={22} />
            </span>
            <span>New Connection</span>
          </button>
        </div>
      )}

      {recent.length > 0 && (
        <div className="dash-recent">
          <div className="dash-recent-head">
            <Clock size={13} /> Recent
          </div>
          {recent.map((row) => {
            const prof = profiles.find((p) => p.id === row.profile_id);
            return (
              <button key={row.id} className="dash-recent-item" onClick={() => void openRecent(row)}>
                {prof && <Avatar profile={prof} index={profiles.indexOf(prof)} size={22} />}
                <span className="dash-recent-sql">{row.sql.replace(/\s+/g, " ").trim()}</span>
                <span className="dash-recent-meta">
                  {prof?.name || prof?.host || "—"} · {relTime(row.ran_at)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {menu && (
        <ContextMenu
          point={menu}
          items={connectionMenu(
            menu.profile,
            (connState[menu.profile.id] ?? "disconnected") === "connected",
          )}
          onClose={() => setMenu(null)}
        />
      )}
    </motion.div>
  );
}
