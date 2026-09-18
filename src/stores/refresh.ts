/** The two refresh tiers, and the frame they answer in (E2 R1-R6, amended by
 * E3 rules 1-3).
 *
 * ⌘R reloads what you are looking at: the active tab alone. ⇧⌘R is the hard
 * tier: the schema and the tab both, with the connection probed and rebuilt
 * BESIDE them. One implementation each, so the header ↻ and the palette
 * cannot drift apart (DESIGN rule 15).
 *
 * The app answers in the gesture's own frame (LESSONS 16). One synchronous
 * store write decides every surface that will refetch and puts its skeleton
 * up; the fetches go out in that same tick; the heal round trip starts next
 * to them rather than ahead of them, so the network's honest slowness shows
 * in how long a loader HOLDS, never in when it starts. The band is the ack
 * laid over surfaces that are already answering, and nothing reads it
 * (DESIGN rule 6's E3 amendment). This module owns WHEN each cycle starts;
 * the skeleton and the fades are each surface's own CSS.
 */
import { create } from "zustand";
import { canvasRefresh } from "../canvas/port";
import { readOnlyHeads } from "../lib/sqlHeads";
import { nextRetryAt, requestHeal } from "./heal";
import { afterHeal } from "./liveSession";
import { anySessionOn, useConnections } from "./connections";
import { useBrowser } from "./browser";
import { useEdits } from "./edits";
import { useResults } from "./results";
import { useSchema } from "./schema";
import { useSidePane } from "./sidePane";
import { useTabs } from "./tabs";

export type Tier = "soft" | "hard";
export type Surface = "tree" | "main" | "inspector" | `widget:${string}`;

/** --dur-slow: once a skeleton is up it stays long enough to read as a state */
const MIN_SHOW_MS = 240;
/** how long the status bar keeps a note about what a refresh did NOT do (R4) */
const NOTE_MS = 2_600;

interface Note {
  tabId: string;
  text: string;
}

interface RefreshState {
  tier: Tier | null;
  profileId: string | null;
  /** re-keys the band so consecutive hard refreshes each play their own */
  sweepSeq: number;
  /** t0 of the current run: the instant the gesture was answered */
  startedAt: number | null;
  cycling: Record<string, boolean>;
  /** what the active tab's status bar says about a refresh it declined (R4) */
  note: Note | null;
  /** the hard tier's heal failed: the connection strip's own countdown (R6).
   * retryAt is heal's next attempt, null once its chain gave up */
  dead: { profileId: string; retryAt: number | null } | null;
  hardRefresh: (profileId: string) => Promise<void>;
  softRefresh: () => Promise<void>;
  /** hold a surface's skeleton — already up, since the plan's own write —
   * until its refetch lands, and never for less than MIN_SHOW_MS (E3 rule 2) */
  track: (surface: Surface, work: Promise<unknown>) => void;
}

// generation guard: a new gesture orphans the previous run's timers
let gen = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
let noteTimer: ReturnType<typeof setTimeout> | undefined;
/** this run came back empty-handed somewhere: a refetch failed, or there was
 * no address to send one on at all. A heal that holds AFTER that means the
 * connection those surfaces wanted is here now while the reader is still
 * looking at the old rows (LESSONS 13), so the run goes round once more. */
let missed = false;

function stopTimers() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

const cycleMap = (surfaces: Surface[]): Record<string, boolean> =>
  Object.fromEntries(surfaces.map((s) => [s, true]));

export const useRefresh = create<RefreshState>((set) => ({
  tier: null,
  profileId: null,
  sweepSeq: 0,
  startedAt: null,
  cycling: {},
  note: null,
  dead: null,

  track: (surface, work) => {
    const g = gen;
    // the skeleton went up in the tick this is called from, so its floor runs
    // from here; `startedAt` is the whole run's t0, which a second pass after
    // a late heal does not share
    const shownAt = Date.now();

    const hide = () =>
      set((s) => {
        if (s.cycling[surface] !== true) return s;
        const { [surface]: _gone, ...rest } = s.cycling;
        return { cycling: rest };
      });

    // a rejected refetch ends the cycle too: the old data comes back with its
    // own strip, and nothing stays blank (R3)
    const done = (landed: boolean) => {
      if (gen !== g) return;
      if (!landed) missed = true;
      const held = Date.now() - shownAt;
      if (held >= MIN_SHOW_MS) {
        hide();
        return;
      }
      const wait = setTimeout(() => {
        timers.delete(wait);
        if (gen === g) hide();
      }, MIN_SHOW_MS - held);
      timers.add(wait);
    };
    void work.then(
      () => done(true),
      () => done(false),
    );
  },

  softRefresh: () => refreshActiveTab(),

  hardRefresh: async (profileId) => {
    const g = ++gen;
    stopTimers();
    // the schema has nowhere to go yet; the heal beside us may be about to
    // build it one, and then this run owes the reader a second pass
    missed = !anySessionOn(profileId);
    const plan = surfacePass(profileId);
    set((s) => ({
      tier: "hard",
      profileId,
      sweepSeq: s.sweepSeq + 1,
      startedAt: Date.now(),
      cycling: cycleMap(plan.surfaces),
      note: plan.note,
      dead: null,
    }));
    armNote(plan.note);
    // the surfaces go out first and the connection is probed BESIDE them: the
    // gesture's own frame belongs to the app (LESSONS 16)
    const landing = plan.send();
    const ok = await requestHeal(profileId, true);
    if (gen !== g) return;
    if (!ok) {
      // the app tried, and the answer came back dead: every surface still
      // cycling returns to its old rows in ONE write, and whatever is still on
      // the wire lands or fails on its own terms (E3 rule 3). heal's backoff
      // keeps trying, and the retry that lands cycles them again with no band
      set({ cycling: {}, dead: { profileId, retryAt: nextRetryAt(profileId) } });
      return;
    }
    await afterHeal(profileId);
    if (gen !== g) return;
    await landing;
    if (gen !== g || !missed) return;
    // a surface that cannot refetch must not blank as though it could: with
    // no address even now, the run ends on the dead strip instead (R3, R6)
    if (!anySessionOn(profileId)) {
      set({ dead: { profileId, retryAt: nextRetryAt(profileId) } });
      return;
    }
    await runPass(profileId, g);
  },
}));

