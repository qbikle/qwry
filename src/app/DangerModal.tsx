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
      label={prompt.title}
      onClose={() => resolve(false)}
      // Mac destructive-confirm grammar (Postico): Esc AND plain Enter are the
      // SAFE action (Cancel) — Enter must never fire a destructive confirm.
      // The confirm needs the deliberate ⌘⌫ chord, shown on the button.
      onKey={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopImmediatePropagation();
          resolve(false);
        } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          resolve(true);
        }
      }}
    >
      <motion.div className="danger-modal" {...popIn}>
        <div className="danger-title">⚠ {prompt.title}</div>
        <pre className="danger-detail">{prompt.detail}</pre>
        <div className="danger-actions">
          <button autoFocus onClick={() => resolve(false)}>
            Cancel <span className="danger-key">⏎</span>
          </button>
          <button className="danger-go" onClick={() => resolve(true)}>
            {prompt.confirmLabel} <span className="danger-key">⌘⌫</span>
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
