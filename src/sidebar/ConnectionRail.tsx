import { motion } from "motion/react";
import { House, Plus } from "lucide-react";
import { railItemIn } from "../design/springs";
import { useConnections } from "../stores/connections";
import type { Profile } from "../ipc/types";
import { Avatar, avatarColor } from "./avatar";
import "./rail.css";

export const blankProfile = (): Profile => ({
  id: crypto.randomUUID(),
  name: "",
  host: "localhost",
  port: 5432,
  dbname: "",
  user: "",
  sslmode: "prefer",
  color: null,
  glyph: null,
  is_prod: false,
  ssh_host: null,
  ssh_port: null,
  ssh_user: null,
  ssh_key: null,
});

export function ConnectionRail() {
  const profiles = useConnections((s) => s.profiles);
  const connState = useConnections((s) => s.connState);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const homeMode = useConnections((s) => s.homeMode);
  const connect = useConnections((s) => s.connect);
  const setActive = useConnections((s) => s.setActive);
  const setHome = useConnections((s) => s.setHome);
  const editConnection = useConnections((s) => s.editConnection);

  return (
    <div className="rail">
      <button
        className={`rail-home${homeMode ? " active" : ""}`}
        title="Connections home"
        onClick={() => setHome("dashboard")}
      >
        <House size={18} />
      </button>

      <div className="rail-list">
        {profiles.map((p, i) => {
          const state = connState[p.id] ?? "disconnected";
          const active = activeProfileId === p.id && !homeMode;
          return (
            <motion.button
              key={p.id}
              {...railItemIn}
              className={`rail-item${active ? " active" : ""}`}
              style={{ ["--c"]: avatarColor(p, i) } as React.CSSProperties}
              title={`${p.name || p.host}${p.is_prod ? " · PROD" : ""}`}
              onClick={() => {
                if (state === "connected") {
                  setActive(p.id);
                  setHome(null);
                } else {
                  void connect(p.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                editConnection(p);
              }}
            >
              <Avatar profile={p} index={i} size={40} />
              {p.is_prod && <span className="rail-prod" title="Production" />}
              <span className={`rail-dot ${state}`} />
            </motion.button>
          );
        })}
      </div>

      <button className="rail-add" title="New connection" onClick={() => editConnection(blankProfile())}>
        <Plus size={18} />
      </button>
    </div>
  );
}
