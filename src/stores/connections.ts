import { create } from "zustand";
import * as ipc from "../ipc/commands";
import { terminatedSessions } from "./sessionFlags";

/** app-ordered session death: mark BEFORE the IPC so an in-flight run's
 * connection-closed rejection classifies as a cancel, not an error
 * (spare-pool disposals skip this: spares never carry a visible run) */
function dropSession(sid: string) {
  terminatedSessions.add(sid);
  void ipc.disconnect(sid);
}
import type { DriverError, Profile } from "../ipc/types";

type ConnState = "disconnected" | "connecting" | "connected" | "error";
/** which full-screen connection surface is showing (null = work view) */
export type HomeMode = "dashboard" | "edit" | null;

/** key for a per-tab session / transaction flag */
export const skey = (profileId: string, tabId: string) => `${profileId}::${tabId}`;

/** in-flight tab-session connects, keyed by skey; concurrent callers share one */
const inflightTabSessions = new Map<string, Promise<string | null>>();

/** in-flight primary connects, keyed by profile; a double-click (or a
 * concurrent ensureTabSession reconnect) must not spawn a second primary
 * whose loser leaks server-side */
const inflightConnects = new Map<string, Promise<void>>();

/** per-profile connect epoch: bumped whenever the profile's connection
 * identity changes (edit/delete/invalidate). Every handshake captures it at
 * start and refuses to install sessions if it moved, so a "Save & Connect
 * after fixing a bad host" can never join (or install) the OLD host's attempt */
const connectEpochs = new Map<string, number>();
const epochOf = (id: string) => connectEpochs.get(id) ?? 0;
function bumpEpoch(id: string) {
  connectEpochs.set(id, epochOf(id) + 1);
  // stale shared attempts must not be joined by new callers
  inflightConnects.delete(id);
  spareInflight.delete(id);
  const prefix = `${id}::`;
  for (const k of [...inflightTabSessions.keys()]) {
    if (k.startsWith(prefix)) inflightTabSessions.delete(k);
  }
}

// ---- pre-warmed spare session pool -----------------------------------------
// One hot standby session per connected profile. A fresh tab's first run
// CLAIMS the spare instantly (zero handshake; 2-3s through a real bastion)
// and a replacement builds in the background. Connection footprint: tabs that
// actually ran + 1, instead of every visited tab.
const spareSessions = new Map<string, string>();
/** the replenish handshake in flight: ensureTabSession AWAITS and claims it
 * instead of starting a THIRD full handshake (connect → immediate ⌘↩ used to
 * pay the whole tunnel handshake again while the spare was mid-build) */
const spareInflight = new Map<string, Promise<string | null>>();

function replenishSpare(profileId: string) {
  const s = useConnections.getState();
  if (s.connState[profileId] !== "connected") return;
  if (spareSessions.has(profileId) || spareInflight.has(profileId)) return;
  const epoch = epochOf(profileId);
  const p = ipc
    .connect(profileId)
    .then((sid) => {
      // the profile may have disconnected/repointed while we were building
      if (
        epochOf(profileId) === epoch &&
        useConnections.getState().connState[profileId] === "connected"
      ) {
        spareSessions.set(profileId, sid);
        return sid;
      }
      void ipc.disconnect(sid);
      return null;
    })
    .catch(() => null) // no spare → next claim falls back to a direct connect
    .finally(() => {
      if (spareInflight.get(profileId) === p) spareInflight.delete(profileId);
    });
  spareInflight.set(profileId, p);
}

/** sessions that died while holding an OPEN TRANSACTION, by session id (ids
 * are never reused, so no clearing logic — FIFO-capped instead). The commit
 * path consults this to decide whether a rebuilt session deserves a real
 * warning (the tx's staged reality is gone) or just an informational chip. */
const deadTxSessions = new Set<string>();
export const sessionDiedWithTx = (sessionId: string) => deadTxSessions.has(sessionId);
function noteDeadTx(sessionId: string) {
  deadTxSessions.add(sessionId);
  if (deadTxSessions.size > 100) {
    const oldest = deadTxSessions.values().next().value;
    if (oldest !== undefined) deadTxSessions.delete(oldest);
  }
}

/** profiles the USER connected (and hasn't manually disconnected since): the
 * only ones self-heal may resurrect. A manual Disconnect is a decision; heal
 * must never overturn it. Module state, not store: policy, not render state. */
