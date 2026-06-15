import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { ColumnMeta, DriverError, QueryEvent } from "../ipc/types";
import { skey, useConnections } from "./connections";
import { useTabs } from "./tabs";

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

/** one tab's result set */
interface TabResult {
  statements: StatementState[];
  activeStatement: number;
  running: boolean;
  totalMs: number | null;
  executedSql: string | null;
  executedSessionId: string | null;
  globalError: DriverError | null;
}

const blankTab = (): TabResult => ({
  statements: [],
  activeStatement: 0,
  running: false,
  totalMs: null,
  executedSql: null,
  executedSessionId: null,
  globalError: null,
});

// top-level fields mirror the ACTIVE tab so every consumer keeps reading
// `useResults(s => s.statements)` unchanged; `byTab` is the per-tab source of
// truth, so a background tab's stream never touches the visible tab.
interface ResultsState extends TabResult {
  byTab: Record<string, TabResult>;
  active: string;

  setActive: (tabId: string) => void;
  clearTab: (tabId: string) => void;
  run: (sqlOverride?: string) => Promise<void>;
  cancel: () => Promise<void>;
  setActiveStatement: (i: number) => void;
  /** patch one statement's rows in the active tab (used by edits commit) */
  patchStatement: (stmtIndex: number, patchRows: (rows: (string | null)[][]) => (string | null)[][]) => void;
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

type SetFn = (fn: (s: ResultsState) => Partial<ResultsState>) => void;

/** write a partial into byTab[tabId]; mirror to the top level if it's active */
function writeTab(
  set: SetFn,
  tabId: string,
  partial: Partial<TabResult> | ((t: TabResult) => Partial<TabResult>),
) {
  set((s) => {
    const cur = s.byTab[tabId] ?? blankTab();
    const p = typeof partial === "function" ? partial(cur) : partial;
    const next = { ...cur, ...p };
    const byTab = { ...s.byTab, [tabId]: next };
    return tabId === s.active ? { byTab, ...next } : { byTab };
  });
}

// Row batches arrive faster than React should render. Buffer per tab+statement
// and flush on a rAF tick.
let pendingRows: Map<string, Map<number, (string | null)[][]>> | null = null;
let flushScheduled = false;

function queueRows(
  set: SetFn,
  tabId: string,
  index: number,
  rows: (string | null)[][],
) {
  if (!pendingRows) pendingRows = new Map();
  let perTab = pendingRows.get(tabId);
  if (!perTab) {
    perTab = new Map();
    pendingRows.set(tabId, perTab);
  }
  const arr = perTab.get(index);
  if (arr) arr.push(...rows);
  else perTab.set(index, [...rows]);

  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(() => {
      flushScheduled = false;
      const toFlush = pendingRows;
      pendingRows = null;
      if (!toFlush) return;
      for (const [tab, perTabRows] of toFlush) {
        writeTab(set, tab, (t) => ({
          statements: t.statements.map((st) => {
            const extra = perTabRows.get(st.index);
            return extra ? { ...st, rows: [...st.rows, ...extra] } : st;
          }),
        }));
      }
    });
  }
}

