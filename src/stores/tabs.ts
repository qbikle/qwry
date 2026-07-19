import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { bufferSnapshotsClear, fileStat, readTextFile, writeTextFile } from "../ipc/commands";
import { useConnections } from "./connections";
import type { TableInfo } from "./schema";

export interface Tab {
  id: string;
  name: string;
  sql: string;
  position: number;
  /** link to a saved query — keeps names/sql in sync */
  saved_id: string | null;
  /** "query" = SQL editor tab; "table" = data-browser tab (session-only) */
  kind: "query" | "table";
  /** the browsed table when kind === "table" */
  table: TableInfo | null;
  /** owning connection. null = legacy tab from before per-connection
   * workspaces — visible under every connection until first edited under one
   * (adopt-on-touch), so no pre-existing tab ever silently disappears. */
  profile_id: string | null;
  /** backing .sql file on disk — SESSION-ONLY: the appdb tabs table has no
   * column for it (tabs_save strips to the appdb fields), so a restart drops
   * the link but never the text */
  file_path?: string;
  /** exact text last read from / written to file_path — dirty dot = drift */
  file_saved_sql?: string;
  /** file mtime at open/last save — ⌘⇧S compares before overwriting so an
   * external edit is never silently clobbered (session-only, like file_path) */
  file_mtime_ms?: number;
}

interface ClosedTab {
  name: string;
  sql: string;
  saved_id: string | null;
  kind: Tab["kind"];
  table: TableInfo | null;
  profile_id: string | null;
  file_path?: string;
  file_saved_sql?: string;
  file_mtime_ms?: number;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  loaded: boolean;
  /** the last tabs_save failed — surfaced so persistence can never lie */
  saveError: boolean;
  /** most-recently-closed first; ⌘⇧T pops */
  closedStack: ClosedTab[];

  load: () => Promise<void>;
  newTab: (sql?: string, name?: string, savedId?: string | null) => void;
  /** open (or focus) a data-browser tab for a table; returns the tab id */
  openTableTab: (table: TableInfo) => string;
  /** open (or focus) a query tab backed by a .sql file on disk; mtimeMs
   * stamps the save-conflict baseline (undefined = stat unavailable) */
  openFileTab: (path: string, contents: string, mtimeMs?: number) => string;
  closeTab: (id: string) => void;
  select: (id: string) => void;
  /** drag-reorder: move VISIBLE index `from` to sit at VISIBLE boundary `to` */
  moveTab: (from: number, to: number) => void;
  selectByIndex: (i: number) => void;
  cycle: (dir: 1 | -1) => void;
  restoreClosed: () => void;
  rename: (id: string, name: string) => void;
  /** pinned tab ids — pinned tabs are visible under EVERY connection and
   * survive bulk closes / middle-click; explicit X still closes */
  pinned: Set<string>;
  togglePin: (id: string) => void;
  /** bulk close — scoped to the CURRENT connection's visible tabs */
  closeOthers: (id: string) => void;
  closeToRight: (id: string) => void;
  closeAll: () => void;
  /** ⌘S: persist the active tab into the saved-queries sidebar */
  saveActive: () => Promise<void>;
  /** a profile was deleted — close its tabs (pins become orphans, kept) */
  purgeProfileTabs: (profileId: string) => void;
}

// ---------------------------------------------------------------------------
// Per-connection visibility. A tab is visible under profile `pid` when it
// belongs to it, is pinned (cross-connection by design), or is a legacy
// pre-workspace tab (profile_id null). With no active profile everything is
// visible — the tab UI is hidden then, but invariants stay simple.
export function isTabVisible(t: Tab, pinned: ReadonlySet<string>, pid: string | null): boolean {
  if (!pid) return true;
  return t.profile_id === pid || t.profile_id === null || pinned.has(t.id);
}

export function visibleTabs(tabs: Tab[], pinned: ReadonlySet<string>, pid: string | null): Tab[] {
  return tabs.filter((t) => isTabVisible(t, pinned, pid));
}

const activePid = () => useConnections.getState().activeProfileId;

/** ⌘T contract: a new tab lands you TYPING. The editor (which may only mount
 * on the next render — zero-tab state) consumes this and focuses itself. */
