import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyTheme,
  DEFAULT_PALETTE,
  PALETTES,
  type Mode,
  type Palette,
} from "../design/theme";

export type { Mode } from "../design/theme";

interface SettingsState {
  /** include pg functions in the typed completion flow (always available via ^Space) */
  fnInComplete: boolean;
  toggleFnInComplete: () => void;

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
  const { mode } = useSettings.getState();
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
      s.customThemes !== prev.customThemes
    ) {
      prev = s;
      apply();
    } else {
      prev = s;
    }
  });
}
