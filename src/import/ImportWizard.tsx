// CSV/TSV import wizard. Three steps in one modal: file+parse (sniffed
// delimiter/header, both overridable), column mapping (source → target,
// unmapped targets take their DEFAULT), then a dry-run validate that ALWAYS
// rolls back before the real all-or-nothing commit. Parsing, casting and
// batching all live in Rust (src-tauri/src/import.rs); the wizard only
// drives it and renders the honest report.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, ArrowRight, CheckCircle2, FileUp, X } from "lucide-react";
import { popIn } from "../design/springs";
import { Switch } from "../design/Switch";
import { Modal } from "../app/overlay/Overlay";
import * as ipc from "../ipc/commands";
import type {
  CsvPreview,
  ImportNullMode,
  ImportProgress,
  ImportReport,
  ImportSpec,
} from "../ipc/types";
import type { TableInfo } from "../stores/schema";
import { useBrowser } from "../stores/browser";
import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { useTabs } from "../stores/tabs";
import "./import.css";

const DELIMS: { d: string; label: string }[] = [
  { d: ",", label: "Comma" },
  { d: "\t", label: "Tab" },
  { d: ";", label: "Semicolon" },
  { d: "|", label: "Pipe" },
];

const NULL_SENTENCE: Record<ImportNullMode, string> = {
  empty: "empty fields import as NULL (the CSV convention). A quoted \"\" is empty too",
  literal:
    "fields spelled NULL (any case) import as NULL. Quoted \"NULL\" is also treated as NULL; quoting cannot be honored. Empty fields stay ''",
  custom: "fields equal to the token import as NULL; empty fields stay ''",
  none: "nothing becomes NULL. Empty fields import as ''",
};

/** the import binds to the BROWSE TAB's own session and the profile its rows
 * came from, NEVER the rail-active profile or any fallback session: a rail
 * click mid-wizard must not redirect the import to a different database.
 * Absent or dead session → the caller refuses honestly. */
function browseSession(): { tabId: string; sessionId: string; profileId: string } | null {
  const tabId = useTabs.getState().activeId;
  if (!tabId) return null;
  const rt = useResults.getState().byTab[tabId];
  if (!rt?.executedSessionId || !rt.executedProfileId) return null;
  // the session must still be live; a reaped session id would just error late
  const alive = Object.values(useConnections.getState().tabSessions).includes(
    rt.executedSessionId,
  );
  return alive
    ? { tabId, sessionId: rt.executedSessionId, profileId: rt.executedProfileId }
    : null;
}

/** the commit-phase refusal when the file's stat no longer matches the
 * validate-time `expected_stat` (backend: "file changed since validation,
 * validate again before committing"), routed into a forced re-validate */
const STAT_MISMATCH_RE = /changed since validation|file .*changed|stat.*mismatch/i;

function errText(e: unknown): { message: string; code: string | null } {
  const err = e as { message?: string; code?: string | null } | null;
  const message = err?.message ?? String(e);
  const code = err?.code ?? null;
  if (code === "25006") {
    return {
      message: `${message}. This is a production connection in safe mode; unlock writes for this tab first`,
      code,
    };
  }
  return { message, code };
}

