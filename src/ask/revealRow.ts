// Scrolls ONE list so a row inside it is in view, and scrolls nothing else.
// `scrollIntoView` walks every scroll container up the tree, and the pane
// (`.ask-panel`, overflow hidden) is one: a slide-over still at
// translateX(100%) when its reveal effect runs (the transition has not
// advanced, even under reduced motion's 0.01ms) extends the pane's
// scrollable overflow sideways, and revealing a row of it scrolled the whole
// pane 310px left, header and composer included (LESSONS 7: one scroll
// authority per gesture). Vertical only, instant, never animated.

export function revealRow(list: HTMLElement | null, row: HTMLElement | null): void {
  if (!list || !row) return;
  const l = list.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < l.top) list.scrollTop -= l.top - r.top;
  else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
}
