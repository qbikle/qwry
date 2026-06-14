import { motion } from "motion/react";
import { Pencil, Plus } from "lucide-react";
import { panelIn } from "../design/springs";
import { useConnections } from "../stores/connections";
import { Avatar } from "../sidebar/avatar";
import { blankProfile } from "../sidebar/ConnectionRail";
import "./home.css";

export function Dashboard() {
  const profiles = useConnections((s) => s.profiles);
  const connState = useConnections((s) => s.connState);
  const connect = useConnections((s) => s.connect);
  const setActive = useConnections((s) => s.setActive);
  const setHome = useConnections((s) => s.setHome);
  const editConnection = useConnections((s) => s.editConnection);

  // already connected (green) → open the work view instantly; else connect
  const openConn = (id: string) => {
    if ((connState[id] ?? "disconnected") === "connected") {
      setActive(id);
      setHome(null);
    } else {
      void connect(id);
    }
  };

  return (
    <motion.div className="dash" {...panelIn}>
      <div className="dash-head">
        <span className="dash-title">Connections</span>
      </div>

      <div className="dash-grid">
        {profiles.map((p, i) => {
          const state = connState[p.id] ?? "disconnected";
          return (
            <div
              key={p.id}
              className="dash-card"
              onClick={() => openConn(p.id)}
              title={state === "connected" ? `Open ${p.name || p.host}` : `Connect to ${p.name || p.host}`}
            >
              <Avatar profile={p} index={i} size={44} />
              <div className="dash-card-body">
                <div className="dash-card-name">
                  {p.name || p.host}
                  {p.is_prod && <span className="dash-prod">PROD</span>}
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
          <span>New connection</span>
        </button>
      </div>
    </motion.div>
  );
}
