// The refresh harness (E2, docs/refresh-sketch-e2.html; DESIGN rules 9 and 6).
// Every harness before this one framed ONE surface: a pane, a modal, a tab's
// face. ⌘R and ⇧⌘R are not surfaces, they are acts that cross the whole
// window, so this root composes the real `.v2-shell` around the real
// DbSwitcher, SchemaTree, TabBar, TableBrowser / QueryBox / CanvasTab and
// Inspector, fed from fixtures.e2.ts, and lets the product's own
// hardRefresh / softRefresh run over it:
//
//   /?harness=refresh&state=<e2-table|e2-table-staged|e2-query|e2-query-wrote
//                            |e2-canvas|e2-dead>
//        &w=<640|960|1280>&theme=<dark|light>
//        [&tier=hard|soft][&at=<ms>][&lat=<ms>]
//
// `tier` names the act to run once the stores are seeded; without it the page
// is the window at rest, the sketch's `idle` still. `at` is what makes a
// MOTION still possible at all: at that millisecond the page is frozen
// deterministically, every running animation seeked to `at` and paused, the
// cycling map pinned to the plan the store itself computed, and the clock
// neutralized so nothing pending can advance past the instant the shot is
// taken. Without `at` nothing is ever frozen, which is the probe's mode:
// e2-probe.ts samples the band and the surfaces over real time instead.
//
// The three marks are separate on purpose. `data-harness-seeded` goes up when
// the stores hold the state and BEFORE the act fires, so a probe watching for
// it (Page.addScriptToEvaluateOnNewDocument, so its observer is installed
// before any page script) can never miss t0; `data-harness-ready` follows the
// freeze, so a frame never lands between. `data-harness-t0` carries the
// instant of the stamp itself, because a sampler only LEARNS of the mark on
// its next frame while the hard tier's first requests go out some 14 ms after
// it: anchored on the observation instead of on the instant, a poller one
// frame late reads a refetch that did go out as one that never happened.
//
// Reduced motion is Chrome's own lever (--force-prefers-reduced-motion), never
// a harness costume: the product reads the media query, so a URL flag here
// would be testing the harness instead of the rule.
//
// The sketch's widths are the window's, not a card's: at 640 the side pane is
// closed, the way the sketch drops its right column, and at 960 it is the
// sketch's own 250. The ask pane is a MODE of that one card here rather than a
// second card (AGENT-UX section 1), so the inspector is the mode on stage; the
// rule it stands for, that a surface with nothing to refetch never cycles,
// belongs to the store and is asserted there.
//
// Never calls IPC: tauriShim.ts (imported first) answers introspect,
// execute_stream, execute, session_probe and connect with the sketch's own
// latencies, and `e2-dead` is the state where the last two refuse.

import { e2ResetCalls, e2SetAlive } from "./tauriShim";
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import { TableBrowser } from "../browser/TableBrowser";
import { CanvasTab } from "../canvas/CanvasTab";
import { QueryBox } from "../editor/QueryBox";
import { TabBar } from "../editor/TabBar";
import { ResultsPane } from "../grid/ResultsPane";
import { Inspector } from "../inspector/Inspector";
import { DbSwitcher } from "../sidebar/DbSwitcher";
import { SchemaTree } from "../sidebar/SchemaTree";
import { RefreshSweep } from "../app/RefreshSweep";
import { DEFAULT_PALETTE } from "../design/theme";
import { useBrowser } from "../stores/browser";
import { useCanvas } from "../stores/canvas";
import { skey, useConnections } from "../stores/connections";
import { useEdits } from "../stores/edits";
import { useInspector } from "../stores/inspector";
import { useRefresh, useRetrying } from "../stores/refresh";
import { useResults } from "../stores/results";
import { useSchema } from "../stores/schema";
import { useSettings } from "../stores/settings";
import { useSidePane } from "../stores/sidePane";
import { useTabs } from "../stores/tabs";
import {
  E2_CANVAS_ID,
  E2_CARD_H,
  E2_PANE_W,
  E2_PROFILE_ID,
  E2_SEL_ROW,
  E2_SESSION,
  E2_STATES,
  E2_TABLE_TAB,
  E2_WIDTHS,
  e2AfterMount,
  e2Profile,
  e2Seed,
  e2Snapshot,
  isE2State,
  type E2State,
} from "./fixtures.e2";
import "../app/v2.css";
import "./harness.css";

