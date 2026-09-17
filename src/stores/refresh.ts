/** The two refresh tiers, and the clock they run on (E2 R1-R6).
 *
 * ⌘R reloads what you are looking at: the active tab alone. ⇧⌘R is the hard
 * tier: the connection is probed and rebuilt, the schema refetched, then every
 * surface takes its turn. One implementation each, so the header ↻ and the
 * palette cannot drift apart (DESIGN rule 15).
 *
 * The sweep is the ACK and the surfaces are the verdict (LESSONS 15): the band
 * plays at once on ⇧⌘R, always, even when the connection turns out dead, and
 * says only that a hard refresh started. A surface blanks to its skeleton only
 * while it is itself mid-refetch, and comes back with the old data plus a
 * strip when the refetch failed. This module owns WHEN each cycle starts; the
 * skeleton and the fades are each surface's own CSS.
 */
import { create } from "zustand";
import { prefersReducedMotion } from "../design/springs";
import { readOnlyHeads } from "../lib/sqlHeads";
import { nextRetryAt, requestHeal } from "./heal";
import { afterHeal } from "./liveSession";
import { useConnections } from "./connections";
import { useResults } from "./results";
import { useSchema } from "./schema";
import { useTabs } from "./tabs";
import type { ResultBlock } from "./canvas";

export type Tier = "soft" | "hard";
export type Surface = "tree" | "main" | "inspector" | `widget:${string}`;

/** DESIGN rule 6's named sweep: --dur-slow × 3 at constant speed. The band's
 * own front is the clock every surface reads, so the CSS animation and this
 * projection must name the same number (rule 14). */
const SWEEP_MS = 720;
/** the skeleton's grace: a refetch that lands inside it crossfades and never
 * blanks, so a warm cache reads as instant instead of as a flicker (R3) */
const GRACE_MS = 150;
/** --dur-slow: once a skeleton is up it stays long enough to read as a state */
const MIN_SHOW_MS = 240;
/** how long the status bar keeps a note about what a refresh did NOT do (R4) */
const NOTE_MS = 2_600;

interface RefreshState {
  tier: Tier | null;
  profileId: string | null;
  /** re-keys the band so consecutive hard refreshes each play their own */
  sweepSeq: number;
  /** t0 of the current run: every surface's reach is measured from here */
  startedAt: number | null;
  cycling: Record<string, boolean>;
  /** what the active tab's status bar says about a refresh it declined (R4) */
  note: { tabId: string; text: string } | null;
  /** the hard tier's heal failed: the connection strip's own countdown (R6).
   * retryAt is heal's next attempt, null once its chain gave up */
  dead: { profileId: string; retryAt: number | null } | null;
  hardRefresh: (profileId: string) => Promise<void>;
  softRefresh: () => Promise<void>;
  /** register a refetch: its surface cycles from max(front reach, grace)
   * until the work settles, never before the band's front arrives (R3) */
  track: (surface: Surface, work: Promise<unknown>, el?: HTMLElement | null) => void;
  /** ms after t0 at which the band's front crosses this element's centre */
  frontReachMs: (el: HTMLElement | null | undefined) => number;
}

// generation guard: a new gesture orphans the previous run's timers
let gen = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
let noteTimer: ReturnType<typeof setTimeout> | undefined;

function stopTimers() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