/** what a gesture WILL do, decided from store state alone: the one write of
 * E3 rule 1 needs the whole answer before the first await. `send` fires the
 * refetches and never rejects — its awaits are for the data landing. */
interface Plan {
  /** every surface that will refetch, in the order they are sent */
  surfaces: Surface[];
  /** what this gesture declines to do on the active tab (R4) */
  note: Note | null;
  send: () => Promise<unknown>;
}

const NOTHING: Plan = { surfaces: [], note: null, send: () => Promise.resolve() };

const declined = (note: Note): Plan => ({ ...NOTHING, note });

const merge = (a: Plan, b: Plan): Plan => ({
  surfaces: [...a.surfaces, ...b.surfaces],
  note: a.note ?? b.note,
  send: () => Promise.all([a.send(), b.send()]),
});

/** the hard tier's whole plan: the schema, and the tab you are looking at */
function surfacePass(profileId: string): Plan {
  return merge(planTree(profileId), planActive());
}

/** the schema. A heal that answered ok is not yet a connection to send on:
 * what it left behind is, so the session is resolved through the one resolver
 * every other side query uses — the primary first, then any live tab session
 * (connections.anySessionOn, DESIGN rule 15). With neither there is nothing
 * on this window that CAN refetch the tree, and a surface that cannot refetch
 * must not blank as though it were (R3, R6). */
function planTree(profileId: string): Plan {
  const sid = anySessionOn(profileId);
  if (!sid) return NOTHING;
  return {
    surfaces: ["tree"],
    note: null,
    send: () => {
      const work = useSchema.getState().fetch(profileId, sid);
      useRefresh.getState().track("tree", work);
      return work.catch(() => {});
    },
  };
}

/** the soft act, by tab kind. Both tiers end here, because "reload the tab you
 * are looking at" is one behaviour: the hard tier only adds the schema and a
 * band. Everything the reader owns survives it (R4): scroll, filters, sort,
 * the selected row, staged edits, and an open transaction, whose session the
 * rerun reads INSIDE rather than rebuilding. */
function planActive(): Plan {
  const tabs = useTabs.getState();
  const tabId = tabs.activeId;
  if (!tabId) return NOTHING;
  const tab = tabs.tabs.find((t) => t.id === tabId);
  if (!tab) return NOTHING;
  if (tab.kind === "canvas") return tab.canvas_id ? planCanvas(tab.canvas_id) : NOTHING;
  const edits = useEdits.getState();
  // a commit in flight builds its PK locators against the rows on screen, so
  // this tab has nothing it may refetch. The plan answers it HERE, where the
  // whole answer is due (E3 rule 1): results.run refuses the run too, but it
  // refused it after the skeleton was already up, so the surface cycled over
  // a request nothing ever sent (R3)
  if (edits.committing) return NOTHING;
  const staged = Object.keys(edits.byTab[tabId]?.pending ?? {}).length;
  if (staged > 0) {
    // the rows those edits sit on must not move under them, so this tab does
    // not refetch at all and says so where the reader already looks
    return declined({
      tabId,
      text: `${staged} staged edit${staged === 1 ? "" : "s"} kept. Commit ⌘S or discard to refresh`,
    });
  }
  let start: () => Promise<unknown>;
  if (tab.kind === "table") {
    // a table tab reloads the sub-tab on screen (rows, structure or DDL), and
    // the browse store is what knows which one that is
    start = () => useBrowser.getState().refresh();
  } else {
    const res = useResults.getState().byTab[tabId];
    const sql = res?.executedSql;
    // nothing has run on this tab yet: there is nothing to reload, and an
    // empty gesture is not a failure to report
    if (!sql) return NOTHING;
    if (!readOnlyHeads(sql)) return declined({ tabId, text: "last run wrote. ⌘↩ runs again" });
    start = () =>
      useResults.getState().run(sql, res.executedOffset, {
        refresh: true,
        // the tab's own origin, never the rail selection: a refresh reads the
        // connection the rows came from
        ...(res.executedProfileId ? { profileId: res.executedProfileId } : null),
      });
  }
  // the inspector shows a row of the result the main body is refetching, so it
  // follows that same landing; a pane closed, or showing Ask, has nothing to
  // refetch and never cycles
  const pane = useSidePane.getState();
  const surfaces: Surface[] =
    pane.open && pane.mode === "inspector" ? ["main", "inspector"] : ["main"];
  return {
    surfaces,
    note: null,
    send: () => {
      const work = start();
      const r = useRefresh.getState();
      for (const s of surfaces) r.track(s, work);
      return work.catch(() => {});
    },
  };
}