export const editorFocusSignal = { current: false };

// per-connection "last active tab" memory (localStorage — UI nicety only)
const ACTIVE_KEY = "qwry.activeTabByProfile";
function readActiveMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function rememberActive(pid: string | null, tabId: string) {
  if (!pid) return;
  const m = readActiveMap();
  m[pid] = tabId;
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(m));
}
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveRetryTimer: ReturnType<typeof setTimeout> | null = null;

function doSave(): Promise<void> {
  const { tabs, loaded } = useTabs.getState();
  // NEVER persist before load succeeded — tabs_save is replace-all, so a
  // failed startup load followed by a save would WIPE every saved tab
  if (!loaded) return Promise.resolve();
  // table tabs are session-only; persist query tabs only, stripped to the
  // appdb fields. Dedupe by id as insurance — one duplicated tab must never
  // wedge saving forever (tabs.id is a PRIMARY KEY in a replace-all write)
  const seen = new Set<string>();
  const rows = tabs
    .filter((t) => t.kind === "query" && !seen.has(t.id) && (seen.add(t.id), true))
    .map(({ id, name, sql, saved_id, profile_id }, i) => ({
      id,
      name,
      sql,
      position: i,
      saved_id,
      profile_id,
    }));
  return invoke<void>("tabs_save", { tabs: rows })
    .then(() => {
      if (useTabs.getState().saveError) useTabs.setState({ saveError: false });
    })
    .catch((e) => {
      // surface + retry — a silently failing save would lie about safety
      console.error("tabs_save failed", e);
      useTabs.setState({ saveError: true });
      if (saveRetryTimer) clearTimeout(saveRetryTimer);
      saveRetryTimer = setTimeout(() => void doSave(), 3000);
    });
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void doSave();
  }, 600);
}

/** fire any debounced save NOW — window blur / close must not lose the last
 * ≤600ms of typing */
export function flushTabs(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return doSave();
}

// the debounce must never outlive focus: flush when the window deactivates
window.addEventListener("blur", () => void flushTabs());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushTabs();
});

const blank = (n: number, pid: string | null): Tab => ({
  id: crypto.randomUUID(),
  name: "new qwry",
  sql: "",
  position: n - 1,
  saved_id: null,
  kind: "query",
  table: null,
  profile_id: pid,
});

const asClosed = (t: Tab): ClosedTab => ({
  name: t.name,
  sql: t.sql,
  saved_id: t.saved_id,
  kind: t.kind,
  table: t.table,
  profile_id: t.profile_id,
  file_path: t.file_path,
  file_saved_sql: t.file_saved_sql,
  file_mtime_ms: t.file_mtime_ms,
});

/** a file-backed tab whose buffer drifted from its on-disk copy — closing it
 * is honest about DISK only (the text itself persists in the app db) */
export function fileDrifted(t: Tab): boolean {
  return t.file_path != null && t.sql !== t.file_saved_sql;
}

/** one aggregate prompt when bulk-closing tabs that hold uncommitted cell
 * edits or unsaved file drift */
