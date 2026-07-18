import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Eye, KeyRound, Table2 } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useResults } from "../stores/results";
import { useTabs } from "../stores/tabs";
import { useConnections } from "../stores/connections";
import { useSchema, type ColumnInfo, type TableInfo } from "../stores/schema";
import { qualify } from "../lib/sqlIdent";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import "./sidebar.css";
import "./sidebar-tree.css";

function fuzzyMatch(needle: string, hay: string): boolean {
  let i = 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return n.length === 0;
}

// icon elements hoisted once — thousands of rows re-creating 2 SVG trees per
// filter keystroke was pure churn (React elements are immutable; reuse is safe)
const SCHEMA_OPEN = <ChevronDown size={12} />;
const SCHEMA_CLOSED = <ChevronRight size={12} />;
const TWIST_OPEN = <ChevronDown size={11} />;
const TWIST_CLOSED = <ChevronRight size={11} />;
const VIEW_ICON = <Eye size={13} className="tree-icon view" />;
const TABLE_ICON = <Table2 size={13} className="tree-icon" />;
const PK_ICON = <KeyRound size={9} className="tree-col-pk" />;

type TreeRow =
  | { kind: "schema"; schema: string; count: number; open: boolean }
  | { kind: "table"; t: TableInfo; open: boolean }
  | { kind: "col"; t: TableInfo; c: ColumnInfo; pk: boolean };

const rowKey = (r: TreeRow) =>
  r.kind === "schema"
    ? `s:${r.schema}`
    : r.kind === "table"
      ? `t:${r.t.table_oid}`
      : `c:${r.t.table_oid}:${r.c.attnum}`;

const SchemaRow = memo(function SchemaRow(p: {
  schema: string;
  count: number;
  open: boolean;
  onToggle: (schema: string, open: boolean) => void;
}) {
  return (
    <div className="tree-schema" onClick={() => p.onToggle(p.schema, p.open)}>
      {p.open ? SCHEMA_OPEN : SCHEMA_CLOSED}
      <span>{p.schema}</span>
      <span className="tree-count">{p.count}</span>
    </div>
  );
});

