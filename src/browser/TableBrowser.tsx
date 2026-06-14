import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { menuIn, popIn } from "../design/springs";
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
  const [inserting, setInserting] = useState(false);

  // close the insert panel when switching table or tab
  useEffect(() => {
    setInserting(false);
  }, [table?.table_oid, tab]);

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
        {tab === "data" && table.kind === "r" && (
          <button
            className={`icon-btn${inserting ? " active" : ""}`}
            title="Add row"
            onClick={() => setInserting((v) => !v)}
          >
            <Plus size={15} />
          </button>
        )}
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
          {inserting && <InsertPanel onClose={() => setInserting(false)} />}
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

function InsertPanel({ onClose }: { onClose: () => void }) {
  const table = useBrowser((s) => s.table)!;
  const insertRow = useBrowser((s) => s.insertRow);
  const [vals, setVals] = useState<Record<string, { text: string; isNull: boolean }>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const cell = (name: string) => vals[name] ?? { text: "", isNull: false };
  const setText = (name: string, text: string) =>
    setVals((v) => ({ ...v, [name]: { text, isNull: false } }));
  const toggleNull = (name: string) =>
    setVals((v) => ({ ...v, [name]: { text: "", isNull: !cell(name).isNull } }));

  const submit = async () => {
    const cols: string[] = [];
    const values: (string | null)[] = [];
    for (const c of table.columns) {
      const st = cell(c.name);
      if (st.isNull) {
        cols.push(c.name);
        values.push(null);
      } else if (st.text !== "") {
        cols.push(c.name);
        values.push(st.text);
      }
      // untouched → omit so the column default applies
    }
    setSaving(true);
    setError(null);
    const res = await insertRow(cols, values);
    setSaving(false);
    if (res.ok) onClose();
    else setError(res.error ?? "insert failed");
  };

  return (
    <motion.div
      className="tb-insert"
      {...popIn}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
      }}
    >
      <div className="tb-insert-head">
        <span>New row in {table.name}</span>
        <span className="tb-insert-hint">blank = default · ∅ = NULL · ⌘↵ insert</span>
      </div>
      <div className="tb-insert-grid">
        {table.columns.map((c) => {
          const st = cell(c.name);
          return (
            <div key={c.name} className="tb-insert-field">
              <div className="tb-insert-label">
                <span className="tb-insert-name">{c.name}</span>
                <span className="tb-insert-type">
                  {c.type}
                  {c.not_null ? " · not null" : ""}
                </span>
              </div>
              <div className={`tb-insert-input${st.isNull ? " is-null" : ""}`}>
                <input
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus={c === table.columns[0]}
                  value={st.isNull ? "" : st.text}
                  placeholder={
                    st.isNull ? "NULL" : c.default ? `default: ${c.default}` : "DEFAULT"
                  }
                  disabled={st.isNull}
                  onChange={(e) => setText(c.name, e.target.value)}
                />
                <button
                  type="button"
                  className={`tb-null-btn${st.isNull ? " on" : ""}`}
                  title="Set NULL"
                  onClick={() => toggleNull(c.name)}
                >
                  ∅
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="tb-insert-error">{error}</div>}
      <div className="tb-insert-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={saving} onClick={() => void submit()}>
          {saving ? "Inserting…" : "Insert row"}
        </button>
      </div>
    </motion.div>
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
          <motion.div className="tbs-pop" {...menuIn}>
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
          </motion.div>
      )}
    </div>
  );
}