async function confirmBulkClose(ids: string[]): Promise<boolean> {
  const { useEdits } = await import("./edits");
  const byTab = useEdits.getState().byTab;
  const dirty = ids.filter((id) => Object.keys(byTab[id]?.pending ?? {}).length > 0).length;
  const tabs = useTabs.getState().tabs;
  const drifted = ids.filter((id) => {
    const t = tabs.find((x) => x.id === id);
    return !!t && fileDrifted(t);
  }).length;
  if (dirty === 0 && drifted === 0) return true;
  const { confirmDanger } = await import("./danger");
  const detail = [
    dirty > 0
      ? `Staged cell edits in ${dirty} tab${dirty === 1 ? "" : "s"} will be discarded.`
      : null,
    drifted > 0
      ? `${drifted} file-backed tab${drifted === 1 ? " has" : "s have"} changes not written to ${
          drifted === 1 ? "its" : "their"
        } .sql file on disk (the text stays in qwry, the file keeps its old version).`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  const n = new Set([
    ...ids.filter((id) => Object.keys(byTab[id]?.pending ?? {}).length > 0),
    ...ids.filter((id) => {
      const t = tabs.find((x) => x.id === id);
      return !!t && fileDrifted(t);
    }),
  ]).size;
  return confirmDanger(
    `Close ${n} tab${n === 1 ? "" : "s"} with unsaved changes?`,
    detail,
    dirty > 0 ? "Discard & close" : "Close anyway",
  );
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  loaded: false,
  saveError: false,
  closedStack: [],

  load: async () => {
    // load exactly once — a second call (HMR remount, StrictMode) must not
    // re-merge in-memory tabs with the disk rows: that duplicates every tab
    // WITH ITS ID, which breaks close (filter removes both) and tabs_save
    // (PRIMARY KEY violation → permanent "not saving")
    if (get().loaded) return;
    try {
      // appdb only stores query tabs (no kind/table) — normalize on the way in
      const rows = await invoke<Omit<Tab, "kind" | "table">[]>("tabs_list");
      const restored: Tab[] = rows.map((r) => ({
        ...r,
        kind: "query",
        table: null,
        profile_id: r.profile_id ?? null,
      }));
      // a failed first load may have left the user typing into a scratch tab —
      // carry any non-empty buffer over (never a tab that's already on disk)
      const restoredIds = new Set(restored.map((t) => t.id));
      const scratch = get().tabs.filter(
        (t) => t.sql.trim() !== "" && !restoredIds.has(t.id),
      );
      const tabs = [...restored, ...scratch]; // zero tabs is a legal state
      // launch happens on the home surface (no profile) — every tab is
      // visible; the per-profile active tab is applied on connect
      const remembered = localStorage.getItem("qwry.activeTab");
      const first = tabs.find((t) => t.id === remembered) ?? tabs[0] ?? null;
      // prune pin ids whose tabs no longer exist (X-closed, or session-only
      // table tabs) — otherwise qwry.pinnedTabs grows forever
      const pinned = new Set([...get().pinned].filter((id) => tabs.some((t) => t.id === id)));
      localStorage.setItem("qwry.pinnedTabs", JSON.stringify([...pinned]));
      set({ tabs, activeId: first?.id ?? null, loaded: true, pinned });
      useConnections.getState().setSql(first?.sql ?? "");
    } catch (e) {
      // keep loaded=false — persist() is gated on it, so the saved tabs on
      // disk stay untouched; give the user a scratch tab and retry
      console.error("tabs_list failed, retrying", e);
      set({ saveError: true }); // scratchless: empty strip is fine now
      setTimeout(() => void get().load(), 1500);
    }
  },

  newTab: (sql = "", name, savedId = null) => {
    const { tabs } = get();
    const t = {
      ...blank(tabs.length + 1, activePid()),
      sql,
      name: name ?? "new qwry",
      saved_id: savedId,
    };
    set({ tabs: [...tabs, t], activeId: t.id });
    rememberActive(activePid(), t.id);
    useConnections.getState().setSql(sql);
    editorFocusSignal.current = true;
    persist();
  },

  openFileTab: (path, contents, mtimeMs) => {
    const { tabs, pinned } = get();
    // the same file twice focuses the existing tab — never a duplicate.
    // Scoped to the VISIBLE strip: a foreign workspace's tab must not be
    // focused invisibly (reopening there gets its own tab instead).
    const existing = visibleTabs(tabs, pinned, activePid()).find((t) => t.file_path === path);
    if (existing) {
      const clean = existing.sql === existing.file_saved_sql;
      const diskChanged = contents !== existing.file_saved_sql;
      if (clean && diskChanged) {
        // the tab tracks its file faithfully — adopt the fresh disk contents
        // instead of silently discarding the re-read
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === existing.id
              ? { ...t, sql: contents, file_saved_sql: contents, file_mtime_ms: mtimeMs }
              : t,
          ),
        }));
        persist();
      } else if (clean) {
        // contents unchanged — just refresh the save-conflict baseline
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === existing.id ? { ...t, file_mtime_ms: mtimeMs ?? t.file_mtime_ms } : t,
          ),
        }));
      }
      get().select(existing.id);
      editorFocusSignal.current = true;
      if (!clean && diskChanged) {
        // dirty tab + changed file: keep the buffer AND the old baseline (so
        // ⌘⇧S still prompts before clobbering the newer disk version) — but
        // say so instead of silently discarding the read
        void import("./danger").then(({ confirmDanger }) =>
          confirmDanger(
            "File changed on disk",
            `${path}\n\nThe tab keeps your unsaved version — the newer disk contents were not loaded. ⌘⇧S will ask before overwriting them.`,
            "OK",
          ),
        );
      }
      return existing.id;
    }
    const t: Tab = {
      ...blank(tabs.length + 1, activePid()),
      sql: contents,
      name: path.split("/").pop() || "file.sql",
      file_path: path,
      file_saved_sql: contents,
      file_mtime_ms: mtimeMs,
    };
    set({ tabs: [...tabs, t], activeId: t.id });
    rememberActive(activePid(), t.id);
    useConnections.getState().setSql(contents);
    editorFocusSignal.current = true;
    persist();
    return t.id;
  },

  openTableTab: (table) => {
    const { tabs } = get();
    const id = crypto.randomUUID();
    const t: Tab = {
      id,
      name: table.name,
      sql: "",
      position: tabs.length,
      saved_id: null,
      kind: "table",
      table,
      profile_id: activePid(),
    };
    set({ tabs: [...tabs, t], activeId: id });
    rememberActive(activePid(), id);
    persist(); // no-op for the table tab itself; keeps query-tab order in sync
    return id;
  },

  closeTab: (id) => {
    const { tabs, activeId, closedStack, pinned } = get();
    // drop the closed tab's dedicated DB session(s)
    useConnections.getState().closeTabSessions(id);
    // the tab's buffer time-machine dies with it (a ⌘⇧T restore gets a NEW id)
    void bufferSnapshotsClear(id).catch(() => {});
    const closing = tabs.find((t) => t.id === id);
    const remember =
      closing && (closing.sql.trim() !== "" || closing.kind === "table")
        ? [asClosed(closing), ...closedStack].slice(0, 20)
        : closedStack;
    // an X-closed pin is gone — a dangling id would resurrect on nothing
    if (pinned.has(id)) {
      const nextPinned = new Set(pinned);
      nextPinned.delete(id);
      localStorage.setItem("qwry.pinnedTabs", JSON.stringify([...nextPinned]));
      set({ pinned: nextPinned });
    }
    const next = tabs.filter((t) => t.id !== id);
    const pid = activePid();
    const visNext = visibleTabs(next, get().pinned, pid);
    // closing the LAST visible tab leaves an empty strip — a phoenix scratch
    // tab that always came back was more annoying than an empty state
    if (visNext.length === 0) {
      set({ tabs: next, activeId: null, closedStack: remember });
      useConnections.getState().setSql("");
      persist();
      return;
    }
    let newActive = activeId;
    let fallback: Tab | null = null;
    if (activeId === id) {
      // neighbor within the VISIBLE strip, not the global array — closing a
      // tab must never teleport focus to another connection's hidden tab
      const visAll = visibleTabs(tabs, get().pinned, pid);
      const visIdx = visAll.findIndex((t) => t.id === id);
      fallback = visNext[Math.max(0, visIdx - 1)] ?? visNext[visNext.length - 1];
      newActive = fallback.id;
      rememberActive(pid, fallback.id);
    }
    // activeId before setSql — same order as select/closeAll, so the editor's
    // subscribers land on the fallback tab instead of the dying one's doc
    set({ tabs: next, activeId: newActive, closedStack: remember });
    if (fallback) useConnections.getState().setSql(fallback.sql);
    persist();
  },

  pinned: new Set(
    (() => {
      try {
        return JSON.parse(localStorage.getItem("qwry.pinnedTabs") ?? "[]") as string[];
      } catch {
        return [];
      }
    })(),
  ),
  togglePin: (id) => {
    const pinned = new Set(get().pinned);
    const pid = activePid();
    if (pinned.has(id)) {
      pinned.delete(id);
      // unpinning returns the tab to its home connection. If that home is
      // gone (deleted profile / legacy null while connected), adopt the
      // CURRENT one — a tab visible nowhere would be lost alive.
      const t = get().tabs.find((x) => x.id === id);
      const profiles = useConnections.getState().profiles;
      if (t && pid && (t.profile_id === null || !profiles.some((p) => p.id === t.profile_id))) {
        set((s) => ({
          tabs: s.tabs.map((x) => (x.id === id ? { ...x, profile_id: pid } : x)),
        }));
        persist();
      }
    } else {
      pinned.add(id);
    }
    localStorage.setItem("qwry.pinnedTabs", JSON.stringify([...pinned]));
    set({ pinned });
    // unpinning a foreign tab removes it from THIS strip — refocus if needed
    ensureActiveVisible();
  },

  closeOthers: (id) => {
    void (async () => {
      const { pinned, tabs } = get();
      const ids = visibleTabs(tabs, pinned, activePid())
        .filter((t) => t.id !== id && !pinned.has(t.id))
        .map((t) => t.id);
      if (ids.length === 0) return;
      if (!(await confirmBulkClose(ids))) return;
      ids.forEach((oid) => get().closeTab(oid));
      get().select(id);
    })();
  },

  closeToRight: (id) => {
    void (async () => {
      const { tabs, pinned } = get();
      const vis = visibleTabs(tabs, pinned, activePid());
      const idx = vis.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const ids = vis.slice(idx + 1).filter((t) => !pinned.has(t.id)).map((t) => t.id);
      if (ids.length === 0) return;
      if (!(await confirmBulkClose(ids))) return;
      ids.forEach((rid) => get().closeTab(rid));
      get().select(id);
    })();
  },

  closeAll: () => {
    void (async () => {
      const { pinned, tabs } = get();
      const pid = activePid();
      const closing = visibleTabs(tabs, pinned, pid).filter((t) => !pinned.has(t.id));
      if (closing.length === 0) return;
      if (!(await confirmBulkClose(closing.map((t) => t.id)))) return;
      closing.forEach((t) => {
        useConnections.getState().closeTabSessions(t.id);
        void bufferSnapshotsClear(t.id).catch(() => {});
      });
      const closingIds = new Set(closing.map((t) => t.id));
      const remember = [
        ...closing.filter((t) => t.sql.trim() !== "" || t.kind === "table").map(asClosed),
        ...get().closedStack,
      ].slice(0, 20);
      // other connections' tabs are untouched; pinned survive here too
      const next = get().tabs.filter((t) => !closingIds.has(t.id));
      const visNext = visibleTabs(next, pinned, pid);
      const active = visNext[0] ?? null; // empty strip is fine
      set({
        tabs: next.map((t, i) => ({ ...t, position: i })),
        activeId: active?.id ?? null,
        closedStack: remember,
      });
      if (active) rememberActive(pid, active.id);
      useConnections.getState().setSql(active?.sql ?? "");
      persist();
    })();
  },

  select: (id) => {
    const t = get().tabs.find((t) => t.id === id);
    if (!t) return;
    set({ activeId: id });
    localStorage.setItem("qwry.activeTab", id); // launch fallback
    rememberActive(activePid(), id);
    useConnections.getState().setSql(t.sql);
  },

  moveTab: (from, to) => {
    // indexes speak the VISIBLE strip; the global array holds every
    // connection's tabs — anchor-splice, same technique as column reorder
    // over hidden columns, so invisible tabs keep their relative slots
    const { tabs, pinned } = get();
    const vis = visibleTabs(tabs, pinned, activePid());
    if (from < 0 || from >= vis.length || to < 0 || to > vis.length || from === to) return;
    const fromTab = vis[from];
    const visWithout = vis.filter((t) => t.id !== fromTab.id);
    const anchor = visWithout[to > from ? to - 1 : to]; // undefined = past the end
    const without = tabs.filter((t) => t.id !== fromTab.id);
    const at = anchor ? without.findIndex((t) => t.id === anchor.id) : without.length;
    without.splice(at, 0, fromTab);
    set({ tabs: without.map((tb, i) => ({ ...tb, position: i })) });
    persist();
  },

  selectByIndex: (i) => {
    const vis = visibleTabs(get().tabs, get().pinned, activePid());
    const t = vis[i];
    if (t) get().select(t.id);
  },

  cycle: (dir) => {
    const { activeId } = get();
    const vis = visibleTabs(get().tabs, get().pinned, activePid());
    if (vis.length < 2) return;
    const idx = vis.findIndex((t) => t.id === activeId);
    const next = vis[(idx + dir + vis.length) % vis.length];
    get().select(next.id);
  },

  restoreClosed: () => {
    const { closedStack } = get();
    const top = closedStack[0];
    if (!top) return;
    set({ closedStack: closedStack.slice(1) });
    if (top.kind === "table" && top.table) {
      // reopen as a real table tab (re-runs the browse; adopts current conn)
      void import("./browser").then(({ useBrowser }) => useBrowser.getState().openTable(top.table!));
    } else {
      // ⌘⇧T means "bring it back HERE" — newTab stamps the current profile;
      // the saved-query link survives so the restored tab still syncs
      get().newTab(top.sql, top.name, top.saved_id);
      // a file-backed tab keeps its disk link (and dirty state) through ⌘⇧T
      if (top.file_path) {
        const id = get().activeId;
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  file_path: top.file_path,
                  file_saved_sql: top.file_saved_sql,
                  file_mtime_ms: top.file_mtime_ms,
                }
              : t,
          ),
        }));
      }
    }
  },

  rename: (id, name) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)) }));
    const t = get().tabs.find((t) => t.id === id);
    if (t?.saved_id) {
      // keep the sidebar entry's NAME in sync — never its SQL: the tab's
      // buffer may hold an unsaved draft, and a mere rename must not push
      // that draft over the saved query (⌘S is the only sql-update path)
      void import("./saved").then(({ useSaved }) => {
        const saved = useSaved.getState().queries.find((q) => q.id === t.saved_id);
        if (saved) void useSaved.getState().upsert({ ...saved, name });
      });
    }
    persist();
  },

  saveActive: async () => {
    const { tabs, activeId } = get();
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || !tab.sql.trim()) return;
    const { useSaved } = await import("./saved");
    const savedId = tab.saved_id ?? crypto.randomUUID();
    await useSaved.getState().upsert({ id: savedId, name: tab.name, sql: tab.sql });
    if (!tab.saved_id) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, saved_id: savedId } : t)),
      }));
      persist();
    }
  },

  purgeProfileTabs: (profileId) => {
    // deleted profile: its unpinned tabs die (sessions already torn down by
    // deleteProfile); its PINNED tabs stay as orphans — cross-connection by
    // design, badged "origin deleted" until unpinned (which adopts).
    const { tabs, pinned } = get();
    const dying = tabs.filter((t) => t.profile_id === profileId && !pinned.has(t.id));
    dying.forEach((t) => get().closeTab(t.id));
  },
}));

