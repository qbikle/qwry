import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Lock, LockOpen, PanelRight, SwatchBook } from "lucide-react";
import { panelIn, swapIn } from "../design/springs";
import { useUI } from "../stores/ui";
import { ThemePicker } from "./ThemePicker";
import { useConnections } from "../stores/connections";
import { useInspector } from "../stores/inspector";
import { openFilePaths, openSqlFileDialog, saveActiveToFile, useTabs } from "../stores/tabs";
import { blankProfile, ConnectionRail } from "../sidebar/ConnectionRail";
import { editorFormat, editorRunText } from "../editor/SqlEditor";
import { openTxCount, skey } from "../stores/connections";
import { overlayOpen } from "./overlay/escStack";
import { useSettings } from "../stores/settings";
import { SettingsModal } from "./SettingsModal";
import { HistoryPanel } from "./HistoryPanel";
import { ShortcutsModal } from "./ShortcutsModal";
import { ZenScreen } from "./ZenScreen";
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
import { useFind } from "../stores/find";
import { useResults } from "../stores/results";
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
  // scalar selectors only — selecting the tab OBJECT re-rendered the entire
  // shell tree on every editor keystroke (setSql replaces the active tab
  // object). kind/name are primitives; table is a stable reference.
  const activeTabKind = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.kind ?? null);
  const activeTabName = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.name ?? null);
  const browserTable = useTabs((s) => {
    const t = s.tabs.find((tb) => tb.id === s.activeId);
    return t?.kind === "table" ? t.table : null;
  });
  const isTableTab = activeTabKind === "table";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const activeTabId = useTabs((s) => s.activeId);
  // prod safe-mode: is the ACTIVE tab's session unlocked for writes?
  const writeUnlocked = useConnections((s) => {
    const pid = s.activeProfileId;
    return pid && activeTabId ? !!s.writeTabs[skey(pid, activeTabId)] : false;
  });
  const editorFontSize = useSettings((s) => s.fontSize);
  const gridFontSize = useSettings((s) => s.gridFontSize);

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
        : activeTabName;
    return [activeProfile.name || activeProfile.host, activeProfile.dbname, ctx].filter(
      Boolean,
    ) as string[];
  }, [homeMode, activeProfile, isTableTab, browserTable, activeTabName]);

  // drag writes go straight to a CSS var — the store (and its localStorage
  // persist) previously ran once PER MOUSEMOVE and re-rendered the whole shell
  useEffect(() => {
    document.documentElement.style.setProperty("--inspector-w", `${inspectorWidth}px`);
  }, [inspectorWidth]);

  // editor font size flows through a CSS var — no CodeMirror remount
  useEffect(() => {
    document.documentElement.style.setProperty("--editor-fs", `${editorFontSize}px`);
  }, [editorFontSize]);
  useEffect(() => {
    document.documentElement.style.setProperty("--grid-fs", `${gridFontSize}px`);
  }, [gridFontSize]);

  // ambient which-connection cue: the profile's avatar color tints the
  // breadcrumb dot + active tab underline (falls back to the theme accent)
  useEffect(() => {
    const c = connected ? activeProfile?.color : null;
    if (c) document.documentElement.style.setProperty("--conn-color", c);
    else document.documentElement.style.removeProperty("--conn-color");
  }, [activeProfile?.color, connected]);

  // user-draggable layout (editor/results split, sidebar width): CSS vars
  // during drag — zero re-renders — persisted to localStorage on release
  const [splitDragging, setSplitDragging] = useState(false);
  useEffect(() => {
    // a split persisted on a tall display must not swallow the results pane
    // (divider off-screen = unrecoverable) — clamp on restore AND live resize
    const clampEditorH = () => {
      const raw = localStorage.getItem("qwry.editorH");
      if (!raw) return;
      const px = parseInt(raw, 10);
      if (Number.isNaN(px)) return;
      const max = Math.max(90, window.innerHeight - 320); // results + chrome stay usable
      document.documentElement.style.setProperty("--editor-h", `${Math.min(px, max)}px`);
    };
    clampEditorH();
    const w = localStorage.getItem("qwry.sidebarW");
    if (w) document.documentElement.style.setProperty("--sidebar-w", w);
    window.addEventListener("resize", clampEditorH);
    return () => window.removeEventListener("resize", clampEditorH);
  }, []);

  const startSplitResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setSplitDragging(true);
    const pane = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement | null;
    const host = pane?.parentElement;
    if (!pane || !host) return;
    let value = "";
    const onMove = (me: MouseEvent) => {
      const r = host.getBoundingClientRect();
      const top = pane.getBoundingClientRect().top;
      // clamp: keep both panes usable
      const px = Math.max(90, Math.min(me.clientY - top, r.bottom - top - 140));
      value = `${px}px`;
      document.documentElement.style.setProperty("--editor-h", value);
    };
    const onUp = () => {
      setSplitDragging(false);
      if (value) localStorage.setItem("qwry.editorH", value);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const card = (e.currentTarget as HTMLElement).parentElement;
    if (!card) return;
    let value = "";
    const onMove = (me: MouseEvent) => {
      // recompute per move — the card's mount spring animates its position
      const left = card.getBoundingClientRect().left;
      const px = Math.max(180, Math.min(me.clientX - left, 420));
      value = `${px}px`;
      document.documentElement.style.setProperty("--sidebar-w", value);
    };
    const onUp = () => {
      if (value) localStorage.setItem("qwry.sidebarW", value);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // prod safe-mode chip: confirm, then lift read-only on THIS tab's session only
  const toggleProdWrites = async () => {
    const { activeProfileId: pid, setSessionWrites } = useConnections.getState();
    const tabId = useTabs.getState().activeId;
    if (!pid || !tabId) return;
    if (writeUnlocked) {
      void setSessionWrites(pid, tabId, false); // re-locking needs no ceremony
      return;
    }
    const { confirmDanger } = await import("../stores/danger");
    const name = useConnections.getState().profiles.find((p) => p.id === pid)?.name || "production";
    const ok = await confirmDanger(
      `Enable writes on ${name}?`,
      "This tab's session drops the server-side read-only guard.\nEvery other tab stays read-only. Re-lock via the same chip.",
      "Enable writes",
    );
    if (ok) void setSessionWrites(pid, tabId, true);
  };

  const startInspectorResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true); // suppress the width transition while dragging
    let w = useInspector.getState().width;
    const onMove = (me: MouseEvent) => {
      w = Math.max(220, Math.min(640, window.innerWidth - me.clientX));
      document.documentElement.style.setProperty("--inspector-w", `${w}px`);
    };
    const onUp = () => {
      setResizing(false);
      useInspector.getState().setWidth(w); // one store write, on release
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    loadProfiles();
    void useTabs.getState().load();

    // StrictMode double-mounts this effect — a listener that resolves after
    // the first mount's cleanup ran must unregister itself, not leak
    let disposed = false;

    // a connection's socket died → flip its dot (auto-reconnects on next run)
    let unlistenClosed: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ session_id: string; profile_id: string; reason: string | null }>(
        "session-closed",
        (e) => {
          // session_id lets the store tell a dead SPARE apart from a real
          // drop; the reason (when driver-known) drives the store's toast
          useConnections
            .getState()
            .markDisconnected(e.payload.profile_id, e.payload.session_id, e.payload.reason);
        },
      ).then((un) => {
        if (disposed) un();
        else unlistenClosed = un;
      }),
    );

    // quit/close flow shared by the menu's Quit (⌘Q) and the window close
    // button: flush the debounced tab persist so the last keystrokes hit disk,
    // guard uncommitted cell edits / a half-typed draft row, then destroy.
    const requestQuit = async () => {
      const { flushTabs } = await import("../stores/tabs");
      await flushTabs();
      const [{ useEdits }, { useBrowser }] = await Promise.all([
        import("../stores/edits"),
        import("../stores/browser"),
      ]);
      const dirty = Object.values(useEdits.getState().byTab).reduce(
        (n, t) => n + Object.keys(t.pending).length,
        0,
      );
      const draft = Object.values(useBrowser.getState().byTab).some(
        (t) => t.draftRow && Object.keys(t.draftRow).length > 0,
      );
      // open transactions roll back on quit — that loss needs the same
      // confirm as staged edits, never a silent rollback
      const txn = useConnections
        .getState()
        .profiles.reduce((n, p) => n + openTxCount(p.id), 0);
      if (dirty > 0 || draft || txn > 0) {
        const { confirmDanger } = await import("../stores/danger");
        const ok = await confirmDanger(
          dirty > 0
            ? `Quit with ${dirty} uncommitted edit${dirty === 1 ? "" : "s"}?`
            : draft
              ? "Quit with an unfinished new row?"
              : `Quit with ${txn} open transaction${txn === 1 ? "" : "s"}?`,
          [
            dirty > 0 || draft
              ? "Staged changes are not written to the database and will be lost."
              : null,
            txn > 0
              ? `Open transaction${txn === 1 ? "" : "s"} on ${txn} tab${txn === 1 ? "" : "s"} will be rolled back.`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
          "Quit",
        );
        if (!ok) return; // keep the app open
      }
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      void getCurrentWindow().destroy(); // bypasses onCloseRequested
    };

    let unlistenClose: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win
        .onCloseRequested(async (event) => {
          event.preventDefault(); // hold the close until the flush lands
          await requestQuit();
        })
        .then((un) => {
          if (disposed) un();
          else unlistenClose = un;
        });
    });

    // native menu bar → store actions (custom items emit "menu" with their id)
    let unlistenMenu: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("menu", (e) => {
        // an open overlay owns the interaction — the menu path used to act
        // BEHIND modals (Close Tab under an open CloseGuard etc.), mirroring
        // the keyboard guard below. Help and Quit stay reachable, like ⌘?.
        if (overlayOpen() && e.payload !== "shortcuts" && e.payload !== "quit") return;
        switch (e.payload) {
          case "new-tab":
            useTabs.getState().newTab();
            break;
          case "new-connection":
            useConnections.getState().editConnection(blankProfile());
            break;
          case "close-tab": {
            const { activeId } = useTabs.getState();
            if (activeId) useCloseGuard.getState().request(activeId);
            break;
          }
          // File ▸ Open… / Save — ids reserved for the native menu items
          // (lib.rs); the ⌘O/⌘⇧S window shortcuts below work regardless
          case "open-file":
            void openSqlFileDialog();
            break;
          case "save-file":
            void saveActiveToFile();
            break;
          case "restore-tab":
            useTabs.getState().restoreClosed();
            break;
          case "run": {
            const t = editorRunText.current?.();
            void useResults.getState().run(t?.text, t?.offset);
            break;
          }
          case "run-all":
            void useResults.getState().run(useConnections.getState().sql, 0);
            break;
          case "cancel":
            void useResults.getState().cancel();
            break;
          case "explain":
            void useExplain.getState().run(editorRunText.current?.()?.text);
            break;
          case "commit":
            void import("../stores/edits").then(({ useEdits }) => {
              const st = useEdits.getState();
              if (Object.keys(st.pending).length > 0) void st.openPreview();
              else void useTabs.getState().saveActive();
            });
            break;
          case "palette":
            setPaletteOpen((o) => !o);
            break;
          case "inspector":
            useInspector.getState().toggle();
            break;
          case "theme":
            useUI.getState().openThemePicker();
            break;
          case "settings":
            useSettings.getState().setSettingsOpen(true);
            break;
          case "history":
            setHistoryOpen(true);
            break;
          case "shortcuts":
            setKeysOpen(true);
            break;
          case "format":
            editorFormat.current?.();
            break;
          case "refresh-schema": {
            void import("../stores/schema").then(({ useSchema }) => {
              const { activeProfileId: pid, sessions } = useConnections.getState();
              if (pid && sessions[pid]) void useSchema.getState().fetch(pid, sessions[pid]);
            });
            break;
          }
          case "quit":
            void requestQuit();
            break;
        }
      }).then((un) => {
        if (disposed) un();
        else unlistenMenu = un;
      }),
    );

    // OS file drops (Finder → editor) open .sql/.txt as tabs. Tauri-level,
    // not HTML5: with dragDropEnabled (the default) WKWebView never delivers
    // HTML5 file-drop events. Gated to the main (editor) card so stray drops
    // on the rail/sidebar don't hijack; internal drags (tab strip, grid) are
    // mouse-event based and never enter this path.
    let unlistenDrag: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((e) => {
          if (e.payload.type !== "drop") return;
          const files = e.payload.paths.filter((p) => /\.(sql|txt)$/i.test(p));
          if (files.length === 0) return;
          if (useConnections.getState().homeMode) return; // no tab strip there
          // payload position is PHYSICAL px — scale to logical before hit-test
          const scale = window.devicePixelRatio || 1;
          const x = e.payload.position.x / scale;
          const y = e.payload.position.y / scale;
          const r = document.querySelector(".main-card")?.getBoundingClientRect();
          if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return;
          void openFilePaths(files);
        })
        .then((un) => {
          if (disposed) un();
          else unlistenDrag = un;
        }),
    );

    // palette action → history panel (palette has no access to App state)
    const onOpenHistory = () => setHistoryOpen(true);
    window.addEventListener("qwry:open-history", onOpenHistory);

    const onKey = (e: KeyboardEvent) => {
      // CodeMirror (or another component) already handled it — don't double-fire
      if (e.defaultPrevented) return;
      // ⌘? is non-destructive and useful FROM a modal — the only shortcut
      // exempt from the overlay guard below (the menu path isn't gated either).
      // WebKit reports the UNSHIFTED key while ⌘ is held, so ⌘⇧/ arrives as
      // key="/" — match both spellings or the binding never fires on macOS.
      if (e.metaKey && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
        e.preventDefault();
        setKeysOpen(true);
        return;
      }
      // an open overlay owns the keyboard: without this, ⌘W through the
      // palette/history/settings closed tabs BEHIND the modal (escStack only
      // hard-claims Escape; everything else used to fall through to here)
      if (overlayOpen()) return;
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (e.metaKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        useSettings.getState().setSettingsOpen(true);
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        setHistoryOpen(true);
      }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        useTabs.getState().newTab();
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openSqlFileDialog();
      }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveActiveToFile();
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
      // ⌘F = find scoped to the focused surface. The editor (CodeMirror
      // search panel) and the inspector (JsonTree search) handle their own
      // ⌘F and preventDefault before this window listener fires; anything
      // else routes to find-in-results over the loaded grid rows.
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        const t = e.target as HTMLElement | null;
        const inInspector = !!t?.closest?.(".inspector-fixed");
        if (!inInspector && useResults.getState().statements.length > 0) {
          e.preventDefault();
          useFind.getState().openFind();
        }
      }
      // ⌘G / ⌘⇧G step find-in-results matches while the bar is open
      if (e.metaKey && e.key.toLowerCase() === "g" && useFind.getState().open) {
        e.preventDefault();
        useFind.getState().step(e.shiftKey ? -1 : 1);
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
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "i") {
        // table browser: open (or toggle away) the inline new-row band
        const t = useTabs.getState();
        const tab = t.tabs.find((x) => x.id === t.activeId);
        if (tab?.kind !== "table") return;
        e.preventDefault();
        void import("../stores/browser").then(({ useBrowser }) => {
          const b = useBrowser.getState();
          if (b.draftRow) b.cancelDraft();
          else b.beginDraft();
        });
      }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        // direct discard, no confirm — discardAll pushes an undo snapshot,
        // so ⌘Z brings the staged edits straight back
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
      disposed = true;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("qwry:open-history", onOpenHistory);
      unlistenClosed?.();
      unlistenClose?.();
      unlistenMenu?.();
      unlistenDrag?.();
    };
  }, [loadProfiles]);

  return (
    <div className="v2-shell">
      {prodActive && <div className="prod-strip" title="Connected to PRODUCTION" />}

      <div className="v2-titlebar" data-tauri-drag-region>
        <motion.span className="v2-breadcrumb" key={crumbs.join("›")} {...swapIn}>
          {connected && <span className="conn-dot" title={activeProfile?.name} />}
          {crumbs.map((seg, i, arr) => (
            <span key={i} className="crumb">
              {i > 0 && <span className="crumb-sep">/</span>}
              <span className={i === arr.length - 1 ? "crumb-strong" : ""}>{seg}</span>
            </span>
          ))}
        </motion.span>
        {prodActive && (
          <button
            className={`prod-chip ${writeUnlocked ? "unlocked" : "locked"}`}
            title={
              writeUnlocked
                ? "Writes ENABLED on this tab's session — click to re-lock"
                : "PROD safe-mode: session is read-only at the server — click to enable writes for this tab"
            }
            onClick={() => void toggleProdWrites()}
          >
            {writeUnlocked ? <LockOpen size={10} /> : <Lock size={10} />}
            {writeUnlocked ? "PROD · WRITES ON" : "PROD · READ-ONLY"}
          </button>
        )}
        <button
          className="v2-tool"
          title="Theme"
          onClick={() => useUI.getState().openThemePicker()}
        >
          <SwatchBook size={15} />
        </button>
        <button
          className={`v2-tool${inspectorOpen ? " on" : ""}`}
          title="Inspector ⌘I"
          onClick={() => useInspector.getState().toggle()}
        >
          <PanelRight size={15} />
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
              <div className="sidebar-resize" onMouseDown={startSidebarResize} />
            </motion.aside>

            <motion.main className="main-card card" {...panelIn}>
              {activeProfile ? (
                <>
                  <TabBar />
                  {activeTabKind === null ? (
                    // zero tabs is a legal state — breathe (no phoenix tab)
                    <ZenScreen />
                  ) : isTableTab ? (
                    <TableBrowser />
                  ) : (
                    <>
                      <section className="editor-pane">
                        <QueryBox />
                      </section>
                      <div
                        className={`split-divider${splitDragging ? " dragging" : ""}`}
                        title="Drag to resize editor / results"
                        onMouseDown={startSplitResize}
                        onDoubleClick={() => {
                          // dbl-click = reset to the default split
                          document.documentElement.style.removeProperty("--editor-h");
                          localStorage.removeItem("qwry.editorH");
                        }}
                      />
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


            </motion.main>

            <aside
              className={`inspector-card card${inspectorOpen ? "" : " collapsed"}${resizing ? " resizing" : ""}`}
              style={{ width: inspectorOpen ? "var(--inspector-w)" : 0 }}
            >
              <div className="inspector-resize" onMouseDown={startInspectorResize} />
              {/* fixed-width content so it slides in from the right as the card
                  widens (the main card reflows in lockstep) */}
              <div className="inspector-fixed" style={{ width: "var(--inspector-w)" }}>
                <Inspector />
              </div>
            </aside>
          </>
        )}
      </div>

      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} />}
      {keysOpen && <ShortcutsModal onClose={() => setKeysOpen(false)} />}
      <SettingsModal />
      <ThemePicker />
      <DangerModal />
      <CloseGuardModal />
      <ConnToast />
    </div>
  );
}
