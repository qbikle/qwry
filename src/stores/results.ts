import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { ColumnMeta, DriverError, QueryEvent } from "../ipc/types";
import type { EditMapSlot } from "./edits";
import { headToken } from "../editor/statements";
import { terminatedSessions } from "./sessionFlags";
import { dropTabQueryScroll } from "../grid/scrollMemory";
import { skey, useConnections } from "./connections";
import {
  humanSessionError,
  isDeathStrip,
  isSessionDeath,
  noteForgottenStamp,
} from "./liveSession";
import { isTabVisible, useTabs } from "./tabs";
import { useInspector, type InspectTarget } from "./inspector";
import { copyCueShow } from "../lib/copyCue";

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
  /** cancel requested for the in-flight run: instant feedback while the
   * backend cancel ladder works; clears when the cancel IPC settles or the
   * run itself settles, whichever comes first */
  cancelling: boolean;
  /** establishing this tab's DB session (first run in a fresh tab) */
  connecting: boolean;
  /** a refresh run is in flight: the rows on screen are the OLD ones and stay
   * there until the fresh set swaps in whole (E2 R5) */
  refreshing: boolean;
  /** when the last refresh run swapped; the status bar says "just now" for
   * two seconds off this, then goes back to the plain ms */
  refreshedAt: number | null;
  totalMs: number | null;
  executedSql: string | null;
  /** char offset of executedSql within the editor buffer at run time; lets
   * the error squiggle land right when only a statement/selection ran */
  executedOffset: number;
  /** server NOTICEs (RAISE NOTICE, …) received on this tab's session since
   * the last run. psql prints these; dropping them hides real information */
  notices: { severity: string; message: string }[];
  executedSessionId: string | null;
  /** profile the result came from: commits must target THIS, never the
   * currently-active rail selection (staging→prod misfire class) */
  executedProfileId: string | null;
  globalError: DriverError | null;
}

