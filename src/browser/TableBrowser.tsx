import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { menuIn } from "../design/springs";
import { Plus, RefreshCw, X } from "lucide-react";
import { opNeedsValue, opsForType, useBrowser, type Filter } from "../stores/browser";
import { useConnections } from "../stores/connections";
import * as ipc from "../ipc/commands";
import { useResults } from "../stores/results";
import { useTabs } from "../stores/tabs";
import { useCloseGuard } from "../stores/closeGuard";
import { nearEndHook } from "../grid/Grid";
import { ResultsPane } from "../grid/ResultsPane";
import { StructureTab } from "./StructureTab";
import { DdlTab } from "./DdlTab";
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
  const requestClose = useCloseGuard((s) => s.request);
  const activeId = useTabs((s) => s.activeId);
  const refresh = useBrowser((s) => s.refresh);
  const running = useResults((s) => s.running);
  const [estBump, setEstBump] = useState(0);

  if (!table) return null;

  return (
    <div className="tbrowser">
      <div className="tb-header">
        <span className="tb-title">
          {table.schema !== "public" && <span className="tb-schema">{table.schema}.</span>}
          {table.name}
        </span>
        <RowEstimate table={table} bump={estBump} />
        <div className="tb-tabs">
          <button className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}>
            Data
          </button>
          <button
            className={tab === "ddl" ? "active" : ""}
            onClick={() => setTab("ddl")}
          >
            DDL
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
          onClick={() => {
            refresh();
            setEstBump((n) => n + 1);
          }}
          disabled={running}
        >
          <RefreshCw size={13} className={running ? "spin" : ""} />
        </button>
        <button
          className="icon-btn"
          title="Close tab ⌘W"
          onClick={() => activeId && requestClose(activeId)}
        >
          <X size={14} />
        </button>
      </div>

      {tab === "data" ? (
        <>
          <FilterBar />
          <div className="tb-results">
            <ResultsPane browser />
          </div>
        </>
      ) : tab === "ddl" ? (
        <DdlTab table={table} />
      ) : (
        <StructureTab table={table} />
      )}
    </div>
  );
}

/** locally-buffered filter value — the query fires on Enter/blur, not per
 * keystroke (typing "manish" used to run six streaming SELECTs) */
function FilterValue({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="tb-filter-value"
      placeholder={placeholder}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft);
        }
      }}
    />
  );
}

/** planner row estimate for the whole table (reltuples — no COUNT scan).
 * Honest tilde: it's statistics, refreshed by (auto)analyze. */
function RowEstimate({ table, bump }: { table: { schema: string; name: string }; bump: number }) {
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const [est, setEst] = useState<string | null>(null);
  useEffect(() => {
    setEst(null);
    const conn = useConnections.getState();
    const pid = conn.activeProfileId;
    // primary preferred; any live tab session works (primary can be dead)
    const sid = pid
      ? (conn.sessions[pid] ??
        Object.entries(conn.tabSessions).find(([k]) => k.startsWith(`${pid}::`))?.[1])
      : undefined;
    if (!sid) return;
    let stale = false;
    const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
    void ipc
      .execute(
        sid,
        `SELECT reltuples::bigint FROM pg_class WHERE oid = (quote_ident(${lit(table.schema)}) || '.' || quote_ident(${lit(table.name)}))::regclass`,
      )
      .then((out) => {
        if (stale) return;
        const n = Number(out.statements[0]?.rows[0]?.[0] ?? -1);
        if (n >= 0) setEst(n.toLocaleString());
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // bump = header Refresh clicks — stats move after (auto)analyze
  }, [table.schema, table.name, activeProfileId, bump]);
  if (!est) return null;
  return (
    <span className="tb-rowest" title="Planner estimate (reltuples) — not an exact count">
      ~{est} rows
    </span>
  );
}

function FilterBar() {
  const table = useBrowser((s) => s.table)!;
  const filters = useBrowser((s) => s.filters);
  const setFilters = useBrowser((s) => s.setFilters);
  const draftRow = useBrowser((s) => s.draftRow);
  const beginDraft = useBrowser((s) => s.beginDraft);
  const cancelDraft = useBrowser((s) => s.cancelDraft);
  const canInsert = table.kind === "r";

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
          <select
            value={f.col}
            onChange={(e) => {
              const col = e.target.value;
              // the new column's type may not support the current operator —
              // normalize so the row always renders a consistent control set
              const type = table.columns.find((c) => c.name === col)?.type ?? "";
              const ops = opsForType(type);
              let { op, value } = f;
              if (!ops.includes(op)) {
                op = ops[0];
                value = op === "IS" || op === "IS NOT" ? "TRUE" : "";
              }
              update(i, { col, op, value });
            }}
          >
            {table.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={f.op}
            onChange={(e) => {
              const op = e.target.value as Filter["op"];
              // bool ops carry a fixed-choice value — normalize on switch so
              // the row never renders an inconsistent state
              const boolOp = op === "IS" || op === "IS NOT";
              update(i, {
                op,
                value: boolOp && !["TRUE", "FALSE", "NULL"].includes(f.value) ? "TRUE" : f.value,
              });
            }}
          >
            {opsForType(table.columns.find((c) => c.name === f.col)?.type ?? "").map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          {(f.op === "IS" || f.op === "IS NOT") && (
            <select
              className="tb-boolval"
              value={["TRUE", "FALSE", "NULL"].includes(f.value) ? f.value : "TRUE"}
              onChange={(e) => update(i, { value: e.target.value })}
            >
              <option value="TRUE">TRUE</option>
              <option value="FALSE">FALSE</option>
              <option value="NULL">NULL</option>
            </select>
          )}
          {f.op !== "IS" && f.op !== "IS NOT" && opNeedsValue(f.op) && (
            <FilterValue
              value={f.value}
              placeholder={
                f.op === "IN" || f.op === "NOT IN"
                  ? "a, b, c"
                  : f.op === "raw SQL"
                    ? "created_at > now() - interval '1 day'"
                    : "value"
              }
              onCommit={(v) => update(i, { value: v })}
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
        {canInsert && (
          <button
            className={`tb-addrow${draftRow ? " active" : ""}`}
            title="Add row ⌘⇧I"
            onClick={() => (draftRow ? cancelDraft() : beginDraft())}
          >
            <Plus size={12} /> Add row
          </button>
        )}
        <button
          className="tb-addfilter"
          onClick={() => {
            // seed a type-valid operator — "=" isn't offered for booleans
            const first = table.columns[0];
            const op = opsForType(first?.type ?? "")[0] ?? "=";
            setFilters([
              ...filters,
              {
                col: first?.name ?? "",
                op,
                value: op === "IS" || op === "IS NOT" ? "TRUE" : "",
                enabled: true,
                conj: "AND",
              },
            ]);
          }}
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
