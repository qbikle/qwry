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
  /** element that held focus when the overlay opened — focus returns to it on
   *  close (captured at render time, BEFORE any autoFocus inside the overlay) */
  restoreFocus?: Element | null;
};

const stack: OverlayEntry[] = [];
let installed = false;
/** bumped on every push — a pending focus-restore aborts if a newer overlay
 *  opened in the meantime (it owns focus and carries its own restore point) */
let pushSeq = 0;

/** Put focus back where it was when the overlay opened. A gone/unfocusable
 *  opener falls back to the main surface (editor, then the main card) — focus
 *  must never be left stranded on <body>. */
function restoreFocusTo(el: Element | null | undefined) {
  const target = el instanceof HTMLElement && el.isConnected ? el : null;
  if (target) {
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
  const fallback =
    document.querySelector<HTMLElement>(".main-card .cm-content") ??
    document.querySelector<HTMLElement>(".main-card");
  fallback?.focus({ preventScroll: true });
}

/** stacking base for overlay layers; each push gets BASE_Z + its 1-based depth,
 *  so a later overlay always paints above the one it opened over */
const BASE_Z = 50;
/** ceiling for dynamic overlay z — fixed chrome (prod strip, z 60) must stay
 *  on top; ties between clamped layers fall back to DOM order */
export const MAX_OVERLAY_Z = 59;
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
  pushSeq++;
  const z = Math.min(BASE_Z + ++zSeq, MAX_OVERLAY_Z);
  return {
    z,
    pop: () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) zSeq = 0;
      // Restore focus AFTER React finishes removing the overlay's DOM (focus
      // lands on <body> then). Deferred a microtask so a close that
      // immediately opens another overlay (Settings → Theme…, StrictMode
      // re-mount) skips the restore — the newer overlay owns focus. An action
      // that deliberately focused something else on close also wins.
      const seqAtPop = pushSeq;
      queueMicrotask(() => {
        if (pushSeq !== seqAtPop) return;
        const ae = document.activeElement;
        if (ae && ae !== document.body && ae !== document.documentElement) return;
        restoreFocusTo(entry.restoreFocus);
      });
    },
  };
}

/** true while any overlay is mounted — global shortcut handlers use this to
 *  stand down (⌘W through an open modal was silently closing tabs) */
export function overlayOpen(): boolean {
  return stack.length > 0;
}

ensureListener();
