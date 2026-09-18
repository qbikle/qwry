import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "../ipc/commands";
import type { TableInfo } from "../stores/schema";
import { subTabRefresh } from "../stores/browser";
import { useConnections } from "../stores/connections";
import { useRefresh } from "../stores/refresh";
import "./browser.css";

/** server-deparsed CREATE TABLE + constraints + indexes (read-only view) */
export function DdlTab({ table }: { table: TableInfo }) {
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const sessionId = useConnections((s) =>
    s.activeProfileId ? s.sessions[s.activeProfileId] : undefined,
  );
  const [ddl, setDdl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // this pane IS the table tab's main body while it shows, so it cycles with
  // the refresh that fetched it (E2 R3)
  const cycling = useRefresh((s) => !!s.cycling.main);
  // only the newest load may land: a refresh while the first fetch is in
  // flight would otherwise paint whichever answer arrives last
  const epoch = useRef(0);

  // a refresh does NOT clear: the DDL on screen stays readable until the
  // fresh text lands, and a refetch that failed leaves it there with the
  // strip above it (R3). Only a different table or session blanks the pane.
  const load = useCallback((): Promise<void> => {
    const mine = ++epoch.current;
    if (!sessionId) return Promise.resolve();
    return ipc.tableDdl(sessionId, table.schema, table.name).then(
      (d) => {
        if (epoch.current !== mine) return;
        setDdl(d);
        setError(null);
      },
      (e: { message?: string }) => {
        if (epoch.current === mine) setError(e.message ?? String(e));
      },
    );
    // refetch when the table or the (re)connected session changes
  }, [sessionId, table.schema, table.name, activeProfileId]);

  useEffect(() => {
    setDdl(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    subTabRefresh.ddl = load;
    return () => {
      if (subTabRefresh.ddl === load) subTabRefresh.ddl = null;
    };
  }, [load]);

  return (
    <div
      className={`ddl-tab${cycling ? " cycling" : ""}`}
      data-refresh-surface="main"
    >
      <div className="ddl-toolbar">
        <span className="ddl-title">
          {table.schema}.{table.name}
        </span>
        <button
          className="iconbtn"
          title="Copy DDL"
          disabled={!ddl}
          onClick={() => {
            if (!ddl) return;
            void writeText(ddl).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {error && <div className="ddl-error">{error}</div>}
      {ddl !== null ? (
        <pre className="ddl-body">{ddl}</pre>
      ) : (
        !error && <div className="ddl-loading">Loading…</div>
      )}
    </div>
  );
}
