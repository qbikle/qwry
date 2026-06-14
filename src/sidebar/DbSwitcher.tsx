import { useState } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown, Database } from "lucide-react";
import { menuIn } from "../design/springs";
import { useConnections } from "../stores/connections";
import * as ipc from "../ipc/commands";

const LIST_DBS =
  "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY datname";

/** sidebar DB header: shows the current database, opens a list to switch.
 * Picking another database clones the connection (sibling) and connects. */
export function DbSwitcher({ profileId, dbname, name }: { profileId: string; dbname: string; name: string }) {
  const sessions = useConnections((s) => s.sessions);
  const connect = useConnections((s) => s.connect);
  const loadProfiles = useConnections((s) => s.loadProfiles);
  const [open, setOpen] = useState(false);
  const [dbs, setDbs] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (dbs) return;
    const sid = sessions[profileId];
    if (!sid) {
      setDbs([]);
      return;
    }
    try {
      const out = await ipc.execute(sid, LIST_DBS);
      setDbs((out.statements[0]?.rows.map((r) => r[0] ?? "").filter(Boolean) as string[]) ?? []);
    } catch {
      setDbs([]);
    }
  };

  const pick = async (db: string) => {
    setOpen(false);
    if (db === dbname) return;
    setBusy(true);
    try {
      const p = await ipc.cloneConnection(profileId, db);
      await loadProfiles();
      await connect(p.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dbsw">
      <button className="sb-dbhead" onClick={() => void toggle()} title={`${name} · ${dbname}`} disabled={busy}>
        <Database size={15} className="sb-db-icon" />
        <span className="sb-db-name">{dbname || name}</span>
        <ChevronDown size={13} className="sb-db-chev" />
      </button>
      {open && <div className="dbsw-backdrop" onMouseDown={() => setOpen(false)} />}
      {open && (
        <motion.div className="dbsw-pop" {...menuIn}>
          {dbs === null ? (
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
                {db === dbname && <Check size={13} />}
              </button>
            ))
          )}
        </motion.div>
      )}
    </div>
  );
}