const healArmed = new Set<string>();
export const isHealArmed = (profileId: string) => healArmed.has(profileId);

/** heal verdict: ok = the profile ended green; rebuilt = at least one dead
 * session was actually found and replaced (a no-op probe is ok+!rebuilt) */
export interface HealResult {
  ok: boolean;
  rebuilt: boolean;
}

/** one heal per profile at a time; concurrent triggers join the same pass */
const healInflight = new Map<string, Promise<HealResult>>();

function dropSpare(profileId: string) {
  const sid = spareSessions.get(profileId);
  if (sid) {
    spareSessions.delete(profileId);
    void ipc.disconnect(sid);
  }
}
// ----------------------------------------------------------------------------

interface ConnectionsState {
  profiles: Profile[];
  /** profileId → primary session (schema introspection; isolated from tab txns) */
  sessions: Record<string, string>;
  /** skey(profile,tab) → dedicated query session so transactions stay per-tab */
  tabSessions: Record<string, string>;
  /** skey(profile,tab) → an explicit transaction is open on that tab's session */
  txTabs: Record<string, boolean>;
  /** skey(profile,tab) → prod safe-mode lifted on that tab's session */
  writeTabs: Record<string, boolean>;
  connState: Record<string, ConnState>;
  activeProfileId: string | null;

  /** profile being edited in the form; null = form closed */
  editing: Profile | null;
  /** full-screen connection surface (dashboard / editor); null = work view */
  homeMode: HomeMode;

  sql: string;
  /** connect-time errors (auth, network), surfaced as a global toast */
  error: DriverError | null;
  /** profile id the connect error belongs to (for the toast's "Edit" action) */
  errorProfileId: string | null;
  /** profiles_list failed at startup; surfaced with a retry, never a silently
   * empty rail */
  profilesError: string | null;
  /** a held session died with a driver-known reason; rendered by ConnToast.
   * Set by markDisconnected itself (it knows which branch fired), never by a
   * separate listener racing it. */
  closedToast: { profileId: string; reason: string } | null;

  loadProfiles: () => Promise<void>;
  clearError: () => void;
  saveProfile: (p: Profile, password?: string) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  setEditing: (p: Profile | null) => void;
  setHome: (m: HomeMode) => void;
  /** open the editor for a profile (or a blank one) in the home surface */
  editConnection: (p: Profile | null) => void;
  connect: (profileId: string) => Promise<void>;
  setActive: (profileId: string) => void;
  setSql: (sql: string) => void;
  /** get-or-create the active tab's dedicated query session */
  ensureTabSession: (profileId: string, tabId: string) => Promise<string | null>;
  setTxTab: (key: string, inTx: boolean) => void;
  /** lift/restore prod read-only safe-mode on ONE tab's session */
  setSessionWrites: (profileId: string, tabId: string, on: boolean) => Promise<boolean>;
  /** disconnect and forget every session for a closed tab */
  closeTabSessions: (tabId: string) => void;
  /** a profile's connection died: flip the dot and drop its (dead) sessions.
   * When the dead session is just the pre-warmed SPARE, it's replaced quietly
   * without touching the live connection state. `reason` (driver-known) makes
   * a held session's death toast; without it the teardown is silent. */
  markDisconnected: (profileId: string, sessionId?: string, reason?: string | null) => void;
  clearClosedToast: () => void;
  /** a profile was repointed: close its live sessions + drop its tunnel so the
   * next connect uses the new host/creds */
  invalidateProfile: (profileId: string) => Promise<void>;
  /** probe-first self-heal (wake from sleep, tunnel death): rebuilds ONLY the
   * sessions that actually died, quiet on failure (no toast, no surface
   * moves). Triggers live in stores/heal.ts. */
  healProfile: (profileId: string) => Promise<HealResult>;
}

/** fields that decide what/where we connect to: a change here means any live
 * session for the profile is stale and must be rebuilt. Also the identity the
 * persisted schema cache is bound to (schema.ts). */
