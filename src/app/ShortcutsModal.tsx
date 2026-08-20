import { motion } from "motion/react";
import { popIn } from "../design/springs";
import { Modal } from "./overlay/Overlay";
import "./app.css";

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Query",
    rows: [
      ["⌘↩", "Run statement under caret (or selection)"],
      ["⇧⌘↩", "Run all"],
      ["⌘.", "Cancel query"],
      ["⌘E", "Explain"],
      ["⇧⌘F", "Format SQL (in editor)"],
      ["⌘/", "Toggle comment"],
      ["⇧⌘U", "Search functions"],
    ],
  },
  {
    title: "Tabs",
    rows: [
      ["⌘T", "New tab"],
      ["⌘W", "Close tab"],
      ["⇧⌘T", "Reopen closed tab"],
      ["⌃⇥ / ⌃⇧⇥", "Next / previous tab"],
      ["⌘1…9", "Jump to tab"],
      ["drag", "Reorder tabs"],
    ],
  },
  {
    title: "Results Grid",
    rows: [
      ["↑↓←→ / ⇧", "Move / extend selection"],
      ["⌘C", "Copy (single cell = raw)"],
      ["⌘V", "Paste over selection"],
      ["↩ / F2 / type", "Edit cell"],
      ["⇥", "Commit + move right"],
      ["⌫", "Stage NULL"],
      ["Space", "Open as record"],
      ["⌘D", "Fill down"],
      ["⌘Z / ⇧⌘Z", "Undo / redo staged edits"],
      ["⌘S", "Commit staged edits"],
      ["⇧⌘D", "Discard staged edits"],
      ["⌘F", "Find in results"],
      ["⇧⌘I", "Add row (table browser)"],
    ],
  },
  {
    title: "App",
    rows: [
      ["⌘K", "Command palette"],
      ["⌘Y", "Query history"],
      ["⌘,", "Settings"],
      ["⌘I", "Inspector"],
      ["⌘R", "Refresh schema"],
      ["⇧⌘R", "Refresh connection"],
      ["⌘+ / ⌘−", "Zoom UI in / out"],
      ["⌘0", "Reset zoom"],
      ["⌘?", "This cheatsheet"],
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Keyboard Shortcuts" onClose={onClose}>
      <motion.div className="keys-modal" {...popIn}>
        <div className="settings-title">Keyboard Shortcuts</div>
        <div className="keys-grid">
          {SECTIONS.map((sec) => (
            <div key={sec.title} className="keys-section">
              <div className="settings-section">{sec.title}</div>
              {sec.rows.map(([k, label]) => (
                <div key={k} className="keys-row">
                  <kbd>{k}</kbd>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </motion.div>
    </Modal>
  );
}
