import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyTheme,
  DEFAULT_PALETTE,
  PALETTES,
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

  /** default ⌘⇧F style — id into FORMAT_PRESETS */
  formatPreset: string;
  setFormatPreset: (id: string) => void;
  /** keyword/type case applied by every preset */
  formatKeywordCase: "upper" | "lower" | "preserve";
  setFormatKeywordCase: (c: "upper" | "lower" | "preserve") => void;

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
      partialize: (s) => ({
        fnInComplete: s.fnInComplete,
        fontSize: s.fontSize,
        gridFontSize: s.gridFontSize,
        gridDensity: s.gridDensity,
        wrapLines: s.wrapLines,
        statementTimeoutSecs: s.statementTimeoutSecs,
        formatPreset: s.formatPreset,
        formatKeywordCase: s.formatKeywordCase,
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

if (typeof window !== "undefined") {
  window
    .matchMedia?.("(prefers-color-scheme: light)")
    .addEventListener?.("change", () => {
      if (useSettings.getState().mode === "system") apply();
    });
  // re-apply whenever the mode, palette or custom set changes
  let prev = useSettings.getState();
  useSettings.subscribe((s) => {
    if (
      s.mode !== prev.mode ||
      s.paletteId !== prev.paletteId ||
      s.customThemes !== prev.customThemes ||
      s.glassAlpha !== prev.glassAlpha
    ) {
      prev = s;
      apply();
    } else {
      prev = s;
    }
  });
}
