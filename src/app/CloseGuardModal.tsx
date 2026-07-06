import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { useCloseGuard } from "../stores/closeGuard";
import { useTabs } from "../stores/tabs";
import { useEdits } from "../stores/edits";
import { Modal } from "./overlay/Overlay";
import "./app.css";

/** confirm before closing a tab that has uncommitted cell edits.
 * Esc = keep · Enter = discard & close · ⌘↵ = commit & close */
export function CloseGuardModal() {
  const pending = useCloseGuard((s) => s.pending);
  const cancel = useCloseGuard((s) => s.cancel);
  const discard = useCloseGuard((s) => s.discard);
  const commit = useCloseGuard((s) => s.commit);
  const tabName = useTabs((s) => s.tabs.find((t) => t.id === pending)?.name);
  const count = useEdits((s) =>
    pending ? Object.keys(s.byTab[pending]?.pending ?? {}).length : 0,
  );

  if (!pending) return null;

  return (
    <Modal
      backdropClassName="danger-backdrop"
      onClose={cancel}
      onKey={(e) => {
        // Enter = discard, ⌘/Ctrl+Enter = commit — only while topmost.
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.metaKey || e.ctrlKey) void commit();
        else discard();
      }}
    >
      <motion.div className="cg-modal" {...popIn}>
        <div className="cg-title">Unsaved edits</div>
        <div className="cg-detail">
          “{tabName}” has {count} uncommitted cell edit{count === 1 ? "" : "s"}. Discard them?
        </div>
        <div className="cg-actions">
          <button onClick={cancel}>
            Keep <span className="cg-key">esc</span>
          </button>
          <button className="cg-commit" onClick={() => void commit()}>
            Commit &amp; close <span className="cg-key">⌘↵</span>
          </button>
          <button className="cg-discard" onClick={discard}>
            Discard &amp; close <span className="cg-key">⏎</span>
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
