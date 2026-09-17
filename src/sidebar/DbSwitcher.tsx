import { useState } from "react";
import { motion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { menuIn } from "../design/springs";
import { anySessionOn, useConnections } from "../stores/connections";
import { useRefreshFx } from "../stores/refreshFx";
import { useTabs } from "../stores/tabs";
import * as ipc from "../ipc/commands";
import { DbGlyph } from "./DbGlyph";
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
  const fx = useRefreshFx();
  const fxHere = fx.profileId === profileId;
  // the hard tier's verdict lands on COLOUR, never on the clap (E2 R6): the
  // glyph wears the two states the connection rail's own dot already wears
  // (rail.css), read off the same connState, so one connection can never read
  // two ways in one window (DESIGN rule 14). The rail hides its dot when the
  // profile is disconnected; a header that is only on screen BECAUSE the
  // profile connected cannot hide, so the state it fell to is the state it
  // shows
  const connState = useConnections((s) => s.connState[profileId] ?? "connected");

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setDbs(null);
    setErr(null);
    // prefer the PRIMARY session: opening the switcher must not mint (or
    // consume the pre-warmed spare for) a tab session just to run one
    // SELECT datname. Any live tab session of the profile is the fallback,
    // and minting one is the last resort.
    const conn = useConnections.getState();
    const tabId = useTabs.getState().activeId;
    const sid =
      anySessionOn(profileId) ?? (tabId ? await conn.ensureTabSession(profileId, tabId) : null);
    if (!sid) {
      setErr("not connected");
      return;
    }
    try {
      const out = await ipc.execute(sid, LIST_DBS);
      setDbs((out.statements[0]?.rows.map((r) => r[0] ?? "").filter(Boolean) as string[]) ?? []);
    } catch (e) {
      // a failure must never render as "No databases"; that's a lie
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
      <button
        className={`sb-dbhead${connState === "connected" ? "" : ` ${connState}`}`}
        onClick={() => void toggle()}
        title={`${name} · ${dbname}`}
        disabled={busy}
      >
        <DbGlyph key={profileId} apart={fxHere && fx.apart} spinTurns={fxHere ? fx.spinTurns : 0} />
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
