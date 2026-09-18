// The only place spring parameters live. Springs on transitions, never on
// scroll, typing, or completion popups (those must be instant).
//
// prefers-reduced-motion: every preset collapses to an instant variant while
// the OS setting is on. The presets expose getters so each render reads the
// LIVE flag: flipping the setting mid-session applies to the next animation
// without a reload. Initial offsets also collapse (no one-frame jump).

const rmq: MediaQueryList | null =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
let reduced = rmq?.matches ?? false;
rmq?.addEventListener("change", (e) => {
  reduced = e.matches;
});

export const prefersReducedMotion = () => reduced;

const INSTANT = { duration: 0 } as const;

const POP = { type: "spring", stiffness: 520, damping: 32, mass: 0.8 } as const;
const SNAPPY = { type: "spring", stiffness: 700, damping: 38, mass: 0.6 } as const;
// long-travel rotations (a full revolution): slow build, fluid middle, soft
// settle with a whisper of overshoot; POP-class springs read as a violent
// snap over 360°
const TURN = { type: "spring", stiffness: 130, damping: 19, mass: 1 } as const;
const PANEL = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;
const RAIL = { type: "spring", stiffness: 600, damping: 24, mass: 0.6 } as const;
const DRAWER = { type: "spring", stiffness: 520, damping: 40, mass: 0.8 } as const;
const SWAP = { type: "spring", stiffness: 700, damping: 40, mass: 0.5 } as const;
// the right pane's mode swap (Ask ↔ Inspector): a 32px slide that reads as
// ease-out with no bounce, Stage Manager's register. ζ = 40 / (2·√400) = 1.0,
// critically damped: no overshoot by construction; 90% of the travel in
// ~200 ms, settled by ~300 ms
const SLIDE = { type: "spring", stiffness: 400, damping: 40, mass: 1 } as const;
// the stylesheet's own `--dur-quick` on `--ease-std`, for a motion value that
// has to move in step with a CSS transition standing beside it. The token's
// numbers, restated in seconds because this is the one file allowed to hold
// them (DESIGN rule 6): a component that typed 0.12 would be a dialect
const QUICK = { duration: 0.12, ease: [0.2, 0, 0, 1] as const } as const;

export const spring = {
  /** palette / fn-search / modals entering */
  get pop() {
    return reduced ? INSTANT : POP;
  },
  /** small UI bits (menus, chips) */
  get snappy() {
    return reduced ? INSTANT : SNAPPY;
  },
  /** long-travel rotations (⇧⌘R glyph revolution) */
  get turn() {
    return reduced ? INSTANT : TURN;
  },
  /** shared-layout morphs: an element travelling to become another (the Ask
   * suggestion chip → question echo, AGENT-UX section 6); PANEL-class so the
   * travel settles instead of snapping */
  get layout() {
    return reduced ? INSTANT : PANEL;
  },
  /** the side pane's mode swap, both directions (App.tsx); reduced motion
   * drops the travel and the swap is a crossfade at the instant variant */
  get slide() {
    return reduced ? INSTANT : SLIDE;
  },
  /** the way OUT of a fold: the drawing's armed tool leaving its rest slot,
   * a family member leaving the slot it was folded under (canvas/ToolIsland).
   * ζ = 24 / (2·√360) = .63, so the travel carries a whisper of overshoot,
   * always into room the body has already made; the way home rides `snappy`
   * and never crosses the island's own edge. The rail avatars' own spring,
   * exposed by name so the island types no number of its own */
  get rail() {
    return reduced ? INSTANT : RAIL;
  },
  /** `--dur-quick` / `--ease-std` as a motion transition: siblings fading in a
   * fold while a hairline beside them fades on the stylesheet's clock */
  get quick() {
    return reduced ? INSTANT : QUICK;
  },
};

/** the mode swap's off-stage pose: Ask sits left of the Inspector (the
 * titlebar order), so Ask leaves and returns on the left, the Inspector on
 * the right. Reduced motion travels nothing (crossfade only) */
export const slideOffset = (side: "left" | "right"): number =>
  reduced ? 0 : side === "left" ? -32 : 32;

export const popIn = {
  get initial() {
    return reduced ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.96, y: -8 };
  },
  animate: { opacity: 1, scale: 1, y: 0 },
  get transition() {
    return reduced ? INSTANT : POP;
  },
};

export const menuIn = {
  get initial() {
    return reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.97 };
  },
  animate: { opacity: 1, scale: 1 },
  get transition() {
    return reduced ? INSTANT : SNAPPY;
  },
};

/** floating panels/cards settling in: gentle, Linear/Arc-ish */
export const panelIn = {
  get initial() {
    return reduced ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 10, scale: 0.985 };
  },
  animate: { opacity: 1, y: 0, scale: 1 },
  get transition() {
    return reduced ? INSTANT : PANEL;
  },
};

/** connection-rail avatars popping in */
export const railItemIn = {
  get initial() {
    return reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 };
  },
  animate: { opacity: 1, scale: 1 },
  get transition() {
    return reduced ? INSTANT : RAIL;
  },
};

/** inspector drawer: spring in from the right, crisp tween out */
export const drawerIn = {
  get initial() {
    return reduced ? { opacity: 1, x: 0 } : { opacity: 0, x: 36 };
  },
  get animate() {
    return reduced
      ? { opacity: 1, x: 0, transition: INSTANT }
      : { opacity: 1, x: 0, transition: DRAWER };
  },
  get exit() {
    return reduced
      ? { opacity: 0, x: 36, transition: INSTANT }
      : { opacity: 0, x: 36, transition: { duration: 0.15, ease: [0.4, 0, 1, 1] as const } };
  },
};

/** quick crossfade for swapping content (breadcrumb, results) */
export const swapIn = {
  get initial() {
    return reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 };
  },
  animate: { opacity: 1, y: 0 },
  get transition() {
    return reduced ? INSTANT : SWAP;
  },
};
