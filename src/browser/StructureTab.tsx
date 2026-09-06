import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyEvent,
} from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as ipc from "../ipc/commands";
import type { TableStats } from "../ipc/types";
import { useConnections } from "../stores/connections";
import { hintLineFor, knowledgeTarget, parseHintLine, saveHintLine, useKnowledge } from "../stores/knowledge";
import type { TableInfo } from "../stores/schema";
import "./browser.css";

/** TableBrowser's header Refresh routes here while Structure is active; it
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

/** the way in, and the one place this feature says its name (DESIGN rule 11) */
const PLACEHOLDER = "Hint for Ask…";


/** any live session on the active profile (primary preferred; it can be
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

/** The hint line (A2 item 2): the slot where this view already printed the
 * live COMMENT, made editable. Three faces in one text and the tier says whose
 * it is: a hint the user wrote in tier 1, the database's own comment in tier 2,
 * `Hint for Ask…` in the placeholder register when neither stands. A click, or
 * ↩ on the focused line, swaps the words for a field in place, no travel and
 * no size change (VS Code's rename box; the app's own inline editors are the
 * grammar: ↩ saves, Esc cancels, blur saves). An emptied line deletes the hint
 * and the comment reads again; when both stand the hint wins and the comment
 * is the line's tooltip AND the field's placeholder, so clearing the field
 * previews what will stand. No pencil, no label, no second line.
 *
 * Synonyms ride the same line as a trailing `aka orders, purchases` clause,
 * because a field of their own is one more line per table and per column
 * (DESIGN rule 15); the store parses and writes that clause as a pair.
 *
 * A column's cell is the same line at one row's height, ellipsized at rest and
 * printing nothing when it is empty: it shows the placeholder on its row's
 * hover and on focus (DESIGN rule 8's two routes), so a sixty-column table
 * prints no sixty lines of chrome and the table's own line is the one place
 * the feature says its name. */
function HintLine({
  target,
  comment,
  cell = false,
}: {
  target: string;
  comment: string | null;
  cell?: boolean;
}) {
  const profileId = useConnections((s) => s.activeProfileId);
  const rows = useKnowledge((s) => (profileId ? s.rows[profileId] : undefined));
  const line = hintLineFor(rows, target);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  // an Esc that closed the field must not be committed by the blur behind it
  const done = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  // the field is the line: it grows with the text it holds instead of
  // scrolling inside a fixed box (the table's line wraps, which is content)
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el || !editing || el.tagName !== "TEXTAREA") return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  // focus is the state's, never the DOM's autoFocus, and it never scrolls the
  // table under the pointer (LESSONS 7); the caret parks after the last word
  useEffect(() => {
    const el = fieldRef.current;
    if (!el || !editing) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const open = () => {
    done.current = false;
    setDraft(line);
  };
  const commit = (text: string) => {
    if (done.current) return;
    done.current = true;
    setDraft(null);
    if (profileId && text.trim() !== line.trim()) void saveHintLine(profileId, target, text);
  };
  const cancel = () => {
    done.current = true;
    setDraft(null);
  };

  const keys = (e: ReactKeyEvent<HTMLElement>) => {
    // typing keys are the field's; ⌘/⌃ chords belong to the window (LESSONS 10)
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      commit(draft ?? "");
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (draft !== null) {
    // one line, two element kinds: a column's cell stays on its row and holds
    // its text on one line, the table's own line wraps with the view
    const props = {
      ref: fieldRef,
      className: "st-hint editing",
      value: draft,
      // the comment a hint stands over is the field's placeholder, so clearing
      // the field previews what will read again
      placeholder: comment ?? PLACEHOLDER,
      spellCheck: false,
      onKeyDown: keys,
      onChange: (e: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => setDraft(e.target.value),
      onBlur: () => commit(draft),
    };
    return cell ? <input {...props} /> : <textarea {...props} rows={1} />;
  }

  const { hint, synonyms } = parseHintLine(line);
  return (
    <div
      className={`st-hint${line ? " hinted" : ""}${cell && !line && !comment ? " empty" : ""}`}
      role="button"
      tabIndex={0}
      // the comment the hint stands over stays reachable, and the line says
      // nothing when it is showing the comment itself (DESIGN rule 14)
      title={line && comment ? comment : undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {line ? (
        <>
          {hint}
          {synonyms.length > 0 && (
            <>
              {hint ? " " : ""}
              <span className="st-aka">aka</span> <span className="st-syn">{synonyms.join(", ")}</span>
            </>
          )}
        </>
      ) : comment ? (
        comment
      ) : (
        <span className="st-ph">{PLACEHOLDER}</span>
      )}
    </div>
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
  const tableComment = stats ? stats.comment : (table.comment ?? null);
  const tableTarget = knowledgeTarget(table.schema, table.name);

  // "never scanned" is a neutral fact; "candidate for dropping" is advice:
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
      <HintLine target={tableTarget} comment={tableComment} />
      <h3>Columns</h3>
      <table className="st-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            <th>Comment</th>
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
              <td className="st-comment">
                <HintLine
                  target={knowledgeTarget(table.schema, table.name, c.name)}
                  comment={colComment(c.name)}
                  cell
                />
              </td>
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
        </>
      )}
    </div>
  );
}
