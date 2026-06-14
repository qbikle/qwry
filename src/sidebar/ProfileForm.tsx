import { useState } from "react";
import { useConnections } from "../stores/connections";
import type { Profile } from "../ipc/types";
import "./sidebar.css";

export function ProfileForm({ profile }: { profile: Profile }) {
  const saveProfile = useConnections((s) => s.saveProfile);
  const setEditing = useConnections((s) => s.setEditing);
  const [p, setP] = useState<Profile>(profile);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tunnel, setTunnel] = useState(!!profile.ssh_host?.trim());

  const field = <K extends keyof Profile>(k: K, v: Profile[K]) =>
    setP((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await saveProfile(p, password || undefined);
    } catch (ex) {
      setErr((ex as { message?: string }).message ?? String(ex));
      setSaving(false);
    }
  };

  return (
    <form className="profile-form" onSubmit={submit}>
      <div className="pf-title">{profile.name ? "Edit connection" : "New connection"}</div>
      <label>
        Name
        <input value={p.name} onChange={(e) => field("name", e.target.value)} required autoFocus />
      </label>
      <div className="pf-row">
        <label style={{ flex: 3 }}>
          Host
          <input value={p.host} onChange={(e) => field("host", e.target.value)} required />
        </label>
        <label style={{ flex: 1 }}>
          Port
          <input
            type="number"
            value={p.port}
            onChange={(e) => field("port", Number(e.target.value) || 5432)}
          />
        </label>
      </div>
      <label>
        Database
        <input value={p.dbname} onChange={(e) => field("dbname", e.target.value)} required />
      </label>
      <label>
        User
        <input value={p.user} onChange={(e) => field("user", e.target.value)} required />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={profile.name ? "(unchanged)" : ""}
        />
      </label>
      <div className="pf-row">
        <label style={{ flex: 1 }}>
          SSL
          <select
            value={p.sslmode}
            onChange={(e) => field("sslmode", e.target.value as Profile["sslmode"])}
          >
            <option value="prefer">prefer</option>
            <option value="require">require</option>
            <option value="disable">disable</option>
          </select>
        </label>
        <label className="pf-check">
          <input
            type="checkbox"
            checked={p.is_prod}
            onChange={(e) => field("is_prod", e.target.checked)}
          />
          Production
        </label>
      </div>

      <label className="pf-check">
        <input
          type="checkbox"
          checked={tunnel}
          onChange={(e) => {
            setTunnel(e.target.checked);
            if (!e.target.checked) field("ssh_host", null);
          }}
        />
        SSH tunnel
      </label>
      {tunnel && (
        <div className="pf-ssh">
          <div className="pf-hint">
            Uses your system <code>ssh</code> (~/.ssh/config, keys, ProxyJump). Host/Port
            above are the database as seen from the SSH server.
          </div>
          <div className="pf-row">
            <label style={{ flex: 3 }}>
              SSH host
              <input
                value={p.ssh_host ?? ""}
                onChange={(e) => field("ssh_host", e.target.value)}
                placeholder="bastion.example.com or ssh-config alias"
              />
            </label>
            <label style={{ flex: 1 }}>
              SSH port
              <input
                type="number"
                value={p.ssh_port ?? 22}
                onChange={(e) => field("ssh_port", Number(e.target.value) || 22)}
              />
            </label>
          </div>
          <label>
            SSH user
            <input
              value={p.ssh_user ?? ""}
              onChange={(e) => field("ssh_user", e.target.value)}
              placeholder="(optional — from ssh config)"
            />
          </label>
          <label>
            Identity file
            <input
              value={p.ssh_key ?? ""}
              onChange={(e) => field("ssh_key", e.target.value)}
              placeholder="(optional — e.g. ~/.ssh/id_ed25519)"
            />
          </label>
        </div>
      )}
      {err && <div className="pf-error">{err}</div>}
      <div className="pf-actions">
        <button type="button" onClick={() => setEditing(null)}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
