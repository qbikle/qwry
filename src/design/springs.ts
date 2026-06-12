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
