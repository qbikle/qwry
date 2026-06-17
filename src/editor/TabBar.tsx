import { useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, Table, X } from "lucide-react";
import { useTabs } from "../stores/tabs";
import { useCloseGuard } from "../stores/closeGuard";
import { skey, useConnections } from "../stores/connections";
import "./editor.css";

export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const select = useTabs((s) => s.select);
  const requestClose = useCloseGuard((s) => s.request);
  const newTab = useTabs((s) => s.newTab);
  const rename = useTabs((s) => s.rename);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const txTabs = useConnections((s) => s.txTabs);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const activeRef = useRef<HTMLDivElement>(null);
  const newBtnRef = useRef<HTMLButtonElement>(null);

  // keep the active tab in view: slide the strip just enough to reveal it (no
  // movement when it's already visible). When it's the last tab, reveal the +
  // button instead so it stays visible alongside the tab.
  useEffect(() => {
    const lastActive = tabs.length > 0 && tabs[tabs.length - 1].id === activeId;
    const el = lastActive ? newBtnRef.current : activeRef.current;
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div className="tabbar" data-tauri-drag-region>
      {tabs.map((t) => (
        <div
          key={t.id}
          ref={t.id === activeId ? activeRef : null}
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
            <span className="tab-name">
              <span className="tab-icon" title={t.kind === "table" ? "Table" : "Query"}>
                {t.kind === "table" ? <Table size={12} /> : <SquareTerminal size={12} />}
              </span>
              {activeProfileId && txTabs[skey(activeProfileId, t.id)] && (
                <span className="tab-tx" title="Open transaction on this tab" />
              )}
              {t.name}
            </span>
          )}
          <button
            className="tab-close"
            title="Close ⌘W"
            onClick={(e) => {
              e.stopPropagation();
              requestClose(t.id);
            }}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <button ref={newBtnRef} className="tab-new" title="New tab ⌘T" onClick={() => newTab()}>
        <Plus size={13} />
      </button>
    </div>
  );
}
