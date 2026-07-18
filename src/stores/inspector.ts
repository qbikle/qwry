import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface InspectTarget {
  stmtIndex: number;
  row: number;
  col: number;
}

interface InspectorState {
  open: boolean;
  width: number;
  target: InspectTarget | null;
  /** full value fetched on demand for truncated cells */
  fullValue: string | null;
  fullValueFor: string | null;
  /** why the full-value fetch failed (shown instead of a silent forever-spin) */
  fullValueError: string | null;

  /** bumped when a cell asks the inspector to start editing (e.g. JSON dbl-click) */
  editSeq: number;

  toggle: () => void;
  setWidth: (w: number) => void;
  setTarget: (t: InspectTarget | null) => void;
  setFullValue: (key: string, v: string | null) => void;
  setFullValueError: (msg: string) => void;
  /** open the inspector on a cell and request edit mode */
  requestEdit: (t: InspectTarget) => void;
}

export const useInspector = create<InspectorState>()(
  persist(
    (set) => ({
      open: true,
      width: 300,
      target: null,
      fullValue: null,
      fullValueFor: null,
      fullValueError: null,
      editSeq: 0,

      toggle: () => set((s) => ({ open: !s.open })),
      setWidth: (w) => set({ width: Math.max(220, Math.min(640, w)) }),
      setTarget: (t) =>
        set({ target: t, fullValue: null, fullValueFor: null, fullValueError: null }),
      setFullValue: (key, v) =>
        set({ fullValue: v, fullValueFor: key, fullValueError: null }),
      setFullValueError: (msg) => set({ fullValueError: msg }),
      requestEdit: (t) =>
        set((s) => ({
          open: true,
          target: t,
          fullValue: null,
          fullValueFor: null,
          fullValueError: null,
          editSeq: s.editSeq + 1,
        })),
    }),
    {
      name: "qwry.inspector",
      partialize: (s) => ({ open: s.open, width: s.width }),
    },
  ),
);


// the target indexes INTO the active result set — when that set is replaced
// or cleared (tab closed, new run, tab switch), stale coordinates would show
// another dataset's value. Drop the target the moment it stops resolving.
void import("./results").then(({ useResults }) => {
  useResults.subscribe((s) => {
    const t = useInspector.getState().target;
    if (!t) return;
    const stmt = s.statements.find((st) => st.index === t.stmtIndex);
    if (!stmt || t.row >= stmt.rows.length || t.col >= stmt.columns.length) {
      useInspector.getState().setTarget(null);
    }
  });
});
