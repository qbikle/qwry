/** Refresh feedback choreography ("the rebuild"). Manual ⇧⌘R sequence:
 * the sidebar db glyph spins one full turn (the gesture ack) and the disc
 * stack splits apart while the heal runs, then claps back together on the
 * verdict. The gesture's own ack is the window-wide sweep (E2 R2,
 * app/RefreshSweep.tsx), which plays whatever the verdict turns out to be;
 * the glyph is where the verdict itself lands. Background heals (wake/focus/
 * session death) never sweep and never spin: they clap the stack once, and
 * only when something was actually rebuilt — a no-op probe stays invisible.
 * DbGlyph renders the discs; stores/heal.ts calls in; this store owns time. */
import { create } from "zustand";

/** the spin owns the stage before the stack opens (spring.turn settles
 * ~1s; splitting into its tail reads as one continuous move) */
const SPIN_MS = 680;
/** the split must READ before a fast verdict claps it shut */
const MIN_APART_MS = 320;

// generation guard: any new gesture orphans the previous timers
let gen = 0;
let apartAt = 0;
/** a verdict landed while the spin still owned the stage */
let pendingVerdict = false;
/** a manual ceremony is running (begin → resolve's clap): a background
 * autoClap for the same profile must defer to it — the ceremony claps on
 * the same verdict, and its gen++ would orphan the ceremony's timers */
let manualActive = false;
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
  /** manual gesture: spin now, split when the spin has read */
  begin: (profileId: string) => void;
  /** manual verdict, whichever way it went: clap the stack home. The verdict
   * itself is the rail dot's and the glyph's own color, never the clap */
  resolve: (profileId: string) => void;
  /** background heal that really rebuilt something: one clap, nothing else */
  autoClap: (profileId: string) => void;
}

export const useRefreshFx = create<RefreshFxState>((set, get) => ({
  profileId: null,
  spinTurns: 0,
  apart: false,
  begin: (profileId) => {
    const g = ++gen;
    pendingVerdict = false;
    manualActive = true;
    // the counter is only meaningful to a glyph already resting at
    // spinTurns × 360: an unmounted profile's glyph sits at 0°, so adopting
    // a new profile restarts at 1 (0 → 360, exactly one revolution)
    set((s) => ({
      profileId,
      spinTurns: s.profileId === profileId ? s.spinTurns + 1 : 1,
      apart: false,
    }));
    later(SPIN_MS, g, () => {
      apartAt = Date.now();
      set({ apart: true });
      if (pendingVerdict) {
        pendingVerdict = false;
        get().resolve(profileId);
      }
    });
  },
  resolve: (profileId) => {
    if (get().profileId !== profileId) return;
    // verdict beat the spin: hold it until the split takes the stage
    if (!get().apart) {
      pendingVerdict = true;
      return;
    }
    const g = ++gen;
    const wait = Math.max(0, MIN_APART_MS - (Date.now() - apartAt));
    later(wait, g, () => {
      set({ apart: false });
      manualActive = false;
    });
  },
  autoClap: (profileId) => {
    // a background heal can JOIN a manual pass (connections.healInflight):
    // both continuations fire on one verdict, and the manual ceremony will
    // already report it — stomping in here would orphan its timers
    if (manualActive && get().profileId === profileId) return;
    const g = ++gen;
    pendingVerdict = false;
    manualActive = false;
    // adopting a profile whose glyph rests at 0°: spin stays untouched only
    // when the counter still matches what that glyph is displaying
    set((s) => ({
      profileId,
      spinTurns: s.profileId === profileId ? s.spinTurns : 0,
      apart: true,
    }));
    apartAt = Date.now();
    later(MIN_APART_MS, g, () => set({ apart: false }));
  },
}));
