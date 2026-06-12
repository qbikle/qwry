import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye, Table2 } from "lucide-react";
import { useConnections } from "../stores/connections";
import { useResults } from "../stores/results";
import { useSchema, type TableInfo } from "../stores/schema";
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
  const [filter, setFilter] = useState("");
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({ public: true });

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

  if (loading) return <div className="tree-msg">Loading schema…</div>;
  if (!snapshot) return null;

  // single click = browse (Postico-style); double click = SELECT into editor
  const browseTable = (t: TableInfo) => {
    void import("../stores/browser").then(({ useBrowser }) =>
      useBrowser.getState().openTable(t),
    );
  };

  const insertSelect = (t: TableInfo) => {
    void import("../stores/browser").then(({ useBrowser }) => {
      useBrowser.getState().close();
      const ref = t.schema === "public" ? t.name : `${t.schema}.${t.name}`;
      useConnections.getState().setSql(`SELECT * FROM ${ref} LIMIT 100`);
      void useResults.getState().run();
    });
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
                <div
                  key={t.table_oid}
                  className="tree-table"
                  title={`${t.columns.length} columns${t.pk.length ? ` · pk: ${t.pk.join(", ")}` : ""}\nclick: browse · double-click: SELECT in editor`}
                  onClick={() => browseTable(t)}
                  onDoubleClick={() => insertSelect(t)}
                >
                  {t.kind === "v" || t.kind === "m" ? (
                    <Eye size={13} className="tree-icon view" />
                  ) : (
                    <Table2 size={13} className="tree-icon" />
                  )}
                  <span className="tree-name">{t.name}</span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
