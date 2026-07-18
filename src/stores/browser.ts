import { create } from "zustand";
import type { TableInfo } from "./schema";
import { useSchema } from "./schema";
import { useResults } from "./results";
import { useTabs } from "./tabs";
import { useConnections } from "./connections";
import * as ipc from "../ipc/commands";
import {
  browseCountSql,
  browsePageSql,
  browseSql,
  compiledWhere,
  keysetKeys,
  type BrowseSort,
  type Filter,
  type KeysetKey,
  type SortChain,
} from "./browseSql";

// SQL generation is pure and lives in browseSql.ts (testable outside Tauri);
// re-exported here so existing importers keep one entry point.
export {
  browseSql,
  compiledWhere,
  parseInList,
  typeClassOf,
  FILTER_OPS,
  opNeedsValue,
  opsForType,
} from "./browseSql";
export type { Filter, FilterOp, SortChain, SortKey, BrowseSort, TypeClass } from "./browseSql";

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
  /** builder ⇄ raw-WHERE escape hatch. In raw mode the textarea's text is the
   * WHERE body, used as written (the user owns it; validated only by
   * running); builder filters are kept but inert until toggled back. */
  whereMode: "builder" | "raw";
  rawWhere: string;
  /** multi-column sort chain — the SOURCE OF TRUTH for ordering.
   * setSortChain is the store contract the grid header wires to. */
  sortChain: SortChain;
  /** legacy single-sort mirror of sortChain[0] (uppercased) for pre-chain
   * consumers (grid header glyph, sort button label); never write directly */
  sort: BrowseSort | null;
  limit: number;
  /** ⌘L jump-to-row: OFFSET of the current result's first row (0 = top).
   * The jump page itself is offset-fetched — honest and one-shot; scrolling
   * onward re-anchors keyset from the landed page's last row, so continuation
   * costs the same as any other page (offset-fallback relations continue by
   * offset growth as before). */
  jumpOffset: number;
  draftRow: Record<string, DraftCell> | null;
  draftError: string | null;
  /** keyset keys (incl. casts) PINNED at run() time — loadMore seeks with
   * THESE, never a live-snapshot recompute: DDL landing mid-scroll would
   * otherwise change the keys under the loaded rows and splice wrong rows */
  pinnedKeys: KeysetKey[] | null;
  /** a committed edit patched a pinned key column — the loaded last row no
   * longer holds the value the executed ORDER BY placed there, so the next
   * loadMore must re-run instead of seeking from the patched value */
  pageStale: boolean;
  /** pagination latch: a page fetch failed; loadMore no-ops until
   * refresh/sort/filter/re-run clears it (unbounded per-scroll retries
   * against a broken seek would hammer the server invisibly) */
  paginationBroken: string | null;
  /** exact-count-on-demand footer: count(*) over the browse WHERE. Cleared by
   * any re-run (fresh result set = the number may be stale). */
  exactCount: number | null;
  counting: boolean;
  countError: string | null;
}
const blankBrowse = (): BrowseTab => ({
  tab: "data",
  filters: [],
  whereMode: "builder",
  rawWhere: "",
  sortChain: [],
  sort: null,
  limit: PAGE,
  jumpOffset: 0,
  draftRow: null,
  draftError: null,
  pinnedKeys: null,
  pageStale: false,
  paginationBroken: null,
  exactCount: null,
  counting: false,
  countError: null,
});

/** the legacy single-sort mirror of a chain's first key */
const sortMirror = (chain: SortChain): BrowseSort | null =>
  chain.length > 0
    ? { col: chain[0].column, dir: chain[0].dir === "desc" ? "DESC" : "ASC" }
    : null;

/** the raw-WHERE text the queries actually use — only when raw mode is on */
const rawWhereArg = (t: Pick<BrowseTab, "whereMode" | "rawWhere">): string | null =>
  t.whereMode === "raw" ? t.rawWhere : null;

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
  /** THE sort contract: replace the whole chain (grid header + toolbar both
   * drive this). Chain shape: [{ column, dir: "asc"|"desc", nulls?: "first"|"last" }] */
  setSortChain: (chain: SortChain) => void;
  /** back-compat shim over setSortChain for single-column callers */
  setSort: (s: BrowseSort | null) => void;
  setWhereMode: (mode: "builder" | "raw") => void;
  setRawWhere: (text: string) => void;
  /** ⌘L jump: re-fetch one page starting at row `offset` (0-based) */
  jumpToRow: (offset: number) => void;
  clearJump: () => void;
  /** footer exact count: SELECT count(*) over the current browse WHERE */
  runExactCount: () => Promise<void>;
  cancelExactCount: () => void;
  loadMore: () => void;
  refresh: () => void;
  /** commit-patch hook (called from edits.ts after a commit patches rows):
   * when any patched column is one of the PINNED keyset key columns, latch
   * the tab stale so the next loadMore re-runs instead of appending — a seek
   * from the patched value would silently skip/dup rows */
  noteCommittedPatch: (tabId: string, cols: string[]) => void;
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
function keysFor(table: TableInfo, chain: SortChain): KeysetKey[] | null {
  return keysetKeys(table, chain, serverVersionNum(useConnections.getState().activeProfileId));
}

