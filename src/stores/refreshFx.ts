/** Refresh feedback choreography ("the rebuild"). The sidebar db glyph's
 * disc stack splits apart when a manual ⇧⌘R heal starts, springs back
 * together on the verdict, and a top→bottom shine sweeps the header ONLY
 * when the heal actually succeeded: the shine is a claim, never decoration.
 * Background heals (wake/focus/session death) skip the split and shine only
 * when something was actually rebuilt — a no-op probe stays invisible.
 * DbGlyph renders the discs; stores/heal.ts calls in; this store owns time. */
import { create } from "zustand";

/** trial flag: background heals gleam too; flip false for ⇧⌘R-only */
const AUTO_HEAL_SHINE = true;
/** the split must READ before a fast verdict claps it shut */
const MIN_APART_MS = 320;
/** shine launches as the discs land, not while they travel */
const JOIN_SHINE_LAG_MS = 180;

// generation guard: any new gesture orphans the previous timers
let gen = 0;
let apartAt = 0;
const later = (ms: number, g: number, fn: () => void) => {
  setTimeout(() => {
    if (gen === g) fn();
  }, ms);
};

interface RefreshFxState {
  /** profile whose header animates; everyone else stays inert */
  profileId: string | null;
  /** discs split apart = a heal is in flight */
  apart: boolean;
  /** bump = replay the shine (element re-keyed per value); 0 = never shone */
  shineSeq: number;
  /** manual gesture: split the stack now */
  begin: (profileId: string) => void;
  /** manual verdict: clap the stack home; shine only if the heal held */
  resolve: (profileId: string, ok: boolean) => void;
  /** background heal that really rebuilt something: shine without the split */
  autoShine: (profileId: string) => void;
}

export const useRefreshFx = create<RefreshFxState>((set, get) => ({
  profileId: null,
  apart: false,
  shineSeq: 0,
  begin: (profileId) => {
    gen++;
    apartAt = Date.now();
    set({ profileId, apart: true });
  },
  resolve: (profileId, ok) => {
    if (get().profileId !== profileId || !get().apart) return;
    const g = ++gen;
    const wait = Math.max(0, MIN_APART_MS - (Date.now() - apartAt));
    later(wait, g, () => {
      set({ apart: false });
      if (ok) later(JOIN_SHINE_LAG_MS, g, () => set((s) => ({ shineSeq: s.shineSeq + 1 })));
    });
  },
  autoShine: (profileId) => {
    if (!AUTO_HEAL_SHINE) return;
    gen++;
    set((s) => ({ profileId, apart: false, shineSeq: s.shineSeq + 1 }));
  },
}));
