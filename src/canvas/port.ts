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
// this file holds the references. There are two: the Ask door below, and the
// refresh seam at the end of the file. It is a store rather than a module
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
import type { ImagePart } from "../agent/providers/types";

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
  /** C2b: the palette's `New Drawing`, the same route for the third kind. The
   * canvas's other door to a sheet is a press on the page, so the keyboard
   * has one too (DESIGN rule 8's reveal clause) */
  newDrawing: () => void;
  /** F2: the palette's `New Chart…`, the keyboard route to the dialog the `+`
   * menu's own `Chart…` row opens. The ellipsis is WRITING rule 2's contract:
   * unlike `New Note` and `New Drawing` it places nothing until the picks are
   * made (AGENT-UX §16ii) */
  newChart: () => void;
  /** B3: the one canvas a QUESTION can cause. A question carrying the word
   * "canvas" on a connection with no canvas tab gets one, its tab opening
   * beside the user's WITHOUT focus; the caller prefixes the question's pill
   * and cues `New canvas`. The model creates nothing: it has no tool for a
   * canvas and no id to name one (canvas-agent-spec 1.1, 3.2) */
  newCanvasFor: (profileId: string) => { canvasId: string; title: string };
  /** B3: forget every block these exchanges wrote, one document write per
   * canvas that changed. The cut's own act, so the pane's store can drop the
   * blocks of the exchanges it is dropping without importing the document
   * (a null port means nothing was ever written and nothing can be lost) */
  removeByExchange: (exchangeIds: readonly string[]) => void;
  /** E5b: the exchange whose `canvas_create` MINTED this canvas has been
   * cut. The canvas stands when it holds at least one block, because the
   * work on it is the user's and its title is theirs too; it goes, tab and
   * all, when the cut left it empty, rather than standing as a tab no
   * exchange made (AGENT-SPEC §9's Open (D1), closed). Called AFTER
   * `removeByExchange`, so "empty" counts what the cut actually left */
  dropIfEmpty: (canvasId: string) => void;
  /** B3: this exchange is about to be asked again, so its FIRST canvas write
   * clears what its previous attempt wrote. Marked rather than deleted: an
   * attempt that fails, is refused or is cancelled before writing anything
   * leaves the blocks that stand exactly where they are (spec 2.4 rule 2) */
  clearOnNextWrite: (exchangeId: string) => void;
  /** C2b: one drawing's picture, rendered from the document AS IT STANDS.
   * The pane asks for it at the moment a question is SENT and `canvas_read`
   * renders it at the moment the model calls: one renderer, read twice, so a
   * stroke drawn between a press and a send can never leave the two doors
   * handing out two different pictures of one sheet (LESSONS 13). Null for a
   * block that is not a drawing and for a sheet nobody has written on */
  drawingImage: (canvasId: string, blockId: string) => Promise<ImagePart | null>;
  /** B3: the exchange's assumption labels, once its verdict has parsed them,
   * onto the FIRST result block it wrote. They belong to the exchange, so
   * they stand in one slot and not under every block it wrote (DESIGN rule
   * 14); an empty list clears the fragment a re-run's own answer dropped */
  assumeOn: (exchangeId: string, labels: readonly string[]) => void;
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

// ---- the refresh seam (E2 R3, R4) -----------------------------------------
//
// Which widgets a document can refetch and what re-running one MEANS: its
// session, its row cap, where the rows land. `stores/refresh.ts` owns only
// when each one starts, so the document hands it this and keeps the rest.
//
// It is registered on this leaf rather than into the refresh store directly
// because canvas.ts used to reach that store through `import("./refresh")` as
// it evaluated, the one module-eval reach into it anywhere in the app: a file
// that imported the canvas store and then the refresh store got the refresh
// namespace half-built (`Cannot access useRefresh before initialization`,
// order-dependent on a warm run, E4's own open item). The seam is the piece
// the two modules share, so it sits where they both import it and neither is
// ever in flight when the other asks. A plain variable, not a store: only
// `refreshCanvas` reads it and no surface re-renders on it.

/** What a canvas document offers the refresh store. Implemented once, by
 * `src/stores/canvas.ts`, and registered from its module scope. */
export interface CanvasRefresh {
  /** the result widgets that WILL refetch, in document order. Answers
   * synchronously, because every skeleton goes up in the gesture's own frame
   * and may only cycle what is actually going out (E3 rule 1) */
  blocks: (canvasId: string) => string[];
  refetch: (canvasId: string, blockId: string) => Promise<unknown>;
}

let seam: CanvasRefresh | null = null;

/** the canvas store's own registration, at its module scope */
export function setCanvasRefresh(next: CanvasRefresh): void {
  seam = next;
}

/** null only until something has imported the canvas store; a gesture that
 * lands there first loads it and asks again, rather than silently refetching
 * no widget at all (LESSONS 9) */
export function canvasRefresh(): CanvasRefresh | null {
  return seam;
}
