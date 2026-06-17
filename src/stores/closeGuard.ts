import { create } from "zustand";
import { useTabs } from "./tabs";
import { useEdits } from "./edits";

interface CloseGuardState {
  /** tab id awaiting a discard/commit decision; null = no prompt showing */
  pending: string | null;
  /** close a tab — prompts first if it has uncommitted cell edits */
  request: (tabId: string) => void;
  cancel: () => void;
  discard: () => void;
  commit: () => Promise<void>;
}

const pendingCount = (tabId: string) =>
  Object.keys(useEdits.getState().byTab[tabId]?.pending ?? {}).length;

export const useCloseGuard = create<CloseGuardState>((set) => ({
  pending: null,

  request: (tabId) => {
    if (pendingCount(tabId) > 0) set({ pending: tabId });
    else useTabs.getState().closeTab(tabId);
  },

  cancel: () => set({ pending: null }),

  discard: () => {
    const id = useCloseGuard.getState().pending;
    set({ pending: null });
    if (id) useTabs.getState().closeTab(id);
  },

  commit: async () => {
    const id = useCloseGuard.getState().pending;
    if (!id) return;
    // make this tab active so the commit applies to its edits, then commit
    useTabs.getState().select(id);
    await useEdits.getState().commit();
    set({ pending: null });
    // only close if the commit cleared the edits — on failure keep the tab open
    // so its error stays visible
    if (pendingCount(id) === 0) useTabs.getState().closeTab(id);
  },
}));
