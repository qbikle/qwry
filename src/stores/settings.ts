import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyTheme,
  DEFAULT_PALETTE,
  PALETTES,
  sanitizePalette,
  setGlassAlpha,
  type Mode,
  type Palette,
} from "../design/theme";

export type { Mode } from "../design/theme";

interface SettingsState {
  /** include pg functions in the typed completion flow (always available via ^Space) */
  fnInComplete: boolean;
  toggleFnInComplete: () => void;

  /** editor font size in px */
  fontSize: number;
  setFontSize: (n: number) => void;
  /** results grid font size in px */
  gridFontSize: number;
  setGridFontSize: (n: number) => void;
  /** results grid row density */
  gridDensity: "compact" | "normal" | "comfortable";
  setGridDensity: (d: "compact" | "normal" | "comfortable") => void;
  /** soft-wrap long lines in the SQL editor */
  wrapLines: boolean;
  toggleWrapLines: () => void;
  /** server-side statement_timeout, seconds — applies to NEW connections */
  statementTimeoutSecs: number;
  setStatementTimeoutSecs: (n: number) => void;

  /** default ⇧⌘F style — id into FORMAT_PRESETS */
  formatPreset: string;
  setFormatPreset: (id: string) => void;
  /** keyword/type case applied by every preset */
  formatKeywordCase: "upper" | "lower" | "preserve";
  setFormatKeywordCase: (c: "upper" | "lower" | "preserve") => void;

  /** UI (chrome) zoom percent, ⌘+/⌘−/⌘0 — 70–150, 100 = actual size */
  uiZoom: number;
  setUiZoom: (n: number) => void;

  /** settings modal */
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;

  /** gutter glass opacity 0.1–0.9 (lower = more see-through vibrancy) */
  glassAlpha: number;
  setGlass: (a: number) => void;

  /** dark / light / system */
  mode: Mode;
  /** active palette id (curated or custom) */
  paletteId: string;
  /** user-created palettes */
  customThemes: Palette[];
  /** resolved render mode after applying system pref */
  resolved: "dark" | "light";

  setMode: (m: Mode) => void;
  setPalette: (id: string) => void;
  addCustomTheme: (p: Palette) => void;
  removeCustomTheme: (id: string) => void;
}

function systemDark(): boolean {
  return !(
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
  );
}

/* rehydrate validation — a corrupt qwry.settings blob (NaN sizes, garbage
 * enums, mangled custom themes) must degrade field-by-field to defaults, never
 * propagate invalid CSS vars app-wide */
const finite = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/** UI zoom bounds — ⌘0 resets to 100 */
export const ZOOM_MIN = 70;
export const ZOOM_MAX = 150;
export const ZOOM_STEP = 10;
const clampZoom = (n: number) =>
  Number.isFinite(n) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(n))) : 100;
const pick = <T,>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

function sanitizeSettings(persisted: unknown, current: SettingsState): SettingsState {
  const p = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Record<
    string,
    unknown
  >;
  return {
    ...current,
    fnInComplete: typeof p.fnInComplete === "boolean" ? p.fnInComplete : current.fnInComplete,
    fontSize: finite(p.fontSize, 10, 20, current.fontSize),
    gridFontSize: finite(p.gridFontSize, 10, 18, current.gridFontSize),
    gridDensity: pick(
      p.gridDensity,
      ["compact", "normal", "comfortable"] as const,
      current.gridDensity,
    ),
    wrapLines: typeof p.wrapLines === "boolean" ? p.wrapLines : current.wrapLines,
    statementTimeoutSecs: finite(p.statementTimeoutSecs, 0, 7200, current.statementTimeoutSecs),
    formatPreset: typeof p.formatPreset === "string" ? p.formatPreset : current.formatPreset,
    formatKeywordCase: pick(
      p.formatKeywordCase,
      ["upper", "lower", "preserve"] as const,
      current.formatKeywordCase,
    ),
    uiZoom: finite(p.uiZoom, ZOOM_MIN, ZOOM_MAX, current.uiZoom),
    glassAlpha: finite(p.glassAlpha, 0, 1, current.glassAlpha),
    mode: pick(p.mode, ["system", "dark", "light"] as const, current.mode),
    paletteId:
      typeof p.paletteId === "string" && p.paletteId !== "" ? p.paletteId : DEFAULT_PALETTE,
    customThemes: Array.isArray(p.customThemes)
      ? p.customThemes.map(sanitizePalette).filter((t): t is Palette => t !== null)
      : current.customThemes,
  };
}

