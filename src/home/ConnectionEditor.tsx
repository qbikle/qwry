import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, Trash2, Zap } from "lucide-react";
import * as ipc from "../ipc/commands";
import { confirmTxRollback, useConnections } from "../stores/connections";
import type { Profile } from "../ipc/types";
import { Avatar, AVATAR_ICONS, AVATAR_PALETTE } from "../sidebar/avatar";
import { Kbd } from "../design/Kbd";
import { looksLikeDsn, parseDsn } from "./dsn";
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
  const [pastedDsn, setPastedDsn] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; ms: number; version: string; tls: boolean } | { ok: false; error: string } | null
  >(null);

  // probe the CURRENT form values — nothing is saved; an unsaved password is
  // passed along, otherwise the keychain entry for this profile id is used
  const testConn = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await ipc.testConnection(p, password || undefined);
      setTestResult({
        ok: true,
        ms: r.latency_ms,
        // "PostgreSQL 16.4 on aarch64-…" → keep the part that matters
        version: r.server_version.split(" on ")[0],
        tls: r.tls,
      });
    } catch (ex) {
      setTestResult({ ok: false, error: (ex as { message?: string }).message ?? String(ex) });
    } finally {
      setTesting(false);
    }
  };

  const field = <K extends keyof Profile>(k: K, v: Profile[K]) =>
    setP((prev) => ({ ...prev, [k]: v }));

  // paste a postgres:// DSN anywhere in the form → fill the fields from it
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (!looksLikeDsn(text)) return;
    const d = parseDsn(text);
    if (!d || !d.host) return;
    e.preventDefault();
    setP((prev) => ({
      ...prev,
      host: d.host ?? prev.host,
      port: d.port ?? prev.port,
      dbname: d.dbname ?? prev.dbname,
      user: d.user ?? prev.user,
      sslmode: d.sslmode ?? prev.sslmode,
      name: prev.name.trim() || d.dbname || prev.name,
    }));
    if (d.password) setPassword(d.password);
    setPastedDsn(true);
    setTimeout(() => setPastedDsn(false), 3000);
  };

  // glyph: text (letter/emoji) lives in the input; `icon:<name>` picks an icon
  const glyphIsIcon = p.glyph?.startsWith("icon:");
  const glyphText = glyphIsIcon ? "" : (p.glyph ?? "");

  const save = async (thenConnect: boolean) => {
    setSaving(true);
    setErr(null);
    try {
      await saveProfile(p, password || undefined);
      // leave the editor BEFORE connecting: a connect failure used to strand
      // a blank New Connection form (saveProfile clears `editing`, homeMode
      // stayed "edit"). On the dashboard the saved card stays visible, shows
      // the connecting/failed dot, and the failure lands in the ConnToast.
      setHome("dashboard");
      if (thenConnect) await connect(p.id);
    } catch (ex) {
      setErr((ex as { message?: string }).message ?? String(ex));
      setSaving(false);
    }
  };

  const valid = !saving && !!p.name.trim() && !!p.host && !!p.dbname && !!p.user;

  // a dirty 8-field form must not vanish on one stray Esc
  const dirty = password !== "" || JSON.stringify(p) !== JSON.stringify(profile);
  const requestCancel = () => {
    if (!dirty) {
      setHome("dashboard");
      return;
    }
    void import("../stores/danger").then(async ({ confirmDanger }) => {
      const ok = await confirmDanger(
        "Discard Connection Changes?",
        "Edits to this connection form will be lost.",
        "Discard Edits",
      );
      if (ok) setHome("dashboard");
    });
  };

  // capture-phase window listener: fires regardless of focus (WKWebView buttons
  // don't take focus on click) and beats the global ⌘S/Esc handlers
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestCancel();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (valid) void save(true);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      if (valid) void save(false);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  return (
    <div className="ce" onPaste={onPaste}>
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
                  className={`iconbtn iconbtn-lg bordered ce-icon${p.glyph === `icon:${name}` ? " active" : ""}`}
                  title={name}
                  onClick={() => field("glyph", `icon:${name}`)}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* connection */}
        <div className="ce-section">
          <div className="ce-label">
            Connection
            {pastedDsn ? (
              <span className="ce-hint ok">filled from the pasted URL</span>
            ) : (
              <span className="ce-hint">paste a postgres:// URL to fill</span>
            )}
          </div>
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
                placeholder={isNew ? "" : "Unchanged"}
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
            Production Connection
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
            SSH Tunnel
          </label>
          {tunnel && (
            <div className="ce-grid">
              <label className="ce-field ce-span3">
                <span>SSH Host</span>
                <input
                  value={p.ssh_host ?? ""}
                  onChange={(e) => field("ssh_host", e.target.value)}
                  placeholder="bastion or ssh-config alias"
                />
              </label>
              <label className="ce-field">
                <span>SSH Port</span>
                <input
                  type="number"
                  value={p.ssh_port ?? 22}
                  onChange={(e) => field("ssh_port", Number(e.target.value) || 22)}
                />
              </label>
              <label className="ce-field ce-span2">
                <span>SSH User</span>
                <input value={p.ssh_user ?? ""} onChange={(e) => field("ssh_user", e.target.value)} placeholder="Optional" />
              </label>
              <label className="ce-field ce-span2">
                <span>Identity File</span>
                <input value={p.ssh_key ?? ""} onChange={(e) => field("ssh_key", e.target.value)} placeholder="Optional" />
              </label>
            </div>
          )}
        </div>

        {err && <div className="ce-error">{err}</div>}
        {testResult &&
          (testResult.ok ? (
            <div className="ce-test-ok">
              <ShieldCheck size={12} />
              {testResult.version} · {Math.round(testResult.ms)}ms
              {testResult.tls ? " · TLS" : " · no TLS"}
            </div>
          ) : (
            <div className="ce-error">{testResult.error}</div>
          ))}
      </div>

      <div className="ce-actions">
        <button className="btnish ce-test" disabled={!valid || testing} onClick={() => void testConn()}>
          {testing ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
          {testing ? "Testing…" : "Test"}
        </button>
        {!isNew && (
          <button
            className={`btnish danger ce-del${armed ? " armed" : ""}`}
            onClick={() => {
              if (armed) {
                void (async () => {
                  if (!(await confirmTxRollback(p.id, "Delete"))) return;
                  void deleteProfile(p.id);
                  setHome("dashboard");
                })();
              } else {
                setArmed(true);
                setTimeout(() => setArmed(false), 2000);
              }
            }}
          >
            <Trash2 size={14} /> {armed ? "Confirm Delete" : "Delete"}
          </button>
        )}
        <button className="btnish ce-cancel" onClick={requestCancel}>
          Cancel <Kbd chord="esc" />
        </button>
        <button className="btnish" disabled={!valid} onClick={() => void save(false)}>
          {saving ? "Saving…" : "Save"} <Kbd chord="cmd+s" />
        </button>
        <button className="btnish primary" disabled={!valid} onClick={() => void save(true)}>
          Save and Connect <Kbd chord="cmd+return" />
        </button>
      </div>
    </div>
  );
}
