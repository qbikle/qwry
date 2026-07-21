import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { menuIn } from "../design/springs";
import { FileUp, Plus, RefreshCw, X } from "lucide-react";
import { copyCue } from "../lib/copyCue";
import {
  compiledWhere,
  opNeedsValue,
  opsForType,
  typeClassOf,
  useBrowser,
  type Filter,
} from "../stores/browser";
import { useConnections } from "../stores/connections";
import { useSchema, type EnumInfo, type TableInfo } from "../stores/schema";
import * as ipc from "../ipc/commands";
import { useResults } from "../stores/results";
import { useTabs } from "../stores/tabs";
import { useCloseGuard } from "../stores/closeGuard";
import { nearEndHook } from "../grid/Grid";
import { ResultsPane } from "../grid/ResultsPane";
import { ImportWizard } from "../import/ImportWizard";
import { StructureTab, structureRefresh } from "./StructureTab";
import { DdlTab, ddlRefresh } from "./DdlTab";
import "./browser.css";
import "./browseControls.css";

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
  const [jumpOpen, setJumpOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // ⌘L — jump to row (data tab only; the footer input takes it from there)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "l") {
        if (useBrowser.getState().tab !== "data") return;
        e.preventDefault();
        setJumpOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

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
        {(table.kind === "r" || table.kind === "p") && (
          <button
            className="icon-btn"
            title="Import CSV…"
            onClick={() => setImportOpen(true)}
          >
            <FileUp size={13} />
          </button>
        )}
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => {
            // Structure shows table_stats, not the data query — refresh THAT
            if (tab === "structure") {
              structureRefresh.current?.();
              return;
            }
            // DDL shows the deparsed DDL — refetch it, never the invisible
            // data query behind the pane
            if (tab === "ddl") {
              ddlRefresh.current?.();
              return;
            }
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
          <BrowseFooter
            table={table}
            bump={estBump}
            jumpOpen={jumpOpen}
            onJumpOpen={() => setJumpOpen(true)}
            onJumpClose={() => setJumpOpen(false)}
          />
        </>
      ) : tab === "ddl" ? (
        <DdlTab table={table} />
      ) : (
        <StructureTab table={table} />
      )}
      {importOpen && <ImportWizard table={table} onClose={() => setImportOpen(false)} />}
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

/** enum labels for a column type, from the snapshot — defensively: `enums`
 * is absent on pre-introspect-v2 cached snapshots → null → plain text input */
