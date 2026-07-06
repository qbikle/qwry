import { useEffect, useState } from "react";
import { Bookmark, ChevronDown, ChevronRight, Pencil, Search, Trash2 } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useSaved, visibleSaved, type SavedQuery } from "../stores/saved";
import { useConnections } from "../stores/connections";
import { useTabs } from "../stores/tabs";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import "./sidebar.css";
import "./sidebar-tree.css";

export function SavedQueries() {
  const allQueries = useSaved((s) => s.queries);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  // per-connection bookmarks (legacy unscoped ones show everywhere)
  const queries = visibleSaved(allQueries, activeProfileId);
  const expanded = useSaved((s) => s.expanded);
  const toggleExpanded = useSaved((s) => s.toggleExpanded);
  const load = useSaved((s) => s.load);
  const remove = useSaved((s) => s.remove);
  const rename = useSaved((s) => s.rename);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // window.confirm is a stub in WKWebView — two-click arm instead
  const [armed, setArmed] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; q: SavedQuery } | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const open = (q: { id: string; sql: string; name: string }) => {
    // selecting/creating a query tab makes the active tab a query tab, so any
    // open table view is left automatically
    const { tabs, select } = useTabs.getState();
    const existing = tabs.find((t) => t.saved_id === q.id);
    if (existing) select(existing.id);
    else useTabs.getState().newTab(q.sql, q.name, q.id);
  };

  const savedMenu = (q: SavedQuery): MenuNode[] => [
    { kind: "item", label: "Open", onSelect: () => open(q) },
    {
      kind: "item",
      label: "Rename",
      onSelect: () => {
        setRenaming(q.id);
        setDraft(q.name);
      },
    },
    {
      kind: "item",
      label: "Duplicate",
      onSelect: () =>
        void useSaved
          .getState()
          .upsert({ id: crypto.randomUUID(), name: `${q.name} copy`, sql: q.sql }),
    },
    { kind: "item", label: "Copy SQL", onSelect: () => void writeText(q.sql) },
    { kind: "sep" },
    {
      kind: "item",
      label: "Delete",
      danger: true,
      onSelect: () =>
        void (async () => {
          const { confirmDanger } = await import("../stores/danger");
          const ok = await confirmDanger(
            `Delete saved query “${q.name}”?`,
            "This cannot be undone.",
            "Delete",
          );
          if (ok) await remove(q.id);
        })(),
    },
  ];

  // name OR sql text match — a flat list is unusable past ~20 entries
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? queries.filter(
        (q) => q.name.toLowerCase().includes(needle) || q.sql.toLowerCase().includes(needle),
      )
    : queries;

  return (
    <div className="saved-section">
      <div className="pl-header saved-header" onClick={toggleExpanded}>
        <span className="saved-title">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Saved queries
        </span>
        <span className="tree-count">{queries.length}</span>
      </div>
      {expanded && queries.length > 8 && (
        <div className="saved-search">
          <Search size={11} />
          <input
            placeholder="Filter saved…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setFilter("");
            }}
          />
        </div>
      )}
      {expanded &&
        shown.map((q) => (
          <div
            key={q.id}
            className="pl-item saved-item"
            onClick={() => open(q)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, q });
            }}
          >
            <Bookmark size={13} />
            {renaming === q.id ? (
              <input
                autoFocus
                className="saved-rename"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    void rename(q.id, draft.trim() || q.name);
                    setRenaming(null);
                  } else if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <span className="pl-name" title={q.sql}>
                {q.name}
              </span>
            )}
            <span className="pl-item-actions">
              <button
                className="icon-btn"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming(q.id);
                  setDraft(q.name);
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                className={`icon-btn${armed === q.id ? " armed" : ""}`}
                title={armed === q.id ? "Click again to delete" : "Delete"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (armed === q.id) {
                    void remove(q.id);
                    setArmed(null);
                  } else {
                    setArmed(q.id);
                    setTimeout(() => setArmed((a) => (a === q.id ? null : a)), 2000);
                  }
                }}
              >
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        ))}
      {expanded && queries.length === 0 && (
        <div className="pl-empty">Bookmark a tab to save it here</div>
      )}
      {expanded && queries.length > 0 && shown.length === 0 && (
        <div className="pl-empty">No matches</div>
      )}
      {menu && (
        <ContextMenu point={menu} items={savedMenu(menu.q)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
