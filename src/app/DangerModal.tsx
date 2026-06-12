import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { useDanger } from "../stores/danger";
import "./app.css";

export function DangerModal() {
  const prompt = useDanger((s) => s.prompt);
  const resolve = useDanger((s) => s.resolve);

  if (!prompt) return null;

  return (
    <div
      className="danger-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && resolve(false)}
      onKeyDown={(e) => e.key === "Escape" && resolve(false)}
      tabIndex={-1}
    >
      <motion.div className="danger-modal" {...popIn}>
        <div className="danger-title">⚠ {prompt.title}</div>
        <pre className="danger-detail">{prompt.detail}</pre>
        <div className="danger-actions">
          <button autoFocus onClick={() => resolve(false)}>
            Cancel
          </button>
          <button className="danger-go" onClick={() => resolve(true)}>
            Run anyway
          </button>
        </div>
      </motion.div>
    </div>
  );
}
