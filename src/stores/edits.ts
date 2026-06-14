import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { EditabilityMap, RowEdit } from "../ipc/types";
import { useResults } from "./results";

export interface PendingEdit {
  stmtIndex: number;
  row: number;
  col: number;
  /** new value; null = SQL NULL */
  value: string | null;
  /** original cell value for revert/display */
  original: string | null;
}

const keyOf = (stmtIndex: number, row: number, col: number) =>
  `${stmtIndex}:${row}:${col}`;

/** one tab's edit state */
interface TabEdits {
  maps: Record<number, EditabilityMap | "loading" | "unavailable">;
  pending: Record<string, PendingEdit>;
  flash: Set<string>;
}
const blankEdits = (): TabEdits => ({ maps: {}, pending: {}, flash: new Set() });

// like results: top-level mirrors the active tab, byTab is the source of truth.
// committing / preview / lastError are global (one commit/preview at a time).
interface EditsState extends TabEdits {
  byTab: Record<string, TabEdits>;
  active: string;
  committing: boolean;
  preview: { statements: string[]; error: string | null } | null;
  lastError: string | null;

  syncActive: (tabId: string) => void;
  resetTab: (tabId: string) => void;
  ensureMap: (stmtIndex: number) => void;
  setEdit: (e: PendingEdit) => void;
  clearEdit: (stmtIndex: number, row: number, col: number) => void;
  discardAll: () => void;
  openPreview: () => Promise<void>;
  closePreview: () => void;
  commit: () => Promise<void>;
}

function sessionAndSql(): { sessionId: string; sql: string } | null {
  const res = useResults.getState();
  const sessionId = res.executedSessionId;
  if (!sessionId || !res.executedSql) return null;
  return { sessionId, sql: res.executedSql };
}

/** group pending edits into RowEdit payloads for one statement (active tab) */
function buildRowEdits(pending: PendingEdit[], map: EditabilityMap, stmtIndex: number): RowEdit[] {
  const stmt = useResults.getState().statements.find((s) => s.index === stmtIndex);
  if (!stmt) return [];
  const out: RowEdit[] = [];
  for (const e of pending) {
    const colMeta = map.columns[e.col];
    if (!colMeta?.editable) continue;
    const pkColIdxs = map.pk_cols[colMeta.table_oid] ?? [];
    const pk: [number, string | null][] = pkColIdxs.map((pc) => [pc, stmt.rows[e.row]?.[pc] ?? null]);
    out.push({ table_oid: colMeta.table_oid, col: e.col, value: e.value, pk });
  }
  return out;
}

type SetFn = (fn: (s: EditsState) => Partial<EditsState>) => void;

function writeEdits(set: SetFn, tabId: string, partial: Partial<TabEdits> | ((t: TabEdits) => Partial<TabEdits>)) {
  set((s) => {
    const cur = s.byTab[tabId] ?? blankEdits();
    const p = typeof partial === "function" ? partial(cur) : partial;
    const next = { ...cur, ...p };
    const byTab = { ...s.byTab, [tabId]: next };
    return tabId === s.active ? { byTab, ...next } : { byTab };
  });
}

