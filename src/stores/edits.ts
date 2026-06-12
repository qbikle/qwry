import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { EditabilityMap, RowEdit } from "../ipc/types";
import { useConnections } from "./connections";
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

interface EditsState {
  /** editability per statement index, fetched lazily after a run */
  maps: Record<number, EditabilityMap | "loading" | "unavailable">;
  pending: Record<string, PendingEdit>;
  committing: boolean;
  /** preview modal contents; null = closed */
  preview: { statements: string[]; error: string | null } | null;
  lastError: string | null;

  ensureMap: (stmtIndex: number) => void;
  setEdit: (e: PendingEdit) => void;
  clearEdit: (stmtIndex: number, row: number, col: number) => void;
  discardAll: () => void;
  openPreview: () => Promise<void>;
  closePreview: () => void;
  commit: () => Promise<void>;
  reset: () => void;
}

function sessionAndSql(): { sessionId: string; sql: string } | null {
  const conn = useConnections.getState();
  const res = useResults.getState();
  const sessionId = conn.activeProfileId ? conn.sessions[conn.activeProfileId] : null;
  if (!sessionId || !res.executedSql) return null;
  return { sessionId, sql: res.executedSql };
}

/** group pending edits into RowEdit payloads for one statement */
function buildRowEdits(
  pending: PendingEdit[],
  map: EditabilityMap,
  stmtIndex: number,
): RowEdit[] {
  const res = useResults.getState();
  const stmt = res.statements.find((s) => s.index === stmtIndex);
  if (!stmt) return [];
  const out: RowEdit[] = [];
  for (const e of pending) {
    const colMeta = map.columns[e.col];
    if (!colMeta?.editable) continue;
    const pkColIdxs = map.pk_cols[colMeta.table_oid] ?? [];
    const pk: [number, string | null][] = pkColIdxs.map((pc) => {
      // PK values come from the ORIGINAL row data — never from edited values
      return [pc, stmt.rows[e.row]?.[pc] ?? null];
    });
    out.push({ table_oid: colMeta.table_oid, col: e.col, value: e.value, pk });
  }
  return out;
}

export const useEdits = create<EditsState>((set, get) => ({
  maps: {},
  pending: {},
  committing: false,
  preview: null,
  lastError: null,

  ensureMap: (stmtIndex) => {
    const { maps } = get();
    if (maps[stmtIndex]) return;
    const ctx = sessionAndSql();
    if (!ctx) return;
    set((s) => ({ maps: { ...s.maps, [stmtIndex]: "loading" } }));
    ipc
      .editability(ctx.sessionId, ctx.sql, stmtIndex)
      .then((map) => set((s) => ({ maps: { ...s.maps, [stmtIndex]: map } })))
      .catch(() =>
        set((s) => ({ maps: { ...s.maps, [stmtIndex]: "unavailable" } })),
      );
  },

  setEdit: (e) => {
    const k = keyOf(e.stmtIndex, e.row, e.col);
    if (e.value === e.original) {
      // editing back to original = no edit
      set((s) => {
        const { [k]: _, ...rest } = s.pending;
        return { pending: rest };
      });
      return;
    }
    set((s) => ({ pending: { ...s.pending, [k]: e } }));
  },

  clearEdit: (stmtIndex, row, col) =>
    set((s) => {
      const { [keyOf(stmtIndex, row, col)]: _, ...rest } = s.pending;
      return { pending: rest };
    }),

  discardAll: () => set({ pending: {}, preview: null, lastError: null }),

  openPreview: async () => {
    const ctx = sessionAndSql();
    const { pending, maps } = get();
    const edits = Object.values(pending);
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
        const map = maps[stmtIndex];
        if (!map || map === "loading" || map === "unavailable") continue;
        const rowEdits = buildRowEdits(stmtEdits, map, stmtIndex);
        const sqls = await ipc.editsPreview(ctx.sessionId, ctx.sql, stmtIndex, rowEdits);
        all.push(...sqls);
      }
      set({ preview: { statements: all, error: null } });
    } catch (e) {
      set({
        preview: {
          statements: [],
          error: (e as { message?: string }).message ?? String(e),
        },
      });
    }
  },

  closePreview: () => set({ preview: null }),

  commit: async () => {
    const ctx = sessionAndSql();
    const { pending, maps, committing } = get();
    const edits = Object.values(pending);
    if (!ctx || edits.length === 0 || committing) return;
    set({ committing: true, lastError: null });

    const byStmt = new Map<number, PendingEdit[]>();
    for (const e of edits) {
      const arr = byStmt.get(e.stmtIndex) ?? [];
      arr.push(e);
      byStmt.set(e.stmtIndex, arr);
    }

    try {
      for (const [stmtIndex, stmtEdits] of byStmt) {
        const map = maps[stmtIndex];
        if (!map || map === "loading" || map === "unavailable") continue;
        const rowEdits = buildRowEdits(stmtEdits, map, stmtIndex);
        const outcome = await ipc.editsApply(ctx.sessionId, ctx.sql, stmtIndex, rowEdits);
        if (outcome.committed) {
          // patch grid values in place from RETURNING
          useResults.setState((s) => ({
            statements: s.statements.map((st) => {
              if (st.index !== stmtIndex) return st;
              const rows = st.rows.map((r) => [...r]);
              stmtEdits.forEach((e, i) => {
                const res = outcome.results[i];
                if (res?.ok) rows[e.row][e.col] = res.new_value;
              });
              return { ...st, rows };
            }),
          }));
          const failed = outcome.results.filter((r) => !r.ok);
          if (failed.length > 0) {
            set({ lastError: failed.map((f) => f.message).join("; ") });
          }
        }
      }
      set({ pending: {}, preview: null, committing: false });
    } catch (e) {
      set({
        committing: false,
        lastError: (e as { message?: string }).message ?? String(e),
      });
    }
  },

  reset: () => set({ maps: {}, pending: {}, preview: null, lastError: null }),
}));

export const editKey = keyOf;
