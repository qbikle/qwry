import { create } from "zustand";

/** aggregates of the current grid selection, shown in the status bar.
 * Published by the mounted Grid (which owns the view→data maps); numbers ride
 * PG wire text, so numeric-ness is detected per value. */
export interface SelectionStats {
  cells: number;
  nonNull: number;
  numeric: number;
  sum: number;
  min: number;
  max: number;
  /** selection was too big to aggregate synchronously */
  tooBig: boolean;
}

interface GridStatsState {
  stats: SelectionStats | null;
  set: (s: SelectionStats | null) => void;
}

export const useGridStats = create<GridStatsState>((set) => ({
  stats: null,
  set: (stats) => set({ stats }),
}));