function resolveDark(mode: Mode): boolean {
  return mode === "system" ? systemDark() : mode === "dark";
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      fnInComplete: false,
      toggleFnInComplete: () => set((s) => ({ fnInComplete: !s.fnInComplete })),

      fontSize: 13,
      setFontSize: (n) => set({ fontSize: Math.max(10, Math.min(20, Math.round(n))) }),
      gridFontSize: 12,
      setGridFontSize: (n) => set({ gridFontSize: Math.max(10, Math.min(18, Math.round(n))) }),
      gridDensity: "normal",
      setGridDensity: (gridDensity) => set({ gridDensity }),
      wrapLines: false,
      toggleWrapLines: () => set((s) => ({ wrapLines: !s.wrapLines })),
      statementTimeoutSecs: 300,
      setStatementTimeoutSecs: (n) =>
        // 0 = no timeout; else clamp 1s..2h
        set({ statementTimeoutSecs: n <= 0 ? 0 : Math.max(1, Math.min(7200, Math.round(n))) }),

      formatPreset: "standard",
      setFormatPreset: (formatPreset) => set({ formatPreset }),
      formatKeywordCase: "upper",
      setFormatKeywordCase: (formatKeywordCase) => set({ formatKeywordCase }),

      uiZoom: 100,
      setUiZoom: (n) => set({ uiZoom: clampZoom(n) }),

      settingsOpen: false,
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

      glassAlpha: 0.55,
      setGlass: (a) => set({ glassAlpha: Math.max(0, Math.min(1, a)) }),

      mode: "dark",
      paletteId: DEFAULT_PALETTE,
      customThemes: [],
      resolved: "dark",

      setMode: (mode) => set({ mode, resolved: resolveDark(mode) ? "dark" : "light" }),
      setPalette: (paletteId) => set({ paletteId }),
      addCustomTheme: (p) =>
        set((s) => ({
          customThemes: [...s.customThemes.filter((c) => c.id !== p.id), p],
          paletteId: p.id,
        })),
      removeCustomTheme: (id) =>
        set((s) => ({
          customThemes: s.customThemes.filter((c) => c.id !== id),
          paletteId: s.paletteId === id ? DEFAULT_PALETTE : s.paletteId,
        })),
    }),
    {
      name: "qwry.settings",
      merge: sanitizeSettings,
      partialize: (s) => ({
        fnInComplete: s.fnInComplete,
        fontSize: s.fontSize,
        gridFontSize: s.gridFontSize,
        gridDensity: s.gridDensity,
        wrapLines: s.wrapLines,
        statementTimeoutSecs: s.statementTimeoutSecs,
        formatPreset: s.formatPreset,
        formatKeywordCase: s.formatKeywordCase,
        uiZoom: s.uiZoom,
        glassAlpha: s.glassAlpha,
        mode: s.mode,
        paletteId: s.paletteId,
        customThemes: s.customThemes,
      }),
    },
  ),
);

/** all selectable palettes — curated first, then the user's */
export function allPalettes(): Palette[] {
  return [...PALETTES, ...useSettings.getState().customThemes];
}

function currentPalette(): Palette {
  const { paletteId } = useSettings.getState();
  return allPalettes().find((p) => p.id === paletteId) ?? PALETTES[0];
}

