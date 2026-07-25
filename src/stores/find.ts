// Find-in-results (⌘F over the loaded grid rows). Honest by design: matches
// are computed over the in-memory rows only; the bar says so when the result
// is capped. Hits are computed by FindBar (which owns the debounce); the grid
// reads hitSet/current for highlighting + scroll-to.
import { create } from "zustand";

export interface FindHit {
  r: number;
  c: number;
}

interface FindState {
  open: boolean;
  query: string;
  /** bumped on every ⌘F so the bar re-focuses + selects its input */
  focusSeq: number;
  hits: FindHit[];
  hitSet: Set<string>; // "r:c"
  idx: number;
  /** hit list stopped at the cap (not the row cap, the match cap) */
  hitCapped: boolean;

  openFind: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  setResults: (hits: FindHit[], hitCapped: boolean) => void;
  step: (dir: 1 | -1) => void;
}

export const hitKey = (r: number, c: number) => `${r}:${c}`;

export const useFind = create<FindState>((set, get) => ({
  open: false,
  query: "",
  focusSeq: 0,
  hits: [],
  hitSet: new Set(),
  idx: 0,
  hitCapped: false,

  openFind: () => set((s) => ({ open: true, focusSeq: s.focusSeq + 1 })),

  close: () => set({ open: false, hits: [], hitSet: new Set(), idx: 0, hitCapped: false }),

  setQuery: (query) => set({ query }),

  setResults: (hits, hitCapped) =>
    set((s) => ({
      hits,
      hitCapped,
      hitSet: new Set(hits.map((h) => hitKey(h.r, h.c))),
      idx: hits.length === 0 ? 0 : Math.min(s.idx, hits.length - 1),
    })),

  step: (dir) => {
    const { hits, idx } = get();
    if (hits.length === 0) return;
    set({ idx: (idx + dir + hits.length) % hits.length });
  },
}));
