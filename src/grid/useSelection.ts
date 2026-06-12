import { useCallback, useRef, useState } from "react";

export interface CellPos {
  r: number;
  c: number;
}

export interface SelRect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export type DragMode = "cell" | "row" | "col";

export function rectOf(anchor: CellPos, focus: CellPos): SelRect {
  return {
    r0: Math.min(anchor.r, focus.r),
    c0: Math.min(anchor.c, focus.c),
    r1: Math.max(anchor.r, focus.r),
    c1: Math.max(anchor.c, focus.c),
  };
}

export function useSelection(rowCount: number, colCount: number) {
  const [anchor, setAnchor] = useState<CellPos | null>(null);
  const [focus, setFocus] = useState<CellPos | null>(null);
  const dragging = useRef<DragMode | null>(null);

  const clamp = useCallback(
    (p: CellPos): CellPos => ({
      r: Math.max(0, Math.min(rowCount - 1, p.r)),
      c: Math.max(0, Math.min(colCount - 1, p.c)),
    }),
    [rowCount, colCount],
  );

  /** For row mode the rect always spans all columns; for col mode all rows. */
  const posFor = useCallback(
    (p: CellPos, mode: DragMode, end: "anchor" | "focus"): CellPos => {
      const q = clamp(p);
      if (mode === "row") return { r: q.r, c: end === "anchor" ? 0 : colCount - 1 };
      if (mode === "col") return { r: end === "anchor" ? 0 : rowCount - 1, c: q.c };
      return q;
    },
    [clamp, rowCount, colCount],
  );

  const startDrag = useCallback(
    (p: CellPos, extend: boolean, mode: DragMode = "cell") => {
      dragging.current = mode;
      if (extend && anchor) {
        setFocus(posFor(p, mode, "focus"));
      } else {
        setAnchor(posFor(p, mode, "anchor"));
        setFocus(posFor(p, mode, "focus"));
      }
    },
    [anchor, posFor],
  );

  const dragOver = useCallback(
    (p: CellPos) => {
      const mode = dragging.current;
      if (!mode) return;
      // keep the anchor's full-span edge; move focus along the drag axis
      if (mode === "row") setFocus({ r: clamp(p).r, c: colCount - 1 });
      else if (mode === "col") setFocus({ r: rowCount - 1, c: clamp(p).c });
      else setFocus(clamp(p));
    },
    [clamp, rowCount, colCount],
  );

  const endDrag = useCallback(() => {
    dragging.current = null;
  }, []);

  const moveFocus = useCallback(
    (dr: number, dc: number, extend: boolean) => {
      const base = focus ?? { r: 0, c: 0 };
      const next = clamp({ r: base.r + dr, c: base.c + dc });
      setFocus(next);
      if (!extend) setAnchor(next);
      return next;
    },
    [focus, clamp],
  );

  const selectAll = useCallback(() => {
    if (rowCount === 0 || colCount === 0) return;
    setAnchor({ r: 0, c: 0 });
    setFocus({ r: rowCount - 1, c: colCount - 1 });
  }, [rowCount, colCount]);

  const rect = anchor && focus ? rectOf(anchor, focus) : null;

  return { rect, focus, startDrag, dragOver, endDrag, moveFocus, selectAll };
}
