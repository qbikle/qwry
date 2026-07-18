import { create } from "zustand";
import type { TableInfo } from "./schema";
import { useSchema } from "./schema";
import { useResults } from "./results";
import { useTabs } from "./tabs";
import { useConnections } from "./connections";
import * as ipc from "../ipc/commands";
import {
  browsePageSql,
  browseSql,
  keysetKeys,
  type Filter,
  type KeysetKey,
} from "./browseSql";

// SQL generation is pure and lives in browseSql.ts (testable outside Tauri);
// re-exported here so existing importers keep one entry point.
export { browseSql, FILTER_OPS, opNeedsValue, opsForType } from "./browseSql";
export type { Filter, FilterOp } from "./browseSql";

/** one cell of the inline draft (new) row. Untouched columns (absent, or
 * present but never typed into) take their DB DEFAULT; `isNull` inserts NULL;
 * `touched` with empty text inserts a real '' — all three are expressible */
export interface DraftCell {
  text: string;
  isNull: boolean;
  touched?: boolean;
}

const PAGE = 1000;

/** per-tab browse state (the browsed table itself lives on the Tab) */
interface BrowseTab {
  tab: "data" | "structure" | "ddl";
  filters: Filter[];
  sort: { col: string; dir: "ASC" | "DESC" } | null;
  limit: number;
  draftRow: Record<string, DraftCell> | null;
  draftError: string | null;
}
const blankBrowse = (): BrowseTab => ({
  tab: "data",
  filters: [],
  sort: null,
  limit: PAGE,
  draftRow: null,
  draftError: null,
});

// top-level mirrors the active tab's BrowseTab (like results/edits); byTab is the
// source of truth so every table tab keeps its own filters/sort/scroll/draft.
interface BrowserState extends BrowseTab {
  byTab: Record<string, BrowseTab>;
  active: string;
  /** the active tab's table (null when the active tab is a query tab) */
  table: TableInfo | null;

  /** re-mirror after the active tab changes (driven by useTabs) */
  syncActive: (tabId: string) => void;
  /** open (or focus) a data-browser tab for a table; optional initial
   * filters land BEFORE the first query (FK navigation) */
  openTable: (t: TableInfo, initialFilters?: Filter[]) => void;
  /** forget a closed tab's browse state */
  clearTab: (tabId: string) => void;
  setTab: (t: "data" | "structure" | "ddl") => void;
  setFilters: (f: Filter[]) => void;
  setSort: (s: BrowseTab["sort"]) => void;
  loadMore: () => void;
  refresh: () => void;
  /** insert a row; cols/values cover only the columns the user set */
  insertRow: (
    cols: string[],
    values: (string | null)[],
  ) => Promise<{ ok: boolean; error?: string }>;
  /** inline add-row: open a blank draft, edit cells, commit/cancel */
  /** inline add-row; optional prefill (duplicate-row minus PK) */
  beginDraft: (prefill?: Record<string, DraftCell>) => void;
  cancelDraft: () => void;
  setDraftCell: (col: string, cell: DraftCell) => void;
  commitDraft: () => Promise<void>;
}

/** in-flight commit guards, per tab — a second ⌘↵ during the insert round
 * trip must not fire a second identical INSERT */
const draftCommitting = new Set<string>();

type SetFn = (fn: (s: BrowserState) => Partial<BrowserState>) => void;

/** write a partial into byTab[tabId]; mirror to the top level if it's active */
function writeBrowse(
  set: SetFn,
  tabId: string,
  partial: Partial<BrowseTab> | ((t: BrowseTab) => Partial<BrowseTab>),
) {
  set((s) => {
    const cur = s.byTab[tabId] ?? blankBrowse();
    const p = typeof partial === "function" ? partial(cur) : partial;
    const next = { ...cur, ...p };
    const byTab = { ...s.byTab, [tabId]: next };
    return tabId === s.active ? { byTab, ...next } : { byTab };
  });
}

