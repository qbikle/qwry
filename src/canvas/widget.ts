// The widget a FACE is standing in (D2 items 4 and 5).
//
// A face sometimes has to act on the CELLS it was given: `+ 4 more` resizes the
// widget it is drawn in, the compared connection's `×` clears the comparison
// the widget holds. Between the face and the page stands the pane's own
// `ResultBlock`, which knows nothing about cells and carries a prop for
// neither, so the slot hands its identity down instead of threading callbacks
// through a surface that has no use for them. `null` in the pane, where a face
// stands on no cells and neither action exists.
//
// Its own module, and a small one, so the two faces can read it without
// pulling the grid (and through it the document store, and through that the
// settings and the DOM) into their module graphs: `Chart.tsx` is measured by a
// test with no document in it, and a context is the one thing here that both
// halves need (LESSONS 1: the pair is born together).

import { createContext } from "react";

export interface WidgetRef {
  canvasId: string;
  blockId: string;
  /** the count the page stands at, read at the moment it is used: a window
   * drag between the press and the act must not commit a stale layout */
  columns: () => number;
}

export const Widget = createContext<WidgetRef | null>(null);
