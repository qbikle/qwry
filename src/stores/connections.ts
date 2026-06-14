import { create } from "zustand";
import * as ipc from "../ipc/commands";
import type { DriverError, Profile } from "../ipc/types";

type ConnState = "disconnected" | "connecting" | "connected";

/** key for a per-tab session / transaction flag */
export const skey = (profileId: string, tabId: string) => `${profileId}::${tabId}`;

interface ConnectionsState {
  profiles: Profile[];
  /** profileId → primary session (schema introspection; isolated from tab txns) */
  sessions: Record<string, string>;
  /** skey(profile,tab) → dedicated query session so transactions stay per-tab */
  tabSessions: Record<string, string>;
  /** skey(profile,tab) → an explicit transaction is open on that tab's session */
  txTabs: Record<string, boolean>;
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
  /** get-or-create the active tab's dedicated query session */
  ensureTabSession: (profileId: string, tabId: string) => Promise<string | null>;
  setTxTab: (key: string, inTx: boolean) => void;
  /** disconnect and forget every session for a closed tab */
  closeTabSessions: (tabId: string) => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  sessions: {},
  tabSessions: {},
  txTabs: {},
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
    // tear down any per-tab sessions opened against this profile
    const prefix = `${id}::`;
    const keep: Record<string, string> = {};
    for (const [k, sid] of Object.entries(get().tabSessions)) {
      if (k.startsWith(prefix)) void ipc.disconnect(sid);
      else keep[k] = sid;
    }
    set({ tabSessions: keep });
    await ipc.profileDelete(id);
    await get().loadProfiles();
  },

  setEditing: (p) => set({ editing: p }),

  connect: async (profileId) => {
    set((s) => ({ connState: { ...s.connState, [profileId]: "connecting" } }));
    try {
      const sessionId = await ipc.connect(profileId);
      // a fresh primary connection invalidates any prior per-tab sessions for
      // this profile — drop them so tabs re-create against the live connection
      const prefix = `${profileId}::`;
      const tabSessions: Record<string, string> = {};
      const txTabs: Record<string, boolean> = {};
      for (const [k, sid] of Object.entries(get().tabSessions)) {
        if (k.startsWith(prefix)) void ipc.disconnect(sid);
        else tabSessions[k] = sid;
      }
      for (const [k, v] of Object.entries(get().txTabs)) {
        if (!k.startsWith(prefix)) txTabs[k] = v;
      }
      set((s) => ({
        sessions: { ...s.sessions, [profileId]: sessionId },
        tabSessions,
        txTabs,
        connState: { ...s.connState, [profileId]: "connected" },
        activeProfileId: profileId,
        error: null,
      }));
      // schema cache powers sidebar + completion; fire and forget
      void import("./schema").then(({ useSchema }) =>
        useSchema.getState().fetch(profileId, sessionId),
      );
    } catch (e) {
      set((s) => ({
        connState: { ...s.connState, [profileId]: "disconnected" },
        error: e as DriverError,
      }));
    }
  },

  setActive: (profileId) => set({ activeProfileId: profileId }),
  setSql: (sql) => set({ sql }),

  ensureTabSession: async (profileId, tabId) => {
    const key = skey(profileId, tabId);
    const existing = get().tabSessions[key];
    if (existing) return existing;
    // a tab session presupposes the profile is connected (primary session)
    if (!get().sessions[profileId]) return null;
    try {
      const sid = await ipc.connect(profileId);
      set((s) => ({ tabSessions: { ...s.tabSessions, [key]: sid } }));
      return sid;
    } catch (e) {
      set({ error: e as DriverError });
      return null;
    }
  },

  setTxTab: (key, inTx) =>
    set((s) => {
      if (!!s.txTabs[key] === inTx) return s;
      return { txTabs: { ...s.txTabs, [key]: inTx } };
    }),

  closeTabSessions: (tabId) => {
    const suffix = `::${tabId}`;
    const sessions: Record<string, string> = {};
    for (const [k, sid] of Object.entries(get().tabSessions)) {
      if (k.endsWith(suffix)) void ipc.disconnect(sid);
      else sessions[k] = sid;
    }
    const txTabs: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(get().txTabs)) {
      if (!k.endsWith(suffix)) txTabs[k] = v;
    }
    set({ tabSessions: sessions, txTabs });
  },
}));