function enumLabelsFor(colType: string, enums: EnumInfo[] | undefined): string[] | null {
  if (!Array.isArray(enums)) return null;
  const bare = colType.replace(/"/g, "");
  for (const e of enums) {
    if (!e || !Array.isArray(e.labels)) continue;
    if (bare === e.name || bare === `${e.schema}.${e.name}`) return e.labels;
  }
  return null;
}

/** native picker kind for a datetime column, or null → raw text only */
function dateInputKind(type: string): "date" | "datetime-local" | null {
  const t = type.toLowerCase();
  if (t === "date") return "date";
  if (t.startsWith("timestamp")) return "datetime-local";
  return null;
}

const nativeDateRe = /^\d{4}-\d{2}-\d{2}$/;
const nativeDatetimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** date/timestamp value editor: native picker with a raw-text fallback for
 * anything the picker can't express (now(), interval math, tz suffixes…) */
function DateValue({
  kind,
  value,
  onCommit,
}: {
  kind: "date" | "datetime-local";
  value: string;
  onCommit: (v: string) => void;
}) {
  const parses = (v: string) =>
    v === "" || (kind === "date" ? nativeDateRe : nativeDatetimeRe).test(v);
  const [raw, setRaw] = useState(() => !parses(value));
  if (raw) {
    return (
      <>
        <FilterValue
          value={value}
          placeholder="2026-07-18 or now() - interval '1 day'"
          onCommit={onCommit}
        />
        <button
          className="tb-datemode"
          title="Use the date picker"
          onClick={() => {
            if (!parses(value)) onCommit("");
            setRaw(false);
          }}
        >
          Picker
        </button>
      </>
    );
  }
  return (
    <>
      <input
        className="tb-filter-value tb-dateval"
        type={kind}
        value={parses(value) ? value : ""}
        onChange={(e) => onCommit(e.target.value)}
      />
      <button className="tb-datemode" title="Type a raw value" onClick={() => setRaw(true)}>
        Raw
      </button>
    </>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="tb-seg">
      {options.map((o) => (
        <button key={o} className={value === o ? "active" : ""} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function FilterRow({
  f,
  table,
  enums,
  onPatch,
  onRemove,
  first,
}: {
  f: Filter;
  table: TableInfo;
  enums: EnumInfo[] | undefined;
  onPatch: (patch: Partial<Filter>) => void;
  onRemove: () => void;
  first: boolean;
}) {
  const colType = table.columns.find((c) => c.name === f.col)?.type ?? "";
  const labels = enumLabelsFor(colType, enums);
  const cls = typeClassOf(colType, labels !== null);
  const ops = opsForType(colType, labels !== null);
  const dateKind = cls === "datetime" ? dateInputKind(colType) : null;

  const valueEditor = () => {
    if (f.op === "IS" || f.op === "IS NOT")
      return (
        <Segmented
          options={["TRUE", "FALSE", "NULL"]}
          value={["TRUE", "FALSE", "NULL"].includes(f.value) ? f.value : "TRUE"}
          onChange={(value) => onPatch({ value })}
        />
      );
    if (!opNeedsValue(f.op)) return null;
    if (f.op === "BETWEEN") {
      const input = (value: string, commit: (v: string) => void) =>
        dateKind ? (
          <DateValue kind={dateKind} value={value} onCommit={commit} />
        ) : (
          <FilterValue value={value} placeholder="Value" onCommit={commit} />
        );
      return (
        <>
          {input(f.value, (value) => onPatch({ value }))}
          <span className="tb-between-and">AND</span>
          {input(f.value2 ?? "", (value2) => onPatch({ value2 }))}
        </>
      );
    }
    if (f.op === "IN" || f.op === "NOT IN")
      return (
        <FilterValue
          value={f.value}
          placeholder="a, b, 'c, with comma'"
          onCommit={(value) => onPatch({ value })}
        />
      );
    if (f.op === "raw SQL")
      return (
        <FilterValue
          value={f.value}
          placeholder="created_at > now() - interval '1 day'"
          onCommit={(value) => onPatch({ value })}
        />
      );
    if (f.op === "@>")
      return (
        <FilterValue
          value={f.value}
          placeholder='{"key": "value"}'
          onCommit={(value) => onPatch({ value })}
        />
      );
    if (labels && (f.op === "=" || f.op === "!="))
      return (
        <select
          className="tb-filter-value tb-enumval"
          value={f.value}
          onChange={(e) => onPatch({ value: e.target.value })}
        >
          {!labels.includes(f.value) && (
            <option value={f.value}>{f.value === "" ? "Pick a value…" : f.value}</option>
          )}
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      );
    if (dateKind)
      return <DateValue kind={dateKind} value={f.value} onCommit={(value) => onPatch({ value })} />;
    return (
      <FilterValue value={f.value} placeholder="Value" onCommit={(value) => onPatch({ value })} />
    );
  };

  return (
    <div className="tb-filter">
      <input
        type="checkbox"
        checked={f.enabled}
        onChange={(e) => onPatch({ enabled: e.target.checked })}
      />
      {first ? (
        <span className="tb-conj-label">WHERE</span>
      ) : (
        <select
          className="tb-conj"
          value={f.conj}
          onChange={(e) => onPatch({ conj: e.target.value as "AND" | "OR" })}
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
          const isEnum = enumLabelsFor(type, enums) !== null;
          const colOps = opsForType(type, isEnum);
          let { op, value, value2 } = f;
          if (!colOps.includes(op)) {
            op = colOps[0];
            value = op === "IS" || op === "IS NOT" ? "TRUE" : "";
            value2 = undefined;
          }
          onPatch({ col, op, value, value2 });
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
          onPatch({
            op,
            value: boolOp && !["TRUE", "FALSE", "NULL"].includes(f.value) ? "TRUE" : f.value,
            ...(op === "BETWEEN" ? { value2: f.value2 ?? "" } : {}),
          });
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      {valueEditor()}
      <button className="icon-btn" onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}

/** raw-WHERE escape hatch: the text becomes the browse WHERE as written —
 * the user owns it; it's validated only by running */
function RawWhere() {
  const rawWhere = useBrowser((s) => s.rawWhere);
  const setRawWhere = useBrowser((s) => s.setRawWhere);
  const [draft, setDraft] = useState(rawWhere);
  useEffect(() => setDraft(rawWhere), [rawWhere]);
  return (
    <div className="tb-rawwhere">
      <span className="tb-conj-label">WHERE</span>
      <textarea
        rows={2}
        spellCheck={false}
        title="Runs as written — ⌘↵ or blur applies"
        placeholder="status = 'paid' AND created_at > now() - interval '7 days'"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== rawWhere) setRawWhere(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            setRawWhere(draft);
          }
        }}
      />
    </div>
  );
}

/** the COMPILED WHERE clause for builder-mode filters — the exact SQL text
 * the queries embed (trust feature); click copies it */
function WherePreview({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div
      className="tb-wherepreview"
      title={`${text}\n\nClick to copy`}
      onClick={() => {
        void copyCue(text, "Copied WHERE clause");
        setCopied(true);
      }}
    >
      <span className="tb-wherekw">WHERE</span>
      <span className="tb-wheresql">{text}</span>
      {copied && <span className="tb-wherecopied">copied</span>}
    </div>
  );
}

function FilterBar() {
  const table = useBrowser((s) => s.table)!;
  const filters = useBrowser((s) => s.filters);
  const setFilters = useBrowser((s) => s.setFilters);
  const whereMode = useBrowser((s) => s.whereMode);
  const setWhereMode = useBrowser((s) => s.setWhereMode);
  const draftRow = useBrowser((s) => s.draftRow);
  const beginDraft = useBrowser((s) => s.beginDraft);
  const cancelDraft = useBrowser((s) => s.cancelDraft);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const enums = useSchema((s) =>
    activeProfileId ? s.snapshots[activeProfileId]?.enums : undefined,
  );
  const canInsert = table.kind === "r";

  const update = (i: number, patch: Partial<Filter>) =>
    setFilters(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const compiled = whereMode === "builder" ? compiledWhere(filters, null) : null;

  return (
    <div className="tb-filters">
      {whereMode === "builder" ? (
        filters.map((f, i) => (
          <FilterRow
            key={i}
            f={f}
            first={i === 0}
            table={table}
            enums={enums}
            onPatch={(patch) => update(i, patch)}
            onRemove={() => setFilters(filters.filter((_, j) => j !== i))}
          />
        ))
      ) : (
        <RawWhere />
      )}
      {compiled && <WherePreview text={compiled} />}
      <div className="tb-filter-actions">
        {canInsert && (
          <button
            className={`tb-addrow${draftRow ? " active" : ""}`}
            title={draftRow ? "Close the Add Row band ⌘⇧I" : "Add Row ⌘⇧I"}
            onClick={() => (draftRow ? cancelDraft() : beginDraft())}
          >
            <Plus size={12} /> Add Row <kbd className="tb-key">⌘⇧I</kbd>
          </button>
        )}
        {whereMode === "builder" && (
          <button
            className="tb-addfilter"
            onClick={() => {
              // seed a type-valid operator — "=" isn't offered for booleans
              const first = table.columns[0];
              const isEnum = enumLabelsFor(first?.type ?? "", enums) !== null;
              const op = opsForType(first?.type ?? "", isEnum)[0] ?? "=";
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
        )}
        <button
          className={`tb-rawtoggle${whereMode === "raw" ? " active" : ""}${whereMode === "raw" ? " tb-rawtoggle-right" : ""}`}
          title={
            whereMode === "raw"
              ? "Back to the filter builder"
              : "Raw WHERE — write the predicate yourself"
          }
          onClick={() => setWhereMode(whereMode === "raw" ? "builder" : "raw")}
        >
          SQL
        </button>
        <SortSelect />
      </div>
    </div>
  );
}

/** footer: honest row numbers (planner estimate → exact count on demand,
 * cancellable via the session cancel path) + jump-to-row (⌘L) */
function BrowseFooter({
  table,
  bump,
  jumpOpen,
  onJumpOpen,
  onJumpClose,
}: {
  table: { schema: string; name: string };
  bump: number;
  jumpOpen: boolean;
  onJumpOpen: () => void;
  onJumpClose: () => void;
}) {
  const jumpOffset = useBrowser((s) => s.jumpOffset);
  const exactCount = useBrowser((s) => s.exactCount);
  const counting = useBrowser((s) => s.counting);
  const countError = useBrowser((s) => s.countError);
  const runExactCount = useBrowser((s) => s.runExactCount);
  const cancelExactCount = useBrowser((s) => s.cancelExactCount);
  const jumpToRow = useBrowser((s) => s.jumpToRow);
  const clearJump = useBrowser((s) => s.clearJump);
  const whereActive = useBrowser((s) =>
    Boolean(compiledWhere(s.filters, s.whereMode === "raw" ? s.rawWhere : null)),
  );

  // planner row estimate for the whole table (reltuples — no COUNT scan).
  // Honest tilde: it's statistics, refreshed by (auto)analyze.
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

  return (
    <div className="tb-footer">
      {counting ? (
        <span className="tbf-count tbf-counting">
          counting…
          <button className="tbf-x" title="Cancel count" onClick={cancelExactCount}>
            <X size={10} />
          </button>
        </span>
      ) : exactCount != null ? (
        <button
          className="tbf-count tbf-exact"
          title="Exact count over the current WHERE — click to re-count"
          onClick={() => void runExactCount()}
        >
          {exactCount.toLocaleString()} rows{whereActive ? " (filtered)" : ""}
        </button>
      ) : (
        <button
          className="tbf-count"
          title={
            (est
              ? "Planner estimate (reltuples) for the whole table — not exact."
              : "No estimate available.") +
            " Click to run SELECT count(*)" +
            (whereActive ? " over the current WHERE." : ".")
          }
          onClick={() => void runExactCount()}
        >
          {est ? `≈ ${est} rows${whereActive ? " in table" : ""}` : "Count Rows"}
        </button>
      )}
      {countError && (
        <span className="tbf-counterr" title={countError}>
          count failed — {countError.length > 60 ? `${countError.slice(0, 60)}…` : countError}
        </span>
      )}
      <span className="tbf-spacer" />
      {jumpOffset > 0 && (
        <span
          className="tbf-jumpchip"
          title="The result starts at this row (⌘L jump) — × returns to the top"
        >
          from row {(jumpOffset + 1).toLocaleString()}
          <button className="tbf-x" onClick={clearJump}>
            <X size={10} />
          </button>
        </span>
      )}
      {jumpOpen ? (
        <input
          className="tbf-jumpinput"
          autoFocus
          type="number"
          min={1}
          placeholder="Row #"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = parseInt((e.target as HTMLInputElement).value, 10);
              if (Number.isFinite(n) && n >= 1) jumpToRow(n - 1);
              onJumpClose();
            }
            if (e.key === "Escape") onJumpClose();
          }}
          onBlur={onJumpClose}
        />
      ) : (
        <button className="tbf-jumpbtn" title="Jump to row ⌘L" onClick={onJumpOpen}>
          Go to Row…
        </button>
      )}
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
  const sortChain = useBrowser((s) => s.sortChain);
  const setSortChain = useBrowser((s) => s.setSortChain);
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

  // click = single-column sort (replace the chain; clicking the sole active
  // column flips its direction — the pre-chain behavior); ⇧click = append
  // the column as a tiebreaker (or flip it where it already sits)
  const pick = (col: string, additive: boolean) => {
    const idx = sortChain.findIndex((k) => k.column === col);
    if (additive && sortChain.length > 0) {
      if (idx >= 0) {
        setSortChain(
          sortChain.map((k, i) =>
            i === idx ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k,
          ),
        );
      } else {
        setSortChain([...sortChain, { column: col, dir: "asc" }]);
      }
    } else if (idx === 0 && sortChain.length === 1) {
      setSortChain([{ ...sortChain[0], dir: sortChain[0].dir === "asc" ? "desc" : "asc" }]);
    } else {
      setSortChain([{ column: col, dir: "asc" }]);
    }
  };

  const chainIdx = (name: string) => sortChain.findIndex((k) => k.column === name);

  const row = (c: (typeof table.columns)[number]) => {
    const ci = chainIdx(c.name);
    return (
      <div
        key={c.name}
        className={`tbs-row${ci >= 0 ? " active" : ""}`}
        onClick={(e) => pick(c.name, e.shiftKey)}
      >
        <span className="tbs-name">{c.name}</span>
        {ci >= 0 && (
          <span>
            {sortChain.length > 1 && <span className="tbs-pos">{ci + 1} </span>}
            {sortChain[ci].dir === "asc" ? "↑" : "↓"}
          </span>
        )}
      </div>
    );
  };

  const label =
    sortChain.length === 0
      ? "Sort"
      : `${sortChain[0].column} ${sortChain[0].dir === "asc" ? "↑" : "↓"}${
          sortChain.length > 1 ? ` +${sortChain.length - 1}` : ""
        }`;

  return (
    <div className="tbs-wrap">
      <button className="tb-sort-btn" onClick={() => setOpen(!open)}>
        {label}
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
                    pick(first.name, e.shiftKey);
                    if (!e.shiftKey) setOpen(false);
                  }
                }
              }}
            />
            {sortChain.length > 0 && (
              <div className="tbs-chain">
                {sortChain.map((k, i) => {
                  // a NULLS override on a catalog-NOT NULL key is semantically
                  // inert but emits a non-default NULLS clause that demolishes
                  // the plan (Index Scan → Seq Scan + full Sort per page) —
                  // gate the affordance; a stale override (column altered
                  // after it was set) stays clickable so it can be cleared
                  const notNull =
                    table.columns.find((c) => c.name === k.column)?.not_null === true;
                  const gated = notNull && !k.nulls;
                  return (
                    <div key={k.column} className="tbs-chainrow">
                      <span className="tbs-pos">{i + 1}</span>
                      <span className="tbs-name">{k.column}</span>
                      <button
                        className="tbs-mini"
                        title="Flip direction"
                        onClick={() =>
                          setSortChain(
                            sortChain.map((x, j) =>
                              j === i ? { ...x, dir: x.dir === "asc" ? "desc" : "asc" } : x,
                            ),
                          )
                        }
                      >
                        {k.dir === "asc" ? "↑" : "↓"}
                      </button>
                      <button
                        className={`tbs-mini tbs-nulls${gated ? " tbs-nulls-off" : ""}`}
                        aria-disabled={gated}
                        title={
                          notNull
                            ? k.nulls
                              ? `${k.column} is NOT NULL — this NULLS override does nothing but wreck the query plan. Click to clear.`
                              : `${k.column} is NOT NULL — there are no NULLs to place (an override would only wreck the query plan)`
                            : "NULLS placement — auto follows the direction (ASC ⇒ last, DESC ⇒ first)"
                        }
                        onClick={() => {
                          if (gated) return;
                          setSortChain(
                            sortChain.map((x, j) =>
                              j === i
                                ? {
                                    ...x,
                                    nulls: notNull
                                      ? undefined
                                      : x.nulls === "first"
                                        ? ("last" as const)
                                        : x.nulls === "last"
                                          ? undefined
                                          : ("first" as const),
                                  }
                                : x,
                            ),
                          );
                        }}
                      >
                        {gated ? "∅ —" : k.nulls ? `∅ ${k.nulls}` : "∅ auto"}
                      </button>
                      <button
                        className="tbs-mini"
                        title="Remove sort key"
                        onClick={() => setSortChain(sortChain.filter((_, j) => j !== i))}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="tbs-list">
              {sortChain.length > 0 && (
                <div
                  className="tbs-row tbs-clear"
                  onClick={() => {
                    setSortChain([]);
                    setOpen(false);
                  }}
                >
                  <X size={12} />
                  <span>Clear Sort</span>
                </div>
              )}
              {quickM.length > 0 && <div className="tbs-group">PK & Time</div>}
              {quickM.map(row)}
              {restM.length > 0 && <div className="tbs-group">All Columns</div>}
              {restM.map(row)}
              {quickM.length === 0 && restM.length === 0 && (
                <div style={{ padding: "5px 10px", color: "var(--fg-muted)" }}>
                  No columns match
                </div>
              )}
            </div>
            <div className="tbs-hint">⇧ click adds a tiebreaker</div>
          </motion.div>
      )}
    </div>
  );
}