/** keep activeId inside the CURRENT connection's visible strip */
function ensureActiveVisible() {
  const { tabs, activeId, pinned, loaded } = useTabs.getState();
  if (!loaded) return;
  const pid = activePid();
  const vis = visibleTabs(tabs, pinned, pid);
  if (activeId && vis.some((t) => t.id === activeId)) return;
  const remembered = pid ? readActiveMap()[pid] : null;
  const target = vis.find((t) => t.id === remembered) ?? vis[0] ?? null;
  if (target) {
    useTabs.setState({ activeId: target.id });
    rememberActive(pid, target.id);
    useConnections.getState().setSql(target.sql);
  } else {
    // no tabs here — empty strip, empty editor state (⌘T when needed)
    useTabs.setState({ activeId: null });
    useConnections.getState().setSql("");
  }
}

// switching connections switches the whole workspace: restore that
// connection's remembered tab (or first visible, or a fresh scratch)
useConnections.subscribe((s, prev) => {
  if (s.activeProfileId === prev.activeProfileId) return;
  ensureActiveVisible();
});

// ---------------------------------------------------------------------------
// .sql files on disk — File ▸ Open… ⌘O / File ▸ Save ⌘⇧S / window drops

const MB = 1024 * 1024;
const OPEN_CONFIRM_BYTES = 8 * MB;
const OPEN_REFUSE_BYTES = 64 * MB;
const fmtMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;

