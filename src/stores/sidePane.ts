// The one right pane (AGENT-UX section 1): Inspector and Ask are MODES of a
// single card, never two cards fighting for the right side. This store owns
// the shell's three facts (which mode shows, whether the card is open, how
// wide it is) and is persisted the way the inspector's open + width were.
// Everything a mode knows about its own content stays in its own store
// (inspector.ts: target, full value, edit requests; ask.ts: drafts, trace,
// picker, focus requests), and those stores mirror `open` for their readers.
//
// Width is shared; each mode has its own floor and ceiling, so switching
// clamps the shared width into the new mode's range (an Inspector at 240
// becomes an Ask at 320; an Ask at 560 stays a 560 Inspector).

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PaneMode = "inspector" | "ask";

export const PANE_FLOOR: Record<PaneMode, number> = { inspector: 220, ask: 320 };
export const PANE_MAX: Record<PaneMode, number> = { inspector: 640, ask: 560 };
export const PANE_DEFAULT_W: Record<PaneMode, number> = { inspector: 300, ask: 392 };

export interface SidePaneState {
  mode: PaneMode;
  open: boolean;
  width: number;

  /** the radio press: closed → open in `mode`; showing `mode` → close;
   * showing the other mode → switch (width stays, clamped) */
  toggle: (mode: PaneMode) => void;
  /** open in `mode` or switch to it; never closes */
  show: (mode: PaneMode) => void;
  close: () => void;
  setWidth: (w: number) => void;
}

export const clampPaneWidth = (mode: PaneMode, w: number): number =>
  Number.isFinite(w)
    ? Math.max(PANE_FLOOR[mode], Math.min(PANE_MAX[mode], Math.round(w)))
    : PANE_DEFAULT_W[mode];

const isMode = (v: unknown): v is PaneMode => v === "inspector" || v === "ask";

/** the pre-pane persisted inspector shell (`qwry.inspector`, open + width):
 * adopted once when this store has nothing of its own, so an upgrade keeps
 * the width the user had dragged to. Ask defaulted closed and never owned
 * the launch state, so its old key is not consulted */
function legacyInspector(): { open?: boolean; width?: number } {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem("qwry.inspector");
    if (!raw) return {};
    const st = (JSON.parse(raw) as { state?: { open?: unknown; width?: unknown } }).state;
    return {
      open: typeof st?.open === "boolean" ? st.open : undefined,
      width: typeof st?.width === "number" ? st.width : undefined,
    };
  } catch {
    return {};
  }
}

export const useSidePane = create<SidePaneState>()(
  persist(
    (set) => ({
      // the inspector's shipped defaults: open at launch, 300 wide
      mode: "inspector",
      open: true,
      width: PANE_DEFAULT_W.inspector,

      toggle: (mode) =>
        set((s) =>
          s.open && s.mode === mode
            ? { open: false }
            : { open: true, mode, width: clampPaneWidth(mode, s.width) },
        ),
      show: (mode) => set((s) => ({ open: true, mode, width: clampPaneWidth(mode, s.width) })),
      close: () => set({ open: false }),
      setWidth: (w) => set((s) => ({ width: clampPaneWidth(s.mode, w) })),
    }),
    {
      name: "qwry.sidePane",
      partialize: (s) => ({ mode: s.mode, open: s.open, width: s.width }),
      merge: (persisted, current) => {
        const p = (typeof persisted === "object" && persisted !== null ? persisted : {}) as {
          mode?: unknown;
          open?: unknown;
          width?: unknown;
        };
        const fresh = typeof p.width !== "number" && typeof p.open !== "boolean";
        const legacy = fresh ? legacyInspector() : {};
        const mode = isMode(p.mode) ? p.mode : current.mode;
        const open = typeof p.open === "boolean" ? p.open : legacy.open ?? current.open;
        const width =
          typeof p.width === "number"
            ? p.width
            : typeof legacy.width === "number"
              ? legacy.width
              : current.width;
        return { ...current, mode, open, width: clampPaneWidth(mode, width) };
      },
    },
  ),
);
