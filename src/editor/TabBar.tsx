import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useTabs } from "../stores/tabs";
import "./editor.css";

export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const select = useTabs((s) => s.select);
  const closeTab = useTabs((s) => s.closeTab);
  const newTab = useTabs((s) => s.newTab);
  const rename = useTabs((s) => s.rename);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab${t.id === activeId ? " active" : ""}`}
          onClick={() => select(t.id)}
          onDoubleClick={() => {
            setRenaming(t.id);
            setDraft(t.name);
          }}
        >
          {renaming === t.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  rename(t.id, draft.trim() || t.name);
                  setRenaming(null);
                } else if (e.key === "Escape") {
                  setRenaming(null);
                }
              }}
              onBlur={() => {
                rename(t.id, draft.trim() || t.name);
                setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="tab-name">{t.name}</span>
          )}
          <button
            className="tab-close"
            title="Close ⌘W"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(t.id);
            }}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <button className="tab-new" title="New tab ⌘T" onClick={() => newTab()}>
        <Plus size={13} />
      </button>
    </div>
  );
}
