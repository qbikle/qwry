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
