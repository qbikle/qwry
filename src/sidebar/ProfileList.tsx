import { useState } from "react";
import { Circle, Database, Pencil, Plus, Trash2 } from "lucide-react";
import { useConnections } from "../stores/connections";
import type { Profile } from "../ipc/types";
import { SchemaTree } from "./SchemaTree";
import "./sidebar.css";

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

export function ProfileList() {
  // window.confirm is a stub in WKWebView — two-click arm instead
  const [armed, setArmed] = useState<string | null>(null);
  const profiles = useConnections((s) => s.profiles);
  const connState = useConnections((s) => s.connState);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const connect = useConnections((s) => s.connect);
  const setActive = useConnections((s) => s.setActive);
  const setEditing = useConnections((s) => s.setEditing);
  const deleteProfile = useConnections((s) => s.deleteProfile);

  return (
    <div className="profile-list">
      <div className="pl-header" data-tauri-drag-region>
        <span>Connections</span>
        <button className="icon-btn" title="New connection" onClick={() => setEditing(blank())}>
          <Plus size={14} />
        </button>
      </div>
      {profiles.length === 0 && (
        <div className="pl-empty">
          No connections yet.
          <button className="link-btn" onClick={() => setEditing(blank())}>
            Create one
          </button>
        </div>
      )}
      {profiles.map((p) => {
        const state = connState[p.id] ?? "disconnected";
        return (
          <div key={p.id}>
          <div
            className={`pl-item ${activeProfileId === p.id ? "active" : ""}`}
            onClick={() => (state === "connected" ? setActive(p.id) : connect(p.id))}
            onDoubleClick={() => connect(p.id)}
          >
            <Database size={14} className={p.is_prod ? "prod" : ""} />
            <span className="pl-name">{p.name || p.host}</span>
            {p.is_prod && <span className="badge badge-danger">PROD</span>}
            <Circle
              size={8}
              className={`pl-dot ${state}`}
              fill={state === "connected" ? "currentColor" : "none"}
            />
            <span className="pl-item-actions">
              <button
                className="icon-btn"
                title="Edit"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(p);
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                className={`icon-btn${armed === p.id ? " armed" : ""}`}
                title={armed === p.id ? "Click again to delete" : "Delete"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (armed === p.id) {
                    void deleteProfile(p.id);
                    setArmed(null);
                  } else {
                    setArmed(p.id);
                    setTimeout(() => setArmed((a) => (a === p.id ? null : a)), 2000);
                  }
                }}
              >
                <Trash2 size={12} />
              </button>
            </span>
          </div>
          {state === "connected" && activeProfileId === p.id && (
            <SchemaTree profileId={p.id} />
          )}
          </div>
        );
      })}
    </div>
  );
}
