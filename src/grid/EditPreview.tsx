import { useEffect, useRef } from "react";
import { useEdits } from "../stores/edits";
import "./grid.css";

export function EditPreview() {
  const preview = useEdits((s) => s.preview);
  const committing = useEdits((s) => s.committing);
  const closePreview = useEdits((s) => s.closePreview);
  const commit = useEdits((s) => s.commit);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (preview) ref.current?.focus();
  }, [preview]);

  if (!preview) return null;

  const canCommit = !committing && !preview.error && preview.statements.length > 0;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="ep-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && closePreview()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && canCommit) {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closePreview();
        }
      }}
    >
      <div className="ep-modal">
        <div className="ep-title">
          Commit {preview.statements.length} change
          {preview.statements.length === 1 ? "" : "s"} — runs in one transaction
        </div>
        {preview.error ? (
          <div className="ep-error">{preview.error}</div>
        ) : (
          <pre className="ep-sql">{preview.statements.join(";\n\n")}</pre>
        )}
        <div className="ep-actions">
          <button onClick={closePreview}>Cancel esc</button>
          <button className="primary" disabled={!canCommit} onClick={() => void commit()}>
            {committing ? "Committing…" : "Commit ⏎"}
          </button>
        </div>
      </div>
    </div>
  );
}
