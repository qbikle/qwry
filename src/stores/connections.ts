import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { DriverError, Profile } from "../ipc/types";

type ConnState = "disconnected" | "connecting" | "connected";

interface ConnectionsState {
  profiles: Profile[];
  /** profileId → live sessionId */
  sessions: Record<string, string>;
  connState: Record<string, ConnState>;
  activeProfileId: string | null;

  /** profile being edited in the form; null = form closed, "new" sentinel id for create */
  editing: Profile | null;

  sql: string;
  /** connect-time errors (auth, network) */
  error: DriverError | null;

  loadProfiles: () => Promise<void>;
  saveProfile: (p: Profile, password?: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  setEditing: (p: Profile | null) => void;
  connect: (profileId: string) => Promise<void>;
  setActive: (profileId: string) => void;
  setSql: (sql: string) => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  sessions: {},
  connState: {},
  activeProfileId: null,
  editing: null,
  sql: "",
  error: null,

  loadProfiles: async () => {
    set({ profiles: await ipc.profilesList() });
  },

  saveProfile: async (p, password) => {
    await ipc.profileSave(p, password);
    set({ editing: null });
    await get().loadProfiles();
  },

  deleteProfile: async (id) => {
    await ipc.profileDelete(id);
    await get().loadProfiles();
  },

  setEditing: (p) => set({ editing: p }),

  connect: async (profileId) => {
    set((s) => ({ connState: { ...s.connState, [profileId]: "connecting" } }));
    try {
      const sessionId = await ipc.connect(profileId);
      set((s) => ({
        sessions: { ...s.sessions, [profileId]: sessionId },
        connState: { ...s.connState, [profileId]: "connected" },
        activeProfileId: profileId,
        error: null,
      }));
    } catch (e) {
      set((s) => ({
        connState: { ...s.connState, [profileId]: "disconnected" },
        error: e as DriverError,
      }));
    }
  },

  setActive: (profileId) => set({ activeProfileId: profileId }),
  setSql: (sql) => set({ sql }),
}));
