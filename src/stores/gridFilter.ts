import { create } from "zustand";

/** quick-filter over LOADED grid rows (editor results only: the browser's
 * paged data filters server-side via the filter bar). View-level like client
 * sort: data indexes untouched, so staged edits stay on the right rows. */
interface GridFilterState {
  open: boolean;
  text: string;
  /** matching view rows, published by the mounted Grid (null = filter off) */
  matches: number | null;
  /** hidden DATA column indexes, published by the mounted Grid (FindBar skips them) */
  hiddenCols: ReadonlySet<number>;
  setOpen: (v: boolean) => void;
  setText: (t: string) => void;
  setMatches: (n: number | null) => void;
  setHiddenCols: (s: ReadonlySet<number>) => void;
  clear: () => void;
}

export const useGridFilter = create<GridFilterState>((set) => ({
  open: false,
  text: "",
  matches: null,
  hiddenCols: new Set<number>(),
  setOpen: (open) => set(open ? { open } : { open, text: "", matches: null }),
  setText: (text) => set({ text }),
  setMatches: (matches) => set({ matches }),
  setHiddenCols: (hiddenCols) => set({ hiddenCols }),
  clear: () => set({ open: false, text: "", matches: null }),
}));