/** server_version_num from the profile's schema snapshot; null = unknown
 * (pre-introspect cache hydrate) — only gates the ctid keyset path */
function serverVersionNum(profileId: string | null): number | null {
  if (!profileId) return null;
  return useSchema.getState().snapshots[profileId]?.server_version_num ?? null;
}

/** keyset sort keys for the current browse, or null → offset fallback */
function keysFor(table: TableInfo, sort: BrowserState["sort"]): KeysetKey[] | null {
  return keysetKeys(table, sort, serverVersionNum(useConnections.getState().activeProfileId));
}

/** in-flight keyset page fetches, per tab */
const pageInflight = new Set<string>();
/** frontend row ceiling for keyset scrolling — mirrors the driver's ROW_CAP
 * so "browse forever" can't grow memory past what a capped query would */
const ROW_HARD_CAP = 50_000;

/** the next-page SQL seeded from the last loaded row's key values, or null
 * when it can't be built honestly: a key column missing from the result, or
 * its last-row cell TRUNCATED at the backend cell cap (seeking from a cut
 * value would silently fetch wrong rows) */
function pageSqlFromLastRow(
  table: TableInfo,
  filters: Filter[],
  keys: KeysetKey[],
  stmt: { columns: { name: string }[]; rows: (string | null)[][]; truncated: Set<string> },
): string | null {
  const lastIdx = stmt.rows.length - 1;
  const lastRow = stmt.rows[lastIdx];
  if (!lastRow) return null;
  const last: (string | null)[] = [];
  for (const k of keys) {
    const ci = stmt.columns.findIndex((c) => c.name === k.col);
    if (ci === -1 || ci >= lastRow.length) return null;
    if (stmt.truncated.has(`${lastIdx}:${ci}`)) return null;
    last.push(lastRow[ci]);
  }
  return browsePageSql({ table, filters, keys, last, limit: PAGE });
}

interface PageResult {
  rows: (string | null)[][];
  /** (row-in-page, col) truncation markers, page-relative */
  truncated: [number, number][];
}

/** run one page query on the tab's session, collecting rows off the stream
 * (bypasses useResults.run — a page must APPEND, never replace, and scroll
 * pages don't belong in history) */
async function fetchPage(sessionId: string, sql: string): Promise<PageResult> {
  const rows: (string | null)[][] = [];
  const truncated: [number, number][] = [];
  await ipc.executeStream(sessionId, sql, (ev) => {
    if (ev.type === "rows") {
      const base = rows.length;
      for (const [r, c] of ev.truncated) truncated.push([base + r, c]);
      rows.push(...ev.rows);
    }
  });
  return { rows, truncated };
}

/** append a fetched page onto the tab's first statement. Drops the page when
 * the result set changed underneath (re-run, commit patch, session swap) —
 * the seek was built against the old rows, so appending would lie; the fresh
 * result's own scrolling refetches. */
function appendPage(
  set: SetFn,
  tabId: string,
  sessionId: string,
  seededRows: (string | null)[][],
  page: PageResult,
) {
  let appended = false;
  useResults.setState((rs) => {
    const t = rs.byTab[tabId];
    const st0 = t?.statements[0];
    if (!t || !st0 || t.executedSessionId !== sessionId || st0.rows !== seededRows) return rs;
    const rows = [...st0.rows, ...page.rows];
    const truncated = new Set(st0.truncated);
    const base = st0.rows.length;
    for (const [r, c] of page.truncated) truncated.add(`${base + r}:${c}`);
    const next = {
      ...t,
      statements: t.statements.map((st, i) =>
        i === 0
          ? {
              ...st,
              rows,
              truncated,
              rowCount: st.rowCount + page.rows.length,
              capped:
                st.capped || (page.rows.length === PAGE && rows.length >= ROW_HARD_CAP),
            }
          : st,
      ),
    };
    appended = true;
    return rs.active === tabId
      ? { byTab: { ...rs.byTab, [tabId]: next }, ...next }
      : { byTab: { ...rs.byTab, [tabId]: next } };
  });
  // keep the fill-check invariant: rows.length < limit ⇢ end of data reached
  if (appended) writeBrowse(set, tabId, (t) => ({ limit: t.limit + PAGE }));
}

