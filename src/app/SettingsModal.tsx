import { motion } from "motion/react";
import { Minus, Plus } from "lucide-react";
import { popIn } from "../design/springs";
import { FORMAT_PRESETS } from "../editor/format";
import { useSettings, zoomBy, type Mode } from "../stores/settings";
import { useUI } from "../stores/ui";
import { Modal } from "./overlay/Overlay";
import { Switch } from "../design/Switch";
import "./app.css";

const MODES: { id: Mode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

export function SettingsModal() {
  const open = useSettings((s) => s.settingsOpen);
  const setOpen = useSettings((s) => s.setSettingsOpen);
  const mode = useSettings((s) => s.mode);
  const setMode = useSettings((s) => s.setMode);
  const glassAlpha = useSettings((s) => s.glassAlpha);
  const setGlass = useSettings((s) => s.setGlass);
  const uiZoom = useSettings((s) => s.uiZoom);
  const fontSize = useSettings((s) => s.fontSize);
  const setFontSize = useSettings((s) => s.setFontSize);
  const wrapLines = useSettings((s) => s.wrapLines);
  const toggleWrapLines = useSettings((s) => s.toggleWrapLines);
  const timeout = useSettings((s) => s.statementTimeoutSecs);
  const setTimeoutSecs = useSettings((s) => s.setStatementTimeoutSecs);
  const fnInComplete = useSettings((s) => s.fnInComplete);
  const toggleFnInComplete = useSettings((s) => s.toggleFnInComplete);
  const formatPreset = useSettings((s) => s.formatPreset);
  const setFormatPreset = useSettings((s) => s.setFormatPreset);
  const keywordCase = useSettings((s) => s.formatKeywordCase);
  const setKeywordCase = useSettings((s) => s.setFormatKeywordCase);
  const gridFontSize = useSettings((s) => s.gridFontSize);
  const setGridFontSize = useSettings((s) => s.setGridFontSize);
  const gridDensity = useSettings((s) => s.gridDensity);
  const setGridDensity = useSettings((s) => s.setGridDensity);

  if (!open) return null;

  return (
    <Modal label="Settings" onClose={() => setOpen(false)}>
      <motion.div className="settings-modal" {...popIn}>
        <div className="settings-title">Settings</div>

        <div className="settings-section">Appearance</div>
        <div className="settings-row">
          <span className="settings-label">Mode</span>
          <div className="settings-seg">
            {MODES.map((m) => (
              <button
                key={m.id}
                className={mode === m.id ? "active" : ""}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Transparency</span>
          <div className="settings-slider">
            <span className="settings-slider-end">Solid</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((1 - glassAlpha) * 100)}
              onChange={(e) => setGlass(1 - Number(e.target.value) / 100)}
              onKeyDown={(e) => {
                if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
              }}
            />
            <span className="settings-slider-end">Glass</span>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Theme</span>
          <button
            className="settings-btn btnish"
            onClick={() => {
              setOpen(false);
              useUI.getState().openThemePicker();
            }}
          >
            Choose Theme…
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">UI Zoom</span>
          <div className="settings-stepper">
            <button className="iconbtn bordered" onClick={() => zoomBy(-1)} aria-label="Zoom Out">
              <Minus size={12} />
            </button>
            <span>{uiZoom}%</span>
            <button className="iconbtn bordered" onClick={() => zoomBy(1)} aria-label="Zoom In">
              <Plus size={12} />
            </button>
          </div>
        </div>

        <div className="settings-section">Editor</div>
        <div className="settings-row">
          <span className="settings-label">Font Size</span>
          <div className="settings-stepper">
            <button
              className="iconbtn bordered"
              onClick={() => setFontSize(fontSize - 1)}
              aria-label="Decrease Font Size"
            >
              <Minus size={12} />
            </button>
            <span>{fontSize}px</span>
            <button
              className="iconbtn bordered"
              onClick={() => setFontSize(fontSize + 1)}
              aria-label="Increase Font Size"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <label className="settings-row settings-check">
          <span className="settings-label">Wrap Long Lines</span>
          <Switch checked={wrapLines} onChange={() => toggleWrapLines()} />
        </label>
        <label className="settings-row settings-check">
          <span className="settings-label">Functions in Autocomplete</span>
          <Switch checked={fnInComplete} onChange={() => toggleFnInComplete()} />
        </label>

        <div className="settings-section">Results Grid</div>
        <div className="settings-row">
          <span className="settings-label">Font Size</span>
          <div className="settings-stepper">
            <button
              className="iconbtn bordered"
              onClick={() => setGridFontSize(gridFontSize - 1)}
              aria-label="Decrease Font Size"
            >
              <Minus size={12} />
            </button>
            <span>{gridFontSize}px</span>
            <button
              className="iconbtn bordered"
              onClick={() => setGridFontSize(gridFontSize + 1)}
              aria-label="Increase Font Size"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Density</span>
          <div className="settings-seg">
            {(["compact", "normal", "comfortable"] as const).map((d) => (
              <button
                key={d}
                className={gridDensity === d ? "active" : ""}
                onClick={() => setGridDensity(d)}
              >
                {d === "compact" ? "Compact" : d === "normal" ? "Normal" : "Roomy"}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">SQL Format</div>
        <div className="settings-row">
          <span className="settings-label">Style</span>
          <select
            className="settings-select"
            value={formatPreset}
            onChange={(e) => setFormatPreset(e.target.value)}
            title={FORMAT_PRESETS.find((p) => p.id === formatPreset)?.blurb}
          >
            {FORMAT_PRESETS.map((p) => (
              <option key={p.id} value={p.id} title={p.blurb}>
                {p.label} · {p.blurb}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-label">Keywords</span>
          <div className="settings-seg">
            {(["upper", "lower", "preserve"] as const).map((c) => (
              <button
                key={c}
                className={keywordCase === c ? "active" : ""}
                onClick={() => setKeywordCase(c)}
              >
                {c === "upper" ? "UPPER" : c === "lower" ? "lower" : "As-is"}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">Query</div>
        <div className="settings-row">
          <span className="settings-label">Statement Timeout</span>
          <div className="settings-timeout">
            <input
              type="number"
              min={0}
              max={7200}
              value={timeout}
              onChange={(e) => setTimeoutSecs(Number(e.target.value))}
              onKeyDown={(e) => {
                if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
              }}
            />
            <span className="settings-hint">
              seconds · 0 = none · applies to new connections
            </span>
          </div>
        </div>
      </motion.div>
    </Modal>
  );
}
