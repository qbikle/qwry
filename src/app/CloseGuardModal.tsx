import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { useCloseGuard } from "../stores/closeGuard";
import { useTabs } from "../stores/tabs";
import { useEdits } from "../stores/edits";
import { Modal } from "./overlay/Overlay";
import "./app.css";

/** confirm before closing a tab that has uncommitted cell edits (Esc/Enter =
 * keep · ⌘⌫ = discard & close · ⌘↵ = commit & close) or unsaved drift against
 * its backing .sql file (Esc/Enter = keep · ⌘⌫ = close anyway). Mac
 * destructive-confirm grammar: plain Enter is always the SAFE action; the
 * destructive one needs the ⌘⌫ chord (Postico convention). */
export function CloseGuardModal() {
  const pending = useCloseGuard((s) => s.pending);
  const cancel = useCloseGuard((s) => s.cancel);
  const discard = useCloseGuard((s) => s.discard);
  const commit = useCloseGuard((s) => s.commit);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === pending));
  const count = useEdits((s) =>
    pending ? Object.keys(s.byTab[pending]?.pending ?? {}).length : 0,
  );

  if (!pending) return null;

  const drifted = !!tab && tab.file_path != null && tab.sql !== tab.file_saved_sql;
  const fileName = tab?.file_path?.split("/").pop() ?? "file.sql";
  const fileOnly = count === 0 && drifted;

  return (
    <Modal
      backdropClassName="danger-backdrop"
      label={fileOnly ? "Unsaved changes" : "Unsaved edits"}
      onClose={cancel}
      onKey={(e) => {
        // plain Enter = SAFE (keep the tab), ⌘⌫ = destructive (discard),
        // ⌘↵ = commit & close — only while topmost.
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopImmediatePropagation();
          if ((e.metaKey || e.ctrlKey) && !fileOnly) void commit();
          else cancel();
        } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          discard();
        }
      }}
    >
      <motion.div className="cg-modal" {...popIn}>
        <div className="cg-title">{fileOnly ? "Unsaved changes" : "Unsaved edits"}</div>
        <div className="cg-detail">
          {fileOnly ? (
            <>
              “{tab?.name}” has unsaved changes to {fileName} — the text stays in qwry, but
              the file on disk keeps its old version. Close anyway?
            </>
          ) : (
            <>
              “{tab?.name}” has {count} uncommitted cell edit{count === 1 ? "" : "s"}.
              {drifted && (
                <> It also has changes not written to {fileName} on disk.</>
              )}{" "}
              Discard them?
            </>
          )}
        </div>
        <div className="cg-actions">
          <button onClick={cancel}>
            Keep <span className="cg-key">⏎</span>
          </button>
          {!fileOnly && (
            <button className="cg-commit" onClick={() => void commit()}>
              Commit &amp; close <span className="cg-key">⌘↵</span>
            </button>
          )}
          <button className="cg-discard" onClick={discard}>
            {fileOnly ? "Close anyway" : "Discard & close"} <span className="cg-key">⌘⌫</span>
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
