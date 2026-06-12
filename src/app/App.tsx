import { useEffect } from "react";
import { useConnections } from "../stores/connections";
import { useInspector } from "../stores/inspector";
import { ProfileList } from "../sidebar/ProfileList";
import { ProfileForm } from "../sidebar/ProfileForm";
import { QueryBox } from "../editor/QueryBox";
import { ResultsPane } from "../grid/ResultsPane";
import { Inspector } from "../inspector/Inspector";
import "./app.css";

export function App() {
  const loadProfiles = useConnections((s) => s.loadProfiles);
  const editing = useConnections((s) => s.editing);
  const inspectorOpen = useInspector((s) => s.open);
  const inspectorWidth = useInspector((s) => s.width);

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
    const onKey = (e: KeyboardEvent) => {
      // CodeMirror (or another component) already handled it — don't double-fire
      if (e.defaultPrevented) return;
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("schema-filter")?.focus();
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void import("../stores/edits").then(({ useEdits }) => {
          const st = useEdits.getState();
          if (Object.keys(st.pending).length > 0) void st.openPreview();
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
      </aside>
      <main className="main-area">
        <section className="editor-pane">
          <QueryBox />
        </section>
        <section className="results-pane">
          <ResultsPane />
        </section>
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
    </div>
  );
}
