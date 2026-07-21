import { useState } from "react";
import { motion } from "motion/react";
import { Copy, Monitor, Moon, Pencil, Plus, Sun, Trash2, X } from "lucide-react";
import { popIn } from "../design/springs";
import { useSettings, type Mode } from "../stores/settings";
import { anchorsOf, PALETTES, swatch, type Palette } from "../design/theme";
import { useUI } from "../stores/ui";
import { Modal } from "./overlay/Overlay";
import "./theme-picker.css";

const MODES: [Mode, string, typeof Moon][] = [
  ["system", "System", Monitor],
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
];

interface Draft {
  editingId: string | null; // null = new
  name: string;
  bg: string;
  fg: string;
  primary: string;
  secondary: string;
}

const BASE_DARK = { bg: "#14161b", fg: "#e7e9ef", primary: "#5b8cff", secondary: "#3ecf8e" };
const BASE_LIGHT = { bg: "#f4f6f9", fg: "#16181d", primary: "#2f6bff", secondary: "#1a9d6b" };

export function ThemePicker() {
  const open = useUI((s) => s.themePicker);
  const close = useUI((s) => s.closeThemePicker);
  const mode = useSettings((s) => s.mode);
  const setMode = useSettings((s) => s.setMode);
  const paletteId = useSettings((s) => s.paletteId);
  const setPalette = useSettings((s) => s.setPalette);
  const resolved = useSettings((s) => s.resolved);
  const addCustomTheme = useSettings((s) => s.addCustomTheme);
  const removeCustomTheme = useSettings((s) => s.removeCustomTheme);
  const customThemes = useSettings((s) => s.customThemes);

  const [draft, setDraft] = useState<Draft | null>(null);

  if (!open) return null;
  const dark = resolved === "dark";
  const palettes = [...PALETTES, ...customThemes];

  const openCreate = () => {
    const b = dark ? BASE_DARK : BASE_LIGHT;
    setDraft({ editingId: null, name: "", ...b });
  };
  const loadFrom = (p: Palette, editingId: string | null, name: string) => {
    const a = anchorsOf(p, dark);
    setDraft({ editingId, name, bg: a.bg, fg: a.fg, primary: a.primary, secondary: a.secondary });
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return;
    const id = draft.editingId ?? `custom-${crypto.randomUUID().slice(0, 8)}`;
    addCustomTheme({
      id,
      name,
      custom: true,
      bg: draft.bg,
      fg: draft.fg,
      primary: draft.primary,
      secondary: draft.secondary,
    });
    setDraft(null);
  };
  const del = () => {
    if (draft?.editingId) removeCustomTheme(draft.editingId);
    setDraft(null);
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const colorRow = (label: string, key: keyof Draft) => (
    <label className="tp-colorrow">
      <span>{label}</span>
      <span className="tp-color" style={{ background: draft![key] as string }}>
        <input type="color" value={draft![key] as string} onChange={(e) => set({ [key]: e.target.value })} />
      </span>
    </label>
  );

  return (
    // Esc/backdrop backs out of the draft sub-form first, then closes the picker
    <Modal
      backdropClassName="tp-backdrop"
      label="Theme"
      onClose={() => (draft ? setDraft(null) : close())}
    >
      <motion.div className="tp-modal" {...popIn}>
        <div className="tp-head">
          <span className="tp-title">Theme</span>
          <button className="tp-x" onClick={close}>
            <X size={15} />
          </button>
        </div>

        <div className="tp-modes">
          {MODES.map(([m, label, Icon]) => (
            <button
              key={m}
              className={`tp-mode${mode === m ? " active" : ""}`}
              onClick={() => setMode(m)}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div className="tp-grid">
          {palettes.map((p) => {
            const sw = swatch(p, dark);
            const active = p.id === paletteId;
            return (
              <button
                key={p.id}
                className={`tp-swatch${active ? " active" : ""}`}
                style={{ background: sw.bg, color: sw.accent }}
                onClick={() => setPalette(p.id)}
              >
                <span className="tp-dot" style={{ background: sw.accent }} />
                <span className="tp-name">{p.name}</span>
                <span
                  className="tp-action"
                  title={p.custom ? "Edit theme" : "Duplicate to a custom theme"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (p.custom) loadFrom(p, p.id, p.name);
                    else loadFrom(p, null, `${p.name} copy`);
                  }}
                >
                  {p.custom ? <Pencil size={12} /> : <Copy size={12} />}
                </span>
              </button>
            );
          })}
        </div>

        {draft ? (
          <div className="tp-create">
            <input
              className="tp-input"
              autoFocus
              placeholder="Theme name"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              onKeyDown={(e) => {
                // Esc is owned by the Modal overlay (backs out of the draft first)
                if (e.key === "Enter") save();
              }}
            />
            <div className="tp-colors">
              {colorRow("Background", "bg")}
              {colorRow("Text", "fg")}
              {colorRow("Primary", "primary")}
              {colorRow("Secondary", "secondary")}
            </div>
            <div className="tp-create-actions">
              {draft.editingId && (
                <button className="tp-del-btn" onClick={del}>
                  <Trash2 size={13} /> Delete
                </button>
              )}
              <button onClick={() => setDraft(null)}>Cancel</button>
              <button className="primary" onClick={save} disabled={!draft.name.trim()}>
                {draft.editingId ? "Save" : "Create"}
              </button>
            </div>
          </div>
        ) : (
          <button className="tp-new" onClick={openCreate}>
            <Plus size={14} /> Custom Theme…
          </button>
        )}

        <div className="tp-foot">
          Custom themes pick exact colors; the opposite light/dark variant is generated
          automatically. Hover to edit or duplicate.
        </div>
      </motion.div>
    </Modal>
  );
}