export function ImportWizard({ table, onClose }: { table: TableInfo; onClose: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [nullMode, setNullMode] = useState<ImportNullMode>("empty");
  const [nullToken, setNullToken] = useState("\\N");
  const [phase, setPhase] = useState<"idle" | "validating" | "committing">("idle");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [commitReport, setCommitReport] = useState<ImportReport | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // the backend refused the commit because the file changed after validate;
  // shown while the forced re-validate runs (and after it lands)
  const [statNotice, setStatNotice] = useState<string | null>(null);
  // explicit user overrides survive re-sniffs (delimiter change re-sniffs the
  // header only while the user hasn't decided it)
  const headerOverride = useRef<boolean | null>(null);
  // the user touched the mapping by hand, so preview reloads must only FILL
  // unmapped slots, never discard the hand-tuned ones
  const handTuned = useRef(false);
  const sessionRef = useRef<string | null>(null);

  // the import's bound target, always visible in the header: the browse tab's
  // result profile (never the rail-active selection)
  const browseTabId = useTabs((s) => s.activeId);
  const boundProfileId = useResults((s) =>
    browseTabId ? (s.byTab[browseTabId]?.executedProfileId ?? null) : null,
  );
  const connName = useConnections((s) => {
    if (!boundProfileId) return null;
    const p = s.profiles.find((x) => x.id === boundProfileId);
    return p ? p.name || p.host : null;
  });

  // GENERATED ALWAYS columns can't be inserted into, so not offered as targets
  const insertable = useMemo(
    () => table.columns.filter((c) => c.generated !== "s" && c.identity !== "a"),
    [table],
  );

  const invalidateRuns = () => {
    setReport(null);
    setCommitReport(null);
    setRunError(null);
    setStatNotice(null);
  };

  const loadPreview = async (p: string, delim: string | null) => {
    setPreviewLoading(true);
    setFileError(null);
    try {
      setPreview(await ipc.csvPreview(p, delim, headerOverride.current));
    } catch (e) {
      setPreview(null);
      setFileError(errText(e).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const pickFile = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: false,
      filters: [{ name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] }],
    });
    if (typeof sel !== "string") return;
    headerOverride.current = null;
    handTuned.current = false; // a NEW file starts from a fresh auto-map
    setPath(sel);
    invalidateRuns();
    void loadPreview(sel, null);
  };

  // auto-map whenever a fresh preview lands: by name when the file has a
  // header, by position when it doesn't. A reload after hand-tuning only
  // FILLS unmapped slots; it never discards what the user set.
  useEffect(() => {
    if (!preview) {
      setMapping([]);
      return;
    }
    setMapping((prev) => {
      const next: (string | null)[] = new Array<string | null>(preview.field_count).fill(null);
      if (handTuned.current) {
        for (let i = 0; i < Math.min(prev.length, next.length); i++) {
          const t = prev[i];
          if (t && insertable.some((c) => c.name === t)) next[i] = t;
        }
      }
      if (preview.has_header) {
        for (let i = 0; i < preview.field_count; i++) {
          if (next[i]) continue;
          const src = preview.source_columns[i]?.trim().toLowerCase();
          const hit = insertable.find((c) => c.name.toLowerCase() === src);
          if (hit && !next.includes(hit.name)) next[i] = hit.name;
        }
      } else {
        for (let i = 0; i < Math.min(preview.field_count, insertable.length); i++) {
          if (next[i]) continue;
          if (!next.includes(insertable[i].name)) next[i] = insertable[i].name;
        }
      }
      return next;
    });
  }, [preview, insertable]);

  const setMap = (i: number, target: string | null) => {
    handTuned.current = true;
    // stealing a target already mapped elsewhere unmaps the other source:
    // one target column can only be fed by one source
    setMapping((m) => m.map((t, j) => (j === i ? target : t === target ? null : t)));
    invalidateRuns();
  };

  const mappedCount = mapping.filter(Boolean).length;
  const unmappedDefaulted = table.columns.filter((c) => !mapping.includes(c.name));
  // identity BY DEFAULT ('d') columns self-fill from their sequence, so an
  // unmapped one is fine, not a "rows will fail" case
  const unmappedRequired = insertable.filter(
    (c) => c.not_null && c.default == null && c.identity !== "d" && !mapping.includes(c.name),
  );

  // header=off but row 1 reads like one: every non-empty field matches a
  // target column name case-insensitively
  const headerish = useMemo(() => {
    if (!preview || preview.has_header) return false;
    const row0 = preview.rows[0];
    if (!row0 || row0.length === 0) return false;
    const names = new Set(table.columns.map((c) => c.name.toLowerCase()));
    const fields = row0.filter((f) => (f ?? "").trim() !== "");
    return fields.length > 0 && fields.every((f) => names.has((f ?? "").trim().toLowerCase()));
  }, [preview, table]);

  const buildSpec = (mode: "validate" | "commit"): ImportSpec => ({
    path: path!,
    delimiter: preview!.delimiter,
    has_header: preview!.has_header,
    schema: table.schema,
    table: table.name,
    columns: mapping.flatMap((t, i) => (t ? [{ src: i, target: t }] : [])),
    null_mode: nullMode,
    null_token: nullMode === "custom" ? nullToken : null,
    mode,
    // commit proves it writes the exact bytes validate rehearsed; the
    // backend refuses on any stat drift ("file changed since validation")
    expected_stat: mode === "commit" ? (report?.file_stat ?? null) : null,
  });

  const runPhase = async (mode: "validate" | "commit") => {
    const ctx = browseSession();
    if (!ctx) {
      setRunError("browse session unavailable. Refresh the table first");
      return;
    }
    sessionRef.current = ctx.sessionId;
    setPhase(mode === "validate" ? "validating" : "committing");
    setProgress(null);
    setRunError(null);
    try {
      const rep = await ipc.csvImport(ctx.sessionId, buildSpec(mode), setProgress);
      if (mode === "validate") {
        setReport(rep);
      } else {
        setCommitReport(rep);
        // reload reads where the COPY landed: the import's bound origin,
        // never the rail (refresh() alone follows the rail selection)
        if (rep.committed) useBrowser.getState().reloadAfterWrite(ctx.tabId, ctx.profileId);
      }
    } catch (e) {
      const msg = errText(e).message;
      if (mode === "commit" && STAT_MISMATCH_RE.test(msg)) {
        // the backend refused: the file changed after validate. The old
        // rehearsal proved nothing: force a fresh validate (the step-3
        // effect re-runs it once report is cleared) and say why.
        setReport(null);
        setCommitReport(null);
        setRunError(null);
        setStatNotice(
          "the file changed on disk after validate, so it was re-validated against the current file",
        );
        return;
      }
      setRunError(msg);
    } finally {
      setPhase("idle");
    }
  };

  // entering step 3 rehearses the whole file first; commit stays gated on a
  // clean validate
  useEffect(() => {
    if (step === 3 && !report && phase === "idle" && !runError && !commitReport) {
      void runPhase("validate");
    }
    // runPhase identity is render-scoped; the guards above gate re-entry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, report, phase, runError, commitReport]);

  const running = phase !== "idle";
  const done = commitReport?.committed === true;
  // the connection died during COMMIT: the server may or may not have
  // applied it; never claim a rollback, never offer a blind retry
  const indeterminate = commitReport != null && !commitReport.committed && commitReport.outcome === "unknown";
  const canCommit =
    !running &&
    !done &&
    !indeterminate &&
    report !== null &&
    report.errors.length === 0 &&
    !report.more_errors &&
    report.ok_rows === report.total_rows;

  const fileName = path?.split("/").pop() ?? "";
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  const issues = commitReport && !commitReport.committed && commitReport.errors.length > 0
    ? commitReport
    : report;

  return (
    <Modal
      label="Import CSV"
      onClose={() => {
        // a run in flight keeps the modal up; Cancel run stops the server work
        if (!running) onClose();
      }}
    >
      <motion.div className="imp-panel" {...popIn}>
        <div className="imp-head">
          <FileUp size={14} />
          <span className="imp-title">
            Import CSV · {table.schema !== "public" ? `${table.schema}.` : ""}
            {table.name}
          </span>
          <span
            className="imp-conn"
            title="This import writes to the browse tab’s session, never the rail selection"
          >
            {connName ?? "no session"}
          </span>
          <div className="imp-steps">
            {["File", "Columns", "Import"].map((label, i) => (
              <button
                key={label}
                className={`imp-step${step === i + 1 ? " active" : ""}`}
                disabled={(i + 1 === 2 && !preview) || (i + 1 === 3 && mappedCount === 0) || running}
                onClick={() => setStep((i + 1) as 1 | 2 | 3)}
              >
                {i + 1} {label}
              </button>
            ))}
          </div>
          <button className="iconbtn" title="Close" onClick={() => !running && onClose()}>
            <X size={14} />
          </button>
        </div>

        {step === 1 && (
          <div className="imp-body">
            {!path ? (
              <button className="imp-drop" onClick={() => void pickFile()}>
                <FileUp size={16} />
                <span>Choose a CSV or TSV File…</span>
              </button>
            ) : (
              <>
                <div className="imp-fileline">
                  <span className="imp-filename" title={path}>
                    {fileName}
                  </span>
                  <button className="linkish" onClick={() => void pickFile()}>
                    Change
                  </button>
                  <span className="imp-spacer" />
                  {preview && (
                    <span className="imp-total">
                      {preview.total_rows.toLocaleString()} data rows ·{" "}
                      {preview.field_count} columns
                    </span>
                  )}
                </div>
                <div className="imp-row">
                  <span className="imp-label">Delimiter</span>
                  <div className="imp-seg">
                    {DELIMS.map((o) => (
                      <button
                        key={o.label}
                        className={preview?.delimiter === o.d ? "active" : ""}
                        onClick={() => {
                          invalidateRuns();
                          void loadPreview(path, o.d);
                        }}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <label className="imp-check">
                    <Switch
                      checked={preview?.has_header ?? false}
                      onChange={(on) => {
                        headerOverride.current = on;
                        invalidateRuns();
                        void loadPreview(path, preview?.delimiter ?? null);
                      }}
                    />
                    Header Row
                  </label>
                </div>
                {fileError && <div className="imp-error">{fileError}</div>}
                {previewLoading && <div className="imp-note">parsing…</div>}
                {preview && !previewLoading && (
                  <div className="imp-preview">
                    <table>
                      <thead>
                        <tr>
                          {preview.source_columns.map((c, i) => (
                            <th key={i}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((r, i) => (
                          <tr key={i}>
                            {preview.source_columns.map((_, j) => (
                              <td key={j}>{r[j] ?? ""}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {headerish && (
                  <div className="imp-warn">
                    <AlertTriangle size={12} /> Row 1 looks like a header. Its fields match{" "}
                    {table.name} column names. Did you mean to enable “Header Row”?
                  </div>
                )}
                <div className="imp-note">
                  Encoding: UTF-8 only. A non-UTF-8 byte is a per-row error, never silently
                  re-encoded.
                </div>
              </>
            )}
          </div>
        )}

        {step === 2 && preview && (
          <div className="imp-body">
            <div className="imp-maphead">
              <span>Source Column</span>
              <span>Sample</span>
              <span />
              <span>Target Column</span>
            </div>
            <div className="imp-maplist">
              {preview.source_columns.map((src, i) => (
                <div className="imp-maprow" key={i}>
                  <span className="imp-src">{src}</span>
                  <span className="imp-sample" title={preview.rows[0]?.[i] ?? ""}>
                    {preview.rows[0]?.[i] ?? ""}
                  </span>
                  <ArrowRight size={12} className="imp-arrow" />
                  <select
                    className={mapping[i] ? "" : "imp-skip"}
                    value={mapping[i] ?? ""}
                    onChange={(e) => setMap(i, e.target.value || null)}
                  >
                    <option value="">{"— skip —" /* em-ok absent-value marker */}</option>
                    {insertable.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.type}
                        {c.not_null ? ", not null" : ""})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            {unmappedDefaulted.length > 0 && (
              <div className="imp-note">
                unmapped columns take their DEFAULT:{" "}
                {unmappedDefaulted.map((c) => c.name).join(", ")}
              </div>
            )}
            {unmappedRequired.length > 0 && (
              <div className="imp-warn">
                <AlertTriangle size={12} /> NOT NULL without a default. Rows will fail unless a
                trigger fills them: {unmappedRequired.map((c) => c.name).join(", ")}
              </div>
            )}
            <div className="imp-row imp-nullrule">
              <span className="imp-label">NULLs</span>
              <div className="imp-seg">
                {(["empty", "literal", "custom", "none"] as ImportNullMode[]).map((m) => (
                  <button
                    key={m}
                    className={nullMode === m ? "active" : ""}
                    onClick={() => {
                      setNullMode(m);
                      invalidateRuns();
                    }}
                  >
                    {m === "empty" ? "empty → ∅" : m === "literal" ? "NULL → ∅" : m === "custom" ? "token → ∅" : "none"}
                  </button>
                ))}
              </div>
              {nullMode === "custom" && (
                <input
                  className="imp-token"
                  value={nullToken}
                  onChange={(e) => {
                    setNullToken(e.target.value);
                    invalidateRuns();
                  }}
                />
              )}
            </div>
            <div className="imp-note">{NULL_SENTENCE[nullMode]}</div>
          </div>
        )}

        {step === 3 && (
          <div className="imp-body">
            {statNotice && (
              <div className="imp-warn">
                <AlertTriangle size={12} /> {statNotice}
              </div>
            )}
            {indeterminate && !running && (
              <div className="imp-warn">
                <AlertTriangle size={12} />{" "}
                {commitReport?.errors[0]?.message ??
                  "connection lost during COMMIT. The import may or may not have been applied; verify the row count before retrying"}
                <button
                  className="linkish"
                  onClick={() => invalidateRuns() /* forces a fresh validate */}
                >
                  Validate Again
                </button>
              </div>
            )}
            {running && (
              <>
                <div className="imp-runline">
                  {phase === "validating"
                    ? // once every row streamed, validate is bisecting the failed
                      // batch; say so instead of freezing the bar at 100%
                      progress && progress.total > 0 && progress.processed >= progress.total
                      ? "Locating failed rows…"
                      : "Validating · dry run, always rolls back…"
                    : "Importing…"}
                  {progress && (
                    <span className="imp-total">
                      {progress.processed.toLocaleString()} / {progress.total.toLocaleString()} rows
                    </span>
                  )}
                </div>
                <div className="imp-progress">
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="imp-row">
                  <button
                    className="btnish"
                    onClick={() => sessionRef.current && void ipc.cancel(sessionRef.current)}
                  >
                    Cancel Run
                  </button>
                </div>
              </>
            )}
            {runError && !running && (
              <div className="imp-error">
                {runError}
                <button className="linkish" onClick={() => void runPhase("validate")}>
                  Validate Again
                </button>
              </div>
            )}
            {done && commitReport && (
              <div className="imp-done">
                <CheckCircle2 size={14} />
                Imported {commitReport.ok_rows.toLocaleString()} rows into {table.schema}.
                {table.name}.
              </div>
            )}
            {!running && !done && !runError && !indeterminate && issues && (
              <>
                <div className="imp-summary">
                  {commitReport && !commitReport.committed ? (
                    <span className="imp-fail">
                      <AlertTriangle size={12} /> import failed. The transaction rolled back,
                      nothing was written
                    </span>
                  ) : issues.errors.length === 0 ? (
                    <span className="imp-ok">
                      <CheckCircle2 size={12} /> dry run clean ·{" "}
                      {issues.total_rows.toLocaleString()} rows ready
                    </span>
                  ) : (
                    <span className="imp-fail">
                      <AlertTriangle size={12} /> {issues.errors.length}
                      {issues.more_errors ? "+" : ""} bad row
                      {issues.errors.length === 1 && !issues.more_errors ? "" : "s"} of{" "}
                      {issues.total_rows.toLocaleString()} · nothing was written
                    </span>
                  )}
                </div>
                {issues.errors.length > 0 && (
                  <div className="imp-issues">
                    {issues.errors.map((e, i) => (
                      <div className="imp-issue" key={i}>
                        <span className="imp-issue-row">
                          {e.row > 0 ? `row ${e.row}` : "—" /* em-ok absent-value marker */}
                          {e.line > 0 ? ` · line ${e.line}` : ""}
                        </span>
                        <span className="imp-issue-msg">{e.message}</span>
                      </div>
                    ))}
                    {issues.more_errors && (
                      <div className="imp-issue imp-issue-more">
                        …and possibly more, stopped at {issues.errors.length}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="imp-foot">
          <span className="imp-foothint">
            {step === 3 && !done
              ? "validate rehearses every row, then the import is one all-or-nothing transaction"
              : ""}
          </span>
          {step > 1 && !done && (
            <button className="btnish" disabled={running} onClick={() => setStep((step - 1) as 1 | 2)}>
              Back
            </button>
          )}
          {step < 3 ? (
            <button
              className="btnish primary"
              disabled={(step === 1 && !preview) || (step === 2 && mappedCount === 0)}
              onClick={() => setStep((step + 1) as 2 | 3)}
            >
              {step === 2 && mappedCount === 0 ? "Map a Column" : "Next"}
            </button>
          ) : done ? (
            <button className="btnish primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button
              className="btnish primary"
              disabled={!canCommit}
              onClick={() => void runPhase("commit")}
            >
              {report ? `Import ${report.total_rows.toLocaleString()} Rows` : "Import"}
            </button>
          )}
        </div>
      </motion.div>
    </Modal>
  );
}
