// Centralized keyboard handling for overlays. One capture-phase window listener
// (installed on import, so it registers before any component's own capture
// listener) routes keys to the TOPMOST registered overlay only:
//   - Escape always closes the topmost overlay (preventDefault + stop).
//   - Any other key is offered to the topmost overlay's optional `onKey`, which
//     is responsible for its own preventDefault/stopImmediatePropagation.
// Because only the topmost entry is consulted, two stacked modals can't both act
// on one keystroke (e.g. EditPreview committing while CloseGuard discards).

export type OverlayEntry = {
  onClose: () => void;
  onKey?: (e: KeyboardEvent) => void;
};

const stack: OverlayEntry[] = [];
let installed = false;

/** stacking base for overlay layers; each push gets BASE_Z + its 1-based depth,
 *  so a later overlay always paints above the one it opened over */
const BASE_Z = 50;
let zSeq = 0;

function onKeyDown(e: KeyboardEvent) {
  if (stack.length === 0) return;
  // IME composition owns the keyboard — Esc/Enter there cancel/commit the
  // composition, never the overlay
  if (e.isComposing) return;
  const top = stack[stack.length - 1];
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation(); // beat other capture listeners + bubble handlers
    top.onClose();
    return;
  }
  top.onKey?.(e);
}

function ensureListener() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true); // capture
}

/** Push an overlay; returns its z-index (derived from stack position) and an
 *  unregister fn. The topmost entry is the one that receives Escape (→ onClose)
 *  and any other key (→ onKey). */
export function pushOverlay(entry: OverlayEntry): { z: number; pop: () => void } {
  ensureListener();
  stack.push(entry);
  const z = BASE_Z + ++zSeq;
  return {
    z,
    pop: () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) zSeq = 0;
    },
  };
}

/** true while any overlay is mounted — global shortcut handlers use this to
 *  stand down (⌘W through an open modal was silently closing tabs) */
export function overlayOpen(): boolean {
  return stack.length > 0;
}

ensureListener();