const blankTab = (): TabResult => ({
  statements: [],
  activeStatement: 0,
  running: false,
  cancelling: false,
  connecting: false,
  refreshing: false,
  refreshedAt: null,
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
  /** opts.profileId pins the run to that profile instead of the rail-active
   * one: post-write reloads must read the connection they wrote to; every
   * other caller keeps rail semantics (the v0.6 contract).
   * opts.refresh is E2's refresh mode: the result on screen is KEPT while the
   * fresh one streams into a shadow buffer, and one store write swaps it in
   * at the end (R5). A failed refresh keeps the old rows and adds the strip. */
  run: (
    sqlOverride?: string,
    offset?: number,
    opts?: { profileId?: string; refresh?: boolean },
  ) => Promise<void>;
  cancel: () => Promise<void>;
  setActiveStatement: (i: number) => void;
  /** patch one statement's rows (edits commit); tabId defaults to the active
   * tab but commits pass their own; the user may switch tabs mid-flight */
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

/** synchronous per-tab run guard: `running` only flips true AFTER the
 * confirm prompts, so a second ⌘↩ during a modal would overwrite the danger
 * resolver and orphan the first invocation */
const runInflight = new Set<string>();

/** sessions the user force-terminated (last cancel tier): their run's
 * connection-closed rejection is a cancel, not an error */


/** statement heads that change the schema (real statement boundaries; heads
 * read past leading comments) */
const DDL_HEADS = new Set(["create", "alter", "drop", "comment", "grant", "revoke", "truncate"]);

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

/** One QueryEvent folded into a tab's result shape. A plain run folds into
 * the store as events land; a refresh run folds into a shadow buffer and
 * swaps once, so neither tier owns a second copy of what an event MEANS
 * (DESIGN rule 15). `rows` is not here: the live path batches it through the
 * rAF queue, the shadow appends straight away, and only `foldRows` differs. */
function foldEvent(t: TabResult, ev: QueryEvent): Partial<TabResult> | null {
  switch (ev.type) {
    case "statement_start":
      return {
        statements: [...t.statements, blankStatement(ev.index, ev.sql)],
        activeStatement: ev.index,
      };
    case "columns":
      return {
        statements: t.statements.map((st) =>
          st.index === ev.index ? { ...st, columns: ev.columns } : st,
        ),
      };
    case "statement_done":
      return {
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
      };
    case "error": {
      const err = {
        message: ev.message,
        position: ev.position,
        code: ev.code,
        detail: ev.detail,
        hint: ev.hint,
      };
      const exists = t.statements.some((st) => st.index === ev.index);
      return exists
        ? {
            statements: t.statements.map((st) =>
              st.index === ev.index ? { ...st, error: err, done: true } : st,
            ),
            activeStatement: ev.index,
          }
        : {
            statements: [
              ...t.statements,
              { ...blankStatement(ev.index), error: err, done: true },
            ],
            activeStatement: ev.index,
          };
    }
    default:
      return null;
  }
}

/** the truncated-cell keys a rows batch adds. `pending` is how many rows for
 * this statement are still queued for the rAF flush, so the keys land on the
 * row indices the batch will actually occupy. */
function foldTruncated(
  t: TabResult,
  ev: Extract<QueryEvent, { type: "rows" }>,
  pending: number,
): Partial<TabResult> {
  return {
    statements: t.statements.map((st) => {
      if (st.index !== ev.index) return st;
      const truncated = new Set(st.truncated);
      const base = st.rows.length + pending;
      for (const [r, c] of ev.truncated) truncated.add(`${base + r}:${c}`);
      return { ...st, truncated };
    }),
  };
}

/** R4: the inspected cell survives a refresh. Its row is found again by PK
 * when the result set has one, kept by index when the row count is unchanged,
 * and dropped when neither holds — a coordinate that no longer names the same
 * row would print another row's value under the same header (LESSONS 4). */
function reinspectRow(
  before: StatementState,
  after: StatementState,
  row: number,
  col: number,
  pkCols: number[],
): number | null {
  if (before.columns[col]?.name !== after.columns[col]?.name) return null;
  const old = before.rows[row];
  const usablePk =
    old !== undefined &&
    pkCols.length > 0 &&
    pkCols.every((c) => c < after.columns.length && !before.truncated.has(`${row}:${c}`));
  if (usablePk) {
    const hit = after.rows.findIndex((r) => pkCols.every((c) => r[c] === old[c]));
    if (hit >= 0) return hit;
  }
  if (before.rows.length === after.rows.length && row < after.rows.length) return row;
  return null;
}

/** the PK column indices of the result's own table, from the editability map
 * the grid already fetched. A join with several tables resolves through the
 * first editable column: that is the table whose rows the browse is showing. */
function pkColsOf(map: EditMapSlot | undefined): number[] {
  if (!map || typeof map === "string") return [];
  const oid = map.columns.find((c) => c.editable)?.table_oid;
  return (oid != null ? map.pk_cols[oid] : undefined) ?? Object.values(map.pk_cols)[0] ?? [];
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

  run: async (
    sqlOverride?: string,
    offset = 0,
    opts?: { profileId?: string; refresh?: boolean },
  ) => {
    const refresh = opts?.refresh === true;
    const conn = useConnections.getState();
    // the profile this run EXECUTES on: everything downstream (session,
    // history, executedProfileId stamp, disconnect reaping) reads this one
    // variable, so the stamp can never claim a profile that didn't execute
    const profileId = opts?.profileId ?? conn.activeProfileId;
    const sql = sqlOverride ?? conn.sql;
    // captured AT ENTRY, next to the executed sql: the snapshot block below
    // sits after awaits (session connect, confirms), and a mid-connect tab
    // switch would otherwise record tab B's buffer under this tab's id
    const buffer = conn.sql;
    const tabId = get().active;
    if (!tabId) return;
    const cur = get().byTab[tabId] ?? blankTab();
    if (runInflight.has(tabId) || cur.running || !profileId || !sql.trim()) return;
    // a commit in flight builds PK locators against the CURRENT result set;
    // replacing it mid-commit could aim UPDATEs at the wrong rows
    {
      const { useEdits } = await import("./edits");
      if (useEdits.getState().committing) return;
    }
    if (runInflight.has(tabId) || (get().byTab[tabId] ?? blankTab()).running) return; // re-check after await
    runInflight.add(tabId);

    // the first run in a fresh tab establishes its dedicated session; say so
    // instead of sitting silent for the tunnel handshake
    writeTab(set, tabId, { connecting: true });
    const sessionId = await conn.ensureTabSession(profileId, tabId);
    writeTab(set, tabId, { connecting: false });
    if (!sessionId) {
      // no statements will ever arrive; without an error the pane sits on
      // "Loading table…" forever once the connect toast expires
      writeTab(set, tabId, {
        globalError: {
          message: "couldn’t establish a session. Check the connection",
          position: null,
          code: null,
        },
      });
      runInflight.delete(tabId);
      return;
    }

    // staged edits die with the old result set, never silently. (Scroll-
    // triggered loadMore parks itself instead of prompting; this covers
    // explicit re-runs, filter/sort changes and refresh.)
    // the editability maps as they stand BEFORE the run: the swap reads its
    // PK columns out of them to find the inspected row again, and by then
    // resetTab has thrown them away (edits.ts imports this module, so the
    // reference is only ever the dynamic one)
    let pkMaps: Record<number, EditMapSlot> = {};
    {
      const { useEdits } = await import("./edits");
      if (refresh) pkMaps = useEdits.getState().byTab[tabId]?.maps ?? {};
      const pendingN = Object.keys(useEdits.getState().byTab[tabId]?.pending ?? {}).length;
      // a refresh never prompts: R4 keeps a staged tab's rows exactly where
      // they are and refreshActiveTab says so in the status bar, so a modal
      // here would be a second answer to a gesture that already has one
      if (pendingN > 0 && refresh) {
        runInflight.delete(tabId);
        return;
      }
      if (pendingN > 0) {
        const { confirmDanger } = await import("./danger");
        const ok = await confirmDanger(
          `Discard ${pendingN} Staged Edit${pendingN === 1 ? "" : "s"}?`,
          "Re-running replaces this result set; uncommitted cell edits will be lost.\nCommit with ⌘S first to keep them.",
          "Discard and Run",
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
      // without executing, but planning still waits on locks, so it runs on
      // the PRIMARY session (never queued in front of the user's own run on
      // the tab session) with a 2s UI deadline → "estimate unavailable".
      const est: string[] = danger.map(() => "≈ estimating…");
      const render = () => danger.map((stmt, i) => `${est[i]}\n${stmt}`).join("\n\n");
      const { done, update } = confirmDangerLive(
        `${danger.length === 1 ? "Statement Has" : `${danger.length} Statements Have`} No WHERE Clause`,
        render(),
      );
      const primary = useConnections.getState().sessions[profileId];
      if (primary) {
        danger.forEach((stmt, i) => {
          const explain = (async (): Promise<number | null> => {
            const out = await ipc.execute(primary, `EXPLAIN (FORMAT JSON) ${stmt}`);
            const txt = out.statements[0]?.rows[0]?.[0];
            if (!txt) return null;
            // DML plans root at ModifyTable whose own Plan Rows is 0 (no
            // RETURNING): the row estimate lives in its child scan node
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

    // never-lose-work: every committed run parks the tab's FULL buffer in the
    // time-machine (query tabs only; table-browse runs land here too);
    // dedupe + the 50/tab cap live in the appdb layer
    if (buffer.trim() && useTabs.getState().tabs.find((t) => t.id === tabId)?.kind === "query") {
      void ipc
        .bufferSnapshotAdd(tabId, buffer)
        .catch((e) => console.error("buffer_snapshot_add failed", e));
    }

    const executedOffset = sqlOverride === undefined ? 0 : offset;
    // a refresh keeps everything the reader owns: the rows, the scroll they
    // are at (no dropTabQueryScroll, and the Grid stays mounted under the same
    // key), the statement they were on. Only the busy flags and the strips
    // the old result left behind move now; the data swaps once, at the end.
    if (refresh) {
      writeTab(set, tabId, {
        running: true,
        cancelling: false,
        refreshing: true,
        notices: [],
        globalError: null,
      });
    } else {
      if (pendingRows) pendingRows.delete(tabId);
      dropTabQueryScroll(tabId); // a fresh run reads from the top
      writeTab(set, tabId, {
        statements: [],
        activeStatement: 0,
        running: true,
        cancelling: false,
        totalMs: null,
        executedSql: sql,
        executedOffset,
        notices: [],
        executedSessionId: sessionId,
        executedProfileId: profileId,
        globalError: null,
      });
      // this tab's stale editability + pending edits die with its old result set
      void import("./edits").then(({ useEdits }) => useEdits.getState().resetTab(tabId));
    }

    // the refresh run's shadow: every event folds in here instead of the
    // store, so nothing on screen moves until the whole set has landed
    let shadow: TabResult = blankTab();

    // history timing/rows come from the events themselves: reading the store
    // after the invoke resolves races the rAF row flush and logged ms=0
    let historyRows = 0;
    let historyDone = false;
    const runStart = performance.now();

    const onEvent = (ev: QueryEvent) => {
      if (ev.type === "statement_done") historyRows += ev.row_count;
      if (ev.type === "rows") {
        if (refresh) {
          // the shadow is this run's alone and is never rendered, so its rows
          // are appended IN PLACE: a 50k result arrives in a hundred batches
          // and rebuilding the array per batch would copy millions of refs
          // for nothing
          const st = shadow.statements.find((s) => s.index === ev.index);
          if (st) {
            const base = st.rows.length;
            for (const [r, c] of ev.truncated) st.truncated.add(`${base + r}:${c}`);
            for (const row of ev.rows) st.rows.push(row);
          }
          return;
        }
        if (ev.truncated.length > 0) {
          writeTab(set, tabId, (t) =>
            foldTruncated(t, ev, pendingRows?.get(tabId)?.get(ev.index)?.length ?? 0),
          );
        }
        queueRows(set, tabId, ev.index, ev.rows);
        return;
      }
      if (ev.type === "finished") {
        if (refresh) shadow = { ...shadow, totalMs: ev.total_ms };
        else writeTab(set, tabId, { totalMs: ev.total_ms });
        historyDone = true;
        void ipc
          .historyAdd(profileId, sql, ev.total_ms, historyRows, "ok")
          .catch((err) => console.error("history_add failed", err));
        return;
      }
      if (refresh) {
        const p = foldEvent(shadow, ev);
        if (p) shadow = { ...shadow, ...p };
      } else {
        writeTab(set, tabId, (t) => foldEvent(t, ev) ?? {});
      }
    };

    // the terminal outcome, applied ONCE below: a refresh that fails must not
    // write a strip over rows it is about to leave alone, then write again
    let terminal: DriverError | null = null;
    let sessionDied = false;

    try {
      await ipc.executeStream(sessionId, sql, onEvent);
      // (open-transaction tracking is driver-truth now: the "tx-state"
      // event listener below feeds txTabs; no SQL sniffing here)

      // schema-affecting statement heads (real statement boundaries from the
      // executed run, not a whole-buffer regex) → refresh the snapshot AND
      // every tab's cached editability maps (they carry table/column/pk
      // identity that DDL can invalidate)
      const ranDdl = (refresh ? shadow.statements : (get().byTab[tabId]?.statements ?? [])).some(
        (st) => !st.error && DDL_HEADS.has(headToken(st.sql)),
      );
      if (ranDdl) {
        const { useSchema } = await import("./schema");
        const primary = useConnections.getState().sessions[profileId];
        if (primary) void useSchema.getState().fetch(profileId, primary);
        void import("./edits").then(({ useEdits }) => useEdits.getState().refreshMapsAfterDdl());
      }
    } catch (e) {
      const err = e as DriverError;
      // 57014 = user cancel, 57P01 = pg_terminate_backend; a force-disconnect
      // (last cancel tier) rejects with a connection-closed shape instead;
      // the terminatedSessions flag marks it as the cancel it was
      const cancelled =
        err?.code === "57014" || err?.code === "57P01" || terminatedSessions.has(sessionId);
      // failed/cancelled runs enter history too: flagged, never silently
      // absent; a failed write logs but must not break the run path
      if (!historyDone) {
        historyDone = true;
        void ipc
          .historyAdd(
            profileId,
            sql,
            performance.now() - runStart,
            historyRows,
            cancelled ? "cancelled" : "error",
          )
          .catch((e2) => console.error("history_add failed", e2));
      }
      terminal = humanSessionError(err);
      sessionDied = isSessionDeath(err?.message);
    } finally {
      terminatedSessions.delete(sessionId);
      // ONE write ends the run, both tiers and both outcomes. A refresh that
      // reached the end swaps its shadow in whole; one that died keeps the
      // rows the user is reading and adds only the strip (R3: nothing stays
      // blank), which is why the swap is decided before anything is written.
      const swapped = refresh && terminal === null;
      // the inspected cell, re-aimed while the OLD rows are still readable.
      // The target is the pane's, not the tab's, so only the tab on screen
      // may move it (LESSONS 4)
      let target: InspectTarget | null = null;
      if (swapped && tabId === get().active) {
        const cur = useInspector.getState().target;
        const from = (get().byTab[tabId]?.statements ?? []).find(
          (st) => st.index === cur?.stmtIndex,
        );
        const to = cur ? shadow.statements.find((st) => st.index === cur.stmtIndex) : undefined;
        if (cur && from && to) {
          const row = reinspectRow(from, to, cur.row, cur.col, pkColsOf(pkMaps[cur.stmtIndex]));
          if (row !== null) target = { ...cur, row };
        }
      }
      writeTab(set, tabId, (t) => {
        // a refresh that failed always says so; a plain run's strip yields to
        // a statement error of its own, which is already on screen
        const err = refresh
          ? terminal
          : terminal && !t.statements.some((st) => st.error)
            ? terminal
            : null;
        if (!refresh) return { running: false, cancelling: false, globalError: err };
        return {
          running: false,
          cancelling: false,
          refreshing: false,
          ...(swapped
            ? {
                statements: shadow.statements,
                activeStatement: shadow.statements.some((st) => st.index === t.activeStatement)
                  ? t.activeStatement
                  : shadow.activeStatement,
                totalMs: shadow.totalMs,
                executedSql: sql,
                executedOffset,
                refreshedAt: Date.now(),
              }
            : {}),
          executedSessionId: sessionId,
          executedProfileId: profileId,
          globalError: err,
        };
      });
      if (swapped) {
        // the maps describe COLUMNS, never rows: the swap hands them back to
        // the tab (kept when the fresh result has the same ones, refetched
        // when it does not), so the header's type glyphs, the inspector's
        // badge and every editable cell survive a refresh (R4). The inspected
        // cell was re-aimed above, by the PK those maps carried.
        void import("./edits").then(({ useEdits }) => {
          useEdits.getState().resetTab(tabId);
          useEdits.getState().remapAfterRefresh(tabId, pkMaps);
        });
        if (target) useInspector.getState().setTarget(target);
      }
      // reap the EXECUTED session only; sibling tabs on the profile keep
      // their live sessions (flipping the whole profile contradicted the
      // per-session reaping in markDisconnected). After the write: the stamp
      // this run left is the one death has to clear.
      if (sessionDied) useConnections.getState().markDisconnected(profileId, sessionId);
      runInflight.delete(tabId);
    }
  },

  cancel: async () => {
    // captured at entry: the flag must land on the tab whose
    // run is being cancelled even if the user switches tabs mid-flight
    const tabId = get().active;
    const sessionId = get().executedSessionId;
    if (!tabId || !sessionId) return;
    // already cancelling → no-op; repeated ⌘. must not stack cancel IPCs
    if ((get().byTab[tabId] ?? blankTab()).cancelling) return;
    writeTab(set, tabId, { cancelling: true });
    // clear scoped to THIS run's session: a late-settling cancel from an
    // earlier run must never release a newer run's flag
    const clearCancelling = () =>
      writeTab(set, tabId, (t) =>
        t.executedSessionId === sessionId ? { cancelling: false } : {},
      );
    try {
      // escalating cancel: CancelToken, then pg_cancel_backend over a fresh
      // control connection if the query didn't die (driver-side)
      await ipc.cancel(sessionId);
      // deliberately NOT cleared on success: over a congested tunnel the
      // dead query's 57014 still has to drain through the buffered rows;
      // the run's finally clears the flag when the run truly settles.
      // Clearing here flickered the button back to Cancel mid-death.
    } catch (e) {
      // a failed cancel leaves the run running; release the flag so the
      // user can retry or escalate through the terminate confirm below
      clearCancelling();
      const conns = useConnections.getState();
      const entry = Object.entries(conns.tabSessions).find(([, sid]) => sid === sessionId);
      // the terminated session's OWN profile: teardown must never touch the
      // tab's sibling sessions on other profiles
      const profileId = entry?.[0].split("::")[0] ?? get().executedProfileId;
      const msg = (e as { message?: string }).message ?? String(e);
      // the session is already gone: nothing to terminate (a dead transport
      // carries no pg_terminate_backend either); just forget it so the next
      // run builds a fresh one
      if (isSessionDeath(msg)) {
        if (profileId) conns.markDisconnected(profileId, sessionId);
        return;
      }
      // both cancel tiers failed. Last tier: pg_terminate_backend (kills the
      // server process) + force-disconnect: explicit confirm, never automatic
      const { confirmDanger } = await import("./danger");
      const inTx = entry ? !!conns.txTabs[entry[0]] : false;
      const ok = await confirmDanger(
        "Cancel Didn’t Stop the Query",
        `${msg}\n\nTerminate the server-side query (pg_terminate_backend) and force-disconnect this tab’s session? A fresh session is created on the next run.${
          inTx ? "\n\nThis tab has an open transaction. It will be rolled back." : ""
        }`,
        "Terminate and Disconnect",
      );
      if (!ok) return;
      terminatedSessions.add(sessionId); // history logs the fallout as a cancel
      try {
        await ipc.terminateBackend(sessionId);
      } catch {
        // server unreachable: the teardown below still unsticks the UI;
        // the server reaps the query via keepalives
      }
      // scoped teardown: disconnects + forgets ONLY the executed session (the
      // old closeTabSessions killed every profile's session for the tab)
      if (profileId) conns.markDisconnected(profileId, sessionId);
      else void ipc.disconnect(sessionId);
    }
  },
}));

// keep the active tab's results mirrored as the editor's tab focus moves, and
// drop results/edits for tabs that get closed
if (useTabs.getState().activeId) useResults.getState().setActive(useTabs.getState().activeId!);
let prevTabIds = new Set(useTabs.getState().tabs.map((t) => t.id));
useTabs.subscribe((s, p) => {
  // (first-run latency is handled by the spare-session pool in connections.ts;
  // a fresh tab claims the pre-warmed standby instantly on its first run)
  if (s.activeId !== p.activeId) useResults.getState().setActive(s.activeId ?? "");
  const ids = new Set(s.tabs.map((t) => t.id));
  if (ids.size !== prevTabIds.size) {
    for (const id of prevTabIds) {
      if (!ids.has(id)) {
        useResults.getState().clearTab(id);
        dropTabQueryScroll(id);
        void import("./edits").then(({ useEdits }) => useEdits.getState().resetTab(id));
        void import("./browser").then(({ useBrowser }) => useBrowser.getState().clearTab(id));
      }
    }
    prevTabIds = ids;
  }
});

/** heal reached this tab: a strip a dead session wrote is stale and comes
 * down. Every other one (a syntax error, a real constraint failure, a "0
 * rows" note) is still true and stays exactly where it is. */
export function clearDeathStrip(tabId: string) {
  const t = useResults.getState().byTab[tabId];
  if (!t?.globalError || !isDeathStrip(t.globalError.message, t.globalError.code)) return;
  writeTab(useResults.setState, tabId, { globalError: null });
}

// A session the app forgot is a handle nobody may send again. Forgetting
// happens in five branches of connections.ts and the stamp used to survive
// all five, so the next send addressed a session the app had already dropped
// and the backend answered with NoSession under a green dot. ONE mechanism
// here covers every branch: whatever leaves tabSessions takes the stamps that
// named it with it. Rows, statements and the profile stamp stay — the data is
// real; only the dead handle goes.
useConnections.subscribe((s, p) => {
  if (s.tabSessions === p.tabSessions) return;
  const live = new Set(Object.values(s.tabSessions));
  const gone = new Set(Object.values(p.tabSessions).filter((sid) => !live.has(sid)));
  if (gone.size === 0) return;
  useResults.setState((rs) => {
    const byTab = { ...rs.byTab };
    let changed = false;
    for (const [tabId, t] of Object.entries(rs.byTab)) {
      if (!t.executedSessionId || !gone.has(t.executedSessionId)) continue;
      // the dead id outlives the stamp by one step: the commit path asks
      // whether it died holding a transaction (liveSession.liveSessionFor)
      noteForgottenStamp(tabId, t.executedSessionId);
      byTab[tabId] = { ...t, executedSessionId: null };
      changed = true;
    }
    if (!changed) return rs;
    const mirror = byTab[rs.active];
    return mirror ? { byTab, executedSessionId: mirror.executedSessionId } : { byTab };
  });
});

// driver-tracked transaction state → the tx chip / amber tab dot. The driver
// lexes statement heads + error outcomes (tokio-postgres hides ReadyForQuery),
// so txTabs is server-truth instead of a frontend SQL sniff. failed-tx still
// counts as open: the transaction exists until COMMIT/ROLLBACK.
void import("@tauri-apps/api/event").then(({ listen }) =>
  listen<{ session_id: string; state: "idle" | "in_tx" | "failed_tx" }>("tx-state", (e) => {
    const conns = useConnections.getState();
    const entry = Object.entries(conns.tabSessions).find(
      ([, sid]) => sid === e.payload.session_id,
    );
    if (!entry) return; // primary/spare sessions have no chip
    conns.setTxTab(entry[0], e.payload.state !== "idle");
  }),
  // a subscription that cannot be made is reported, never left to reject
  // unhandled: the tx chip is what goes quiet, and silence is what a failure
  // must never be (LESSONS 9)
).catch((e) => console.error("tx-state listen failed", e));

// server NOTICEs → the tab whose session raised them (session ids are unique
// per tab session, so routing is exact; notices from unknown sessions
// (primary/spare/introspection) are dropped, matching psql's per-session view)
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
).catch((e) => console.error("pg-notice listen failed", e));

// ---- Ask's one door into a query tab (A4, AGENT-UX section 13.6) ----------
// Ask proposes a change and never runs one itself: the statement runs HERE,
// in the connection's active query tab, through the same `run` above that ⌘↩
// drives, so the tab's own ceremony (the no-WHERE confirm with its planner
// estimates, the staged-edit confirm, the prod safe-mode chip) is the
// ceremony a proposal gets, unchanged and over the window rather than the
// pane. Wrapped in BEGIN when the tab holds no transaction, so what the tab
// already knows how to do, Commit and Rollback, is the rollback plan
// (DESIGN rule 15). One exported function, nothing else: a second run path
// for writes is exactly the founding sin DESIGN rule 1 exists to prevent.

/** What the TAB reported, which is the only account of the run there is:
 * `rows` is its own affected count, never the dry run's `exact_rows`, which
 * a concurrent writer can have made stale (LESSONS 13). */
export interface TabRunOutcome {
  /** the statement reached the database: every confirm said yes */
  ran: boolean;
  /** rows affected, as the tab counted them; null when nothing ran or the
   * statement errored */
  rows: number | null;
  /** `skey(profile, tab)` of the tab it ran in, so a reader can watch THAT
   * tab's transaction rather than whichever tab is active later */
  tabKey: string;
  /** the first line of the tab's error; null when it ran clean */
  error: string | null;
}

/** Run ONE statement in the connection's active query tab. A table tab, a
 * tab of another connection or no tab at all means a query tab is opened for
 * it, carrying the statement as its text, and the cue says so (the W7 Insert
 * precedent, LESSONS 9: a silent no-op reads as broken). */
export async function runStatementInTab(
  profileId: string,
  sql: string,
  tabName?: string,
): Promise<TabRunOutcome> {
  const conn = useConnections.getState();
  // the strip belongs to the ACTIVE connection: a tab opened while another
  // one is on screen would land in that one's workspace (LESSONS 4)
  if (conn.activeProfileId !== profileId) {
    return { ran: false, rows: null, tabKey: "", error: "the connection is no longer active" };
  }
  const statement = sql.trim();
  if (!statement) return { ran: false, rows: null, tabKey: "", error: "no statement" };

  const tabs = useTabs.getState();
  const active = tabs.tabs.find((t) => t.id === tabs.activeId);
  const usable =
    active && active.kind === "query" && isTabVisible(active, tabs.pinned, profileId);
  let created = false;
  if (!usable) {
    tabs.newTab(statement, tabName);
    created = true;
  }
  const tabId = useTabs.getState().activeId;
  if (!tabId) return { ran: false, rows: null, tabKey: "", error: "no query tab" };
  const tabKey = skey(profileId, tabId);

  // the tab's own transaction is the rollback plan: one is opened only when
  // the tab has none, so a statement never lands inside somebody else's
  const text = useConnections.getState().txTabs[tabKey] ? statement : `BEGIN;\n${statement}`;
  await useResults.getState().run(text, 0, { profileId });

  const tab = useResults.getState().byTab[tabId];
  // `run` returns early and writes nothing when a confirm says no or the tab
  // is already busy: the statement it executed is the only proof it ran
  const ran = tab?.executedSql === text;
  const failed = tab?.statements.find((st) => st.error) ?? null;
  const error = failed?.error?.message ?? tab?.globalError?.message ?? null;
  const last = tab?.statements[tab.statements.length - 1];
  if (ran && created) copyCueShow("Ran in a new tab");
  return {
    ran,
    rows: ran && !error ? (last?.affected ?? last?.rowCount ?? null) : null,
    tabKey,
    error: error ? error.split("\n")[0].trim() : null,
  };
}