/* UI zoom (⌘+/⌘−/⌘0) scales the CHROME: the px-based --text-* tokens are
 * re-emitted as inline overrides scaled by uiZoom (bases read from the loaded
 * stylesheet once, so token retunes in tokens.css stay authoritative), plus
 * root font-size % (any rem-based sizes inherit) and a --zoom factor for CSS
 * that wants to opt other px sizes in. DELIBERATELY EXCLUDED: the editor
 * (--editor-fs) and the results grid (--grid-fs, row/header geometry) — both
 * have their own font-size settings, and the grid's virtualizer/hit-test math
 * is anchored to px constants. Zoom is chrome-level. */
const ZOOM_TOKENS = ["--text-2xs", "--text-xs", "--text-sm", "--text-md", "--text-lg"] as const;
const ZOOM_FALLBACK: Record<(typeof ZOOM_TOKENS)[number], number> = {
  "--text-2xs": 10,
  "--text-xs": 11,
  "--text-sm": 12,
  "--text-md": 13,
  "--text-lg": 15,
};
let zoomBase: Record<string, number> | null = null;

function applyZoom(pct: number) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!zoomBase) {
    zoomBase = {};
    const cs = getComputedStyle(root);
    for (const t of ZOOM_TOKENS) {
      const v = parseFloat(cs.getPropertyValue(t));
      zoomBase[t] = Number.isFinite(v) && v > 0 ? v : ZOOM_FALLBACK[t];
    }
  }
  const f = pct / 100;
  root.style.setProperty("--zoom", String(f));
  if (pct === 100) {
    // clear overrides at 100% so the stylesheet's tokens rule again
    root.style.fontSize = "";
    for (const t of ZOOM_TOKENS) root.style.removeProperty(t);
    return;
  }
  root.style.fontSize = `${pct}%`;
  for (const t of ZOOM_TOKENS)
    root.style.setProperty(t, `${Math.round(zoomBase[t] * f * 10) / 10}px`);
}

/** recompute + apply CSS vars from the current palette & mode */
function apply() {
  const { mode, glassAlpha } = useSettings.getState();
  setGlassAlpha(glassAlpha);
  // the mode toggle governs every theme — custom themes synthesise the
  // matching dark/light variant from their authored colours
  const dark = resolveDark(mode);
  applyTheme(currentPalette(), dark);
  useSettings.setState({ resolved: dark ? "dark" : "light" });
}

// apply immediately at import (before first paint) to avoid a flash
apply();
// zoom waits a microtask: this module evaluates BEFORE main.tsx's tokens.css
// import in dev, and the token bases must be read from the loaded stylesheet.
// Microtasks still run before first paint — no unzoomed flash.
if (useSettings.getState().uiZoom !== 100) {
  queueMicrotask(() => applyZoom(useSettings.getState().uiZoom));
}

if (typeof window !== "undefined") {
  window
    .matchMedia?.("(prefers-color-scheme: light)")
    .addEventListener?.("change", () => {
      if (useSettings.getState().mode === "system") apply();
    });
  // re-apply whenever the mode, palette or custom set changes
  let prev = useSettings.getState();
  useSettings.subscribe((s) => {
    const themeChanged =
      s.mode !== prev.mode ||
      s.paletteId !== prev.paletteId ||
      s.customThemes !== prev.customThemes ||
      s.glassAlpha !== prev.glassAlpha;
    const zoomChanged = s.uiZoom !== prev.uiZoom;
    prev = s;
    if (themeChanged) apply();
    if (zoomChanged) applyZoom(s.uiZoom);
  });
}

/** ⌘+/⌘− step, ⌘0 reset — shared by the menu items and the window shortcuts */
export function zoomBy(dir: 1 | -1) {
  const s = useSettings.getState();
  s.setUiZoom(s.uiZoom + dir * ZOOM_STEP);
}
export function zoomReset() {
  useSettings.getState().setUiZoom(100);
}
