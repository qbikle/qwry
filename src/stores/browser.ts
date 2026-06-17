import { create } from "zustand";
import type { TableInfo } from "./schema";
import { useResults } from "./results";
import { useTabs } from "./tabs";
import * as ipc from "../ipc/commands";

export type FilterOp =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "LIKE"
  | "ILIKE"
  | "IN"
  | "IS NULL"
  | "IS NOT NULL";

export const FILTER_OPS: FilterOp[] = [
  "=", "!=", ">", "<", ">=", "<=", "LIKE", "ILIKE", "IN", "IS NULL", "IS NOT NULL",
];

export interface Filter {
  col: string;
  op: FilterOp;
  value: string;
  enabled: boolean;
  /** how this row chains onto the previous one (ignored on the first) */
  conj: "AND" | "OR";
}

/** one cell of the inline draft (new) row; untouched columns are absent from the
 * draft map so their DB default applies on insert */
export interface DraftCell {
  text: string;
  isNull: boolean;
}

const PAGE = 1000;

/** per-tab browse state (the browsed table itself lives on the Tab) */
interface BrowseTab {
  tab: "data" | "structure";
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
  /** open (or focus) a data-browser tab for a table */
  openTable: (t: TableInfo) => void;
  /** forget a closed tab's browse state */
  clearTab: (tabId: string) => void;
  setTab: (t: "data" | "structure") => void;
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
  beginDraft: () => void;
  cancelDraft: () => void;
  setDraftCell: (col: string, cell: DraftCell) => void;
  commitDraft: () => Promise<void>;
}

const ql = (v: string) => `'${v.replace(/'/g, "''")}'`;
const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function browseSql(s: {
  table: TableInfo;
  filters: Filter[];
  sort: BrowserState["sort"];
  limit: number;
}): string {
  const t = `${qi(s.table.schema)}.${qi(s.table.name)}`;
  const active = s.filters.filter(
    (f) => f.enabled && f.col && (f.op.includes("NULL") || f.value !== ""),
  );
  const conds = active.map((f) => {
    if (f.op === "IS NULL" || f.op === "IS NOT NULL") return `${qi(f.col)} ${f.op}`;
    if (f.op === "IN") {
      const vals = f.value.split(",").map((v) => ql(v.trim())).join(", ");
      return `${qi(f.col)} IN (${vals})`;
    }
    return `${qi(f.col)} ${f.op} ${ql(f.value)}`;
  });
  // chained left-to-right; SQL precedence still binds AND tighter than OR
  const where =
    conds.length > 0
      ? `\nWHERE ${conds
          .map((c, i) => (i === 0 ? `(${c})` : `${active[i].conj} (${c})`))
          .join("\n  ")}`
      : "";
  const order = s.sort ? `\nORDER BY ${qi(s.sort.col)} ${s.sort.dir}` : "";
  // ordinary tables without a PK get ctid so they stay editable/deletable
  const cols = s.table.pk.length === 0 && s.table.kind === "r" ? "ctid, *" : "*";
  return `SELECT ${cols} FROM ${t}${where}${order}\nLIMIT ${s.limit}`;
}

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

/** rerun the active tab's browse query (results land in the active tab) */
function run(s: BrowserState) {
  if (!s.table) return;
  void useResults.getState().run(
    browseSql({ table: s.table, filters: s.filters, sort: s.sort, limit: s.limit }),
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

  openTable: (t) => {
    const tabsApi = useTabs.getState();
    // already open in a tab → just focus it
    const existing = tabsApi.tabs.find(
      (tb) => tb.kind === "table" && tb.table?.schema === t.schema && tb.table?.name === t.name,
    );
    if (existing) {
      tabsApi.select(existing.id);
      return;
    }
    const id = tabsApi.openTableTab(t); // creates + selects → fires syncActive
    set((s) => ({ byTab: { ...s.byTab, [id]: blankBrowse() } }));
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
    writeBrowse(set, get().active, { filters, limit: PAGE });
    run(get());
  },

  setSort: (sort) => {
    writeBrowse(set, get().active, { sort, limit: PAGE });
    run(get());
  },

  loadMore: () => {
    const s = get();
    const res = useResults.getState();
    const stmt = res.statements[0];
    // only grow when the current page actually filled up
    if (res.running || !stmt || stmt.rows.length < s.limit) return;
    writeBrowse(set, s.active, { limit: s.limit + PAGE });
    run(get());
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

  beginDraft: () => writeBrowse(set, get().active, { draftRow: {}, draftError: null }),
  cancelDraft: () => writeBrowse(set, get().active, { draftRow: null, draftError: null }),
  setDraftCell: (col, cell) =>
    writeBrowse(set, get().active, (t) =>
      t.draftRow ? { draftRow: { ...t.draftRow, [col]: cell } } : {},
    ),

  commitDraft: async () => {
    const s = get();
    if (!s.table || !s.draftRow) return;
    const draft = s.draftRow;
    const cols: string[] = [];
    const values: (string | null)[] = [];
    // iterate real table columns: NULL → explicit null, value → text,
    // untouched → omit so the column default applies
    for (const c of s.table.columns) {
      const cell = draft[c.name];
      if (!cell) continue;
      if (cell.isNull) {
        cols.push(c.name);
        values.push(null);
      } else if (cell.text !== "") {
        cols.push(c.name);
        values.push(cell.text);
      }
    }
    const res = await get().insertRow(cols, values);
    if (res.ok) writeBrowse(set, get().active, { draftRow: null, draftError: null });
    else writeBrowse(set, get().active, { draftError: res.error ?? "insert failed" });
  },
}));

// follow the editor's active tab (useTabs owns the canonical active tab id)
if (useTabs.getState().activeId) useBrowser.getState().syncActive(useTabs.getState().activeId!);
useTabs.subscribe((s, p) => {
  if (s.activeId && s.activeId !== p.activeId) useBrowser.getState().syncActive(s.activeId);
});