const TableRow = memo(function TableRow(p: {
  t: TableInfo;
  open: boolean;
  onBrowse: (t: TableInfo) => void;
  onSelect: (t: TableInfo) => void;
  onMenu: (e: React.MouseEvent, t: TableInfo) => void;
  onToggleCols: (oid: number) => void;
}) {
  const t = p.t;
  return (
    <div
      className="tree-table"
      title={`${t.columns.length} columns${t.pk.length ? ` · pk: ${t.pk.join(", ")}` : ""}\nclick: browse · double-click: SELECT in editor`}
      onClick={() => p.onBrowse(t)}
      onDoubleClick={() => p.onSelect(t)}
      onContextMenu={(e) => p.onMenu(e, t)}
    >
      <button
        className="tree-twist"
        title="Columns"
        onClick={(e) => {
          e.stopPropagation(); // expand, don't browse
          p.onToggleCols(t.table_oid);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {p.open ? TWIST_OPEN : TWIST_CLOSED}
      </button>
      {t.kind === "v" || t.kind === "m" ? VIEW_ICON : TABLE_ICON}
      <span className="tree-name">{t.name}</span>
    </div>
  );
});

const ColRow = memo(function ColRow(p: {
  c: ColumnInfo;
  pk: boolean;
  onCopy: (name: string) => void;
  onInsert: (name: string) => void;
}) {
  const c = p.c;
  return (
    <div
      className="tree-col"
      title={`${c.type}${c.not_null ? " · not null" : ""}${c.default ? ` · default ${c.default}` : ""}\nclick: copy name · double-click: insert into editor`}
      onClick={() => p.onCopy(c.name)}
      onDoubleClick={() => p.onInsert(c.name)}
    >
      {p.pk && PK_ICON}
      <span className="tree-col-name">{c.name}</span>
      <span className="tree-col-type">{c.type}</span>
    </div>
  );
});

export function SchemaTree({ profileId }: { profileId: string }) {
  const snapshot = useSchema((s) => s.snapshots[profileId]);
  const loading = useSchema((s) => s.loading[profileId]);
  const error = useSchema((s) => s.errors[profileId]);
  const [filterInput, setFilterInput] = useState("");
  /** debounced (80ms) copy of the filter — the tree rebuilds on this */
  const [filter, setFilter] = useState("");
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({ public: true });
  const [openTables, setOpenTables] = useState<Record<number, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; table: TableInfo } | null>(null);

  useEffect(() => {
    if (filterInput === "") {
      setFilter("");
      return;
    }
    const t = setTimeout(() => setFilter(filterInput), 80);
    return () => clearTimeout(t);
  }, [filterInput]);

  const bySchema = useMemo(() => {
    const m = new Map<string, TableInfo[]>();
    if (!snapshot) return m;
    for (const t of snapshot.tables) {
      if (filter && !fuzzyMatch(filter, t.name)) continue;
      const arr = m.get(t.schema);
      if (arr) arr.push(t);
      else m.set(t.schema, [t]);
    }
    return m;
  }, [snapshot, filter]);

  // the visible tree flattened to one row list, virtualized like the grid —
  // a 2k-table schema previously rendered every row on each filter keystroke
  const treeRows = useMemo(() => {
    const out: TreeRow[] = [];
    for (const [schema, tables] of bySchema) {
      const open = openSchemas[schema] ?? !!filter;
      out.push({ kind: "schema", schema, count: tables.length, open });
      if (!open) continue;
      for (const t of tables) {
        const tOpen = !!openTables[t.table_oid];
        out.push({ kind: "table", t, open: tOpen });
        if (tOpen)
          for (const c of t.columns)
            out.push({ kind: "col", t, c, pk: t.pk.includes(c.name) });
      }
    }
    return out;
  }, [bySchema, openSchemas, openTables, filter]);

  // the scroll container is an ancestor (.sb-tables) — find it once the list
  // mounts and anchor the virtualizer with the list's offset inside it
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [listOffset, setListOffset] = useState(0);
  const hasTree = !!snapshot;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      setScrollEl(null);
      return;
    }
    let el: HTMLElement | null = list.parentElement;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") break;
      el = el.parentElement;
    }
    setScrollEl(el);
    if (el) {
      setListOffset(
        list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop,
      );
    }
  }, [hasTree]);

  const rowVirt = useVirtualizer({
    count: treeRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => {
      const kind = treeRows[i]?.kind;
      return kind === "col" ? 21 : 24;
    },
    getItemKey: (i) => rowKey(treeRows[i]),
    overscan: 12,
    scrollMargin: listOffset,
  });

  const browseTable = useCallback((t: TableInfo) => {
    void import("../stores/browser").then(({ useBrowser }) =>
      useBrowser.getState().openTable(t),
    );
  }, []);

  const insertSelect = useCallback((t: TableInfo) => {
    // quoted ref — a mixed-case/reserved name must never case-fold to a
    // DIFFERENT table when this SQL runs
    const ref = qualify(t.schema, t.name);
    // open the SELECT in a fresh query tab (sets editor sql) and run it
    useTabs.getState().newTab(`SELECT * FROM ${ref} LIMIT 100`);
    void useResults.getState().run();
  }, []);

  const openTableMenu = useCallback((e: React.MouseEvent, t: TableInfo) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, table: t });
  }, []);

  const toggleSchema = useCallback((schema: string, open: boolean) => {
    setOpenSchemas((s) => ({ ...s, [schema]: !open }));
  }, []);

  const toggleTableCols = useCallback((oid: number) => {
    setOpenTables((o) => ({ ...o, [oid]: !o[oid] }));
  }, []);

  const copyColName = useCallback((name: string) => void writeText(name), []);

  const insertColName = useCallback((name: string) => {
    void import("../editor/SqlEditor").then(({ editorInsert }) => {
      // table tab active → no editor mounted; a silent
      // no-op reads as broken, so seed a fresh query tab
      if (editorInsert.current) editorInsert.current(name);
      else useTabs.getState().newTab(name);
    });
  }, []);

  const retry = () => {
    const { sessions } = useConnections.getState();
    if (sessions[profileId]) void useSchema.getState().fetch(profileId, sessions[profileId]);
  };

  // stale-while-revalidate: only show the loading message when there is no
  // snapshot yet — a ⌘R refresh must not blank the whole tree
  if (loading && !snapshot) return <div className="tree-msg">Loading schema…</div>;
  if (!snapshot) {
    // a silently empty sidebar lies — say WHY and offer a retry
    if (error)
      return (
        <div className="tree-msg tree-error">
          <div>Schema load failed:</div>
          <div className="tree-error-msg">{error}</div>
          <button className="tree-retry" onClick={retry}>
            Retry
          </button>
        </div>
      );
    return null;
  }

  const tableMenu = (t: TableInfo): MenuNode[] => {
    const ref = qualify(t.schema, t.name);
    return [
      { kind: "item", label: "Browse", onSelect: () => browseTable(t) },
      { kind: "item", label: "Open SELECT in editor", onSelect: () => insertSelect(t) },
      { kind: "sep" },
      { kind: "item", label: "Copy name", onSelect: () => void writeText(t.name) },
      { kind: "item", label: "Copy qualified name", onSelect: () => void writeText(ref) },
      {
        kind: "item",
        label: "Copy SELECT",
        onSelect: () => void writeText(`SELECT * FROM ${ref} LIMIT 100`),
      },
      { kind: "sep" },
      {
        kind: "item",
        label: "Refresh schema",
        onSelect: () => {
          const { sessions } = useConnections.getState();
          if (sessions[profileId]) void useSchema.getState().fetch(profileId, sessions[profileId]);
        },
      },
    ];
  };

  return (
    <div className="schema-tree">
      <input
        className="tree-filter"
        placeholder="Filter tables…  ⌘⇧F"
        value={filterInput}
        onChange={(e) => setFilterInput(e.target.value)}
        id="schema-filter"
      />
      <div
        ref={listRef}
        className="tree-vlist"
        style={{ height: rowVirt.getTotalSize() }}
      >
        {rowVirt.getVirtualItems().map((vr) => {
          const row = treeRows[vr.index];
          if (!row) return null;
          return (
            <div
              key={vr.key}
              data-index={vr.index}
              ref={rowVirt.measureElement}
              className="tree-vrow"
              style={{ transform: `translateY(${vr.start - listOffset}px)` }}
            >
              {row.kind === "schema" ? (
                <SchemaRow
                  schema={row.schema}
                  count={row.count}
                  open={row.open}
                  onToggle={toggleSchema}
                />
              ) : row.kind === "table" ? (
                <TableRow
                  t={row.t}
                  open={row.open}
                  onBrowse={browseTable}
                  onSelect={insertSelect}
                  onMenu={openTableMenu}
                  onToggleCols={toggleTableCols}
                />
              ) : (
                <ColRow c={row.c} pk={row.pk} onCopy={copyColName} onInsert={insertColName} />
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <ContextMenu
          point={menu}
          items={tableMenu(menu.table)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