const surfaceEl = (surface: Surface): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-refresh-surface="${surface}"]`);

export const useRefresh = create<RefreshState>((set, get) => ({
  tier: null,
  profileId: null,
  sweepSeq: 0,
  startedAt: null,
  cycling: {},
  note: null,
  dead: null,

  frontReachMs: (el) => {
    // the soft tier plays no band, and reduced motion removes it: with no
    // front to wait for, every surface starts at once
    if (!el || get().tier !== "hard" || prefersReducedMotion()) return 0;
    const shell = document.querySelector(".v2-shell");
    if (!shell) return 0;
    const f = shell.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (f.width === 0 || f.height === 0 || r.width === 0) return 0;
    const cx = (r.left + r.width / 2 - f.left) / f.width;
    const cy = (r.top + r.height / 2 - f.top) / f.height;
    // the band's right edge travels -0.18 → 1.98 of the window's width at
    // constant speed, leaning 24°, so a point lower on the screen meets it
    // later by cy · tan(24°) · (H/W)
    const x = cx + cy * 0.445 * (f.height / f.width);
    const p = (x + 0.18) / 2.16;
    return Math.round(Math.min(0.95, Math.max(0.05, p)) * SWEEP_MS);
  },

  track: (surface, work, el) => {
    const g = gen;
    const reach = get().frontReachMs(el);
    const startedAt = get().startedAt;
    const since = startedAt === null ? 0 : Date.now() - startedAt;
    // the fetch is already in flight; only the SKELETON waits for the front,
    // and never less than the grace (R3)
    const showIn = Math.max(reach - since, GRACE_MS);
    let shownAt = 0;
    let settled = false;

    const hide = () =>
      set((s) => {
        const { [surface]: _gone, ...rest } = s.cycling;
        return { cycling: rest };
      });

    const show = setTimeout(() => {
      timers.delete(show);
      if (settled || gen !== g) return;
      shownAt = Date.now();
      set((s) => ({ cycling: { ...s.cycling, [surface]: true } }));
    }, showIn);
    timers.add(show);

    // a rejected refetch ends the cycle too: the old data comes back with its
    // own strip, and nothing stays blank (R3)
    const done = () => {
      settled = true;
      if (gen !== g) return;
      if (shownAt === 0) {
        clearTimeout(show);
        timers.delete(show);
        return;
      }
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
    void work.then(done, done);
  },

  softRefresh: async () => {
    gen++;
    stopTimers();
    set({
      tier: "soft",
      profileId: useConnections.getState().activeProfileId,
      startedAt: Date.now(),
      cycling: {},
      note: null,
    });
    await refreshActiveTab();
  },

  hardRefresh: async (profileId) => {
    const g = ++gen;
    stopTimers();
    set((s) => ({
      tier: "hard",
      profileId,
      sweepSeq: s.sweepSeq + 1,
      startedAt: Date.now(),
      cycling: {},
      note: null,
      dead: null,
    }));
    // the band has already started: it announces the attempt, never its result
    const ok = await requestHeal(profileId, true);
    if (gen !== g) return;
    if (!ok) {
      // R6: no surface cycles, no row moves. heal's own backoff keeps trying
      // and the retry that lands cycles the surfaces with no second sweep
      set({ dead: { profileId, retryAt: nextRetryAt(profileId) } });
      return;
    }
    await afterHeal(profileId);
    if (gen !== g) return;
    await surfacePass(profileId, g);
  },
}));

/** the schema, then the tab you are looking at: the order the band crosses
 * them is the order they blank, and track() is what holds each one there */
async function surfacePass(profileId: string, g: number): Promise<void> {
  const sid = useConnections.getState().sessions[profileId];
  if (sid) {
    useRefresh
      .getState()
      .track("tree", useSchema.getState().fetch(profileId, sid), surfaceEl("tree"));
  }
  if (gen !== g) return;
  await refreshActiveTab();
}

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
  // backdated: the band this run would have waited for already crossed the
  // window, so every surface starts as soon as its own fetch is in flight
  useRefresh.setState({ dead: null, startedAt: Date.now() - SWEEP_MS });
  await afterHeal(profileId);
  if (gen !== g) return;
  await surfacePass(profileId, g);
}

function say(tabId: string, text: string) {
  clearTimeout(noteTimer);
  useRefresh.setState({ note: { tabId, text } });
  noteTimer = setTimeout(() => {
    const n = useRefresh.getState().note;
    if (n?.tabId === tabId && n.text === text) useRefresh.setState({ note: null });
  }, NOTE_MS);
}

/** the soft act, by tab kind. Both tiers end here, because "reload the tab you
 * are looking at" is one behaviour: the hard tier only arrives with a rebuilt
 * connection and a band already in flight. Everything the reader owns survives
 * it (R4): scroll, filters, sort, the selected row, staged edits, and an open
 * transaction, whose session the rerun reads INSIDE rather than rebuilding. */
export async function refreshActiveTab(): Promise<void> {
  const tabs = useTabs.getState();
  const tabId = tabs.activeId;
  if (!tabId) return;
  const tab = tabs.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.kind === "canvas") {
    if (tab.canvas_id) await refreshCanvas(tab.canvas_id);
    return;
  }
  const { useEdits } = await import("./edits");
  const staged = Object.keys(useEdits.getState().byTab[tabId]?.pending ?? {}).length;
  if (staged > 0) {
    // the rows those edits sit on must not move under them, so this tab does
    // not refetch at all and says so where the reader already looks
    say(
      tabId,
      `${staged} staged edit${staged === 1 ? "" : "s"} kept. Commit ⌘S or discard to refresh`,
    );
    return;
  }
  let work: Promise<unknown>;
  if (tab.kind === "table") {
    // a table tab reloads the sub-tab on screen (rows, structure or DDL), and
    // the browse store is what knows which one that is
    const { useBrowser } = await import("./browser");
    work = useBrowser.getState().refresh();
  } else {
    const res = useResults.getState().byTab[tabId];
    const sql = res?.executedSql;
    // nothing has run on this tab yet: there is nothing to reload, and an
    // empty gesture is not a failure to report
    if (!sql) return;
    if (!readOnlyHeads(sql)) {
      say(tabId, "last run wrote. ⌘↩ runs again");
      return;
    }
    work = useResults.getState().run(sql, res.executedOffset, {
      refresh: true,
      // the tab's own origin, never the rail selection: a refresh reads the
      // connection the rows came from
      ...(res.executedProfileId ? { profileId: res.executedProfileId } : null),
    });
  }
  const r = useRefresh.getState();
  r.track("main", work, surfaceEl("main"));
  // the inspector shows a row of the result the main body is refetching, so it
  // follows that same landing on its own reach; ⌘R leaves it alone
  if (r.tier === "hard") r.track("inspector", work, surfaceEl("inspector"));
  await work.catch(() => {});
}

type WidgetRefetch = (canvasId: string, blockId: string) => Promise<unknown>;
let widgetRefetch: WidgetRefetch | null = null;

/** the canvas owns what re-running a widget MEANS (its session, its row cap,
 * where the rows land); this module owns only when each one starts */
export function setWidgetRefetch(fn: WidgetRefetch) {
  widgetRefetch = fn;
}

/** result widgets refetch in the order the front reaches them; notes and
 * drawings have nothing to fetch and are not touched (R4) */
export async function refreshCanvas(canvasId: string): Promise<void> {
  // the seam first: canvas.ts registers it as it evaluates, so reading the
  // slot before that module has settled is how a refresh refetches nothing
  const { useCanvas, widgetSeam } = await import("./canvas");
  await widgetSeam;
  const refetch = widgetRefetch;
  if (!refetch) return;
  const r = useRefresh.getState();
  const blocks = (useCanvas.getState().docs[canvasId]?.blocks ?? [])
    .filter((b): b is ResultBlock => b.kind === "result" && !!b.sql)
    .map((b) => ({ id: b.id, el: surfaceEl(`widget:${b.id}`) }))
    .sort((a, b) => r.frontReachMs(a.el) - r.frontReachMs(b.el));
  await Promise.all(
    blocks.map(({ id, el }) => {
      const work = refetch(canvasId, id);
      r.track(`widget:${id}`, work, el);
      return work.catch(() => {});
    }),
  );
}