export const connSig = (p: Profile) =>
  [p.host, p.port, p.dbname, p.user, p.sslmode, p.ssh_host, p.ssh_port, p.ssh_user, p.ssh_key].join(
    "\u0000",
  );

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  sessions: {},
  tabSessions: {},
  txTabs: {},
  writeTabs: {},
  connState: {},
  activeProfileId: null,
  editing: null,
  homeMode: "dashboard", // app opens on the home/connections screen
  sql: "",
  error: null,
  errorProfileId: null,
  profilesError: null,
  closedToast: null,

  loadProfiles: async () => {
    try {
      set({ profiles: await ipc.profilesList(), profilesError: null });
    } catch (e) {
      set({ profilesError: (e as { message?: string }).message ?? String(e) });
    }
  },

  clearError: () => set({ error: null, errorProfileId: null }),

  saveProfile: async (p, password) => {
    const prev = get().profiles.find((x) => x.id === p.id);
    // an edit that changes where/how we connect (or the password) must invalidate
    // the live connection; a cosmetic edit (name/color/glyph) leaves it untouched
    const connChanged = !!prev && (connSig(prev) !== connSig(p) || !!password);
    await ipc.profileSave(p, password);
    set({ editing: null });
    await get().loadProfiles();
    if (connChanged) await get().invalidateProfile(p.id);
  },

  deleteProfile: async (id) => {
    // full teardown FIRST: spare + primary + per-tab sessions + state, and
    // flip connState before the delete so an in-flight replenishSpare can't
    // mint a fresh backend session for a profile that no longer exists
    healArmed.delete(id);
    bumpEpoch(id);
    dropSpare(id);
    set((s) => ({ connState: { ...s.connState, [id]: "disconnected" } }));
    const primary = get().sessions[id];
    if (primary) dropSession(primary);
    const prefix = `${id}::`;
    const keep: Record<string, string> = {};
    for (const [k, sid] of Object.entries(get().tabSessions)) {
      if (k.startsWith(prefix)) dropSession(sid);
      else keep[k] = sid;
    }
    set((s) => {
      const { [id]: _gone, ...sessions } = s.sessions;
      const txTabs: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.txTabs)) {
        if (!k.startsWith(prefix)) txTabs[k] = v;
      }
      const writeTabs: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.writeTabs)) {
        if (!k.startsWith(prefix)) writeTabs[k] = v;
      }
      return {
        tabSessions: keep,
        sessions,
        txTabs,
        writeTabs,
        activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
      };
    });
    await ipc.profileDelete(id);
    await get().loadProfiles();
    // SchemaTree's persisted table pins die with the profile too
    localStorage.removeItem(`qwry.pins.${id}`);
    useSettings.getState().dropConnTheme(id);
    // its workspace dies with it (pinned tabs survive as orphans)
    void import("./tabs").then(({ useTabs }) => useTabs.getState().purgeProfileTabs(id));
  },

  setEditing: (p) => set({ editing: p }),
  setHome: (homeMode) => set({ homeMode }),
  editConnection: (p) => set({ editing: p, homeMode: "edit" }),

  healProfile: (profileId) => {
    const existing = healInflight.get(profileId);
    if (existing) return existing;
    const pass = healInner(profileId, set, get).finally(() => {
      if (healInflight.get(profileId) === pass) healInflight.delete(profileId);
    });
    healInflight.set(profileId, pass);
    return pass;
  },

  connect: (profileId) => {
    // concurrent calls (double-click, run + explain racing a reconnect) share
    // ONE attempt: two parallel ipc.connects left the loser's backend
    // session/tunnel alive with nothing tracking it
    const inflight = inflightConnects.get(profileId);
    if (inflight) return inflight;
    // guarded delete: an epoch bump may have already replaced this entry with
    // a fresh attempt; the stale finally must not evict it
    const attempt = connectInner(profileId, set, get).finally(() => {
      if (inflightConnects.get(profileId) === attempt) inflightConnects.delete(profileId);
    });
    inflightConnects.set(profileId, attempt);
    return attempt;
  },

  setActive: (profileId) => set({ activeProfileId: profileId }),
  setSql: (sql) => set({ sql }),

  ensureTabSession: async (profileId, tabId) => {
    const key = skey(profileId, tabId);
    const existing = get().tabSessions[key];
    if (existing) return existing;
    // claim the pre-warmed spare (instant, no handshake); replenish behind it
    const spare = spareSessions.get(profileId);
    if (spare && get().sessions[profileId]) {
      spareSessions.delete(profileId);
      set((s) => ({ tabSessions: { ...s.tabSessions, [key]: spare } }));
      replenishSpare(profileId);
      return spare;
    }
    // no ready spare, but one is MID-HANDSHAKE (connect → immediate ⌘↩):
    // await and claim it instead of paying a second full handshake
    const building = spareInflight.get(profileId);
    if (building && get().sessions[profileId]) {
      const sid = await building;
      // re-checks after the await: this tab may have been given a session by a
      // concurrent caller, and the spare may have been claimed by another tab
      const again = get().tabSessions[key];
      if (again) return again;
      if (sid && spareSessions.get(profileId) === sid) {
        spareSessions.delete(profileId);
        set((s) => ({ tabSessions: { ...s.tabSessions, [key]: sid } }));
        replenishSpare(profileId);
        return sid;
      }
      // build failed or someone else claimed it; fall through
    }
    // dedupe concurrent callers (run + explain): two parallel connects would
    // leak the loser's backend session
    const inflight = inflightTabSessions.get(key);
    if (inflight) return inflight;
    const epoch = epochOf(profileId);
    const p = (async (): Promise<string | null> => {
      try {
        // primary gone (never connected, or dropped) → reconnect transparently
        if (!get().sessions[profileId]) {
          await get().connect(profileId);
          if (!get().sessions[profileId]) return null;
        }
        const sid = await ipc.connect(profileId);
        // the profile was repointed mid-handshake: this session targets the
        // OLD host; installing it would run the tab against the wrong database
        if (epochOf(profileId) !== epoch) {
          void ipc.disconnect(sid);
          return null;
        }
        set((s) => ({ tabSessions: { ...s.tabSessions, [key]: sid } }));
        // we paid the handshake because no spare existed; build one so the
        // NEXT fresh tab doesn't
        replenishSpare(profileId);
        return sid;
      } catch (e) {
        // a stale attempt failing (old host unreachable) is noise, not an error
        if (epochOf(profileId) === epoch) {
          set({ error: e as DriverError, errorProfileId: profileId });
        }
        return null;
      }
    })();
    inflightTabSessions.set(key, p);
    // guarded delete: an epoch bump may have evicted (and a new attempt
    // replaced) this entry; the stale cleanup must not remove the fresh one
    void p.finally(() => {
      if (inflightTabSessions.get(key) === p) inflightTabSessions.delete(key);
    });
    return p;
  },

  setTxTab: (key, inTx) =>
    set((s) => {
      if (!!s.txTabs[key] === inTx) return s;
      return { txTabs: { ...s.txTabs, [key]: inTx } };
    }),

  setSessionWrites: async (profileId, tabId, on) => {
    const sid = await get().ensureTabSession(profileId, tabId);
    if (!sid) return false;
    try {
      // per-SESSION: only this tab's connection gains (or loses) writes; every
      // other session on the prod profile keeps the server-side read-only guard
      await ipc.execute(
        sid,
        `SET default_transaction_read_only = ${on ? "off" : "on"}`,
      );
      const key = skey(profileId, tabId);
      set((s) => ({ writeTabs: { ...s.writeTabs, [key]: on } }));
      return true;
    } catch (e) {
      set({ error: e as DriverError, errorProfileId: profileId });
      return false;
    }
  },

  closeTabSessions: (tabId) => {
    const suffix = `::${tabId}`;
    const sessions: Record<string, string> = {};
    for (const [k, sid] of Object.entries(get().tabSessions)) {
      if (k.endsWith(suffix)) dropSession(sid);
      else sessions[k] = sid;
    }
    const txTabs: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(get().txTabs)) {
      if (!k.endsWith(suffix)) txTabs[k] = v;
    }
    const writeTabs: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(get().writeTabs)) {
      if (!k.endsWith(suffix)) writeTabs[k] = v;
    }
    set({ tabSessions: sessions, txTabs, writeTabs });
  },

  markDisconnected: (profileId, sessionId, reason) => {
    // the standby died (bastion idle-drop etc.): replace it quietly; the
    // profile and its live tab sessions are untouched
    if (sessionId && spareSessions.get(profileId) === sessionId) {
      spareSessions.delete(profileId);
      dropSession(sessionId); // free the backend registry entry
      replenishSpare(profileId);
      return;
    }
    // ONE tab session died (e.g. its own idle-in-tx timeout): forget just
    // that session; sibling tabs on the profile keep their live sessions and
    // open transactions. The old profile-wide wipe silently orphaned them.
    if (sessionId && get().sessions[profileId] !== sessionId) {
      // a dead socket still occupies the backend session map until released
      dropSession(sessionId);
      const entry = Object.entries(get().tabSessions).find(([, sid]) => sid === sessionId);
      if (!entry) return; // already forgotten (tab closed etc.)
      const [key] = entry;
      // an open transaction died with it: the commit path warns off this
      if (get().txTabs[key]) noteDeadTx(sessionId);
      set((s) => {
        const { [key]: _s, ...tabSessions } = s.tabSessions;
        const { [key]: _t, ...txTabs } = s.txTabs;
        const { [key]: _w, ...writeTabs } = s.writeTabs;
        return {
          tabSessions,
          txTabs,
          writeTabs,
          // a session the user actually held died; say so
          ...(reason ? { closedToast: { profileId, reason } } : {}),
        };
      });
      return;
    }
    // the PRIMARY died (real drop: network/bastion); flip the dot. Tab
    // sessions ride the same transport; each fires its own session-closed as
    // keepalives detect it, and the branch above reaps them one by one.
    dropSpare(profileId);
    const primary = get().sessions[profileId];
    if (primary) dropSession(primary);
    set((s) => ({
      sessions: (({ [profileId]: _gone, ...rest }) => rest)(s.sessions),
      connState: { ...s.connState, [profileId]: "disconnected" },
      ...(reason ? { closedToast: { profileId, reason } } : {}),
    }));
  },

  clearClosedToast: () => set({ closedToast: null }),

  invalidateProfile: async (profileId) => {
    const prefix = `${profileId}::`;
    // a manual disconnect/repoint is a decision: self-heal must not overturn it
    healArmed.delete(profileId);
    // any handshake still in flight belongs to the OLD identity: it must
    // neither be joined nor allowed to install what it produces
    bumpEpoch(profileId);
    dropSpare(profileId);
    // close every live backend session for this profile (primary + per-tab)
    const primary = get().sessions[profileId];
    if (primary) dropSession(primary);
    const tabSessions: Record<string, string> = {};
    for (const [k, sid] of Object.entries(get().tabSessions)) {
      if (k.startsWith(prefix)) dropSession(sid);
      else tabSessions[k] = sid;
    }
    const { [profileId]: _gone, ...sessions } = get().sessions;
    const txTabs: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(get().txTabs)) {
      if (!k.startsWith(prefix)) txTabs[k] = v;
    }
    const writeTabs: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(get().writeTabs)) {
      if (!k.startsWith(prefix)) writeTabs[k] = v;
    }
    set((s) => ({
      sessions,
      tabSessions,
      txTabs,
      writeTabs,
      connState: { ...s.connState, [profileId]: "disconnected" },
    }));
    // drop the cached SSH tunnel so the next connect rebuilds it against the new
    // host, awaited so a Save&Connect that reconnects right after sees it gone
    await ipc.invalidateProfile(profileId);
  },
}));