type Theme = "dark" | "light";
type Tier = "hard" | "soft";

interface Params {
  state: E2State;
  w: number;
  theme: Theme;
  tier: Tier | null;
  at: number | null;
}

function paramsFrom(search: string): Params {
  const q = new URLSearchParams(search);
  const raw = q.get("state") ?? "";
  const w = Number(q.get("w"));
  const tier = q.get("tier");
  const at = Number(q.get("at"));
  return {
    state: isE2State(raw) ? raw : E2_STATES[0],
    w: (E2_WIDTHS as readonly number[]).includes(w) ? w : 1280,
    theme: q.get("theme") === "light" ? "light" : "dark",
    tier: tier === "hard" || tier === "soft" ? tier : null,
    at: q.has("at") && Number.isFinite(at) && at >= 0 ? at : null,
  };
}

// ---- the seed --------------------------------------------------------------

/** every store the shell reads, filled before the first render. Seeded rather
 * than run: a harness that CONNECTED and ran the browse would be timing the
 * shim's own mount, and the act under test has to start from a window that is
 * already sitting on its rows */
function seed({ state, w, theme }: Params) {
  const s = e2Seed(state);

  useSettings.setState({
    gridDensity: "normal",
    uiZoom: 100,
    paletteId: DEFAULT_PALETTE,
    matchConnection: false,
    themeEverywhere: true,
  });
  useSettings.getState().setMode(theme);
  document.documentElement.dataset.theme = theme;

  useConnections.setState({
    profiles: [e2Profile],
    activeProfileId: E2_PROFILE_ID,
    sessions: { [E2_PROFILE_ID]: E2_SESSION },
    tabSessions: Object.fromEntries(
      s.tabs.map((t) => [skey(E2_PROFILE_ID, t.id), `${E2_SESSION}-${t.id}`]),
    ),
    txTabs: {},
    writeTabs: {},
    connState: { [E2_PROFILE_ID]: "connected" },
    homeMode: null,
    sql: s.tabs.find((t) => t.id === s.activeTabId)?.sql ?? "",
    error: null,
    closedToast: null,
  });

  useSchema.setState({
    snapshots: { [E2_PROFILE_ID]: e2Snapshot },
    source: { [E2_PROFILE_ID]: "server" },
    loading: {},
    errors: {},
  });

  useTabs.setState({ tabs: s.tabs, activeId: s.activeTabId, loaded: true, closedStack: [] });

  const byTab = Object.fromEntries(
    Object.entries(s.results).map(([tabId, r]) => [
      tabId,
      {
        statements: r.statements.map((st) => ({
          index: st.index,
          sql: st.sql,
          columns: st.columns,
          rows: st.rows,
          truncated: new Set<string>(),
          affected: st.affected,
          ms: st.ms,
          rowCount: st.rows.length,
          capped: false,
          done: true,
          error: null,
        })),
        activeStatement: 0,
        running: false,
        cancelling: false,
        connecting: false,
        totalMs: r.totalMs,
        executedSql: r.sql,
        executedOffset: 0,
        notices: [],
        executedSessionId: `${E2_SESSION}-${tabId}`,
        executedProfileId: E2_PROFILE_ID,
        globalError: null,
        refreshing: false,
        refreshedAt: null,
      },
    ]),
  );
  useResults.setState({ byTab, active: s.activeTabId, ...byTab[s.activeTabId] });

  // the browse tab's rest state comes from the store's own door: syncActive
  // reads the TAB for its table and fills the rest from its own blank, so a
  // shape change here is a tsc failure rather than a drifted copy
  useBrowser.setState({ byTab: {}, active: "" });
  useBrowser.getState().syncActive(s.activeTabId);

  useEdits.setState({
    byTab: {
      [E2_TABLE_TAB]: {
        maps: {},
        pending: Object.fromEntries(
          s.pending.map((p) => [
            `0:${p.row}:${p.col}`,
            { stmtIndex: 0, row: p.row, col: p.col, value: p.value, original: p.original },
          ]),
        ),
        flash: new Set<string>(),
        undoStack: [],
        redoStack: [],
      },
    },
    active: s.activeTabId,
    committing: false,
  });
  useEdits.getState().syncActive(s.activeTabId);

  useCanvas.setState({
    canvases: s.canvases,
    docs: s.docs,
    loaded: { [E2_PROFILE_ID]: true },
    recent: { [E2_PROFILE_ID]: E2_CANVAS_ID },
    comparing: {},
    saveError: false,
    editing: null,
    askedFrom: {},
  });

  // the window's own widths, not a card's: the pane closes at the floor the
  // way the sketch drops its right column, and the main card takes the room
  // ...and closed on the canvas, where nothing is selected: the sketch gives
  // that card to the Ask pane, this window has no Ask, and a pane holding
  // only "Select a cell to inspect" would spend a third of the frame saying
  // nothing (DESIGN rule 12)
  const paneW = state === "e2-canvas" ? null : (E2_PANE_W[w] ?? null);
  useSidePane.setState({ mode: "inspector", open: paneW !== null, width: paneW ?? 300 });
  document.documentElement.style.setProperty("--pane-w", `${paneW ?? 0}px`);
  useInspector.setState({
    target: state === "e2-canvas" ? null : { stmtIndex: 0, row: E2_SEL_ROW, col: 1 },
    fullValue: null,
    fullValueFor: null,
    fullValueError: null,
  });

  return s;
}

