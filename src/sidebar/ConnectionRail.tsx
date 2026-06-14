import { motion } from "motion/react";
import { Plus } from "lucide-react";
import { railItemIn } from "../design/springs";
import { useConnections } from "../stores/connections";
import type { Profile } from "../ipc/types";
import "./rail.css";

const blank = (): Profile => ({
  id: crypto.randomUUID(),
  name: "",
  host: "localhost",
  port: 5432,
  dbname: "",
  user: "",
  sslmode: "prefer",
  color: null,
  is_prod: false,
  ssh_host: null,
  ssh_port: null,
  ssh_user: null,
  ssh_key: null,
});

// fallback palette when a profile has no custom colour yet (P2.3 adds the picker)
const PALETTE = ["#5b8cff", "#3ecf8e", "#f5a623", "#ff5c69", "#c792ea", "#22b8cf", "#ff8a65"];
const colorFor = (p: Profile, i: number) => p.color || PALETTE[i % PALETTE.length];
const glyphFor = (p: Profile) => (p.name.trim()[0] || p.host[0] || "?").toUpperCase();

export function ConnectionRail() {
  const profiles = useConnections((s) => s.profiles);
  const connState = useConnections((s) => s.connState);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const connect = useConnections((s) => s.connect);
  const setActive = useConnections((s) => s.setActive);
  const setEditing = useConnections((s) => s.setEditing);

  return (
    <div className="rail">
      <div className="rail-list">
        {profiles.map((p, i) => {
          const state = connState[p.id] ?? "disconnected";
          const active = activeProfileId === p.id;
          return (
            <motion.button
              key={p.id}
              {...railItemIn}
              className={`rail-item${active ? " active" : ""}`}
              style={{ ["--c"]: colorFor(p, i) } as React.CSSProperties}
              title={`${p.name || p.host}${p.is_prod ? " · PROD" : ""}`}
              onClick={() => (state === "connected" ? setActive(p.id) : connect(p.id))}
              onContextMenu={(e) => {
                e.preventDefault();
                setEditing(p);
              }}
            >
              <span className="rail-avatar" style={{ background: colorFor(p, i) }}>
                {glyphFor(p)}
                {p.is_prod && <span className="rail-prod" title="Production" />}
              </span>
              <span className={`rail-dot ${state}`} />
            </motion.button>
          );
        })}
      </div>
      <button className="rail-add" title="New connection" onClick={() => setEditing(blank())}>
        <Plus size={18} />
      </button>
    </div>
  );
}