type SetState = (
  partial:
    | Partial<ConnectionsState>
    | ((s: ConnectionsState) => Partial<ConnectionsState>),
) => void;

async function connectInner(
  profileId: string,
  set: SetState,
  get: () => ConnectionsState,
): Promise<void> {
  const epoch = epochOf(profileId);
  set((s) => ({
    connState: { ...s.connState, [profileId]: "connecting" },
    error: null,
    errorProfileId: null,
  }));
  // hydrate the persisted schema snapshot NOW: sidebar + completion are
  // live at t=0 while the handshake and the fresh introspect run behind it
  void import("./schema").then(({ useSchema }) => useSchema.getState().hydrate(profileId));
  try {
    const sessionId = await ipc.connect(profileId);
    // the profile was edited/deleted mid-handshake: this session belongs to
    // the OLD identity: installing it would put the old host's session under
    // the new profile. Dispose it and let the caller's fresh attempt win.
    if (epochOf(profileId) !== epoch) {
      dropSession(sessionId);
      return;
    }
    // a fresh primary connection invalidates any prior per-tab sessions for
    // this profile; drop them so tabs re-create against the live connection
    const prefix = `${profileId}::`;
    const tabSessions: Record<string, string> = {};
    const txTabs: Record<string, boolean> = {};
    const writeTabs: Record<string, boolean> = {};
    for (const [k, sid] of Object.entries(get().tabSessions)) {
      if (k.startsWith(prefix)) dropSession(sid);
      else tabSessions[k] = sid;
    }
    for (const [k, v] of Object.entries(get().txTabs)) {
      if (!k.startsWith(prefix)) txTabs[k] = v;
    }
    for (const [k, v] of Object.entries(get().writeTabs)) {
      if (!k.startsWith(prefix)) writeTabs[k] = v;
    }
    set((s) => ({
      sessions: { ...s.sessions, [profileId]: sessionId },
      tabSessions,
      txTabs,
      writeTabs,
      connState: { ...s.connState, [profileId]: "connected" },
      activeProfileId: profileId,
      editing: null,
      homeMode: null, // connected → leave the home surface for the work view
      error: null,
    }));
    // an old spare belongs to the previous primary/tunnel epoch
    dropSpare(profileId);
    // a user connect arms self-heal (stores/heal.ts) until a manual disconnect
    healArmed.add(profileId);
    // schema cache powers sidebar + completion; fire and forget
    void import("./schema").then(({ useSchema }) =>
      useSchema.getState().fetch(profileId, sessionId),
    );
    // build the standby session so the first ⌘↩ in ANY tab is instant
    replenishSpare(profileId);
  } catch (e) {
    // a stale attempt failing (the OLD host refusing) must not paint the new
    // profile identity as errored
    if (epochOf(profileId) !== epoch) return;
    set((s) => ({
      // distinct from plain disconnected: the card/rail dot shows the failure
      connState: { ...s.connState, [profileId]: "error" },
      error: e as DriverError,
      errorProfileId: profileId,
    }));
  }
}

