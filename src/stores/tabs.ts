import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useConnections } from "./connections";

export interface Tab {
  id: string;
  name: string;
  sql: string;
  position: number;
  /** link to a saved query — keeps names/sql in sync */
  saved_id: string | null;
}

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  loaded: boolean;
  /** most-recently-closed first; ⌘⇧T pops */
  closedStack: { name: string; sql: string }[];

  load: () => Promise<void>;
  newTab: (sql?: string, name?: string, savedId?: string | null) => void;
  closeTab: (id: string) => void;
  select: (id: string) => void;
  selectByIndex: (i: number) => void;
  cycle: (dir: 1 | -1) => void;
  restoreClosed: () => void;
  rename: (id: string, name: string) => void;
  /** ⌘S: persist the active tab into the saved-queries sidebar */
  saveActive: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { tabs } = useTabs.getState();
    void invoke("tabs_save", {
      tabs: tabs.map((t, i) => ({ ...t, position: i })),
    });
  }, 600);
}

const blank = (n: number): Tab => ({
  id: crypto.randomUUID(),
  name: `Query ${n}`,
  sql: "",
  position: n - 1,
  saved_id: null,
});

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  loaded: false,
  closedStack: [],

  load: async () => {
    const rows = await invoke<Tab[]>("tabs_list");
    const tabs = rows.length > 0 ? rows : [blank(1)];
    set({ tabs, activeId: tabs[0].id, loaded: true });
    useConnections.getState().setSql(tabs[0].sql);
  },

  newTab: (sql = "", name, savedId = null) => {
    const { tabs } = get();
    const t = {
      ...blank(tabs.length + 1),
      sql,
      name: name ?? `Query ${tabs.length + 1}`,
      saved_id: savedId,
    };
    set({ tabs: [...tabs, t], activeId: t.id });
    useConnections.getState().setSql(sql);
    persist();
  },

  closeTab: (id) => {
    const { tabs, activeId, closedStack } = get();
    const closing = tabs.find((t) => t.id === id);
    const remember =
      closing && closing.sql.trim() !== ""
        ? [{ name: closing.name, sql: closing.sql }, ...closedStack].slice(0, 20)
        : closedStack;
    if (tabs.length === 1) {
      // never zero tabs — reset the last one instead
      const t = blank(1);
      set({ tabs: [t], activeId: t.id, closedStack: remember });
      useConnections.getState().setSql("");
      persist();
      return;
    }
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    let newActive = activeId;
    if (activeId === id) {
      const fallback = next[Math.max(0, idx - 1)];
      newActive = fallback.id;
      useConnections.getState().setSql(fallback.sql);
    }
    set({ tabs: next, activeId: newActive, closedStack: remember });
    persist();
  },

  select: (id) => {
    const t = get().tabs.find((t) => t.id === id);
    if (!t) return;
    set({ activeId: id });
    useConnections.getState().setSql(t.sql);
  },

  selectByIndex: (i) => {
    const t = get().tabs[i];
    if (t) get().select(t.id);
  },

  cycle: (dir) => {
    const { tabs, activeId } = get();
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeId);
    const next = tabs[(idx + dir + tabs.length) % tabs.length];
    get().select(next.id);
  },

  restoreClosed: () => {
    const { closedStack } = get();
    const top = closedStack[0];
    if (!top) return;
    set({ closedStack: closedStack.slice(1) });
    get().newTab(top.sql, top.name);
  },

  rename: (id, name) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)) }));
    const t = get().tabs.find((t) => t.id === id);
    if (t?.saved_id) {
      // keep the sidebar entry's name in sync
      void import("./saved").then(({ useSaved }) =>
        useSaved.getState().upsert({ id: t.saved_id!, name, sql: t.sql }),
      );
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
}));

// editor text changes flow into the active tab (and debounce to disk)
useConnections.subscribe((s, prev) => {
  if (s.sql === prev.sql) return;
  const { tabs, activeId, loaded } = useTabs.getState();
  if (!loaded || !activeId) return;
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab || tab.sql === s.sql) return;
  useTabs.setState({
    tabs: tabs.map((t) => (t.id === activeId ? { ...t, sql: s.sql } : t)),
  });
  persist();
});