/** Heal is ARMED by connecting, and `hardRefresh`'s very first act is a heal:
 * `requestHeal` refuses a profile the user never connected (connections.ts
 * healArmed), so a window seeded only by store writes would take R6's picture
 * for the wrong reason. One pass of the product's own `healProfile` over the
 * seeded sessions arms it exactly as a connect would, and the connection is
 * flipped dead only AFTER that, so `e2-dead` is a connection that WAS alive. */
async function arm(alive: boolean): Promise<void> {
  e2SetAlive(true);
  await useConnections.getState().healProfile(E2_PROFILE_ID);
  e2SetAlive(alive);
}

// ---- the freeze ------------------------------------------------------------

interface Freezable {
  __freeze?: (t: number) => void;
}

/** Stop the window at `t`, exactly, so a still of a 720 ms sweep is evidence
 * rather than a lottery. Three acts, in this order: the store is told the
 * instant, IF it has a `__freeze` of its own to settle pending work with; the
 * commit is flushed; every timer and frame callback already SCHEDULED is
 * cancelled, not just the ones yet to be asked for, because a `track` timer
 * due at 700 ms would otherwise clear a cycle during the screenshot's own
 * round trip; and every running animation is paused where it stands. An
 * animation the freeze's own commit just created has no time on it and stands
 * for a state that was already up, so it is run to its end first.
 *
 * What the freeze never does is DECIDE which surfaces are cycling. The store
 * ran the act in real time and its map at `t` is the answer; a harness that
 * recomputed the plan from the projection would have painted every surface of
 * the dead connection blanking, which is the one thing R6 forbids, and the
 * frame would have been evidence of the harness rather than of the code. */
function freezeAt(t: number): void {
  const store = useRefresh as unknown as Freezable;
  flushSync(() => {
    if (typeof store.__freeze === "function") store.__freeze(t);
  });
  const lastTimer = window.setTimeout(() => {}, 0) as unknown as number;
  const lastFrame = window.requestAnimationFrame(() => {});
  for (let i = lastTimer; i > 0; i--) clearTimeout(i);
  for (let i = lastFrame; i > 0; i--) cancelAnimationFrame(i);
  window.setTimeout = ((): number => 0) as unknown as typeof window.setTimeout;
  window.requestAnimationFrame = ((): number => 0) as typeof window.requestAnimationFrame;
  for (const a of document.getAnimations()) {
    const dur = Number(a.effect?.getTiming().duration ?? 0);
    if (!a.currentTime && Number.isFinite(dur)) a.currentTime = dur;
    a.pause();
  }
}

// ---- the window ------------------------------------------------------------

