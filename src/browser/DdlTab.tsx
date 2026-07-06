import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "../ipc/commands";
import type { TableInfo } from "../stores/schema";
import { useConnections } from "../stores/connections";
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

  useEffect(() => {
    setDdl(null);
    setError(null);
    if (!sessionId) return;
    let stale = false;
    ipc
      .tableDdl(sessionId, table.schema, table.name)
      .then((d) => !stale && setDdl(d))
      .catch((e) => !stale && setError((e as { message?: string }).message ?? String(e)));
    return () => {
      stale = true;
    };
    // refetch when the table or the (re)connected session changes
  }, [sessionId, table.schema, table.name, activeProfileId]);

  return (
    <div className="ddl-tab">
      <div className="ddl-toolbar">
        <span className="ddl-title">
          {table.schema}.{table.name}
        </span>
        <button
          className="icon-btn"
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
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      {error ? (
        <div className="ddl-error">{error}</div>
      ) : ddl === null ? (
        <div className="ddl-loading">Loading…</div>
      ) : (
        <pre className="ddl-body">{ddl}</pre>
      )}
    </div>
  );
}
