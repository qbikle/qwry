import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "../ipc/commands";
import type { TableStats } from "../ipc/types";
import { useConnections } from "../stores/connections";
import type { TableInfo } from "../stores/schema";
import "./browser.css";

/** TableBrowser's header Refresh routes here while Structure is active — it
 * used to rerun the DATA query, which does nothing for this surface */
export const structureRefresh = { current: null as null | (() => void) };

const CONSTRAINT_KIND: Record<string, string> = {
  p: "PRIMARY KEY",
  u: "UNIQUE",
  f: "FOREIGN KEY",
  c: "CHECK",
  x: "EXCLUDE",
  t: "CONSTRAINT TRIGGER",
  n: "NOT NULL",
};

/** any live session on the active profile (primary preferred — it can be
 * dead while tab sessions live on) */
function pickSession(): string | undefined {
  const conn = useConnections.getState();
  const pid = conn.activeProfileId;
  if (!pid) return undefined;
  return (
    conn.sessions[pid] ??
    Object.entries(conn.tabSessions).find(([k]) => k.startsWith(`${pid}::`))?.[1]
  );
}

function CopyBtn({ text, id, copied, onCopied }: {
  text: string;
  id: string;
  copied: string | null;
  onCopied: (id: string | null) => void;
}) {
  return (
    <button
      className="iconbtn st-copy"
      title="Copy DDL"
      onClick={() => {
        void writeText(text).then(() => {
          onCopied(id);
          setTimeout(() => onCopied(null), 1200);
        });
      }}
    >
      {copied === id ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function StructureTab({ table }: { table: TableInfo }) {
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const [stats, setStats] = useState<TableStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setStats(null);
    setError(null);
    const sid = pickSession();
    if (!sid) {
      setError("not connected");
      return;
    }
    let stale = false;
    ipc
      .tableStats(sid, table.schema, table.name)
      .then((s) => !stale && setStats(s))
      .catch((e) => !stale && setError((e as { message?: string }).message ?? String(e)));
    return () => {
      stale = true;
    };
    // bump = header Refresh clicks while this tab is showing
  }, [table.schema, table.name, activeProfileId, bump]);

  useEffect(() => {
    structureRefresh.current = () => setBump((n) => n + 1);
    return () => {
      structureRefresh.current = null;
    };
  }, []);

  // fresh comments win over the (possibly stale) snapshot the tab carries
  const colComment = (name: string): string | null => {
    if (stats) return stats.column_comments.find((c) => c.column === name)?.comment ?? null;
    return table.columns.find((c) => c.name === name)?.comment ?? null;
  };
  const anyColComment =
    stats?.column_comments.length ?? table.columns.filter((c) => c.comment).length;

  // "never scanned" is a neutral fact; "candidate for dropping" is advice —
  // enforcement-only unique indexes (CREATE UNIQUE INDEX, no pg_constraint
  // row) get the fact but never the advice: dropping one loses uniqueness
  const neverScanned = (ix: TableStats["indexes"][number]) =>
    ix.scans === 0 && !ix.is_primary && !ix.backs_constraint;
  const dropCandidate = (ix: TableStats["indexes"][number]) =>
    neverScanned(ix) && !ix.is_unique;

  const act = stats?.activity ?? null;
  const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString()); // em-ok absent-value marker

  // live columns win over the (possibly stale) snapshot the tab carries
  const cols = stats
    ? stats.columns.map((c) => ({
        attnum: c.attnum,
        name: c.name,
        type: c.data_type,
        not_null: c.not_null,
        default: c.default,
        identity: c.identity,
        generated: c.generated,
      }))
    : table.columns.map((c) => ({
        attnum: c.attnum,
        name: c.name,
        type: c.type,
        not_null: c.not_null,
        default: c.default,
        identity: c.identity ?? "",
        generated: c.generated ?? "",
      }));

  return (
    <div className="tb-structure">
      <h3>Columns</h3>
      <table className="st-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            {anyColComment ? <th>Comment</th> : null}
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name}>
              <td className="st-num">{c.attnum}</td>
              <td className="st-name">
                {c.name}
                {table.pk.includes(c.name) && <span className="badge badge-accent">PK</span>}
                {c.identity !== "" && (
                  <span
                    className="badge badge-dim"
                    title={`GENERATED ${c.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`}
                  >
                    identity
                  </span>
                )}
                {c.generated === "s" && (
                  <span className="badge badge-dim" title="Generated stored column">
                    generated
                  </span>
                )}
              </td>
              <td className="st-type">{c.type}</td>
              <td>{c.not_null ? "not null" : "null"}</td>
              <td className="st-default">{c.default ?? ""}</td>
              {anyColComment ? <td className="st-comment">{colComment(c.name) ?? ""}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>

      {error ? (
        <div className="st-error">
          <span>Table stats failed: {error}</span>
          <button className="btnish" onClick={() => setBump((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : !stats ? (
        <div className="st-loading">Loading table stats…</div>
      ) : (
        <>
          <h3>Constraints</h3>
          {stats.constraints.length === 0 ? (
            <div className="st-none">No constraints</div>
          ) : (
            <table className="st-table">
              <tbody>
                {stats.constraints.map((c) => (
                  <tr key={c.name}>
                    <td className="st-name">{c.name}</td>
                    <td className="st-kind">{CONSTRAINT_KIND[c.kind] ?? c.kind}</td>
                    <td className="st-def">{c.definition}</td>
                    <td>
                      <CopyBtn
                        text={c.definition}
                        id={`con:${c.name}`}
                        copied={copied}
                        onCopied={setCopied}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Indexes</h3>
          {stats.indexes.length === 0 ? (
            <div className="st-none">No indexes</div>
          ) : (
            <table className="st-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Scans</th>
                  <th></th>
                  <th>Definition</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {stats.indexes.map((ix) => (
                  <tr key={ix.name}>
                    <td className="st-name">{ix.name}</td>
                    <td className="st-num">{ix.size_pretty}</td>
                    <td className="st-num">{ix.scans == null ? "—" /* em-ok absent-value marker */ : ix.scans.toLocaleString()}</td>
                    <td className="st-flags">
                      {ix.is_primary && <span className="badge badge-accent">PK</span>}
                      {ix.is_unique && !ix.is_primary && (
                        <span className="badge badge-accent">UNIQUE</span>
                      )}
                      {dropCandidate(ix) ? (
                        <span
                          className="badge badge-warn"
                          title="idx_scan = 0 and nothing depends on it, a candidate for dropping (stats since last reset)"
                        >
                          never scanned
                        </span>
                      ) : neverScanned(ix) ? (
                        <span
                          className="badge badge-dim"
                          title="idx_scan = 0 (stats since last reset), but this index enforces uniqueness, so scan count is irrelevant to its role"
                        >
                          never scanned
                        </span>
                      ) : null}
                    </td>
                    <td className="st-def">{ix.definition.replace(/^CREATE\s+/i, "")}</td>
                    <td>
                      <CopyBtn
                        text={ix.definition}
                        id={`ix:${ix.name}`}
                        copied={copied}
                        onCopied={setCopied}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Triggers</h3>
          {stats.triggers.length === 0 ? (
            <div className="st-none">No triggers</div>
          ) : (
            <table className="st-table">
              <tbody>
                {stats.triggers.map((tg) => (
                  <tr key={tg.name}>
                    <td className="st-name">{tg.name}</td>
                    <td>
                      {tg.enabled ? (
                        "enabled"
                      ) : (
                        <span className="badge badge-warn">disabled</span>
                      )}
                    </td>
                    <td className="st-def">{tg.definition}</td>
                    <td>
                      <CopyBtn
                        text={tg.definition}
                        id={`tg:${tg.name}`}
                        copied={copied}
                        onCopied={setCopied}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Stats</h3>
          {!act ? (
            <div className="st-none">No statistics row for this relation</div>
          ) : (
            <div className="st-grid">
              <span className="st-label">Live tuples</span>
              <span className="st-value">{num(act.n_live_tup)}</span>
              <span className="st-label">Dead tuples</span>
              <span className="st-value">{num(act.n_dead_tup)}</span>
              <span className="st-label">Seq scans</span>
              <span className="st-value">{num(act.seq_scan)}</span>
              <span className="st-label">Index scans</span>
              <span className="st-value">{num(act.idx_scan)}</span>
              <span className="st-label">Last vacuum</span>
              <span className="st-value">{act.last_vacuum ?? "never"}</span>
              <span className="st-label">Last autovacuum</span>
              <span className="st-value">{act.last_autovacuum ?? "never"}</span>
              <span className="st-label">Last analyze</span>
              <span className="st-value">{act.last_analyze ?? "never"}</span>
              <span className="st-label">Last autoanalyze</span>
              <span className="st-value">{act.last_autoanalyze ?? "never"}</span>
            </div>
          )}

          <h3>Sizes</h3>
          <div className="st-grid">
            <span className="st-label">Table</span>
            <span className="st-value" title={`${stats.sizes.table_bytes.toLocaleString()} bytes`}>
              {stats.sizes.table_pretty}
            </span>
            <span className="st-label">Indexes</span>
            <span
              className="st-value"
              title={`${stats.sizes.indexes_bytes.toLocaleString()} bytes`}
            >
              {stats.sizes.indexes_pretty}
            </span>
            <span className="st-label">Total</span>
            <span className="st-value" title={`${stats.sizes.total_bytes.toLocaleString()} bytes`}>
              {stats.sizes.total_pretty}
            </span>
          </div>

          <h3>Comments</h3>
          {!stats.comment && stats.column_comments.length === 0 ? (
            <div className="st-none">No comments</div>
          ) : (
            <>
              {stats.comment && <div className="st-tablecomment">{stats.comment}</div>}
              {stats.column_comments.length > 0 && (
                <table className="st-table">
                  <tbody>
                    {stats.column_comments.map((c) => (
                      <tr key={c.column}>
                        <td className="st-name">{c.column}</td>
                        <td className="st-comment">{c.comment}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
