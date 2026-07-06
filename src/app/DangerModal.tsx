import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { useDanger } from "../stores/danger";
import { Modal } from "./overlay/Overlay";
import "./app.css";

export function DangerModal() {
  const prompt = useDanger((s) => s.prompt);
  const resolve = useDanger((s) => s.resolve);

  if (!prompt) return null;

  return (
    <Modal
      backdropClassName="danger-backdrop"
      onClose={() => resolve(false)}
      // explicit keyboard grammar: Esc cancels (stack), ⌘↵ confirms. Plain
      // Enter deliberately does NOT confirm a destructive action — but it must
      // not silently hit the focused Cancel either, that reads as "broken".
      onKey={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.metaKey || e.ctrlKey) resolve(true);
      }}
    >
      <motion.div className="danger-modal" {...popIn}>
        <div className="danger-title">⚠ {prompt.title}</div>
        <pre className="danger-detail">{prompt.detail}</pre>
        <div className="danger-actions">
          <button autoFocus onClick={() => resolve(false)}>
            Cancel <span className="danger-key">esc</span>
          </button>
          <button className="danger-go" onClick={() => resolve(true)}>
            {prompt.confirmLabel} <span className="danger-key">⌘↵</span>
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