/** the note's own life: its text goes up in the plan's one write, and this is
 * only what takes it down again (R4) */
function armNote(note: Note | null) {
  clearTimeout(noteTimer);
  if (!note) return;
  noteTimer = setTimeout(() => {
    const n = useRefresh.getState().note;
    if (n?.tabId === note.tabId && n.text === note.text) useRefresh.setState({ note: null });
  }, NOTE_MS);
}

/** a pass with no gesture behind it: the retry that lands, or a second try
 * after a heal that answered too late for the first. Loaders again, and no
 * band — a retry is not a chord (R6). */
async function runPass(profileId: string, g: number): Promise<void> {
  missed = false;
  const plan = surfacePass(profileId);
  if (gen !== g) return;
  useRefresh.setState({
    startedAt: Date.now(),
    cycling: cycleMap(plan.surfaces),
    note: plan.note,
  });
  armNote(plan.note);
  await plan.send();
}

/** "lost, retrying" is ONE fact, and the dot, the sidebar glyph and the strip
 * are three slots that say it (DESIGN rule 14): they read it here, off the
 * same `retryAt` LostLine counts down, so a connection with a retry coming
 * wears the warning colour everywhere and --danger is left to the one case
 * that has nothing coming (R6). */
export const useRetrying = (profileId: string | null | undefined): boolean =>
  useRefresh((s) => !!profileId && s.dead?.profileId === profileId && s.dead.retryAt !== null);

/** heal settled on a profile, whoever asked for it. Only a hard refresh whose
 * own heal failed is still waiting on one: its retry cycles the surfaces, and
 * a retry is not a gesture, so it plays no band (R6). */
export async function healSettled(profileId: string, ok: boolean): Promise<void> {
  const dead = useRefresh.getState().dead;
  if (dead?.profileId !== profileId) return;
  if (!ok) {
    useRefresh.setState({ dead: { profileId, retryAt: nextRetryAt(profileId) } });
    return;
  }
  const g = ++gen;
  stopTimers();
  useRefresh.setState({ dead: null });
  await afterHeal(profileId);
  if (gen !== g) return;
  await runPass(profileId, g);
}

/** the soft act: ⌘R, the tab you are looking at and nothing else, answered in
 * the same one write the hard tier answers in, minus the band and the glyph */
export async function refreshActiveTab(): Promise<void> {
  gen++;
  stopTimers();
  missed = false;
  const plan = planActive();
  useRefresh.setState({
    tier: "soft",
    profileId: useConnections.getState().activeProfileId,
    startedAt: Date.now(),
    cycling: cycleMap(plan.surfaces),
    note: plan.note,
  });
  armNote(plan.note);
  await plan.send();
}

/** result widgets refetch in document order; notes and drawings have nothing
 * to fetch and are not touched (R4). The seam is canvas.ts's own, registered
 * on canvas/port.ts as that module evaluates; null only before anything has
 * imported it, and there the one thing a gesture must not do is nothing
 * (LESSONS 9), so that case alone pays an await and its skeletons go up a
 * tick late. */
function planCanvas(canvasId: string): Plan {
  const seam = canvasRefresh();
  if (!seam) return { ...NOTHING, send: () => refreshCanvas(canvasId).catch(() => {}) };
  const ids = seam.blocks(canvasId);
  const surfaces = ids.map((id): Surface => `widget:${id}`);
  return {
    surfaces,
    note: null,
    send: () =>
      Promise.all(
        ids.map((id, i) => {
          const work = seam.refetch(canvasId, id);
          useRefresh.getState().track(surfaces[i], work);
          return work.catch(() => {});
        }),
      ),
  };
}

/** one document's widgets, cycled and sent. Every route into a canvas refresh
 * plans it above; this is the door for the seam's own first frames. */
export async function refreshCanvas(canvasId: string): Promise<void> {
  if (!canvasRefresh()) {
    await import("./canvas");
    if (!canvasRefresh()) return;
  }
  const plan = planCanvas(canvasId);
  useRefresh.setState((s) => ({
    startedAt: s.startedAt ?? Date.now(),
    cycling: { ...s.cycling, ...cycleMap(plan.surfaces) },
  }));
  await plan.send();
}
