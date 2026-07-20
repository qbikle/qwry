// Shared overlay primitive — one owner of: portal-to-<body> (escapes the
// floating-card transforms/overflow that break position:fixed), centralized
// topmost-Esc (escStack), outside-click, and viewport clamping. Every popup
// goes through this; call sites keep their own backdrop class + animated
// content (so visuals/springs are unchanged).
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { pushOverlay } from "./escStack";
import "./overlay.css";

/** Register this overlay as a layer while mounted: Escape closes it (when it is
 *  the topmost overlay), and an optional `onKey` receives any other key — but
 *  only while topmost, so stacked overlays never both act on one keystroke.
 *  Returns the layer's z-index (from stack position, so a modal opened over the
 *  palette always paints above it); null until registered. */
export function useOverlayLayer(
  onClose: () => void,
  onKey?: (e: KeyboardEvent) => void,
): number | null {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  // capture the opener at FIRST RENDER — by effect time an autoFocus inside
  // the overlay may already have stolen focus, and restore would then target
  // the overlay's own (soon-removed) input instead of what opened it
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement;
  const [z, setZ] = useState<number | null>(null);
  useEffect(() => {
    const { z, pop } = pushOverlay({
      onClose: () => closeRef.current(),
      onKey: (e) => keyRef.current?.(e),
      restoreFocus: opener.current ?? null,
    });
    setZ(z);
    return pop;
  }, []);
  return z;
}

/** conservative "can receive Tab focus" selector — the backdrop's own
 *  tabindex=-1 focus sink is deliberately excluded */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Tab/⇧Tab cycle inside the topmost modal only (escStack routes keys to the
 *  top layer, so a stacked modal can never leak Tab into the surface — or the
 *  modal — beneath it). Focus outside the modal enters at the first/last
 *  focusable instead of walking the hidden background. */
function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const els = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
  if (els.length === 0) return;
  const cur = document.activeElement as HTMLElement | null;
  const idx = cur ? els.indexOf(cur) : -1;
  const next =
    idx === -1
      ? e.shiftKey
        ? els.length - 1
        : 0
      : (idx + (e.shiftKey ? -1 : 1) + els.length) % els.length;
  els[next].focus({ preventScroll: true });
}

/** Centered modal: dimmed backdrop, outside-click + Esc to close, portaled to
 *  <body>. Pass `backdropClassName` to keep an existing backdrop's styling. */
export function Modal({
  onClose,
  onKey,
  backdropClassName,
  dismissable = true,
  label,
  children,
}: {
  onClose: () => void;
  /** extra keys handled only while this modal is the topmost overlay (e.g. Enter
   *  to confirm) — handler owns its preventDefault/stopImmediatePropagation.
   *  Tab never reaches it: the modal's focus trap claims it first. */
  onKey?: (e: KeyboardEvent) => void;
  backdropClassName?: string;
  dismissable?: boolean;
  /** accessible dialog name (aria-label) — pass from every consumer */
  label?: string;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const z = useOverlayLayer(onClose, (e) => {
    if (e.key === "Tab") {
      trapTab(e, backdropRef.current);
      return;
    }
    onKey?.(e);
  });
  // a modal owns the keyboard: pull focus off the surface underneath (typing
  // must never leak into the editor behind the dialog) — unless something
  // inside (an autoFocus input) already claimed it
  useEffect(() => {
    const el = backdropRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={backdropClassName ?? "ov-backdrop"}
      style={z != null ? { zIndex: z } : undefined}
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Clamp a box anchored at a viewport point: flips left/up near the right/bottom
 *  edge, then clamps inside the viewport. Measures `offsetWidth/Height` (the
 *  untransformed layout box) so a `motion` entrance scale doesn't undersize it.
 *  Returns null until measured (render hidden until then to avoid a flash). */
export function useClampedPosition(
  ref: RefObject<HTMLElement | null>,
  point: { x: number; y: number },
  margin = 8,
): { left: number; top: number } | null {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = point.x;
      if (left + width + margin > vw) left = point.x - width; // flip left of anchor
      left = Math.min(Math.max(margin, left), Math.max(margin, vw - width - margin));
      let top = point.y;
      if (top + height + margin > vh) top = point.y - height; // flip above anchor
      top = Math.min(Math.max(margin, top), Math.max(margin, vh - height - margin));
      // identity-guard: the ResizeObserver fires on observe — same clamp must
      // not re-render
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    clamp();
    // content that loads after mount (Histogram fetch, FkPicker rows) grows the
    // box past the first measurement — re-clamp on size and viewport changes
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    window.addEventListener("resize", clamp);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", clamp);
    };
    // ref is stable; point identity intentionally excluded (x/y are the inputs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point.x, point.y, margin]);
  return pos;
}

/** Popup anchored at a viewport point (e.g. a right-click), clamped to the
 *  viewport with edge-flip. The positioned wrapper owns left/top — content must
 *  not set its own position. `onKey` (topmost-only) drives keyboard nav.
 *  Function children receive the layer's z — a separately-portaled panel (e.g.
 *  a submenu) must paint above this layer's full-screen click catcher. */
export function AnchoredOverlay({
  point,
  onClose,
  onKey,
  layerClassName,
  margin = 8,
  role,
  label,
  children,
}: {
  point: { x: number; y: number };
  onClose: () => void;
  onKey?: (e: KeyboardEvent) => void;
  layerClassName?: string;
  margin?: number;
  /** ARIA role for the anchored panel (e.g. "menu", "dialog") — popovers are
   *  deliberately NOT focus-trapped; keyboard nav runs through onKey */
  role?: string;
  label?: string;
  children: ReactNode | ((z: number | null) => ReactNode);
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const z = useOverlayLayer(onClose, onKey);
  const pos = useClampedPosition(wrapRef, point, margin);

  return createPortal(
    <div
      className={layerClassName ?? "ov-anchor-layer"}
      style={z != null ? { zIndex: z } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={wrapRef}
        className="ov-anchor-pos"
        role={role}
        aria-label={label}
        style={{
          position: "fixed",
          left: pos?.left ?? point.x,
          top: pos?.top ?? point.y,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {typeof children === "function" ? children(z) : children}
      </div>
    </div>,
    document.body,
  );
}