/** rerun the active tab's browse query (results land in the active tab) */
function run(s: BrowserState) {
  if (!s.table) return;
  void useResults.getState().run(
    browseSql({
      table: s.table,
      filters: s.filters,
      sort: s.sort,
      limit: s.limit,
      keys: keysFor(s.table, s.sort),
    }),
  );
}

export const useBrowser = create<BrowserState>((set, get) => ({
  ...blankBrowse(),
  byTab: {},
  active: "",
  table: null,

  syncActive: (tabId) => {
    const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
    const table = tab && tab.kind === "table" ? tab.table : null;
    set((s) => ({ active: tabId, table, ...(s.byTab[tabId] ?? blankBrowse()) }));
  },

  openTable: (t, initialFilters) => {
    const tabsApi = useTabs.getState();
    // already open in a tab → focus it (and apply the requested filter)
    const existing = tabsApi.tabs.find(
      (tb) => tb.kind === "table" && tb.table?.schema === t.schema && tb.table?.name === t.name,
    );
    if (existing) {
      tabsApi.select(existing.id);
      if (initialFilters) get().setFilters(initialFilters);
      return;
    }
    const id = tabsApi.openTableTab(t); // creates + selects → fires syncActive
    set((s) => ({
      byTab: { ...s.byTab, [id]: { ...blankBrowse(), filters: initialFilters ?? [] } },
    }));
    get().syncActive(id);
    run(get());
  },

  clearTab: (tabId) =>
    set((s) => {
      const { [tabId]: _gone, ...byTab } = s.byTab;
      return { byTab };
    }),

  setTab: (tab) => writeBrowse(set, get().active, { tab }),

  setFilters: (filters) => {
    // only hit the server when the effective SQL actually changed — toggling
    // an incomplete filter row or picking a column before typing a value
    // used to re-run the unfiltered SELECT
    const sqlOf = (st: BrowserState) =>
      st.table
        ? browseSql({
            table: st.table,
            filters: st.filters,
            sort: st.sort,
            limit: PAGE,
            keys: keysFor(st.table, st.sort),
          })
        : "";
    const s = get();
    const before = sqlOf(s);
    writeBrowse(set, s.active, { filters, limit: PAGE });
    const after = get();
    if (sqlOf(after) !== before) run(after);
  },

  setSort: (sort) => {
    writeBrowse(set, get().active, { sort, limit: PAGE });
    run(get());
  },

  loadMore: () => {
    const s = get();
    const tabId = s.active;
    const table = s.table;
    if (!table) return;
    const res = useResults.getState();
    const tabRes = res.byTab[tabId];
    const stmt = tabRes?.statements[0];
    // only grow when the current page actually filled up (a short page means
    // end of data); capped = the honest frontend row ceiling was reached
    if (res.running || !stmt || !stmt.done || stmt.error || stmt.capped) return;
    if (stmt.rows.length < s.limit || pageInflight.has(tabId)) return;
    const filters = s.filters;
    const sort = s.sort;
    void import("./edits").then(({ useEdits }) => {
      // re-check past the async boundary — two rapid scroll events can both
      // pass the sync guard before either adds itself
      if (pageInflight.has(tabId)) return;
      // parked while edits are staged — appending/re-running would invalidate
      // their row coordinates (and a confirm modal on mere scrolling would be
      // hostile)
      if (Object.keys(useEdits.getState().byTab[tabId]?.pending ?? {}).length > 0) return;

      // ---- keyset page: WHERE row-value seek from the last loaded row -----
      const keys = keysetKeys(
        table,
        sort,
        serverVersionNum(tabRes.executedProfileId ?? useConnections.getState().activeProfileId),
      );
      const sessionId = tabRes.executedSessionId;
      const pageSql = keys && sessionId ? pageSqlFromLastRow(table, filters, keys, stmt) : null;
      if (!pageSql || !sessionId) {
        // Offset fallback for anything keyset can't serve safely (see
        // keysetKeys / pageSqlFromLastRow): re-run from row 0 with a grown
        // LIMIT — the pre-keyset behavior. O(n²) and, without a unique sort,
        // able to dup/drop rows across pages; kept ONLY as the boundary for
        // non-keysettable relations, never in place of a correct seek.
        writeBrowse(set, tabId, (t) => ({ limit: t.limit + PAGE }));
        run(get());
        return;
      }
      pageInflight.add(tabId);
      void fetchPage(sessionId, pageSql)
        .then((page) => {
          if (page) appendPage(set, tabId, sessionId, stmt.rows, page);
        })
        .catch((e) => {
          // leave the loaded rows untouched; the next scroll retries (an
          // explicit re-run/refresh surfaces session errors through run())
          console.error("browse loadMore page failed", e);
        })
        .finally(() => pageInflight.delete(tabId));
    });
  },

  refresh: () => run(get()),

  insertRow: async (cols, values) => {
    const s = get();
    if (!s.table) return { ok: false, error: "no table open" };
    // insert on the same session the browse query ran on (shares the tab txn)
    const sessionId = useResults.getState().executedSessionId;
    if (!sessionId) return { ok: false, error: "not connected" };
    try {
      await ipc.insertRow(sessionId, s.table.schema, s.table.name, cols, values);
      run(get()); // reload so the new row shows
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as { message?: string }).message ?? String(e) };
    }
  },

  beginDraft: (prefill) =>
    writeBrowse(set, get().active, { draftRow: prefill ?? {}, draftError: null }),
  cancelDraft: () => writeBrowse(set, get().active, { draftRow: null, draftError: null }),
  setDraftCell: (col, cell) =>
    writeBrowse(set, get().active, (t) =>
      t.draftRow ? { draftRow: { ...t.draftRow, [col]: cell } } : {},
    ),

  commitDraft: async () => {
    const s = get();
    if (!s.table || !s.draftRow) return;
    if (draftCommitting.has(s.active)) return;
    draftCommitting.add(s.active);
    try {
      await commitDraftInner(s, set, get);
    } finally {
      draftCommitting.delete(s.active);
    }
  },
}));

async function commitDraftInner(
  s: BrowserState,
  set: SetFn,
  get: () => BrowserState,
): Promise<void> {
  {
    const draft = s.draftRow!;
    const cols: string[] = [];
    const values: (string | null)[] = [];
    // iterate real table columns: NULL → explicit null, touched → text (a
    // touched-but-empty field is a real ''), untouched → omit so the column
    // DEFAULT applies
    for (const c of s.table!.columns) {
      const cell = draft[c.name];
      if (!cell) continue;
      if (cell.isNull) {
        cols.push(c.name);
        values.push(null);
      } else if (cell.touched || cell.text !== "") {
        cols.push(c.name);
        values.push(cell.text);
      }
    }
    const res = await get().insertRow(cols, values);
    if (res.ok) writeBrowse(set, get().active, { draftRow: null, draftError: null });
    else writeBrowse(set, get().active, { draftError: res.error ?? "insert failed" });
  }
}

// follow the editor's active tab (useTabs owns the canonical active tab id)
if (useTabs.getState().activeId) useBrowser.getState().syncActive(useTabs.getState().activeId!);
useTabs.subscribe((s, p) => {
  if (s.activeId && s.activeId !== p.activeId) useBrowser.getState().syncActive(s.activeId);
});
