import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye, KeyRound, Table2 } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useResults } from "../stores/results";
import { useTabs } from "../stores/tabs";
import { useConnections } from "../stores/connections";
import { useSchema, type TableInfo } from "../stores/schema";
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

export function SchemaTree({ profileId }: { profileId: string }) {
  const snapshot = useSchema((s) => s.snapshots[profileId]);
  const loading = useSchema((s) => s.loading[profileId]);
  const error = useSchema((s) => s.errors[profileId]);
  const [filter, setFilter] = useState("");
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({ public: true });
  const [openTables, setOpenTables] = useState<Record<number, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; table: TableInfo } | null>(null);

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

  // single click = browse (Postico-style); double click = SELECT into editor
  const browseTable = (t: TableInfo) => {
    void import("../stores/browser").then(({ useBrowser }) =>
      useBrowser.getState().openTable(t),
    );
  };

  const insertSelect = (t: TableInfo) => {
    // quoted ref — a mixed-case/reserved name must never case-fold to a
    // DIFFERENT table when this SQL runs
    const ref = qualify(t.schema, t.name);
    // open the SELECT in a fresh query tab (sets editor sql) and run it
    useTabs.getState().newTab(`SELECT * FROM ${ref} LIMIT 100`);
    void useResults.getState().run();
  };

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
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        id="schema-filter"
      />
      {[...bySchema.entries()].map(([schema, tables]) => {
        const open = openSchemas[schema] ?? !!filter;
        return (
          <div key={schema}>
            <div
              className="tree-schema"
              onClick={() =>
                setOpenSchemas((s) => ({ ...s, [schema]: !open }))
              }
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>{schema}</span>
              <span className="tree-count">{tables.length}</span>
            </div>
            {open &&
              tables.map((t) => (
                <div key={t.table_oid}>
                  <div
                    className="tree-table"
                    title={`${t.columns.length} columns${t.pk.length ? ` · pk: ${t.pk.join(", ")}` : ""}\nclick: browse · double-click: SELECT in editor`}
                    onClick={() => browseTable(t)}
                    onDoubleClick={() => insertSelect(t)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, table: t });
                    }}
                  >
                    <button
                      className="tree-twist"
                      title="Columns"
                      onClick={(e) => {
                        e.stopPropagation(); // expand, don't browse
                        setOpenTables((o) => ({ ...o, [t.table_oid]: !o[t.table_oid] }));
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      {openTables[t.table_oid] ? (
                        <ChevronDown size={11} />
                      ) : (
                        <ChevronRight size={11} />
                      )}
                    </button>
                    {t.kind === "v" || t.kind === "m" ? (
                      <Eye size={13} className="tree-icon view" />
                    ) : (
                      <Table2 size={13} className="tree-icon" />
                    )}
                    <span className="tree-name">{t.name}</span>
                  </div>
                  {openTables[t.table_oid] &&
                    t.columns.map((c) => (
                      <div
                        key={c.attnum}
                        className="tree-col"
                        title={`${c.type}${c.not_null ? " · not null" : ""}${c.default ? ` · default ${c.default}` : ""}\nclick: copy name · double-click: insert into editor`}
                        onClick={() => void writeText(c.name)}
                        onDoubleClick={() => {
                          void import("../editor/SqlEditor").then(({ editorInsert }) => {
                            // table tab active → no editor mounted; a silent
                            // no-op reads as broken, so seed a fresh query tab
                            if (editorInsert.current) editorInsert.current(c.name);
                            else useTabs.getState().newTab(c.name);
                          });
                        }}
                      >
                        {t.pk.includes(c.name) && <KeyRound size={9} className="tree-col-pk" />}
                        <span className="tree-col-name">{c.name}</span>
                        <span className="tree-col-type">{c.type}</span>
                      </div>
                    ))}
                </div>
              ))}
          </div>
        );
      })}
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
