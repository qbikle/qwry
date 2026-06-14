import { create } from "zustand";

interface UiState {
  themePicker: boolean;
  openThemePicker: () => void;
  closeThemePicker: () => void;
  toggleThemePicker: () => void;
}

export const useUI = create<UiState>((set) => ({
  themePicker: false,
  openThemePicker: () => set({ themePicker: true }),
  closeThemePicker: () => set({ themePicker: false }),
  toggleThemePicker: () => set((s) => ({ themePicker: !s.themePicker })),
}));
