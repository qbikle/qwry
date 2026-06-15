import { useConnections } from "../stores/connections";
import { Dashboard } from "./Dashboard";
import { ConnectionEditor } from "./ConnectionEditor";
import { blankProfile } from "../sidebar/ConnectionRail";

/** the full-screen connection surface shown in the main card when homeMode is set */
export function Home() {
  const homeMode = useConnections((s) => s.homeMode);
  const editing = useConnections((s) => s.editing);

  if (homeMode === "edit") {
    return <ConnectionEditor key={editing?.id} profile={editing ?? blankProfile()} />;
  }
  return <Dashboard />;
}
