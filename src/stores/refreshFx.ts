/** Refresh feedback choreography ("the rebuild"). Manual ⇧⌘R sequence:
 * the sidebar db glyph spins one full turn (the gesture ack), the disc
 * stack splits apart while the heal runs, claps back together on the
 * verdict, and a top→bottom shine sweeps the header ONLY when the heal
 * actually succeeded: the shine is a claim, never decoration. Background
 * heals (wake/focus/session death) skip the spin and split and shine only
 * when something was actually rebuilt — a no-op probe stays invisible.
 * DbGlyph renders the discs; stores/heal.ts calls in; this store owns time. */
import { create } from "zustand";

/** trial flag: background heals gleam too; flip false for ⇧⌘R-only */
const AUTO_HEAL_SHINE = true;
/** the spin owns the stage before the stack opens (spring.turn settles
 * ~1s; splitting into its tail reads as one continuous move) */
const SPIN_MS = 680;
/** the split must READ before a fast verdict claps it shut */
const MIN_APART_MS = 320;
/** shine launches as the discs land, not while they travel */
const JOIN_SHINE_LAG_MS = 180;

// generation guard: any new gesture orphans the previous timers
let gen = 0;
let apartAt = 0;
/** verdict that landed while the spin still owned the stage */
let pendingOk: boolean | null = null;
const later = (ms: number, g: number, fn: () => void) => {
  setTimeout(() => {
    if (gen === g) fn();
  }, ms);
};

interface RefreshFxState {
  /** profile whose header animates; everyone else stays inert */
  profileId: string | null;
  /** full turns spun so far: DbGlyph animates rotate to spinTurns * 360,
   * so each bump springs exactly one more revolution from where it rests */
  spinTurns: number;
  /** discs split apart = a heal is in flight */
  apart: boolean;
  /** bump = replay the shine (element re-keyed per value); 0 = never shone */
  shineSeq: number;
  /** manual gesture: spin now, split when the spin has read */
  begin: (profileId: string) => void;
  /** manual verdict: clap the stack home; shine only if the heal held */
  resolve: (profileId: string, ok: boolean) => void;
  /** background heal that really rebuilt something: shine alone */
  autoShine: (profileId: string) => void;
}

export const useRefreshFx = create<RefreshFxState>((set, get) => ({
  profileId: null,
  spinTurns: 0,
  apart: false,
  shineSeq: 0,
  begin: (profileId) => {
    const g = ++gen;
    pendingOk = null;
    set((s) => ({ profileId, spinTurns: s.spinTurns + 1, apart: false }));
    later(SPIN_MS, g, () => {
      apartAt = Date.now();
      set({ apart: true });
      if (pendingOk !== null) {
        const ok = pendingOk;
        pendingOk = null;
        get().resolve(profileId, ok);
      }
    });
  },
  resolve: (profileId, ok) => {
    if (get().profileId !== profileId) return;
    // verdict beat the spin: hold it until the split takes the stage
    if (!get().apart) {
      pendingOk = ok;
      return;
    }
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
    pendingOk = null;
    set((s) => ({ profileId, apart: false, shineSeq: s.shineSeq + 1 }));
  },
}));
