import { create } from "zustand";
import type { TableInfo } from "./schema";
import { useResults } from "./results";

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

interface BrowserState {
  table: TableInfo | null;
  tab: "data" | "structure";
  filters: Filter[];
  sort: { col: string; dir: "ASC" | "DESC" } | null;
  limit: number;

  openTable: (t: TableInfo) => void;
  close: () => void;
  setTab: (t: "data" | "structure") => void;
  setFilters: (f: Filter[]) => void;
  setSort: (s: BrowserState["sort"]) => void;
  loadMore: () => void;
  refresh: () => void;
}

const PAGE = 1000;

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
  return `SELECT * FROM ${t}${where}${order}\nLIMIT ${s.limit}`;
}

function run(state: BrowserState) {
  if (!state.table) return;
  void useResults.getState().run(
    browseSql({
      table: state.table,
      filters: state.filters,
      sort: state.sort,
      limit: state.limit,
    }),
  );
}

export const useBrowser = create<BrowserState>((set, get) => ({
  table: null,
  tab: "data",
  filters: [],
  sort: null,
  limit: PAGE,

  openTable: (t) => {
    set({ table: t, tab: "data", filters: [], sort: null, limit: PAGE });
    run(get());
  },

  close: () => set({ table: null }),
  setTab: (tab) => set({ tab }),

  setFilters: (filters) => {
    set({ filters, limit: PAGE });
    run(get());
  },

  setSort: (sort) => {
    set({ sort, limit: PAGE });
    run(get());
  },

  loadMore: () => {
    const s = get();
    const res = useResults.getState();
    const stmt = res.statements[0];
    // only grow when the current page actually filled up
    if (res.running || !stmt || stmt.rows.length < s.limit) return;
    set({ limit: s.limit + PAGE });
    run(get());
  },

  refresh: () => run(get()),
}));
