import { useEffect, useState } from "react";
import { Bookmark, ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useSaved } from "../stores/saved";
import { useTabs } from "../stores/tabs";
import "./sidebar.css";
import "./sidebar-tree.css";

export function SavedQueries() {
  const queries = useSaved((s) => s.queries);
  const expanded = useSaved((s) => s.expanded);
  const toggleExpanded = useSaved((s) => s.toggleExpanded);
  const load = useSaved((s) => s.load);
  const remove = useSaved((s) => s.remove);
  const rename = useSaved((s) => s.rename);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // window.confirm is a stub in WKWebView — two-click arm instead
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (q: { id: string; sql: string; name: string }) => {
    void import("../stores/browser").then(({ useBrowser }) => {
      useBrowser.getState().close();
      const { tabs, select } = useTabs.getState();
      const existing = tabs.find((t) => t.saved_id === q.id);
      if (existing) select(existing.id);
      else useTabs.getState().newTab(q.sql, q.name, q.id);
    });
  };

  return (
    <div className="saved-section">
      <div className="pl-header saved-header" onClick={toggleExpanded}>
        <span className="saved-title">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Saved queries
        </span>
        <span className="tree-count">{queries.length}</span>
      </div>
      {expanded &&
        queries.map((q) => (
          <div key={q.id} className="pl-item saved-item" onClick={() => open(q)}>
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
    </div>
  );
}
