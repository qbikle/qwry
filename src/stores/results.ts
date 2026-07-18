import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { ColumnMeta, DriverError, QueryEvent } from "../ipc/types";
import { useConnections } from "./connections";
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
  /** establishing this tab's DB session (first run in a fresh tab) */
  connecting: boolean;
  totalMs: number | null;
  executedSql: string | null;
  /** char offset of executedSql within the editor buffer at run time — lets
   * the error squiggle land right when only a statement/selection ran */
  executedOffset: number;
  /** server NOTICEs (RAISE NOTICE, …) received on this tab's session since
   * the last run — psql prints these; dropping them hides real information */
  notices: { severity: string; message: string }[];
  executedSessionId: string | null;
  /** profile the result came from — commits must target THIS, never the
   * currently-active rail selection (staging→prod misfire class) */
  executedProfileId: string | null;
  globalError: DriverError | null;
}

const blankTab = (): TabResult => ({
  statements: [],
  activeStatement: 0,
  running: false,
  connecting: false,
  totalMs: null,
  executedSql: null,
  executedOffset: 0,
  notices: [],
  executedSessionId: null,
  executedProfileId: null,
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
  run: (sqlOverride?: string, offset?: number) => Promise<void>;
  cancel: () => Promise<void>;
  setActiveStatement: (i: number) => void;
  /** patch one statement's rows (edits commit); tabId defaults to the active
   * tab but commits pass their own — the user may switch tabs mid-flight */
  patchStatement: (
    stmtIndex: number,
    patchRows: (rows: (string | null)[][]) => (string | null)[][],
    tabId?: string,
  ) => void;
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

/** synchronous per-tab run guard — `running` only flips true AFTER the
 * confirm prompts, so a second ⌘↵ during a modal would overwrite the danger
 * resolver and orphan the first invocation */
const runInflight = new Set<string>();

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

  // "" = no active tab (zen screen): mirror resets to blank so nothing
  // downstream (inspector, status bar, find) keeps referencing a closed tab
  setActive: (tabId) => set((s) => ({ active: tabId, ...(s.byTab[tabId] ?? blankTab()) })),

  clearTab: (tabId) =>
    set((s) => {
      const { [tabId]: _gone, ...byTab } = s.byTab;
      return { byTab };
    }),

  setActiveStatement: (i) => writeTab(set, get().active, { activeStatement: i }),

  patchStatement: (stmtIndex, patchRows, tabId) =>
    writeTab(set, tabId ?? get().active, (t) => ({
      statements: t.statements.map((st) =>
        st.index === stmtIndex ? { ...st, rows: patchRows(st.rows) } : st,
      ),
    })),

  run: async (sqlOverride?: string, offset = 0) => {
    const conn = useConnections.getState();
    const { activeProfileId } = conn;
    const sql = sqlOverride ?? conn.sql;
    const tabId = get().active;
    if (!tabId) return;
    const cur = get().byTab[tabId] ?? blankTab();
    if (runInflight.has(tabId) || cur.running || !activeProfileId || !sql.trim()) return;
    // a commit in flight builds PK locators against the CURRENT result set —
    // replacing it mid-commit could aim UPDATEs at the wrong rows
    {
      const { useEdits } = await import("./edits");
      if (useEdits.getState().committing) return;
    }
    if (runInflight.has(tabId) || (get().byTab[tabId] ?? blankTab()).running) return; // re-check after await
    runInflight.add(tabId);

    // the first run in a fresh tab establishes its dedicated session — say so
    // instead of sitting silent for the tunnel handshake
    writeTab(set, tabId, { connecting: true });
    const sessionId = await conn.ensureTabSession(activeProfileId, tabId);
    writeTab(set, tabId, { connecting: false });
    if (!sessionId) {
      runInflight.delete(tabId);
      return;
    }

    // staged edits die with the old result set — never silently. (Scroll-
    // triggered loadMore parks itself instead of prompting; this covers
    // explicit re-runs, filter/sort changes and refresh.)
    {
      const { useEdits } = await import("./edits");
      const pendingN = Object.keys(useEdits.getState().byTab[tabId]?.pending ?? {}).length;
      if (pendingN > 0) {
        const { confirmDanger } = await import("./danger");
        const ok = await confirmDanger(
          `Discard ${pendingN} staged edit${pendingN === 1 ? "" : "s"}?`,
          "Re-running replaces this result set; uncommitted cell edits will be lost.\nCommit with ⌘S first to keep them.",
          "Discard & run",
        );
        if (!ok) {
          runInflight.delete(tabId);
          return;
        }
      }
    }

    const { dangerousStatements, confirmDangerLive } = await import("./danger");
    const danger = dangerousStatements(sql);
    if (danger.length > 0) {
      // the confirm opens IMMEDIATELY listing the statements; planner
      // estimates ("no WHERE clause" reads very differently at 12 rows vs
      // 4.2M) STREAM into the open modal. Plain EXPLAIN (no ANALYZE) plans
      // without executing — but planning still waits on locks, so it runs on
      // the PRIMARY session (never queued in front of the user's own run on
      // the tab session) with a 2s UI deadline → "estimate unavailable".
      const est: string[] = danger.map(() => "≈ estimating…");
      const render = () => danger.map((stmt, i) => `${est[i]}\n${stmt}`).join("\n\n");
      const { done, update } = confirmDangerLive(
        `${danger.length === 1 ? "Statement has" : `${danger.length} statements have`} no WHERE clause`,
        render(),
      );
      const primary = useConnections.getState().sessions[activeProfileId];
      if (primary) {
        danger.forEach((stmt, i) => {
          const explain = (async (): Promise<number | null> => {
            const out = await ipc.execute(primary, `EXPLAIN (FORMAT JSON) ${stmt}`);
            const txt = out.statements[0]?.rows[0]?.[0];
            if (!txt) return null;
            // DML plans root at ModifyTable whose own Plan Rows is 0 (no
            // RETURNING) — the row estimate lives in its child scan node
            interface PlanNode {
              "Node Type"?: string;
              "Plan Rows"?: number;
              Plans?: PlanNode[];
            }
            let node = (JSON.parse(txt) as { Plan?: PlanNode }[])[0]?.Plan;
            while (node && node["Node Type"] === "ModifyTable" && node.Plans?.length) {
              node = node.Plans[0];
            }
            const rows = node?.["Plan Rows"];
            return typeof rows === "number" ? rows : null;
          })();
          const deadline = new Promise<null>((r) => setTimeout(() => r(null), 2000));
          void Promise.race([explain.catch(() => null), deadline]).then((rows) => {
            est[i] =
              rows != null
                ? `≈ ${rows.toLocaleString()} rows (planner estimate)`
                : "estimate unavailable";
            update(render()); // no-ops if the prompt already resolved
          });
        });
      } else {
        est.fill("estimate unavailable (no primary session)");
        update(render());
      }
      const ok = await done;
      if (!ok) {
        runInflight.delete(tabId);
        return;
      }
    }

    if (pendingRows) pendingRows.delete(tabId);
    writeTab(set, tabId, {
      statements: [],
      activeStatement: 0,
      running: true,
      totalMs: null,
      executedSql: sql,
      executedOffset: sqlOverride === undefined ? 0 : offset,
      notices: [],
      executedSessionId: sessionId,
      executedProfileId: activeProfileId,
      globalError: null,
    });
    // this tab's stale editability + pending edits die with its old result set
    void import("./edits").then(({ useEdits }) => useEdits.getState().resetTab(tabId));

    // history timing/rows come from the events themselves — reading the store
    // after the invoke resolves races the rAF row flush and logged ms=0
    let historyRows = 0;
    let historyDone = false;
    const runStart = performance.now();

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
          historyRows += ev.row_count;
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
            const err = {
              message: ev.message,
              position: ev.position,
              code: ev.code,
              detail: ev.detail,
              hint: ev.hint,
            };
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
          historyDone = true;
          void ipc
            .historyAdd(activeProfileId, sql, ev.total_ms, historyRows, "ok")
            .catch((err) => console.error("history_add failed", err));
          break;
      }
    };

    try {
      await ipc.executeStream(sessionId, sql, onEvent);
      // (open-transaction tracking is driver-truth now — the "tx-state"
      // event listener below feeds txTabs; no SQL sniffing here)

      // schema-affecting statement heads (real statement boundaries from the
      // executed run — not a whole-buffer regex) → refresh the snapshot AND
      // every tab's cached editability maps (they carry table/column/pk
      // identity that DDL can invalidate)
      const ranDdl = (get().byTab[tabId]?.statements ?? []).some(
        (st) => !st.error && /^\s*(create|alter|drop|comment|grant|revoke|truncate)\b/i.test(st.sql),
      );
      if (ranDdl) {
        const { useSchema } = await import("./schema");
        const primary = useConnections.getState().sessions[activeProfileId];
        if (primary) void useSchema.getState().fetch(activeProfileId, primary);
        void import("./edits").then(({ useEdits }) => useEdits.getState().refreshMapsAfterDdl());
      }
    } catch (e) {
      const err = e as DriverError;
      // failed/cancelled runs enter history too — flagged, never silently
      // absent; a failed write logs but must not break the run path
      if (!historyDone) {
        historyDone = true;
        void ipc
          .historyAdd(
            activeProfileId,
            sql,
            performance.now() - runStart,
            historyRows,
            err?.code === "57014" ? "cancelled" : "error",
          )
          .catch((e2) => console.error("history_add failed", e2));
      }
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
      runInflight.delete(tabId);
    }
  },

  cancel: async () => {
    const sessionId = get().executedSessionId;
    if (!sessionId) return;
    try {
      // escalating cancel: CancelToken, then pg_cancel_backend over a fresh
      // control connection if the query didn't die — driver-side
      await ipc.cancel(sessionId);
    } catch (e) {
      // both cancel tiers failed. Last tier: pg_terminate_backend (kills the
      // server process) + force-disconnect — explicit confirm, never automatic
      const { confirmDanger } = await import("./danger");
      const msg = (e as { message?: string }).message ?? String(e);
      const ok = await confirmDanger(
        "Cancel didn't stop the query",
        `${msg}\n\nTerminate the server-side query (pg_terminate_backend) and force-disconnect this tab's session? A fresh session is created on the next run.`,
        "Terminate & disconnect",
      );
      if (!ok) return;
      try {
        await ipc.terminateBackend(sessionId);
      } catch {
        // server unreachable — the disconnect below still unsticks the UI;
        // the server reaps the query via keepalives
      }
      void ipc.disconnect(sessionId);
      // forget the dead session so the next run builds a fresh one
      const { useConnections } = await import("./connections");
      const conns = useConnections.getState();
      const entry = Object.entries(conns.tabSessions).find(([, sid]) => sid === sessionId);
      if (entry) {
        const [key] = entry;
        const tabId = key.split("::").slice(1).join("::");
        conns.closeTabSessions(tabId);
      }
    }
  },
}));

