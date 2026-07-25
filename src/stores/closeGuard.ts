import { create } from "zustand";
import { fileDrifted, useTabs } from "./tabs";
import { useEdits } from "./edits";
import { useBrowser } from "./browser";

interface CloseGuardState {
  /** tab id awaiting a discard/commit decision; null = no prompt showing */
  pending: string | null;
  /** close a tab; prompts first if it has uncommitted cell edits or unsaved
   * drift against its backing .sql file */
  request: (tabId: string) => void;
  cancel: () => void;
  discard: () => void;
  commit: () => Promise<void>;
}

const pendingCount = (tabId: string) => {
  const edits = Object.keys(useEdits.getState().byTab[tabId]?.pending ?? {}).length;
  // a half-typed inline add-row is unsaved work too
  const draft = useBrowser.getState().byTab[tabId]?.draftRow;
  return edits + (draft && Object.keys(draft).length > 0 ? 1 : 0);
};

/** buffer differs from the tab's file on disk; the prompt is about DISK
 * drift only (the text itself persists in the app db) */
export const tabFileDrifted = (tabId: string): boolean => {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  return !!t && fileDrifted(t);
};

export const useCloseGuard = create<CloseGuardState>((set) => ({
  pending: null,

  request: (tabId) => {
    if (pendingCount(tabId) > 0 || tabFileDrifted(tabId)) set({ pending: tabId });
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
    // only close if the commit cleared the edits; on failure keep the tab open
    // so its error stays visible
    if (pendingCount(id) === 0) useTabs.getState().closeTab(id);
  },
}));