export async function openFilePaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      // stat before read: gate huge files instead of freezing the editor
      // (stat failure falls through — the read itself reports real errors)
      const stat = await fileStat(path).catch(() => null);
      if (stat && stat.size > OPEN_REFUSE_BYTES) {
        const { confirmDanger } = await import("./danger");
        await confirmDanger(
          "File too large",
          `${path}\nis ${fmtMb(stat.size)} — qwry can't open files over 64 MB.`,
          "OK",
        );
        continue;
      }
      if (stat && stat.size > OPEN_CONFIRM_BYTES) {
        const { confirmDanger } = await import("./danger");
        const ok = await confirmDanger(
          "Large file",
          `${path}\nis ${fmtMb(stat.size)} — the editor may be slow. Open anyway?`,
          "Open",
        );
        if (!ok) continue;
      }
      const contents = await readTextFile(path);
      useTabs.getState().openFileTab(path, contents, stat?.mtime_ms);
    } catch (e) {
      console.error("open file failed", path, e);
      const { confirmDanger } = await import("./danger");
      await confirmDanger("Couldn't open file", `${path}\n${String(e)}`, "OK");
    }
  }
}

export async function openSqlFileDialog(): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({
    multiple: true,
    filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
  });
  if (!sel) return;
  await openFilePaths(Array.isArray(sel) ? sel : [sel]);
}