/** Probe-first self-heal for one profile (wake from sleep, tunnel death,
 * server-side kill). LIVE sessions are untouched: a primary-only death must
 * never wipe sibling tabs' open transactions, which is exactly what
 * connectInner's full ceremony would do — so the reconnect here is a gentle
 * install, no tab wipe, no surface moves (connect()'s activeProfileId /
 * homeMode flips belong to the user's own click). Quiet by design: no error
 * toast; failure leaves the dot honest and the caller's backoff retries. */
async function healInner(
  profileId: string,
  set: SetState,
  get: () => ConnectionsState,
): Promise<HealResult> {
  const epoch = epochOf(profileId);
  // a user-initiated connect owns the outcome; join it instead of racing it
  const userAttempt = inflightConnects.get(profileId);
  if (userAttempt) {
    await userAttempt.catch(() => {});
    return {
      ok: !!get().sessions[profileId] && epochOf(profileId) === epoch,
      rebuilt: false,
    };
  }
  const primary = get().sessions[profileId] ?? null;
  const prefix = `${profileId}::`;
  const tabEntries = Object.entries(get().tabSessions).filter(([k]) => k.startsWith(prefix));
  const spare = spareSessions.get(profileId) ?? null;
  const probes = await Promise.all(
    [...(primary ? [primary] : []), ...tabEntries.map(([, sid]) => sid), ...(spare ? [spare] : [])].map(
      async (sid) => [sid, await ipc.sessionProbe(sid).catch(() => false)] as const,
    ),
  );
  // repointed/deleted mid-probe
  if (epochOf(profileId) !== epoch) return { ok: false, rebuilt: false };
  const alive = new Map(probes);
  let rebuilt = false;
  // dead tab sessions: silent per-session teardown (the reason-less path
  // never toasts); LIVE tabs keep their sessions and open transactions
  for (const [, sid] of tabEntries) {
    if (alive.get(sid) === false) {
      get().markDisconnected(profileId, sid, null);
      rebuilt = true;
    }
  }
  let healed = true;
  if (!primary || alive.get(primary) === false) {
    rebuilt = true;
    if (primary) {
      dropSession(primary);
      set((s) => ({ sessions: (({ [profileId]: _g, ...rest }) => rest)(s.sessions) }));
    }
    set((s) => ({ connState: { ...s.connState, [profileId]: "connecting" } }));
    // registered in inflightConnects so a user's click mid-heal JOINS this
    // attempt (two parallel ipc.connects leak the loser's backend session).
    // The joiner skips connectInner's surface ceremony — benign: a second
    // click lands on an already-green profile and switches instantly.
    const attempt = (async () => {
      const sid = await ipc.connect(profileId);
      if (epochOf(profileId) !== epoch) {
        dropSession(sid);
        return;
      }
      set((s) => ({
        sessions: { ...s.sessions, [profileId]: sid },
        connState: { ...s.connState, [profileId]: "connected" },
      }));
      // the schema may have moved while we were gone; refresh behind the heal
      void import("./schema").then(({ useSchema }) => useSchema.getState().fetch(profileId, sid));
    })();
    const shared = attempt.catch(() => {});
    inflightConnects.set(profileId, shared);
    void shared.finally(() => {
      if (inflightConnects.get(profileId) === shared) inflightConnects.delete(profileId);
    });
    try {
      await attempt;
      healed = !!get().sessions[profileId] && epochOf(profileId) === epoch;
    } catch {
      if (epochOf(profileId) === epoch) {
        set((s) => ({ connState: { ...s.connState, [profileId]: "disconnected" } }));
      }
      healed = false;
    }
  } else if (get().connState[profileId] !== "connected") {
    // transport is fine: make the dot tell the truth (a stale "disconnected"
    // can linger when only a tab session died during sleep)
    set((s) => ({ connState: { ...s.connState, [profileId]: "connected" } }));
  }
  // the spare AFTER the transport verdict: a dead spare's replacement must
  // ride the LIVE tunnel, not a doomed handshake through the dead one
  if (spare && alive.get(spare) === false) get().markDisconnected(profileId, spare, null);
  if (!healed) return { ok: false, rebuilt };
  healArmed.add(profileId);
  replenishSpare(profileId);
  // eager active-tab warm: back at the laptop, the first ⌘↩/⌘S pays no
  // handshake. Other tabs rebuild lazily off the fresh spare.
  const { useTabs } = await import("./tabs");
  const tabId = useTabs.getState().activeId;
  if (tabId && get().activeProfileId === profileId && !get().tabSessions[skey(profileId, tabId)]) {
    void get().ensureTabSession(profileId, tabId);
  }
  return { ok: true, rebuilt };
}

