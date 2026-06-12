import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  created_at?: string;
}

interface SavedState {
  queries: SavedQuery[];
  expanded: boolean;

  load: () => Promise<void>;
  upsert: (q: SavedQuery) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  toggleExpanded: () => void;
}

export const useSaved = create<SavedState>()(
  persist(
    (set, get) => ({
      queries: [],
      expanded: true,

      load: async () => {
        set({ queries: await invoke<SavedQuery[]>("saved_list") });
      },

      upsert: async (q) => {
        await invoke("saved_upsert", { q: { id: q.id, name: q.name, sql: q.sql } });
        await get().load();
      },

      remove: async (id) => {
        await invoke("saved_delete", { id });
        // unlink any tab pointing at it
        const { useTabs } = await import("./tabs");
        useTabs.setState((s) => ({
          tabs: s.tabs.map((t) => (t.saved_id === id ? { ...t, saved_id: null } : t)),
        }));
        await get().load();
      },

      rename: async (id, name) => {
        const q = get().queries.find((q) => q.id === id);
        if (!q) return;
        await get().upsert({ ...q, name });
        // reflect on any open tab linked to this saved query
        const { useTabs } = await import("./tabs");
        useTabs.setState((s) => ({
          tabs: s.tabs.map((t) => (t.saved_id === id ? { ...t, name } : t)),
        }));
      },

      toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
    }),
    { name: "qwry.saved", partialize: (s) => ({ expanded: s.expanded }) as never },
  ),
);
