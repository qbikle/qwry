import { useState } from "react";
import { motion } from "motion/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { popIn } from "../design/springs";
import { useEdits } from "../stores/edits";
import { Modal } from "../app/overlay/Overlay";
import "./grid.css";

export function EditPreview() {
  const preview = useEdits((s) => s.preview);
  const committing = useEdits((s) => s.committing);
  const closePreview = useEdits((s) => s.closePreview);
  const commit = useEdits((s) => s.commit);
  const [copied, setCopied] = useState(false);

  if (!preview) return null;

  const canCommit =
    !committing && !preview.loading && !preview.error && preview.statements.length > 0;

  return (
    <Modal
      backdropClassName="ep-backdrop"
      onClose={closePreview}
      onKey={(e) => {
        // Enter = commit (only while committable + topmost)
        if (e.key === "Enter" && canCommit) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void commit();
        }
      }}
    >
      <motion.div className="ep-modal" {...popIn}>
        <div className="ep-title">
          Commit {preview.statements.length} change
          {preview.statements.length === 1 ? "" : "s"} — runs in one transaction
        </div>
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
          <button onClick={closePreview}>Cancel esc</button>
          <button className="primary" disabled={!canCommit} onClick={() => void commit()}>
            {committing ? "Committing…" : "Commit ⏎"}
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
