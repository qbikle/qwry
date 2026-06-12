import { useEffect } from "react";
import { useConnections } from "../stores/connections";
import { ProfileList } from "../sidebar/ProfileList";
import { ProfileForm } from "../sidebar/ProfileForm";
import { QueryBox } from "../editor/QueryBox";
import { ResultsPane } from "../grid/ResultsPane";
import "./app.css";

export function App() {
  const loadProfiles = useConnections((s) => s.loadProfiles);
  const editing = useConnections((s) => s.editing);

  useEffect(() => {
    loadProfiles();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("schema-filter")?.focus();
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
