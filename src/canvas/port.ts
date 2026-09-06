// The one door from Ask into the canvas (A3 items 3 and 6). The Ask pane must
// be able to say "put this exchange on the canvas" and the palette "start a
// canvas" without either of them importing the canvas document store: the
// pane is the conversation and the canvas is the document, and a hard import
// each way is how two surfaces become one knot. It also keeps the canvas out
// of the pane's own bundle until something actually asks for it, which is the
// app's existing shape for a store one surface uses and another does not
// (Palette's `import("../stores/heal")`).
//
// So `src/stores/canvas.ts` REGISTERS itself here at its module scope and
// this file holds the one reference. It is a store rather than a module
// variable so a surface that wants to READ whether the door exists can
// re-render when it opens; `loadCanvasPort` is for the surfaces that only
// want to walk through it, and loads the store on the way.
//
// The contract is deliberately one line wide. `addExchange` takes an exchange
// ID and nothing else, because everything a result block shows (the question,
// the prose, the SQL, the rows, the assumptions, the timing) is already on
// that exchange in useAgent, and a second copy of it passed through here
// would be the same facts in two shapes (DESIGN rule 14). It answers with
// what the cue needs to say and nothing more.

import { create } from "zustand";

/** What an add reports back: exactly what the cue must say (LESSONS 9, a
 * silent action is one the user has to go and check). */
export interface CanvasLanding {
  /** something landed. False when there was nothing to add at all */
  ok: boolean;
  /** the connection had no canvas and one was made for this block:
   * `Added to a new canvas` rather than `Added to Canvas` */
  created: boolean;
  /** why nothing landed, in the status register; the cue says it verbatim */
  message?: string;
}

/** What the canvas document store offers the Ask side. Implemented once, by
 * `src/stores/canvas.ts`, and registered from its module scope. */
export interface CanvasPort {
  /** Add to Canvas: append the exchange as a block (a result block, or a note
   * when the answer ran nothing and is prose alone) to the connection's
   * current canvas, creating one when there is none, and landing a reply
   * under the block it was asked from. Never switches tabs: the answer is
   * added while the reader keeps reading */
  addExchange: (exchangeId: string) => CanvasLanding;
  /** the palette's `New Canvas`, which does go there */
  newCanvas: () => void;
  /** the palette's `New Note`: the keyboard route onto an empty canvas, whose
   * only other door is a click on the card (A3 item 6, DESIGN rule 8) */
  newNote: () => void;
}

interface CanvasPortState {
  port: CanvasPort | null;
}

export const useCanvasPort = create<CanvasPortState>()(() => ({ port: null }));

/** the canvas store's own registration, at its module scope */
export function setCanvasPort(port: CanvasPort | null): void {
  useCanvasPort.setState({ port });
}

/** the port outside a component, loading the canvas store if this is the
 * first thing to want it. Null is a broken build, never a user state: the
 * caller does nothing rather than cue a sentence that cannot be true */
export async function loadCanvasPort(): Promise<CanvasPort | null> {
  const held = useCanvasPort.getState().port;
  if (held) return held;
  await import("../stores/canvas");
  return useCanvasPort.getState().port;
}
