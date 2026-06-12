import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { ColumnMeta, DriverError, QueryEvent } from "../ipc/types";
import { useConnections } from "./connections";

export interface StatementState {
  index: number;
  sql: string;
  columns: ColumnMeta[];
  rows: (string | null)[][];
  /** "rowIdx:colIdx" keys of cells truncated at the backend cell cap */
  truncated: Set<string>;
  affected: number | null;
  ms: number | null;
  rowCount: number;
  capped: boolean;
  done: boolean;
  error: DriverError | null;
}

interface ResultsState {
  statements: StatementState[];
  /** which statement's grid is visible */
  activeStatement: number;
  running: boolean;
  totalMs: number | null;
  /** exact text of the last execution (for editor error squiggles) */
  executedSql: string | null;
  /** errors not tied to a statement (connect drops etc.) */
  globalError: DriverError | null;

  /** runs `sqlOverride` when given (e.g. editor selection), else the buffer */
  run: (sqlOverride?: string) => Promise<void>;
  cancel: () => Promise<void>;
  setActiveStatement: (i: number) => void;
}

const blankStatement = (index: number, sql = ""): StatementState => ({
  index,
  sql,
  columns: [],
  rows: [],
  truncated: new Set(),
  affected: null,
  ms: null,
  rowCount: 0,
  capped: false,
  done: false,
  error: null,
});

// Row batches arrive faster than React should render. Buffer them and flush
// on a rAF tick so a 1M-row stream causes ~60 store updates/s, not thousands.
let pending: Map<number, (string | null)[][]> | null = null;
let flushScheduled = false;

function queueRows(set: (fn: (s: ResultsState) => Partial<ResultsState>) => void, index: number, rows: (string | null)[][]) {
  if (!pending) pending = new Map();
  const arr = pending.get(index);
  if (arr) arr.push(...rows);
  else pending.set(index, [...rows]);

  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(() => {
      flushScheduled = false;
      const toFlush = pending;
      pending = null;
      if (!toFlush) return;
      set((s) => ({
        statements: s.statements.map((st) => {
          const extra = toFlush.get(st.index);
          return extra ? { ...st, rows: [...st.rows, ...extra] } : st;
        }),
      }));
    });
  }
}

export const useResults = create<ResultsState>((set, get) => ({
  statements: [],
  activeStatement: 0,
  running: false,
  totalMs: null,
  executedSql: null,
  globalError: null,

  setActiveStatement: (i) => set({ activeStatement: i }),

  run: async (sqlOverride?: string) => {
    const conn = useConnections.getState();
    const { activeProfileId, sessions } = conn;
    const sql = sqlOverride ?? conn.sql;
    if (get().running || !activeProfileId || !sql.trim()) return;
    const sessionId = sessions[activeProfileId];
    if (!sessionId) return;

    pending = null;
    set({
      statements: [],
      activeStatement: 0,
      running: true,
      totalMs: null,
      executedSql: sql,
      globalError: null,
    });
    // stale editability + pending edits die with the previous result set
    void import("./edits").then(({ useEdits }) => useEdits.getState().reset());

    const onEvent = (ev: QueryEvent) => {
      switch (ev.type) {
        case "statement_start":
          set((s) => ({
            statements: [...s.statements, blankStatement(ev.index, ev.sql)],
            activeStatement: ev.index,
          }));
          break;
        case "columns":
          set((s) => ({
            statements: s.statements.map((st) =>
              st.index === ev.index ? { ...st, columns: ev.columns } : st,
            ),
          }));
          break;
        case "rows": {
          if (ev.truncated.length > 0) {
            set((s) => ({
              statements: s.statements.map((st) => {
                if (st.index !== ev.index) return st;
                const truncated = new Set(st.truncated);
                const base = st.rows.length + (pending?.get(ev.index)?.length ?? 0);
                for (const [r, c] of ev.truncated) truncated.add(`${base + r}:${c}`);
                return { ...st, truncated };
              }),
            }));
          }
          queueRows(set, ev.index, ev.rows);
          break;
        }
        case "statement_done":
          set((s) => ({
            statements: s.statements.map((st) =>
              st.index === ev.index
                ? {
                    ...st,
                    affected: ev.affected,
                    ms: ev.ms,
                    rowCount: ev.row_count,
                    capped: ev.capped,
                    done: true,
                  }
                : st,
            ),
          }));
          break;
        case "error":
          set((s) => {
            const exists = s.statements.some((st) => st.index === ev.index);
            const err = { message: ev.message, position: ev.position, code: ev.code };
            return exists
              ? {
                  statements: s.statements.map((st) =>
                    st.index === ev.index ? { ...st, error: err, done: true } : st,
                  ),
                  activeStatement: ev.index,
                }
              : {
                  statements: [
                    ...s.statements,
                    { ...blankStatement(ev.index), error: err, done: true },
                  ],
                  activeStatement: ev.index,
                };
          });
          break;
        case "finished":
          set({ totalMs: ev.total_ms });
          break;
      }
    };

    try {
      await ipc.executeStream(sessionId, sql, onEvent);
      const { looksLikeDdl, useSchema } = await import("./schema");
      if (looksLikeDdl(sql)) {
        void useSchema.getState().fetch(activeProfileId, sessionId);
      }
    } catch (e) {
      const err = e as DriverError;
      // statement-level errors already arrive as events; anything else is global
      set((s) => ({
        globalError: s.statements.some((st) => st.error) ? null : err,
      }));
    } finally {
      set({ running: false });
    }
  },

  cancel: async () => {
    const conn = useConnections.getState();
    const sessionId = conn.activeProfileId ? conn.sessions[conn.activeProfileId] : null;
    if (sessionId) await ipc.cancel(sessionId);
  },
}));