/** open explicit transactions across a profile's tab sessions */
export function openTxCount(profileId: string): number {
  const prefix = `${profileId}::`;
  let n = 0;
  for (const [k, v] of Object.entries(useConnections.getState().txTabs)) {
    if (v && k.startsWith(prefix)) n++;
  }
  return n;
}

/** gate for anything that tears down a profile's sessions (disconnect,
 * reconnect, delete, recent-strip connect): confirms when open transactions
 * would be rolled back. Resolves true when there's nothing to lose. */
export async function confirmTxRollback(
  profileId: string,
  confirmLabel: string,
): Promise<boolean> {
  const n = openTxCount(profileId);
  if (n === 0) return true;
  const { confirmDanger } = await import("./danger");
  return confirmDanger(
    `Open Transaction${n === 1 ? "" : "s"} on ${n} Tab${n === 1 ? "" : "s"}`,
    "Uncommitted work in open transactions will be rolled back.",
    confirmLabel,
  );
}

// ---- Match Connection theming feed ---------------------------------------
// Push the ACTIVE connection's avatar color into settings; the theme engine
// re-derives when the toggle is on. One-way import (connections → settings,
// avatarColor is pure data); pushes only on real color changes so the theme
// subscription stays quiet otherwise.
import { avatarColor } from "../design/avatarColor";
import { useSettings } from "./settings";

let lastConnAccent: string | null = null;
let lastActiveConn: string | null = null;
useConnections.subscribe((s) => {
  // per-connection themes key on the workspace identity, connected or not:
  // a disconnected workspace still shows that connection's UI
  if (s.activeProfileId !== lastActiveConn) {
    lastActiveConn = s.activeProfileId;
    useSettings.getState().setActiveConnId(s.activeProfileId);
  }
  const p = s.activeProfileId ? s.profiles.find((x) => x.id === s.activeProfileId) : null;
  const connected = !!p && s.connState[p.id] === "connected";
  const c = connected && p ? avatarColor(p, s.profiles.indexOf(p)) : null;
  if (c === lastConnAccent) return;
  lastConnAccent = c;
  useSettings.getState().setConnAccent(c);
});