export const useResults = create<ResultsState>((set, get) => ({
  ...blankTab(),
  byTab: {},
  active: "",

  setActive: (tabId) => set((s) => ({ active: tabId, ...(s.byTab[tabId] ?? blankTab()) })),

  clearTab: (tabId) =>
    set((s) => {
      const { [tabId]: _gone, ...byTab } = s.byTab;
      return { byTab };
    }),

  setActiveStatement: (i) => writeTab(set, get().active, { activeStatement: i }),

  patchStatement: (stmtIndex, patchRows) =>
    writeTab(set, get().active, (t) => ({
      statements: t.statements.map((st) =>
        st.index === stmtIndex ? { ...st, rows: patchRows(st.rows) } : st,
      ),
    })),

  run: async (sqlOverride?: string) => {
    const conn = useConnections.getState();
    const { activeProfileId } = conn;
    const sql = sqlOverride ?? conn.sql;
    const tabId = get().active;
    if (!tabId) return;
    const cur = get().byTab[tabId] ?? blankTab();
    if (cur.running || !activeProfileId || !sql.trim()) return;

    const sessionId = await conn.ensureTabSession(activeProfileId, tabId);
    if (!sessionId) return;

    const { dangerousStatements, confirmDanger } = await import("./danger");
    const danger = dangerousStatements(sql);
    if (danger.length > 0) {
      const ok = await confirmDanger(
        `${danger.length === 1 ? "Statement has" : `${danger.length} statements have`} no WHERE clause`,
        danger.join(";\n\n"),
      );
      if (!ok) return;
    }

    if (pendingRows) pendingRows.delete(tabId);
    writeTab(set, tabId, {
      statements: [],
      activeStatement: 0,
      running: true,
      totalMs: null,
      executedSql: sql,
      executedSessionId: sessionId,
      globalError: null,
    });
    // this tab's stale editability + pending edits die with its old result set
    void import("./edits").then(({ useEdits }) => useEdits.getState().resetTab(tabId));

    const onEvent = (ev: QueryEvent) => {
      switch (ev.type) {
        case "statement_start":
          writeTab(set, tabId, (t) => ({
            statements: [...t.statements, blankStatement(ev.index, ev.sql)],
            activeStatement: ev.index,
          }));
          break;
        case "columns":
          writeTab(set, tabId, (t) => ({
            statements: t.statements.map((st) =>
              st.index === ev.index ? { ...st, columns: ev.columns } : st,
            ),
          }));
          break;
        case "rows": {
          if (ev.truncated.length > 0) {
            writeTab(set, tabId, (t) => ({
              statements: t.statements.map((st) => {
                if (st.index !== ev.index) return st;
                const truncated = new Set(st.truncated);
                const base =
                  st.rows.length + (pendingRows?.get(tabId)?.get(ev.index)?.length ?? 0);
                for (const [r, c] of ev.truncated) truncated.add(`${base + r}:${c}`);
                return { ...st, truncated };
              }),
            }));
          }
          queueRows(set, tabId, ev.index, ev.rows);
          break;
        }
        case "statement_done":
          writeTab(set, tabId, (t) => ({
            statements: t.statements.map((st) =>
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
          writeTab(set, tabId, (t) => {
            const exists = t.statements.some((st) => st.index === ev.index);
            const err = { message: ev.message, position: ev.position, code: ev.code };
            return exists
              ? {
                  statements: t.statements.map((st) =>
                    st.index === ev.index ? { ...st, error: err, done: true } : st,
                  ),
                  activeStatement: ev.index,
                }
              : {
                  statements: [...t.statements, { ...blankStatement(ev.index), error: err, done: true }],
                  activeStatement: ev.index,
                };
          });
          break;
        case "finished":
          writeTab(set, tabId, { totalMs: ev.total_ms });
          break;
      }
    };

    try {
      await ipc.executeStream(sessionId, sql, onEvent);

      // update the tab's open-transaction flag from what actually ran
      const txKey = skey(activeProfileId, tabId);
      let inTx = useConnections.getState().txTabs[txKey] ?? false;
      for (const st of get().byTab[tabId]?.statements ?? []) {
        const head = st.sql.trim().toLowerCase();
        if (/^(begin|start\s+transaction)\b/.test(head)) inTx = true;
        else if (/^(commit|rollback|end)\b/.test(head)) inTx = false;
        if (st.error) break;
      }
      useConnections.getState().setTxTab(txKey, inTx);

      const { looksLikeDdl, useSchema } = await import("./schema");
      if (looksLikeDdl(sql)) {
        const primary = useConnections.getState().sessions[activeProfileId];
        if (primary) void useSchema.getState().fetch(activeProfileId, primary);
      }
      const tabRes = get().byTab[tabId] ?? blankTab();
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("history_add", {
          profileId: activeProfileId,
          sql,
          ms: tabRes.totalMs ?? 0,
          rows: tabRes.statements.reduce((n, st) => n + st.rowCount, 0),
        }),
      );
    } catch (e) {
      const err = e as DriverError;
      writeTab(set, tabId, (t) => ({
        globalError: t.statements.some((st) => st.error) ? null : err,
      }));
      const msg = (err?.message ?? "").toLowerCase();
      if (/connection|closed|communicat|broken pipe|reset|terminat|no such session/.test(msg)) {
        useConnections.setState((s) => ({
          connState: { ...s.connState, [activeProfileId]: "disconnected" },
        }));
      }
    } finally {
      writeTab(set, tabId, { running: false });
    }
  },

  cancel: async () => {
    const sessionId = get().executedSessionId;
    if (sessionId) await ipc.cancel(sessionId);
  },
}));

// keep the active tab's results mirrored as the editor's tab focus moves, and
// drop results/edits for tabs that get closed
if (useTabs.getState().activeId) useResults.getState().setActive(useTabs.getState().activeId!);
let prevTabIds = new Set(useTabs.getState().tabs.map((t) => t.id));
useTabs.subscribe((s, p) => {
  if (s.activeId && s.activeId !== p.activeId) useResults.getState().setActive(s.activeId);
  const ids = new Set(s.tabs.map((t) => t.id));
  if (ids.size !== prevTabIds.size) {
    for (const id of prevTabIds) {
      if (!ids.has(id)) {
        useResults.getState().clearTab(id);
        void import("./edits").then(({ useEdits }) => useEdits.getState().resetTab(id));
      }
    }
    prevTabIds = ids;
  }
});
