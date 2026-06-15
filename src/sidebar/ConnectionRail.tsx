import { useEffect, useState } from "react";
import { Reorder } from "motion/react";
import { House, Plus } from "lucide-react";
import { useConnections } from "../stores/connections";
import * as ipc from "../ipc/commands";
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

const idSeq = (ps: Profile[]) => ps.map((p) => p.id).join(",");

export function ConnectionRail() {
  const profiles = useConnections((s) => s.profiles);
  const connState = useConnections((s) => s.connState);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const homeMode = useConnections((s) => s.homeMode);
  const connect = useConnections((s) => s.connect);
  const setActive = useConnections((s) => s.setActive);
  const setHome = useConnections((s) => s.setHome);
  const editConnection = useConnections((s) => s.editConnection);

  // local order drives the drag animation; keep our order but always adopt the
  // latest profile objects (so a customise — color/glyph — shows immediately)
  const [items, setItems] = useState<Profile[]>(profiles);
  useEffect(() => {
    setItems((cur) => {
      const byId = new Map(profiles.map((p) => [p.id, p]));
      const kept = cur.filter((c) => byId.has(c.id)).map((c) => byId.get(c.id)!);
      const keptIds = new Set(kept.map((p) => p.id));
      const added = profiles.filter((p) => !keptIds.has(p.id));
      const next = [...kept, ...added];
      const same = next.length === cur.length && next.every((p, i) => p === cur[i]);
      return same ? cur : next;
    });
  }, [profiles]);

  // persist a reorder shortly after the drag settles
  useEffect(() => {
    if (idSeq(items) === idSeq(useConnections.getState().profiles)) return;
    const t = setTimeout(() => {
      void ipc.setProfileOrder(items.map((p) => p.id));
      useConnections.setState({ profiles: items });
    }, 350);
    return () => clearTimeout(t);
  }, [items]);

  return (
    <div className="rail">
      <button
        className={`rail-home${homeMode ? " active" : ""}`}
        title="Connections home"
        onClick={() => setHome("dashboard")}
      >
        <House size={18} />
      </button>

      <Reorder.Group axis="y" values={items} onReorder={setItems} className="rail-list">
        {items.map((p) => {
          const i = items.indexOf(p);
          const state = connState[p.id] ?? "disconnected";
          const active = activeProfileId === p.id && !homeMode;
          return (
            <Reorder.Item
              key={p.id}
              value={p}
              className={`rail-item${active ? " active" : ""}`}
              style={{ ["--c"]: avatarColor(p, i) } as React.CSSProperties}
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              whileDrag={{ scale: 1.14, zIndex: 10 }}
              transition={{ type: "spring", stiffness: 600, damping: 30, mass: 0.6 }}
              title={`${p.name || p.host}${p.is_prod ? " · PROD" : ""}`}
              onClick={() => {
                if (state === "connected") {
                  setActive(p.id);
                  setHome(null);
                } else {
                  void connect(p.id);
                }
              }}
              onContextMenu={(e: React.MouseEvent) => {
                e.preventDefault();
                editConnection(p);
              }}
            >
              <Avatar profile={p} index={i} size={40} />
              {p.is_prod && <span className="rail-prod" title="Production" />}
              <span className={`rail-dot ${state}`} />
            </Reorder.Item>
          );
        })}
      </Reorder.Group>

      <button className="rail-add" title="New connection" onClick={() => editConnection(blankProfile())}>
        <Plus size={18} />
      </button>
    </div>
  );
}
