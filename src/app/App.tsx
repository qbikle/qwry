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