// keep the active tab's results mirrored as the editor's tab focus moves, and
// drop results/edits for tabs that get closed
if (useTabs.getState().activeId) useResults.getState().setActive(useTabs.getState().activeId!);
let prevTabIds = new Set(useTabs.getState().tabs.map((t) => t.id));
useTabs.subscribe((s, p) => {
  // (first-run latency is handled by the spare-session pool in connections.ts
  // — a fresh tab claims the pre-warmed standby instantly on its first run)
  if (s.activeId !== p.activeId) useResults.getState().setActive(s.activeId ?? "");
  const ids = new Set(s.tabs.map((t) => t.id));
  if (ids.size !== prevTabIds.size) {
    for (const id of prevTabIds) {
      if (!ids.has(id)) {
        useResults.getState().clearTab(id);
        void import("./edits").then(({ useEdits }) => useEdits.getState().resetTab(id));
        void import("./browser").then(({ useBrowser }) => useBrowser.getState().clearTab(id));
      }
    }
    prevTabIds = ids;
  }
});

// driver-tracked transaction state → the tx chip / amber tab dot. The driver
// lexes statement heads + error outcomes (tokio-postgres hides ReadyForQuery),
// so txTabs is server-truth instead of a frontend SQL sniff. failed-tx still
// counts as open — the transaction exists until COMMIT/ROLLBACK.
void import("@tauri-apps/api/event").then(({ listen }) =>
  listen<{ session_id: string; state: "idle" | "in_tx" | "failed_tx" }>("tx-state", (e) => {
    const conns = useConnections.getState();
    const entry = Object.entries(conns.tabSessions).find(
      ([, sid]) => sid === e.payload.session_id,
    );
    if (!entry) return; // primary/spare sessions have no chip
    conns.setTxTab(entry[0], e.payload.state !== "idle");
  }),
);

// server NOTICEs → the tab whose session raised them (session ids are unique
// per tab session, so routing is exact; notices from unknown sessions —
// primary/spare/introspection — are dropped, matching psql's per-session view)
void import("@tauri-apps/api/event").then(({ listen }) =>
  listen<{ session_id: string; severity: string; message: string }>("pg-notice", (e) => {
    const { byTab } = useResults.getState();
    const entry = Object.entries(byTab).find(
      ([, t]) => t.executedSessionId === e.payload.session_id,
    );
    if (!entry) return;
    const [tabId, tab] = entry;
    const notices = [
      ...tab.notices,
      { severity: e.payload.severity, message: e.payload.message },
    ].slice(-50); // runaway RAISE loops must not grow memory unbounded
    useResults.setState((s) => {
      const cur = s.byTab[tabId];
      if (!cur) return s;
      const next = { ...cur, notices };
      return {
        byTab: { ...s.byTab, [tabId]: next },
        ...(s.active === tabId ? { notices } : {}),
      };
    });
  }),
);
