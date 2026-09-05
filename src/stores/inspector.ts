import { create } from "zustand";
import { useSidePane, type SidePaneState } from "./sidePane";

export interface InspectTarget {
  stmtIndex: number;
  row: number;
  col: number;
}

interface InspectorState {
  /** mirror: the side pane is open AND showing the inspector. Read-only
   * here; the pane (src/stores/sidePane.ts) is the truth */
  open: boolean;
  /** mirror of the pane width (the narrow mode reads it) */
  width: number;
  target: InspectTarget | null;
  /** full value fetched on demand for truncated cells */
  fullValue: string | null;
  fullValueFor: string | null;
  /** why the full-value fetch failed (shown instead of a silent forever-spin) */
  fullValueError: string | null;

  /** bumped when a cell asks the inspector to start editing (e.g. JSON dbl-click) */
  editSeq: number;

  /** the pane's inspector radio: open here, switch here, or close when showing */
  toggle: () => void;
  setTarget: (t: InspectTarget | null) => void;
  setFullValue: (key: string, v: string | null) => void;
  setFullValueError: (msg: string) => void;
  /** open the inspector on a cell and request edit mode */
  requestEdit: (t: InspectTarget) => void;
}

const mirror = (p: SidePaneState) => ({ open: p.open && p.mode === "inspector", width: p.width });

export const useInspector = create<InspectorState>()((set) => ({
  ...mirror(useSidePane.getState()),
  target: null,
  fullValue: null,
  fullValueFor: null,
  fullValueError: null,
  editSeq: 0,

  toggle: () => useSidePane.getState().toggle("inspector"),
  setTarget: (t) =>
    set({ target: t, fullValue: null, fullValueFor: null, fullValueError: null }),
  setFullValue: (key, v) =>
    set({ fullValue: v, fullValueFor: key, fullValueError: null }),
  setFullValueError: (msg) => set({ fullValueError: msg }),
  requestEdit: (t) => {
    useSidePane.getState().show("inspector");
    set((s) => ({
      target: t,
      fullValue: null,
      fullValueFor: null,
      fullValueError: null,
      editSeq: s.editSeq + 1,
    }));
  },
}));

useSidePane.subscribe((p) => {
  const m = mirror(p);
  const cur = useInspector.getState();
  if (cur.open !== m.open || cur.width !== m.width) useInspector.setState(m);
});


// the target indexes INTO the active result set. When that set is replaced
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
