// The only place spring parameters live. Springs on transitions — never on
// scroll, typing, or completion popups (those must be instant).

export const spring = {
  /** palette / fn-search / modals entering */
  pop: { type: "spring", stiffness: 520, damping: 32, mass: 0.8 } as const,
  /** small UI bits (menus, chips) */
  snappy: { type: "spring", stiffness: 700, damping: 38, mass: 0.6 } as const,
};

export const popIn = {
  initial: { opacity: 0, scale: 0.96, y: -8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  transition: spring.pop,
};

export const menuIn = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  transition: spring.snappy,
};

/** floating panels/cards settling in — gentle, Linear/Arc-ish */
export const panelIn = {
  initial: { opacity: 0, y: 10, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const,
};

/** connection-rail avatars popping in */
export const railItemIn = {
  initial: { opacity: 0, scale: 0.4 },
  animate: { opacity: 1, scale: 1 },
  transition: { type: "spring", stiffness: 600, damping: 24, mass: 0.6 } as const,
};
