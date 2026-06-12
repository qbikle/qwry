import { useEffect, useState } from "react";
import { useConnections } from "../stores/connections";
import { useInspector } from "../stores/inspector";
import { useTabs } from "../stores/tabs";
import { ProfileList } from "../sidebar/ProfileList";
import { ProfileForm } from "../sidebar/ProfileForm";
import { SavedQueries } from "../sidebar/SavedQueries";
import { QueryBox } from "../editor/QueryBox";
import { TabBar } from "../editor/TabBar";
import { ResultsPane } from "../grid/ResultsPane";
import { Inspector } from "../inspector/Inspector";
import { TableBrowser } from "../browser/TableBrowser";
import { Palette } from "../palette/Palette";
import { useBrowser } from "../stores/browser";
import "./app.css";

export function App() {
  const loadProfiles = useConnections((s) => s.loadProfiles);
  const editing = useConnections((s) => s.editing);
  const inspectorOpen = useInspector((s) => s.open);
  const inspectorWidth = useInspector((s) => s.width);
  const browsing = useBrowser((s) => s.table !== null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const startInspectorResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (me: MouseEvent) =>
      useInspector.getState().setWidth(window.innerWidth - me.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    loadProfiles();
    void useTabs.getState().load();
    const onKey = (e: KeyboardEvent) => {
      // CodeMirror (or another component) already handled it — don't double-fire
      if (e.defaultPrevented) return;
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void import("../stores/browser").then(({ useBrowser }) => {
          useBrowser.getState().close();
          useTabs.getState().newTab();
        });
      }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        useTabs.getState().restoreClosed();
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        void import("../stores/browser").then(({ useBrowser }) => {
          // in table view, ⌘W closes the table — not the query tab behind it
          if (useBrowser.getState().table) {
            useBrowser.getState().close();
          } else {
            const { activeId } = useTabs.getState();
            if (activeId) useTabs.getState().closeTab(activeId);
          }
        });
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        useTabs.getState().cycle(e.shiftKey ? -1 : 1);
      }
      if (e.metaKey && !e.shiftKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        const n = e.key === "0" ? 10 : Number(e.key);
        useTabs.getState().selectByIndex(n - 1);
      }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("schema-filter")?.focus();
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void import("../stores/edits").then(({ useEdits }) => {
          const st = useEdits.getState();
          if (Object.keys(st.pending).length > 0) {
            void st.openPreview();
          } else {
            // no pending cell edits → ⌘S saves the query tab to the sidebar
            void useTabs.getState().saveActive();
          }
        });
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        useInspector.getState().toggle();
      }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void import("../stores/edits").then(({ useEdits }) =>
          useEdits.getState().discardAll(),
        );
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault(); // also blocks webview reload
        void Promise.all([
          import("../stores/connections"),
          import("../stores/schema"),
        ]).then(([{ useConnections }, { useSchema }]) => {
          const { activeProfileId, sessions } = useConnections.getState();
          if (activeProfileId && sessions[activeProfileId]) {
            void useSchema.getState().fetch(activeProfileId, sessions[activeProfileId]);
          }
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loadProfiles]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <ProfileList />
        <SavedQueries />
      </aside>
      <main className="main-area">
        {browsing ? (
          <TableBrowser />
        ) : (
          <>
            <TabBar />
            <section className="editor-pane">
              <QueryBox />
            </section>
            <section className="results-pane">
              <ResultsPane />
            </section>
          </>
        )}
      </main>
      {inspectorOpen ? (
        <aside className="inspector-pane" style={{ width: inspectorWidth }}>
          <div className="inspector-resize" onMouseDown={startInspectorResize} />
          <Inspector />
        </aside>
      ) : (
        <button
          className="inspector-reopen"
          title="Show inspector ⌘I"
          onClick={() => useInspector.getState().toggle()}
        >
          ‹
        </button>
      )}
      {editing && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && useConnections.getState().setEditing(null)}>
          <div className="modal">
            <ProfileForm profile={editing} />
          </div>
        </div>
      )}
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
