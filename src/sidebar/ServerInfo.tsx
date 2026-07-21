import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Info } from "lucide-react";
import { popIn } from "../design/springs";
import * as ipc from "../ipc/commands";
import { useConnections } from "../stores/connections";
import { Modal } from "../app/overlay/Overlay";
import "./sidebar.css";

const INFO_SQL = `SELECT
  version(),
  current_setting('server_encoding'),
  current_setting('TimeZone'),
  current_setting('search_path'),
  pg_size_pretty(pg_database_size(current_database())),
  current_database(),
  current_user,
  coalesce(inet_server_addr()::text || ':' || inet_server_port(), 'socket')`;

const LABELS = [
  "Server",
  "Encoding",
  "Time zone",
  "search_path",
  "Database size",
  "Database",
  "User",
  "Listening on",
];

/** ⓘ next to the DB switcher — one-shot server facts (read-only catalog calls) */
export function ServerInfo({ profileId }: { profileId: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<(string | null)[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** actual session encryption — null while loading/unknown */
  const [tls, setTls] = useState<boolean | null>(null);
  const sslmode = useConnections(
    (s) => s.profiles.find((p) => p.id === profileId)?.sslmode ?? "prefer",
  );

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError(null);
    setTls(null);
    // primary session preferred; any live tab session on this profile works —
    // the primary can be dead while tabs reconnected independently
    const conn = useConnections.getState();
    const sid =
      conn.sessions[profileId] ??
      Object.entries(conn.tabSessions).find(([k]) => k.startsWith(`${profileId}::`))?.[1];
    if (!sid) {
      setError("not connected");
      return;
    }
    let stale = false;
    ipc
      .execute(sid, INFO_SQL)
      .then((out) => !stale && setRows(out.statements[0]?.rows[0] ?? []))
      .catch((e) => !stale && setError((e as { message?: string }).message ?? String(e)));
    // sslmode=prefer can silently downgrade to plaintext — show the OUTCOME
    ipc
      .sessionInfo(sid)
      .then((info) => !stale && setTls(info.tls))
      .catch(() => !stale && setTls(null));
    return () => {
      stale = true;
    };
  }, [open, profileId]);

  const tlsText =
    tls === null
      ? "—"
      : tls
        ? "TLS"
        : sslmode === "prefer"
          ? "TLS off — server skipped encryption"
          : "TLS off";

  return (
    <>
      <button className="sb-info-btn" title="Server info" onClick={() => setOpen(true)}>
        <Info size={13} />
      </button>
      {open && (
        <Modal label="Server Info" onClose={() => setOpen(false)}>
          <motion.div className="srvinfo-modal" {...popIn}>
            <div className="settings-title">Server Info</div>
            {error ? (
              <div className="srvinfo-err">{error}</div>
            ) : rows === null ? (
              <div className="srvinfo-loading">Loading…</div>
            ) : (
              <div className="srvinfo-rows">
                {LABELS.map((label, i) => (
                  <div key={label} className="srvinfo-row">
                    <span className="srvinfo-label">{label}</span>
                    <span className="srvinfo-value" title={rows[i] ?? ""}>
                      {i === 0 ? (rows[i] ?? "").split(" on ")[0] : (rows[i] ?? "—")}
                    </span>
                  </div>
                ))}
                <div className="srvinfo-row">
                  <span className="srvinfo-label">Encryption</span>
                  <span className="srvinfo-value" title={tlsText}>
                    {tlsText}
                  </span>
                </div>
              </div>
            )}
          </motion.div>
        </Modal>
      )}
    </>
  );
}
