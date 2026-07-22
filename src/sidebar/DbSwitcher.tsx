import { useState } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown, Database } from "lucide-react";
import { menuIn } from "../design/springs";
import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { useTabs } from "../stores/tabs";
import * as ipc from "../ipc/commands";
import { ServerInfo } from "./ServerInfo";

const LIST_DBS =
  "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY datname";

/** sidebar DB header: shows the current database, opens a list to switch.
 * Picking another database clones the connection (sibling) and connects. */
export function DbSwitcher({ profileId, dbname, name }: { profileId: string; dbname: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [dbs, setDbs] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setDbs(null);
    setErr(null);
    // prefer the PRIMARY session — opening the switcher must not mint (or
    // consume the pre-warmed spare for) a tab session just to run one
    // SELECT datname. Fallbacks: the last-run session (only if it belongs to
    // THIS profile), then a tab session as the true last resort.
    const conn = useConnections.getState();
    const res = useResults.getState();
    const tabId = useTabs.getState().activeId;
    const sid =
      conn.sessions[profileId] ??
      (res.executedProfileId === profileId ? res.executedSessionId : null) ??
      (tabId ? await conn.ensureTabSession(profileId, tabId) : null);
    if (!sid) {
      setErr("not connected");
      return;
    }
    try {
      const out = await ipc.execute(sid, LIST_DBS);
      setDbs((out.statements[0]?.rows.map((r) => r[0] ?? "").filter(Boolean) as string[]) ?? []);
    } catch (e) {
      // a failure must never render as "No databases" — that's a lie
      setErr((e as { message?: string }).message ?? String(e));
    }
  };

  const pick = async (db: string) => {
    setOpen(false);
    if (db === dbname) return;
    setBusy(true);
    try {
      const conn = useConnections.getState();
      const src = conn.profiles.find((p) => p.id === profileId);
      // reuse an existing connection for this database on the same server
      const existing = conn.profiles.find(
        (p) =>
          p.id !== profileId &&
          p.dbname === db &&
          p.host === src?.host &&
          p.port === src?.port &&
          p.user === src?.user,
      );
      if (existing) {
        if (conn.connState[existing.id] === "connected") {
          conn.setActive(existing.id);
          conn.setHome(null);
        } else {
          await conn.connect(existing.id);
        }
        return;
      }
      const p = await ipc.cloneConnection(profileId, db);
      await conn.loadProfiles();
      await conn.connect(p.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dbsw">
      <button className="sb-dbhead" onClick={() => void toggle()} title={`${name} · ${dbname}`} disabled={busy}>
        <Database size={16} className="sb-db-icon" />
        <span className="sb-db-name">{dbname || name}</span>
        <ChevronDown size={12} className="sb-db-chev" />
      </button>
      <ServerInfo profileId={profileId} />
      {open && <div className="dbsw-backdrop" onMouseDown={() => setOpen(false)} />}
      {open && (
        <motion.div className="dbsw-pop" {...menuIn}>
          {err ? (
            <div className="dbsw-msg dbsw-err" title={err}>
              Couldn’t list databases: {err.slice(0, 120)}
            </div>
          ) : dbs === null ? (
            <div className="dbsw-msg">Loading…</div>
          ) : dbs.length === 0 ? (
            <div className="dbsw-msg">No databases</div>
          ) : (
            dbs.map((db) => (
              <button
                key={db}
                className={`dbsw-item${db === dbname ? " active" : ""}`}
                onClick={() => void pick(db)}
              >
                <span className="dbsw-name">{db}</span>
                {db === dbname && <Check size={12} />}
              </button>
            ))
          )}
        </motion.div>
      )}
    </div>
  );
}