function Shell({ state, w, tier, at, alive }: Params & { alive: boolean }) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const paneOpen = useSidePane((s) => s.open);
  // the product shows this dot only while the connection answers, and E2's
  // dead state is the one that stops answering (R6)
  const connState = useConnections((s) => s.connState[E2_PROFILE_ID]);
  const retrying = useRetrying(E2_PROFILE_ID);
  const crumbs = [
    e2Profile.name,
    e2Profile.dbname,
    active?.kind === "table" ? (active.table?.name ?? "") : (active?.name ?? ""),
  ].filter(Boolean);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const id = requestAnimationFrame(() => {
      void arm(alive).then(async () => {
        if (!live) return;
        await e2AfterMount(state);
        if (!live) return;
        e2ResetCalls();
        document.documentElement.dataset.harnessT0 = String(performance.now());
        document.documentElement.dataset.harnessSeeded = "1";
        const fire =
          tier === "hard"
            ? useRefresh.getState().hardRefresh(E2_PROFILE_ID)
            : tier === "soft"
              ? useRefresh.getState().softRefresh()
              : null;
        void fire?.catch(() => {
          // a refused heal is `e2-dead`'s own verdict, not a harness error
        });
        if (at === null) {
          document.documentElement.dataset.harnessReady = "1";
          return;
        }
        timer = window.setTimeout(() => {
          freezeAt(at);
          document.documentElement.dataset.harnessReady = "1";
        }, at);
      });
    });
    return () => {
      live = false;
      cancelAnimationFrame(id);
      clearTimeout(timer);
    };
  }, [state, tier, at, alive]);

  return (
    <div className="harness harness-window">
      <div className="card harness-card" style={{ width: w, height: E2_CARD_H }}>
        <div className="v2-shell">
          <div className="v2-titlebar">
            <span className="v2-breadcrumb">
              {/* App.tsx's own dot: it wears the connection's state instead of
                  unmounting, so the crumb never moves under the reader (R6) */}
              <span
                className={`conn-dot ${connState ?? "disconnected"}${retrying ? " retrying" : ""}`}
              />
              {crumbs.map((seg, i, arr) => (
                <span key={i} className="crumb">
                  {i > 0 && <span className="crumb-sep">/</span>}
                  <span className={i === arr.length - 1 ? "crumb-strong" : ""}>{seg}</span>
                </span>
              ))}
            </span>
          </div>

          <div className="v2-body">
            <aside className="sidebar-card card">
              <DbSwitcher
                profileId={E2_PROFILE_ID}
                dbname={e2Profile.dbname}
                name={e2Profile.name}
              />
              <div className="sb-tables">
                <SchemaTree profileId={E2_PROFILE_ID} />
              </div>
            </aside>

            <main className="main-card card" tabIndex={-1}>
              <TabBar />
              {active?.kind === "table" ? (
                <TableBrowser />
              ) : active?.kind === "canvas" && active.canvas_id ? (
                <CanvasTab canvasId={active.canvas_id} />
              ) : (
                <>
                  <section className="editor-pane">
                    <QueryBox />
                  </section>
                  <div className="split-divider" />
                  <section className="results-pane">
                    <ResultsPane />
                  </section>
                </>
              )}
            </main>

            <aside
              className={`side-card card${paneOpen ? "" : " collapsed"}`}
              data-mode="inspector"
              style={{ width: paneOpen ? "var(--pane-w)" : 0 }}
            >
              <div className="inspector-fixed" style={{ width: "var(--pane-w)" }}>
                <Inspector />
              </div>
            </aside>
          </div>

          <RefreshSweep />
        </div>
      </div>
    </div>
  );
}

export function mountRefreshHarness(root: HTMLElement): void {
  const params = paramsFrom(location.search);
  document.title = `Refresh harness · ${params.state} · ${params.w} · ${params.theme}`;
  const s = seed(params);
  // the store itself, on the window: a probe drives this page over CDP and has
  // no module handle, and what it has to read back is the PLAN, not the class
  // the DOM happens to be animating toward (tauriShim's own precedent)
  const w = window as unknown as { __harness?: Record<string, unknown> };
  w.__harness = { ...(w.__harness ?? {}), refresh: useRefresh };
  ReactDOM.createRoot(root).render(<Shell {...params} alive={s.alive} />);
}
