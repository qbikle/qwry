import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "system" | "dark" | "light";

interface SettingsState {
  /** include pg functions in the typed completion flow (always available via ^Space) */
  fnInComplete: boolean;
  toggleFnInComplete: () => void;

  /** user's theme preference */
  theme: Theme;
  /** the theme actually applied right now (system resolved to dark/light) */
  resolved: "dark" | "light";
  setTheme: (t: Theme) => void;
}

function systemTheme(): "dark" | "light" {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function resolve(theme: Theme): "dark" | "light" {
  return theme === "system" ? systemTheme() : theme;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      fnInComplete: false,
      toggleFnInComplete: () => set((s) => ({ fnInComplete: !s.fnInComplete })),

      theme: "dark",
      resolved: "dark",
      setTheme: (theme) => set({ theme, resolved: resolve(theme) }),
    }),
    {
      name: "qwry.settings",
      // only the preference is persisted; `resolved` is recomputed each launch
      partialize: (s) => ({ fnInComplete: s.fnInComplete, theme: s.theme }),
    },
  ),
);

/** push the resolved theme onto <html data-theme> for the CSS token set */
function apply(theme: Theme) {
  const r = resolve(theme);
  if (typeof document !== "undefined") document.documentElement.dataset.theme = r;
  useSettings.setState({ resolved: r });
}

// apply immediately at import (before first paint) to avoid a theme flash
apply(useSettings.getState().theme);

// keep "system" in sync with the OS appearance
if (typeof window !== "undefined") {
  window
    .matchMedia?.("(prefers-color-scheme: light)")
    .addEventListener?.("change", () => {
      if (useSettings.getState().theme === "system") apply("system");
    });
  // re-apply whenever the preference changes
  useSettings.subscribe((s, p) => {
    if (s.theme !== p.theme) apply(s.theme);
  });
}