/** write the active query tab to its remembered path, or ask for one. The
 * first save adopts the chosen filename as the tab name. */
export async function saveActiveToFile(): Promise<void> {
  const { tabs, activeId } = useTabs.getState();
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab || tab.kind !== "query") return;
  let path = tab.file_path ?? null;
  const firstSave = !path;
  if (!path) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    path = await save({
      defaultPath: /\.sql$/i.test(tab.name) ? tab.name : `${tab.name}.sql`,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!path) return;
  }
  const dest = path; // settled (closure below must see `string`, not `string|null`)
  // the store text is kept in sync with the editor per keystroke, so this IS
  // the buffer (no editor round trip needed)
  const sql = tab.sql;
  // conflict check: the file moved on disk since we opened/last saved it —
  // never silently clobber an external edit (no baseline stamp = no check)
  if (!firstSave && tab.file_mtime_ms != null) {
    const stat = await fileStat(dest).catch(() => null);
    if (stat && stat.mtime_ms !== tab.file_mtime_ms) {
      const { confirmDanger } = await import("./danger");
      const ok = await confirmDanger(
        "File changed on disk",
        `${dest}\nchanged on disk since you opened it — overwrite the newer version?`,
        "Overwrite",
      );
      if (!ok) return;
    }
  }
  try {
    await writeTextFile(dest, sql);
  } catch (e) {
    console.error("save file failed", dest, e);
    const { confirmDanger } = await import("./danger");
    await confirmDanger("Couldn't save file", `${dest}\n${String(e)}`, "OK");
    return;
  }
  // re-stat AFTER the write — the fresh mtime is the new conflict baseline
  const written = await fileStat(dest).catch(() => null);
  const name = firstSave ? dest.split("/").pop() || tab.name : tab.name;
  useTabs.setState((s) => ({
    tabs: s.tabs.map((t) =>
      t.id === tab.id
        ? {
            ...t,
            file_path: dest,
            file_saved_sql: sql,
            file_mtime_ms: written?.mtime_ms,
            name,
          }
        : t,
    ),
  }));
  if (firstSave) persist(); // the rename is appdb-visible; file fields aren't
}

// editor text changes flow into the active tab (and debounce to disk).
// This is also the ADOPTION point: a legacy tab (profile_id null) edited
// while a connection is active joins that connection's workspace.
useConnections.subscribe((s, prev) => {
  if (s.sql === prev.sql) return;
  const { tabs, activeId, loaded } = useTabs.getState();
  if (!loaded || !activeId) return;
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab || tab.sql === s.sql) return;
  const adopt = tab.profile_id === null ? s.activeProfileId : tab.profile_id;
  useTabs.setState({
    tabs: tabs.map((t) =>
      t.id === activeId ? { ...t, sql: s.sql, profile_id: adopt } : t,
    ),
  });
  persist();
});
