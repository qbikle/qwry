import { useEffect } from "react";
import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { useCloseGuard } from "../stores/closeGuard";
import { useTabs } from "../stores/tabs";
import { useEdits } from "../stores/edits";
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

  // buttons don't take focus in WKWebView → handle keys on a capture-phase
  // window listener while the prompt is open
  useEffect(() => {
    if (!pending) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        void commit();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        discard();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [pending, cancel, discard, commit]);

  if (!pending) return null;

  return (
    <div
      className="danger-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && cancel()}
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
    </div>
  );
}
