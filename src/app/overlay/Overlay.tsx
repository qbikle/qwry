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
 *  only while topmost, so stacked overlays never both act on one keystroke. */
export function useOverlayLayer(
  onClose: () => void,
  onKey?: (e: KeyboardEvent) => void,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(
    () =>
      pushOverlay({
        onClose: () => closeRef.current(),
        onKey: (e) => keyRef.current?.(e),
      }),
    [],
  );
}

/** Centered modal: dimmed backdrop, outside-click + Esc to close, portaled to
 *  <body>. Pass `backdropClassName` to keep an existing backdrop's styling. */
export function Modal({
  onClose,
  onKey,
  backdropClassName,
  dismissable = true,
  children,
}: {
  onClose: () => void;
  /** extra keys handled only while this modal is the topmost overlay (e.g. Enter
   *  to confirm) — handler owns its preventDefault/stopImmediatePropagation */
  onKey?: (e: KeyboardEvent) => void;
  backdropClassName?: string;
  dismissable?: boolean;
  children: ReactNode;
}) {
  useOverlayLayer(onClose, onKey);
  return createPortal(
    <div
      className={backdropClassName ?? "ov-backdrop"}
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
    setPos({ left, top });
    // ref is stable; point identity intentionally excluded (x/y are the inputs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point.x, point.y, margin]);
  return pos;
}

/** Popup anchored at a viewport point (e.g. a right-click), clamped to the
 *  viewport with edge-flip. The positioned wrapper owns left/top — content must
 *  not set its own position. `onKey` (topmost-only) drives keyboard nav. */
export function AnchoredOverlay({
  point,
  onClose,
  onKey,
  layerClassName,
  margin = 8,
  children,
}: {
  point: { x: number; y: number };
  onClose: () => void;
  onKey?: (e: KeyboardEvent) => void;
  layerClassName?: string;
  margin?: number;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useOverlayLayer(onClose, onKey);
  const pos = useClampedPosition(wrapRef, point, margin);

  return createPortal(
    <div
      className={layerClassName ?? "ov-anchor-layer"}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={wrapRef}
        className="ov-anchor-pos"
        style={{
          position: "fixed",
          left: pos?.left ?? point.x,
          top: pos?.top ?? point.y,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
