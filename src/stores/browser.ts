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
  | "contains"
  | "starts with"
  | "ends with"
  | "LIKE"
  | "ILIKE"
  | "NOT LIKE"
  | "NOT ILIKE"
  | "~"
  | "!~"
  | "IN"
  | "NOT IN"
  | "IS"
  | "IS NOT"
  | "IS NULL"
  | "IS NOT NULL"
  | "IS TRUE"
  | "IS FALSE"
  | "raw SQL";

export const FILTER_OPS: FilterOp[] = [
  "=", "!=", ">", "<", ">=", "<=",
  "contains", "starts with", "ends with",
  "LIKE", "ILIKE", "NOT LIKE", "NOT ILIKE", "~", "!~",
  "IN", "NOT IN", "IS NULL", "IS NOT NULL", "IS TRUE", "IS FALSE",
  "raw SQL",
];

/** operators that make sense for a column's type — everything else is noise
 * (or a guaranteed server error, e.g. ILIKE on an integer) */
export function opsForType(type: string): FilterOp[] {
  const t = type.toLowerCase();
  if (t === "boolean" || t === "bool") return ["IS", "IS NOT", "raw SQL"];
  if (/int|numeric|decimal|real|double|float|money|serial|oid/.test(t))
    return ["=", "!=", ">", "<", ">=", "<=", "IN", "NOT IN", "IS NULL", "IS NOT NULL", "raw SQL"];
  if (/timestamp|date|time|interval/.test(t))
    return ["=", "!=", ">", "<", ">=", "<=", "IS NULL", "IS NOT NULL", "raw SQL"];
  if (/json|uuid|bytea/.test(t))
    return ["=", "!=", "IS NULL", "IS NOT NULL", "raw SQL"];
  return FILTER_OPS;
}

const NO_VALUE_OPS = new Set<FilterOp>(["IS NULL", "IS NOT NULL", "IS TRUE", "IS FALSE"]);
export const opNeedsValue = (op: FilterOp) => !NO_VALUE_OPS.has(op);

export interface Filter {
  col: string;
  op: FilterOp;
  value: string;
  enabled: boolean;
  /** how this row chains onto the previous one (ignored on the first) */
  conj: "AND" | "OR";
}

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

const ql = (v: string) => `'${v.replace(/'/g, "''")}'`;
const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;
/** in-flight commit guards, per tab — a second ⌘↵ during the insert round
 * trip must not fire a second identical INSERT */
const draftCommitting = new Set<string>();

export function browseSql(s: {
  table: TableInfo;
  filters: Filter[];
  sort: BrowserState["sort"];
  limit: number;
}): string {
  const t = `${qi(s.table.schema)}.${qi(s.table.name)}`;
  const active = s.filters.filter(
    (f) => f.enabled && f.col && (!opNeedsValue(f.op) || f.value !== ""),
  );
  const like = (v: string) => v.replace(/([%_\\])/g, "\\$1");
  const conds = active.map((f) => {
    switch (f.op) {
      case "IS NULL":
      case "IS NOT NULL":
      case "IS TRUE":
      case "IS FALSE":
        return `${qi(f.col)} ${f.op}`;
      case "IS":
      case "IS NOT": {
        // bool three-state — value comes from a fixed select, whitelisted
        const kw = ["TRUE", "FALSE", "NULL"].includes(f.value) ? f.value : "TRUE";
        return `${qi(f.col)} ${f.op} ${kw}`;
      }
      case "IN":
      case "NOT IN": {
        const vals = f.value.split(",").map((v) => ql(v.trim())).join(", ");
        return `${qi(f.col)} ${f.op} (${vals})`;
      }
      case "contains":
        return `${qi(f.col)} ILIKE ${ql(`%${like(f.value)}%`)}`;
      case "starts with":
        return `${qi(f.col)} ILIKE ${ql(`${like(f.value)}%`)}`;
      case "ends with":
        return `${qi(f.col)} ILIKE ${ql(`%${like(f.value)}`)}`;
      case "raw SQL":
        // explicit escape hatch — the value is a predicate, used verbatim
        return `(${f.value})`;
      default:
        return `${qi(f.col)} ${f.op} ${ql(f.value)}`;
    }
  });
  // fold left-associatively so the SQL means what the linear UI reads:
  // A OR B AND C compiles to ((A OR B) AND C), never A OR (B AND C)
  const where =
    conds.length > 0
      ? `\nWHERE ${conds
          .map((c) => `(${c})`)
          .reduce((acc, c, i) => (i === 0 ? c : `(${acc} ${active[i].conj} ${c})`))}`
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
    const s = get();
    const before = s.table
      ? browseSql({ table: s.table, filters: s.filters, sort: s.sort, limit: PAGE })
      : "";
    writeBrowse(set, s.active, { filters, limit: PAGE });
    const after = get();
    const afterSql = after.table
      ? browseSql({ table: after.table, filters: after.filters, sort: after.sort, limit: PAGE })
      : "";
    if (afterSql !== before) run(after);
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
    void import("./edits").then(({ useEdits }) => {
      // parked while edits are staged — the loadMore re-run would wipe them
      // (and a confirm modal on mere scrolling would be hostile)
      if (Object.keys(useEdits.getState().byTab[s.active]?.pending ?? {}).length > 0) return;
      writeBrowse(set, s.active, { limit: get().limit + PAGE });
      run(get());
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
