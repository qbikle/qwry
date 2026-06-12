import { useEffect, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { FILTER_OPS, useBrowser, type Filter } from "../stores/browser";
import { useResults } from "../stores/results";
import { nearEndHook } from "../grid/Grid";
import { ResultsPane } from "../grid/ResultsPane";
import { StructureTab } from "./StructureTab";
import "./browser.css";

export function TableBrowser() {
  const table = useBrowser((s) => s.table);

  // infinite scroll: grow LIMIT when the grid nears its bottom
  useEffect(() => {
    nearEndHook.current = () => useBrowser.getState().loadMore();
    return () => {
      nearEndHook.current = null;
    };
  }, []);
  const tab = useBrowser((s) => s.tab);
  const setTab = useBrowser((s) => s.setTab);
  const close = useBrowser((s) => s.close);
  const refresh = useBrowser((s) => s.refresh);
  const running = useResults((s) => s.running);

  if (!table) return null;

  return (
    <div className="tbrowser">
      <div className="tb-header">
        <span className="tb-title">
          {table.schema !== "public" && <span className="tb-schema">{table.schema}.</span>}
          {table.name}
        </span>
        <div className="tb-tabs">
          <button className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}>
            Data
          </button>
          <button
            className={tab === "structure" ? "active" : ""}
            onClick={() => setTab("structure")}
          >
            Structure
          </button>
        </div>
        <button
          className="icon-btn"
          title="Refresh"
          onClick={refresh}
          disabled={running}
        >
          <RefreshCw size={13} className={running ? "spin" : ""} />
        </button>
        <button className="icon-btn" title="Close (back to editor)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      {tab === "data" ? (
        <>
          <FilterBar />
          <div className="tb-results">
            <ResultsPane />
          </div>
        </>
      ) : (
        <StructureTab table={table} />
      )}
    </div>
  );
}

function FilterBar() {
  const table = useBrowser((s) => s.table)!;
  const filters = useBrowser((s) => s.filters);
  const setFilters = useBrowser((s) => s.setFilters);

  const update = (i: number, patch: Partial<Filter>) =>
    setFilters(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  return (
    <div className="tb-filters">
      {filters.map((f, i) => (
        <div key={i} className="tb-filter">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => update(i, { enabled: e.target.checked })}
          />
          {i === 0 ? (
            <span className="tb-conj-label">WHERE</span>
          ) : (
            <select
              className="tb-conj"
              value={f.conj}
              onChange={(e) => update(i, { conj: e.target.value as "AND" | "OR" })}
            >
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          )}
          <select value={f.col} onChange={(e) => update(i, { col: e.target.value })}>
            {table.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={f.op}
            onChange={(e) => update(i, { op: e.target.value as Filter["op"] })}
          >
            {FILTER_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          {!f.op.includes("NULL") && (
            <input
              className="tb-filter-value"
              placeholder={f.op === "IN" ? "a, b, c" : "value"}
              value={f.value}
              onChange={(e) => update(i, { value: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && setFilters([...filters])}
            />
          )}
          <button
            className="icon-btn"
            onClick={() => setFilters(filters.filter((_, j) => j !== i))}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="tb-filter-actions">
        <button
          className="tb-addfilter"
          onClick={() =>
            setFilters([
              ...filters,
              {
                col: table.columns[0]?.name ?? "",
                op: "=",
                value: "",
                enabled: true,
                conj: "AND",
              },
            ])
          }
        >
          <Plus size={12} /> Filter
        </button>
        <SortSelect />
      </div>
    </div>
  );
}

function fuzzy(needle: string, hay: string): boolean {
  let i = 0;
  const n = needle.toLowerCase();
  for (const ch of hay.toLowerCase()) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return n.length === 0;
}

function SortSelect() {
  const table = useBrowser((s) => s.table)!;
  const sort = useBrowser((s) => s.sort);
  const setSort = useBrowser((s) => s.setSort);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // PKs + time-ish columns are what you actually sort by — surface them first
  const quick = table.columns.filter(
    (c) =>
      table.pk.includes(c.name) ||
      c.type.includes("timestamp") ||
      c.type === "date" ||
      c.type.includes("time"),
  );
  const quickNames = new Set(quick.map((c) => c.name));
  const rest = table.columns.filter((c) => !quickNames.has(c.name));

  const match = (cols: typeof table.columns) =>
    cols.filter((c) => fuzzy(query, c.name));
  const quickM = match(quick);
  const restM = match(rest);

  // click = sort ASC; click the active column again = flip direction
  const pick = (col: string) => {
    if (sort?.col === col) {
      setSort({ col, dir: sort.dir === "ASC" ? "DESC" : "ASC" });
    } else {
      setSort({ col, dir: "ASC" });
    }
  };

  const row = (c: (typeof table.columns)[number]) => (
    <div
      key={c.name}
      className={`tbs-row${sort?.col === c.name ? " active" : ""}`}
      onClick={() => pick(c.name)}
    >
      <span className="tbs-name">{c.name}</span>
      {sort?.col === c.name && <span>{sort.dir === "ASC" ? "↑" : "↓"}</span>}
    </div>
  );

  return (
    <div className="tbs-wrap">
      <button className="tb-sort-btn" onClick={() => setOpen(!open)}>
        {sort ? `${sort.col} ${sort.dir === "ASC" ? "↑" : "↓"}` : "Sort"}
      </button>
      {open && <div className="tbs-backdrop" onMouseDown={() => setOpen(false)} />}
      {open && (
          <div className="tbs-pop">
            <input
              autoFocus
              placeholder="Search columns…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter") {
                  const first = quickM[0] ?? restM[0];
                  if (first) {
                    pick(first.name);
                    setOpen(false);
                  }
                }
              }}
            />
            <div className="tbs-list">
              {sort && (
                <div
                  className="tbs-row tbs-clear"
                  onClick={() => {
                    setSort(null);
                    setOpen(false);
                  }}
                >
                  <X size={12} />
                  <span>Clear sort</span>
                </div>
              )}
              {quickM.length > 0 && <div className="tbs-group">PK & time</div>}
              {quickM.map(row)}
              {restM.length > 0 && <div className="tbs-group">All columns</div>}
              {restM.map(row)}
            </div>
          </div>
      )}
    </div>
  );
}