export const useEdits = create<EditsState>((set, get) => ({
  ...blankEdits(),
  byTab: {},
  active: "",
  committing: false,
  preview: null,
  lastError: null,

  syncActive: (tabId) => set((s) => ({ active: tabId, ...(s.byTab[tabId] ?? blankEdits()) })),

  resetTab: (tabId) => {
    writeEdits(set, tabId, blankEdits());
    if (tabId === get().active) set({ preview: null, lastError: null });
  },

  ensureMap: (stmtIndex) => {
    const tabId = get().active;
    if ((get().byTab[tabId] ?? blankEdits()).maps[stmtIndex]) return;
    const ctx = sessionAndSql();
    if (!ctx) return;
    writeEdits(set, tabId, (t) => ({ maps: { ...t.maps, [stmtIndex]: "loading" } }));
    ipc
      .editability(ctx.sessionId, ctx.sql, stmtIndex)
      .then((map) => writeEdits(set, tabId, (t) => ({ maps: { ...t.maps, [stmtIndex]: map } })))
      .catch(() =>
        writeEdits(set, tabId, (t) => ({ maps: { ...t.maps, [stmtIndex]: "unavailable" } })),
      );
  },

  setEdit: (e) => {
    const tabId = get().active;
    const k = keyOf(e.stmtIndex, e.row, e.col);
    if (e.value === e.original) {
      writeEdits(set, tabId, (t) => {
        const { [k]: _, ...rest } = t.pending;
        return { pending: rest };
      });
      return;
    }
    writeEdits(set, tabId, (t) => ({ pending: { ...t.pending, [k]: e } }));
  },

  clearEdit: (stmtIndex, row, col) => {
    const tabId = get().active;
    writeEdits(set, tabId, (t) => {
      const { [keyOf(stmtIndex, row, col)]: _, ...rest } = t.pending;
      return { pending: rest };
    });
  },

  discardAll: () => {
    writeEdits(set, get().active, { pending: {} });
    set({ preview: null, lastError: null });
  },

  openPreview: async () => {
    const ctx = sessionAndSql();
    const tab = get().byTab[get().active] ?? blankEdits();
    const edits = Object.values(tab.pending);
    if (!ctx || edits.length === 0) return;
    const byStmt = new Map<number, PendingEdit[]>();
    for (const e of edits) {
      const arr = byStmt.get(e.stmtIndex) ?? [];
      arr.push(e);
      byStmt.set(e.stmtIndex, arr);
    }
    try {
      const all: string[] = [];
      for (const [stmtIndex, stmtEdits] of byStmt) {
        const map = tab.maps[stmtIndex];
        if (!map || map === "loading" || map === "unavailable") continue;
        const rowEdits = buildRowEdits(stmtEdits, map, stmtIndex);
        const sqls = await ipc.editsPreview(ctx.sessionId, ctx.sql, stmtIndex, rowEdits);
        all.push(...sqls);
      }
      set({ preview: { statements: all, error: null } });
    } catch (e) {
      set({ preview: { statements: [], error: (e as { message?: string }).message ?? String(e) } });
    }
  },

  closePreview: () => set({ preview: null }),

  commit: async () => {
    const ctx = sessionAndSql();
    const tabId = get().active;
    const tab = get().byTab[tabId] ?? blankEdits();
    const edits = Object.values(tab.pending);
    if (!ctx || edits.length === 0 || get().committing) return;
    set({ committing: true, lastError: null });

    const byStmt = new Map<number, PendingEdit[]>();
    for (const e of edits) {
      const arr = byStmt.get(e.stmtIndex) ?? [];
      arr.push(e);
      byStmt.set(e.stmtIndex, arr);
    }

    try {
      for (const [stmtIndex, stmtEdits] of byStmt) {
        const map = tab.maps[stmtIndex];
        if (!map || map === "loading" || map === "unavailable") continue;
        const rowEdits = buildRowEdits(stmtEdits, map, stmtIndex);
        const outcome = await ipc.editsApply(ctx.sessionId, ctx.sql, stmtIndex, rowEdits);
        if (outcome.committed) {
          useResults.getState().patchStatement(stmtIndex, (rows) => {
            const copy = rows.map((r) => [...r]);
            stmtEdits.forEach((e, i) => {
              const res = outcome.results[i];
              if (res?.ok) copy[e.row][e.col] = res.new_value;
            });
            return copy;
          });
          const failed = outcome.results.filter((r) => !r.ok);
          if (failed.length > 0) set({ lastError: failed.map((f) => f.message).join("; ") });
          writeEdits(set, tabId, (t) => {
            const flash = new Set(t.flash);
            stmtEdits.forEach((e, i) => {
              if (outcome.results[i]?.ok) flash.add(keyOf(e.stmtIndex, e.row, e.col));
            });
            return { flash };
          });
          setTimeout(() => writeEdits(set, tabId, { flash: new Set() }), 900);
        }
      }
      writeEdits(set, tabId, { pending: {} });
      set({ preview: null, committing: false });
    } catch (e) {
      set({ committing: false, lastError: (e as { message?: string }).message ?? String(e) });
    }
  },
}));

export const editKey = keyOf;

// follow the active tab (results owns the canonical active tab id)
if (useResults.getState().active) useEdits.getState().syncActive(useResults.getState().active);
useResults.subscribe((s, p) => {
  if (s.active !== p.active) useEdits.getState().syncActive(s.active);
});
