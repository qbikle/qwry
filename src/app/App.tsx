import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { SwatchBook } from "lucide-react";
import { panelIn, swapIn } from "../design/springs";
import { useUI } from "../stores/ui";
import { ThemePicker } from "./ThemePicker";
import { useConnections } from "../stores/connections";
import { useInspector } from "../stores/inspector";
import { useTabs } from "../stores/tabs";
import { ConnectionRail } from "../sidebar/ConnectionRail";
import { DbSwitcher } from "../sidebar/DbSwitcher";
import { Home } from "../home/Home";
import { SchemaTree } from "../sidebar/SchemaTree";
import { SavedQueries } from "../sidebar/SavedQueries";
import { QueryBox } from "../editor/QueryBox";
import { TabBar } from "../editor/TabBar";
import { ResultsPane } from "../grid/ResultsPane";
import { Inspector } from "../inspector/Inspector";
import { TableBrowser } from "../browser/TableBrowser";
import { Palette } from "../palette/Palette";
import { DangerModal } from "./DangerModal";
import { CloseGuardModal } from "./CloseGuardModal";
import { ConnToast } from "./ConnToast";
import { ExplainView } from "../explain/ExplainView";
import { useExplain } from "../stores/explain";
import { useCloseGuard } from "../stores/closeGuard";
import "./app.css";
import "./v2.css";

/** the sidebar card: DB header → tables → saved queries (shown when connected) */
function SidebarCard({ profileId, dbname, name }: { profileId: string; dbname: string; name: string }) {
  return (
    <>
      <DbSwitcher profileId={profileId} dbname={dbname} name={name} />
      <div className="sb-tables">
        <SchemaTree profileId={profileId} />
      </div>
      <SavedQueries />
    </>
  );
}

export function App() {
  const loadProfiles = useConnections((s) => s.loadProfiles);
  const homeMode = useConnections((s) => s.homeMode);
  const profiles = useConnections((s) => s.profiles);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const connState = useConnections((s) => s.connState);
  const inspectorOpen = useInspector((s) => s.open);
  const inspectorWidth = useInspector((s) => s.width);
  const explainOpen = useExplain((s) => s.open);
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId) ?? null);
  const isTableTab = activeTab?.kind === "table";
  const browserTable = activeTab?.kind === "table" ? activeTab.table : null;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [resizing, setResizing] = useState(false);

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;
  const connected = activeProfileId ? connState[activeProfileId] === "connected" : false;
  const prodActive = !!activeProfile?.is_prod && connected;

  const crumbs: string[] = useMemo(() => {
    if (homeMode) return [homeMode === "edit" ? "Edit connection" : "Connections"];
    if (!activeProfile) return ["qwry"];
    const ctx =
      isTableTab && browserTable
        ? browserTable.schema === "public"
          ? browserTable.name
          : `${browserTable.schema}.${browserTable.name}`
        : activeTab?.name;
    return [activeProfile.name || activeProfile.host, activeProfile.dbname, ctx].filter(
      Boolean,
    ) as string[];
  }, [homeMode, activeProfile, isTableTab, browserTable, activeTab?.name]);

  const startInspectorResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true); // suppress the width transition while dragging
    const onMove = (me: MouseEvent) =>
      useInspector.getState().setWidth(window.innerWidth - me.clientX);
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    loadProfiles();
    void useTabs.getState().load();

    // a connection's socket died → flip its dot (auto-reconnects on next run)
    let unlistenClosed: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ profile_id: string }>("session-closed", (e) => {
        useConnections.getState().markDisconnected(e.payload.profile_id);
      }).then((un) => {
        unlistenClosed = un;
      }),
    );

    const onKey = (e: KeyboardEvent) => {
      // CodeMirror (or another component) already handled it — don't double-fire
      if (e.defaultPrevented) return;
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        useTabs.getState().newTab();
      }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        useTabs.getState().restoreClosed();
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        // closes the active tab — query or table alike (prompts on unsaved edits)
        const { activeId } = useTabs.getState();
        if (activeId) useCloseGuard.getState().request(activeId);
      }
      if (e.key === "Escape" && useExplain.getState().open) {
        useExplain.getState().close();
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void useExplain.getState().run();
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
    return () => {
      window.removeEventListener("keydown", onKey);
      unlistenClosed?.();
    };
  }, [loadProfiles]);

  return (
    <div className="v2-shell">
      {prodActive && <div className="prod-strip" title="Connected to PRODUCTION" />}

      <div className="v2-titlebar" data-tauri-drag-region>
        <motion.span className="v2-breadcrumb" key={crumbs.join("›")} {...swapIn}>
          {crumbs.map((seg, i, arr) => (
            <span key={i} className="crumb">
              {i > 0 && <span className="crumb-sep">/</span>}
              <span className={i === arr.length - 1 ? "crumb-strong" : ""}>{seg}</span>
            </span>
          ))}
        </motion.span>
        <button
          className="v2-tool"
          title="Theme"
          onClick={() => useUI.getState().openThemePicker()}
        >
          <SwatchBook size={15} />
        </button>
      </div>

      <div className="v2-body">
        <ConnectionRail />

        {homeMode ? (
          // full-screen connection surface (dashboard / editor)
          <motion.main className="main-card card" {...panelIn}>
            <Home />
          </motion.main>
        ) : (
          <>
            <motion.aside className="sidebar-card card" {...panelIn}>
              {activeProfile ? (
                <SidebarCard
                  profileId={activeProfile.id}
                  dbname={activeProfile.dbname}
                  name={activeProfile.name || activeProfile.host}
                />
              ) : (
                <div className="sb-empty">Select a connection</div>
              )}
            </motion.aside>

            <motion.main className="main-card card" {...panelIn}>
              {activeProfile ? (
                <>
                  <TabBar />
                  {isTableTab ? (
                    <TableBrowser />
                  ) : (
                    <>
                      <section className="editor-pane">
                        <QueryBox />
                      </section>
                      <section className="results-pane">
                        {explainOpen ? <ExplainView /> : <ResultsPane />}
                      </section>
                    </>
                  )}
                </>
              ) : (
                <div className="main-empty">
                  <div className="me-title">qwry</div>
                  <div>Pick a connection from the rail.</div>
                </div>
              )}

              {!inspectorOpen && activeProfile && (
                <button
                  className="inspector-reopen"
                  title="Show inspector ⌘I"
                  onClick={() => useInspector.getState().toggle()}
                >
                  ‹
                </button>
              )}
            </motion.main>

            <aside
              className={`inspector-card card${inspectorOpen ? "" : " collapsed"}${resizing ? " resizing" : ""}`}
              style={{ width: inspectorOpen ? inspectorWidth : 0 }}
            >
              <div className="inspector-resize" onMouseDown={startInspectorResize} />
              {/* fixed-width content so it slides in from the right as the card
                  widens (the main card reflows in lockstep) */}
              <div className="inspector-fixed" style={{ width: inspectorWidth }}>
                <Inspector />
              </div>
            </aside>
          </>
        )}
      </div>

      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ThemePicker />
      <DangerModal />
      <CloseGuardModal />
      <ConnToast />
    </div>
  );
}
