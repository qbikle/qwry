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
const PANEL = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;
const RAIL = { type: "spring", stiffness: 600, damping: 24, mass: 0.6 } as const;
const DRAWER = { type: "spring", stiffness: 520, damping: 40, mass: 0.8 } as const;
const SWAP = { type: "spring", stiffness: 700, damping: 40, mass: 0.5 } as const;

export const spring = {
  /** palette / fn-search / modals entering */
  get pop() {
    return reduced ? INSTANT : POP;
  },
  /** small UI bits (menus, chips) */
  get snappy() {
    return reduced ? INSTANT : SNAPPY;
  },
};

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
