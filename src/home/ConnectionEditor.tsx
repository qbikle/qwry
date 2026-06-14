import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useConnections } from "../stores/connections";
import type { Profile } from "../ipc/types";
import { Avatar, AVATAR_ICONS, AVATAR_PALETTE } from "../sidebar/avatar";
import "./home.css";

export function ConnectionEditor({ profile }: { profile: Profile }) {
  const saveProfile = useConnections((s) => s.saveProfile);
  const deleteProfile = useConnections((s) => s.deleteProfile);
  const setHome = useConnections((s) => s.setHome);
  const connect = useConnections((s) => s.connect);
  const isNew = !useConnections((s) => s.profiles).some((p) => p.id === profile.id);

  const [p, setP] = useState<Profile>(profile);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [tunnel, setTunnel] = useState(!!profile.ssh_host?.trim());

  const field = <K extends keyof Profile>(k: K, v: Profile[K]) =>
    setP((prev) => ({ ...prev, [k]: v }));

  // glyph: text (letter/emoji) lives in the input; `icon:<name>` picks an icon
  const glyphIsIcon = p.glyph?.startsWith("icon:");
  const glyphText = glyphIsIcon ? "" : (p.glyph ?? "");

  const save = async (thenConnect: boolean) => {
    setSaving(true);
    setErr(null);
    try {
      await saveProfile(p, password || undefined);
      if (thenConnect) await connect(p.id);
      else setHome("dashboard");
    } catch (ex) {
      setErr((ex as { message?: string }).message ?? String(ex));
      setSaving(false);
    }
  };

  return (
    <div className="ce">
      <div className="ce-scroll">
        {/* customization */}
        <div className="ce-custom">
          <Avatar profile={p} size={64} />
          <div className="ce-custom-fields">
            <input
              className="ce-name"
              placeholder="Connection name"
              value={p.name}
              onChange={(e) => field("name", e.target.value)}
              autoFocus
            />
            <div className="ce-colors">
              {AVATAR_PALETTE.map((c) => (
                <button
                  key={c}
                  className={`ce-swatch${p.color === c ? " active" : ""}`}
                  style={{ background: c }}
                  onClick={() => field("color", c)}
                />
              ))}
              <label className="ce-swatch ce-custom-color" style={{ background: p.color ?? "transparent" }}>
                <input type="color" value={p.color ?? "#5b8cff"} onChange={(e) => field("color", e.target.value)} />
                +
              </label>
            </div>
          </div>
        </div>

        {/* glyph */}
        <div className="ce-section">
          <div className="ce-label">Icon</div>
          <div className="ce-glyph">
            <input
              className="ce-glyph-text"
              maxLength={2}
              placeholder="Aa / 🐢"
              value={glyphText}
              onChange={(e) => field("glyph", e.target.value || null)}
            />
            <div className="ce-icons">
              {Object.entries(AVATAR_ICONS).map(([name, Icon]) => (
                <button
                  key={name}
                  className={`ce-icon${p.glyph === `icon:${name}` ? " active" : ""}`}
                  title={name}
                  onClick={() => field("glyph", `icon:${name}`)}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* connection */}
        <div className="ce-section">
          <div className="ce-label">Connection</div>
          <div className="ce-grid">
            <label className="ce-field ce-span3">
              <span>Host</span>
              <input value={p.host} onChange={(e) => field("host", e.target.value)} />
            </label>
            <label className="ce-field">
              <span>Port</span>
              <input
                type="number"
                value={p.port}
                onChange={(e) => field("port", Number(e.target.value) || 5432)}
              />
            </label>
            <label className="ce-field ce-span2">
              <span>Database</span>
              <input value={p.dbname} onChange={(e) => field("dbname", e.target.value)} />
            </label>
            <label className="ce-field ce-span2">
              <span>User</span>
              <input value={p.user} onChange={(e) => field("user", e.target.value)} />
            </label>
            <label className="ce-field ce-span2">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isNew ? "" : "(unchanged)"}
              />
            </label>
            <label className="ce-field ce-span2">
              <span>SSL</span>
              <select value={p.sslmode} onChange={(e) => field("sslmode", e.target.value as Profile["sslmode"])}>
                <option value="prefer">prefer</option>
                <option value="require">require</option>
                <option value="disable">disable</option>
              </select>
            </label>
          </div>
          <label className="ce-check">
            <input type="checkbox" checked={p.is_prod} onChange={(e) => field("is_prod", e.target.checked)} />
            Production connection
          </label>
        </div>

        {/* ssh tunnel */}
        <div className="ce-section">
          <label className="ce-check">
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
            <div className="ce-grid">
              <label className="ce-field ce-span3">
                <span>SSH host</span>
                <input
                  value={p.ssh_host ?? ""}
                  onChange={(e) => field("ssh_host", e.target.value)}
                  placeholder="bastion or ssh-config alias"
                />
              </label>
              <label className="ce-field">
                <span>SSH port</span>
                <input
                  type="number"
                  value={p.ssh_port ?? 22}
                  onChange={(e) => field("ssh_port", Number(e.target.value) || 22)}
                />
              </label>
              <label className="ce-field ce-span2">
                <span>SSH user</span>
                <input value={p.ssh_user ?? ""} onChange={(e) => field("ssh_user", e.target.value)} placeholder="(optional)" />
              </label>
              <label className="ce-field ce-span2">
                <span>Identity file</span>
                <input value={p.ssh_key ?? ""} onChange={(e) => field("ssh_key", e.target.value)} placeholder="(optional)" />
              </label>
            </div>
          )}
        </div>

        {err && <div className="ce-error">{err}</div>}
      </div>

      <div className="ce-actions">
        {!isNew && (
          <button
            className={`ce-del${armed ? " armed" : ""}`}
            onClick={() => {
              if (armed) {
                void deleteProfile(p.id);
                setHome("dashboard");
              } else {
                setArmed(true);
                setTimeout(() => setArmed(false), 2000);
              }
            }}
          >
            <Trash2 size={14} /> {armed ? "Click again" : "Delete"}
          </button>
        )}
        <button onClick={() => setHome("dashboard")}>Cancel</button>
        <button disabled={saving || !p.name.trim() || !p.host || !p.dbname || !p.user} onClick={() => void save(false)}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          className="primary"
          disabled={saving || !p.name.trim() || !p.host || !p.dbname || !p.user}
          onClick={() => void save(true)}
        >
          Save & Connect
        </button>
      </div>
    </div>
  );
}