/** in-flight keyset page fetches, per tab */
const pageInflight = new Set<string>();
/** frontend row ceiling for keyset scrolling — mirrors the driver's ROW_CAP
 * so "browse forever" can't grow memory past what a capped query would */
const ROW_HARD_CAP = 50_000;

/** exact-count staleness guards: an epoch bump (re-run, newer count request)
 * orphans any in-flight count so its result can never land on a fresh browse */
const countEpoch = new Map<string, number>();
/** session the tab's in-flight count runs on — cancel target */
const countSessions = new Map<string, string>();

/** the next-page SQL seeded from the last loaded row's key values, or null
 * when it can't be built honestly: a key column missing from the result, or
 * its last-row cell TRUNCATED at the backend cell cap (seeking from a cut
 * value would silently fetch wrong rows) */
function pageSqlFromLastRow(
  table: TableInfo,
  filters: Filter[],
  rawWhere: string | null,
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
  return browsePageSql({ table, filters, keys, last, limit: PAGE, rawWhere });
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
    // capped means "rows were actually discarded at the ceiling" — a page
    // that merely lands exactly on the cap is NOT capped (the table may end
    // right there); the next loadMore probes one more page and either hits
    // end-of-data honestly or discards for real
    const room = ROW_HARD_CAP - st0.rows.length;
    const kept = page.rows.length > room ? page.rows.slice(0, Math.max(room, 0)) : page.rows;
    const rows = [...st0.rows, ...kept];
    const truncated = new Set(st0.truncated);
    const base = st0.rows.length;
    for (const [r, c] of page.truncated) {
      if (r < kept.length) truncated.add(`${base + r}:${c}`);
    }
    const next = {
      ...t,
      statements: t.statements.map((st, i) =>
        i === 0
          ? {
              ...st,
              rows,
              truncated,
              rowCount: st.rowCount + kept.length,
              capped: st.capped || page.rows.length > room,
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

/** rerun the active tab's browse query (results land in the active tab).
 * Pins the keyset keys computed HERE onto the tab — the executed ORDER BY is
 * built from exactly these, so page seeks must reuse them verbatim — and
 * clears the stale/broken pagination latches (a fresh result set resets
 * both) plus the exact-count footer (the number no longer describes the new
 * result; an in-flight count is orphaned via its epoch). */
function run(set: SetFn, s: BrowserState) {
  if (!s.table) return;
  const keys = keysFor(s.table, s.sortChain);
  countEpoch.set(s.active, (countEpoch.get(s.active) ?? 0) + 1);
  writeBrowse(set, s.active, {
    pinnedKeys: keys,
    pageStale: false,
    paginationBroken: null,
    exactCount: null,
    counting: false,
    countError: null,
  });
  void useResults.getState().run(
    browseSql({
      table: s.table,
      filters: s.filters,
      sort: s.sortChain,
      limit: s.limit,
      keys,
      rawWhere: rawWhereArg(s),
      offset: s.jumpOffset,
    }),
  );
}

/** structural equality of key lists — cheap drift check for loadMore */
function sameKeys(a: KeysetKey[], b: KeysetKey[] | null): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every(
    (k, i) =>
      k.col === b[i].col &&
      k.dir === b[i].dir &&
      k.cast === b[i].cast &&
      k.notNull === b[i].notNull &&
      k.nulls === b[i].nulls,
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
    run(set, get());
  },

  clearTab: (tabId) =>
    set((s) => {
      const { [tabId]: _gone, ...byTab } = s.byTab;
      countEpoch.delete(tabId);
      countSessions.delete(tabId);
      return { byTab };
    }),

  setTab: (tab) => writeBrowse(set, get().active, { tab }),

  setFilters: (filters) => {
    // only hit the server when the effective SQL actually changed — toggling
    // an incomplete filter row or picking a column before typing a value
    // used to re-run the unfiltered SELECT (and in raw-WHERE mode builder
    // edits are inert by construction). The limit/jump reset lives under the
    // same check: resetting on a no-op change would desync limit from the
    // loaded rows (dead scroll / wasted end-of-data queries).
    const sqlOf = (st: BrowserState) =>
      st.table
        ? browseSql({
            table: st.table,
            filters: st.filters,
            sort: st.sortChain,
            limit: PAGE,
            keys: keysFor(st.table, st.sortChain),
            rawWhere: rawWhereArg(st),
          })
        : "";
    const s = get();
    const before = sqlOf(s);
    writeBrowse(set, s.active, { filters });
    const after = get();
    if (sqlOf(after) !== before) {
      writeBrowse(set, s.active, { limit: PAGE, jumpOffset: 0 });
      run(set, get());
    }
  },

  setSortChain: (chain) => {
    // a new ordering makes both the loaded window and any jump offset
    // meaningless — reset to page 1 of the new order
    writeBrowse(set, get().active, {
      sortChain: chain,
      sort: sortMirror(chain),
      limit: PAGE,
      jumpOffset: 0,
    });
    run(set, get());
  },

  setSort: (s) =>
    get().setSortChain(s ? [{ column: s.col, dir: s.dir === "DESC" ? "desc" : "asc" }] : []),

  setWhereMode: (mode) => {
    const s = get();
    if (s.whereMode === mode) return;
    const before = compiledWhere(s.filters, rawWhereArg(s));
    writeBrowse(set, s.active, { whereMode: mode });
    const after = get();
    // toggling only re-runs when the effective WHERE changed (raw text empty
    // + no active filters toggles freely without server chatter)
    if (compiledWhere(after.filters, rawWhereArg(after)) !== before) {
      writeBrowse(set, s.active, { limit: PAGE, jumpOffset: 0 });
      run(set, get());
    }
  },

  setRawWhere: (text) => {
    const s = get();
    const before = compiledWhere(s.filters, rawWhereArg(s));
    writeBrowse(set, s.active, { rawWhere: text });
    const after = get();
    if (compiledWhere(after.filters, rawWhereArg(after)) !== before) {
      writeBrowse(set, s.active, { limit: PAGE, jumpOffset: 0 });
      run(set, get());
    }
  },

  jumpToRow: (offset) => {
    const s = get();
    if (!s.table) return;
    writeBrowse(set, s.active, {
      limit: PAGE,
      jumpOffset: Math.max(0, Math.floor(offset) || 0),
    });
    run(set, get());
  },

  clearJump: () => {
    const s = get();
    if (s.jumpOffset === 0) return;
    writeBrowse(set, s.active, { limit: PAGE, jumpOffset: 0 });
    run(set, get());
  },

  runExactCount: async () => {
    const s = get();
    const tabId = s.active;
    if (!s.table || s.counting) return;
    const conn = useConnections.getState();
    const pid = conn.activeProfileId;
    // primary preferred (never queued behind the tab session's own page
    // fetches); any live tab session works as fallback — same rule as the
    // planner-estimate probe
    const sid = pid
      ? (conn.sessions[pid] ??
        Object.entries(conn.tabSessions).find(([k]) => k.startsWith(`${pid}::`))?.[1])
      : undefined;
    if (!sid) {
      writeBrowse(set, tabId, { countError: "not connected" });
      return;
    }
    const epoch = (countEpoch.get(tabId) ?? 0) + 1;
    countEpoch.set(tabId, epoch);
    countSessions.set(tabId, sid);
    const sql = browseCountSql({ table: s.table, filters: s.filters, rawWhere: rawWhereArg(s) });
    writeBrowse(set, tabId, { counting: true, countError: null, exactCount: null });
    try {
      const out = await ipc.execute(sid, sql);
      if (countEpoch.get(tabId) !== epoch) return; // superseded — never land stale
      const n = Number(out.statements[0]?.rows[0]?.[0]);
      writeBrowse(
        set,
        tabId,
        Number.isFinite(n)
          ? { counting: false, exactCount: n, countError: null }
          : { counting: false, countError: "count returned nothing" },
      );
    } catch (e) {
      if (countEpoch.get(tabId) !== epoch) return;
      const code = (e as { code?: string | null } | null)?.code ?? null;
      // a user-cancelled count just reverts to the estimate — not an error
      writeBrowse(
        set,
        tabId,
        code === "57014"
          ? { counting: false }
          : { counting: false, countError: (e as { message?: string }).message ?? String(e) },
      );
    } finally {
      if (countEpoch.get(tabId) === epoch) countSessions.delete(tabId);
    }
  },

  cancelExactCount: () => {
    const sid = countSessions.get(get().active);
    // existing escalating cancel path (CancelToken → pg_cancel_backend)
    if (sid) void ipc.cancel(sid).catch(() => {});
  },

  loadMore: () => {
    const s = get();
    const tabId = s.active;
    const table = s.table;
    if (!table) return;
    // pagination latch: a page fetch already failed — retrying per scroll
    // tick would hammer a broken seek invisibly; refresh/sort/filter clears
    if (s.paginationBroken) return;
    const res = useResults.getState();
    const tabRes = res.byTab[tabId];
    const stmt = tabRes?.statements[0];
    // only grow when the current page actually filled up (a short page means
    // end of data); capped = the honest frontend row ceiling was reached
    if (res.running || !stmt || !stmt.done || stmt.error || stmt.capped) return;
    if (stmt.rows.length < s.limit || pageInflight.has(tabId)) return;
    const filters = s.filters;
    const rawWhere = rawWhereArg(s);
    const chain = s.sortChain;
    const pinned = s.pinnedKeys;
    void import("./edits").then(({ useEdits }) => {
      // re-check past the async boundary — two rapid scroll events can both
      // pass the sync guard before either adds itself
      if (pageInflight.has(tabId)) return;
      // parked while edits are staged — appending/re-running would invalidate
      // their row coordinates (and a confirm modal on mere scrolling would be
      // hostile)
      if (Object.keys(useEdits.getState().byTab[tabId]?.pending ?? {}).length > 0) return;
      // run() always targets the ACTIVE tab — if focus moved across the
      // async tick, growing/rerunning would hit the WRONG tab's browse (and
      // poison this one's limit). Skip; this tab's own next scroll retries.
      const rerunActive = () => {
        if (get().active === tabId) run(set, get());
      };

      // a committed edit patched a pinned key column (see noteCommittedPatch)
      // — appending would seek from the patched value; re-run instead.
      // Read LIVE: a commit finishing during the import tick can latch it.
      if (get().byTab[tabId]?.pageStale) {
        rerunActive();
        return;
      }

      // ---- keyset page: WHERE row-value seek from the last loaded row -----
      // Seek with the keys PINNED at run() time — the executed ORDER BY was
      // built from them. A live recompute that drifted (DDL mid-scroll: PK
      // dropped/added, column retyped) means the pinned order no longer
      // matches the snapshot: re-run fresh rather than splicing wrong rows.
      if (pinned) {
        const fresh = keysetKeys(
          table,
          chain,
          serverVersionNum(tabRes.executedProfileId ?? useConnections.getState().activeProfileId),
        );
        if (!sameKeys(pinned, fresh)) {
          rerunActive();
          return;
        }
      }
      const sessionId = tabRes.executedSessionId;
      const pageSql =
        pinned && sessionId ? pageSqlFromLastRow(table, filters, rawWhere, pinned, stmt) : null;
      if (!pageSql || !sessionId) {
        // Offset fallback for anything keyset can't serve safely (see
        // keysetKeys / pageSqlFromLastRow): re-run from the jump offset with
        // a grown LIMIT — the pre-keyset behavior. O(n²) and, without a
        // unique sort, able to dup/drop rows across pages; kept ONLY as the
        // boundary for non-keysettable relations, never in place of a
        // correct seek.
        if (get().active !== tabId) return;
        writeBrowse(set, tabId, (t) => ({ limit: t.limit + PAGE }));
        run(set, get());
        return;
      }
      pageInflight.add(tabId);
      void fetchPage(sessionId, pageSql)
        .then((page) => {
          if (page) appendPage(set, tabId, sessionId, stmt.rows, page);
        })
        .catch((e) => {
          const code = (e as { code?: string | null } | null)?.code ?? null;
          // user-initiated cancels aren't a broken paginator — don't latch
          if (code === "57014" || code === "57P01") return;
          const message = `couldn't load more rows: ${
            (e as { message?: string }).message ?? String(e)
          } — refresh to retry`;
          writeBrowse(set, tabId, { paginationBroken: message });
          // surface on the tab's results banner (globalError renders above
          // the loaded rows without replacing them)
          useResults.setState((rs) => {
            const t = rs.byTab[tabId];
            if (!t) return rs;
            const next = { ...t, globalError: { message, position: null, code } };
            return rs.active === tabId
              ? { byTab: { ...rs.byTab, [tabId]: next }, ...next }
              : { byTab: { ...rs.byTab, [tabId]: next } };
          });
        })
        .finally(() => pageInflight.delete(tabId));
    });
  },

  refresh: () => run(set, get()),

  noteCommittedPatch: (tabId, cols) => {
    const t = get().byTab[tabId];
    if (!t?.pinnedKeys || t.pageStale) return;
    if (!t.pinnedKeys.some((k) => cols.includes(k.col))) return;
    writeBrowse(set, tabId, { pageStale: true });
  },

  insertRow: async (cols, values) => {
    const s = get();
    if (!s.table) return { ok: false, error: "no table open" };
    // insert on the same session the browse query ran on (shares the tab txn)
    const sessionId = useResults.getState().executedSessionId;
    if (!sessionId) return { ok: false, error: "not connected" };
    try {
      await ipc.insertRow(sessionId, s.table.schema, s.table.name, cols, values);
      run(set, get()); // reload so the new row shows
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
