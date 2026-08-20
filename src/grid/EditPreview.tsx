import { useState } from "react";
import { motion } from "motion/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { popIn } from "../design/springs";
import { useEdits } from "../stores/edits";
import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { Modal } from "../app/overlay/Overlay";
import { Kbd } from "../design/Kbd";
import "./grid.css";

export function EditPreview() {
  const preview = useEdits((s) => s.preview);
  const committing = useEdits((s) => s.committing);
  const closePreview = useEdits((s) => s.closePreview);
  const commit = useEdits((s) => s.commit);
  // where this commit lands: the result's ORIGIN connection, never the rail
  const originPid = useResults((s) => s.executedProfileId);
  const origin = useConnections((s) =>
    originPid ? (s.profiles.find((p) => p.id === originPid) ?? null) : null,
  );
  const [copied, setCopied] = useState(false);

  if (!preview) return null;

  const canCommit =
    !committing && !preview.loading && !preview.error && preview.statements.length > 0;

  return (
    <Modal
      backdropClassName="ep-backdrop"
      label="Commit Staged Edits"
      onClose={closePreview}
      onKey={(e) => {
        // Enter = commit, DELIBERATELY unlike CloseGuard/DangerModal, where
        // plain Enter maps to the safe action and the destructive confirm
        // needs ⌘⌫. Committing is this dialog's PRIMARY action: the user
        // explicitly opened a review of the exact SQL (⌘S), so Enter here is
        // an informed accept, not a destructive surprise.
        if (e.key === "Enter" && canCommit) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void commit();
        }
      }}
    >
      <motion.div className="ep-modal" {...popIn}>
        <div className="ep-title">
          Commit {preview.statements.length} Change
          {preview.statements.length === 1 ? "" : "s"} · runs in one transaction
        </div>
        {originPid && (
          // always shown, same-profile included: the moment of consequence
          // must name the write target
          <div className="ep-target">
            <span
              className="ep-target-dot"
              style={{ background: origin?.color || "var(--accent)" }}
            />
            commits to <strong>{origin ? origin.name || origin.host : "a deleted connection"}</strong>
          </div>
        )}
        {preview.rebuilt && (
          // inline, never a stacked dialog: the second modal read as buggy
          // and its Enter=Cancel ate the commit mid-keystroke. "tx" escalates:
          // an open transaction died with the old session.
          <div
            className={`ep-rebuilt${preview.rebuilt === "tx" ? " tx" : ""}`}
            title={
              preview.rebuilt === "tx"
                ? "The session this result ran on died holding an open transaction. Its uncommitted work is gone; this commit runs against the current database state, and every row is still verified before writing."
                : "The session this result ran on died and was rebuilt. This commit runs against the current database state, and every row is still verified before writing."
            }
          >
            ⟲ {preview.rebuilt === "tx"
              ? "Connection was rebuilt · the open transaction is gone"
              : "Connection was rebuilt · commits against current state"}
          </div>
        )}
        {preview.notice && <div className="ep-notice">⚠ {preview.notice}</div>}
        {preview.loading ? (
          <div className="ep-loading">Building preview…</div>
        ) : preview.error ? (
          <div className="ep-error">{preview.error}</div>
        ) : (
          <pre className="ep-sql">{preview.statements.join(";\n\n")}</pre>
        )}
        <div className="ep-actions">
          <button
            className="btnish"
            disabled={preview.statements.length === 0}
            onClick={() => {
              void writeText(preview.statements.join(";\n") + ";").then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "Copied ✓" : "Copy SQL"}
          </button>
          <button className="btnish" onClick={closePreview}>
            Cancel <Kbd chord="esc" />
          </button>
          <button className="btnish primary" disabled={!canCommit} onClick={() => void commit()}>
            {committing ? (
              "Committing…"
            ) : (
              <>
                {preview.rebuilt === "tx" ? "Commit Anyway" : "Commit"} <Kbd chord="return" />
              </>
            )}
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
