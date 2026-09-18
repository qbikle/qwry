import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  created_at?: string;
  /** owning connection; null/undefined = legacy, visible everywhere until
   * next saved under a connection (adopt-on-touch, mirrors tabs) */
  profile_id?: string | null;
  /** the question a Save Query on an answer kept. A quick-ask is a saved
   * query that remembers what was asked, not a second kind of row: the Saved
   * group tells it apart by the glyph it wears (A2 item 6a) */
  question?: string | null;
  /** what a check asserts about this query's shape, JSON (`CheckExpect` in
   * ./checks); null = an ordinary saved query, not a check */
  expect_json?: string | null;
  /** what the last Run Checks found here, JSON (`CheckResult`); null until the
   * check has run once */
  last_check_json?: string | null;
}

/** the keys an upsert actually names. `{ ...prev, ...q }` alone would let a
 * key present-but-undefined erase what the stored row holds; TS cannot tell
 * those apart at a call site, so the merge drops them here instead. */
function defined(q: SavedQuery): SavedQuery {
  return Object.fromEntries(
    Object.entries(q).filter(([, v]) => v !== undefined),
  ) as unknown as SavedQuery;
}

/** the current connection's bookmarks (+ legacy unscoped ones) */
export function visibleSaved(queries: SavedQuery[], pid: string | null): SavedQuery[] {
  if (!pid) return queries;
  return queries.filter((q) => !q.profile_id || q.profile_id === pid);
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
        // appdb writes the whole row, so an upsert that names only what it
        // changes (a rename, a re-save from a tab) merges over the row already
        // held: otherwise renaming a quick-ask would drop its question and the
        // check on it. Keys the caller left out keep what they hold; a key
        // passed as null clears, which is how Remove Check clears
        const prev = get().queries.find((x) => x.id === q.id);
        const row = { ...prev, ...defined(q) };
        // saving under a connection adopts the bookmark into its workspace;
        // explicit profile_id (rename path passes the existing one) wins, and
        // a row that already carries one never reaches for the rail at all
        const profile_id =
          row.profile_id ?? (await import("./connections")).useConnections.getState().activeProfileId;
        await invoke("saved_upsert", {
          q: {
            id: row.id,
            name: row.name,
            sql: row.sql,
            profile_id,
            question: row.question ?? null,
            expect_json: row.expect_json ?? null,
            last_check_json: row.last_check_json ?? null,
          },
        });
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
        // rename is not adoption: keep the bookmark's home connection
        await get().upsert({ ...q, name, profile_id: q.profile_id ?? null });
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
