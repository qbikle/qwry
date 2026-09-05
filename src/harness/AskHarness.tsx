// The Ask fixture harness (DESIGN rules 9 and 13, taste-gate skill step 1):
// the real <AskPanel/> with the real tokens.css and v2.css, inside a .card of
// a chosen width at 640px on the app background, fed from the stores with
// canned data (fixtures.ts and its round-2 siblings) instead of a database
// and a model. Mounted by src/main.tsx instead of <App/> when the URL says
// so, DEV builds only:
//
//   /?harness=ask&state=<answer|empty|busy|picker|failure|disconnected|small
//                       |pending|retry|strip|threads|scalar|kv|wide|trace
//                       |echo|echo-long|starters|starters-fallback
//                       |qwrying|qwrying-trail|kv-wide>
//             &w=<320|392|560>&theme=<dark|light>[&scroll=top|bottom]
//
// `scroll=top` parks the thread scroller at the question echo instead of the
// pane's own mount position (pinned to the newest content): a 640px card
// cannot hold the whole live answer, so the two ends are two frames. The
// `strip` and `kv-wide` states park at the top unless the URL says
// `scroll=bottom`: their subject (the thinking strip; the one-row pairs) sits
// above the fold when the scroller is pinned to the newest content.
//
// Round 3 (W2d): the `echo` states seed a whole thread of exchanges
// (fixtures.echo.ts); the `starters` states seed the starter pools store
// (fixtures.starters.ts), and every other state resets it, so a pool
// persisted by an earlier harness page never reaches a frame; the strip
// states (fixtures.strip.ts) carry their own busy / phase.
//
// scripts/ask-frames.ts drives headless Chrome over this route and writes
// one PNG per state × width × theme. The dev build remains the final eyeball;
// these frames are the evidence.
//
// Never calls IPC: tauriShim.ts (imported first) answers the commands the
// pane fires on mount and on a picker open, and refuses the rest by name.

import "./tauriShim";
import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { AskPanel } from "../ask/AskPanel";
import { DEFAULT_PALETTE } from "../design/theme";
import { useAgent } from "../stores/agent";
import { useAsk } from "../stores/ask";
import { useSchema } from "../stores/schema";
import { useSettings } from "../stores/settings";
import { useSidePane } from "../stores/sidePane";
import { useStarterPools } from "../stores/starters";
import {
  FIXTURE,
  HARNESS_STATES,
  HARNESS_WIDTHS,
  choiceFor,
  exchangeFor,
  type HarnessState,
  type HarnessTheme,
} from "./fixtures";
import { ANATOMY_STATES, anatomyTraceFor, type AnatomyState } from "./fixtures.anatomy";
import { ECHO_STATES, echoExchangesFor, type EchoState } from "./fixtures.echo";
import { INTERACT_STATES, interactSeed, type InteractSeed, type InteractState } from "./fixtures.interact";
import { SHELL_THREADS, shellAfterMount } from "./fixtures.shell";
import { STARTER_STATES, startersSeed, type StarterState } from "./fixtures.starters";
import { STRIP_STATES, stripSeed, type StripState } from "./fixtures.strip";
import "../app/v2.css";
import "./harness.css";

/** the pane's height in every frame: tall enough for the whole answer anatomy
 * and the composer, short enough that the empty state's docking reads */
export const CARD_H = 640;

interface Params {
  state: HarnessState;
  w: number;
  theme: HarnessTheme;
  scroll: "top" | "bottom";
}

function paramsFrom(search: string): Params {
  const q = new URLSearchParams(search);
  const rawState = q.get("state");
  const state = HARNESS_STATES.includes(rawState as HarnessState) ? (rawState as HarnessState) : "answer";
  const w = Number(q.get("w"));
  const theme = q.get("theme");
  const scroll = q.get("scroll");
  return {
    state,
    w: (HARNESS_WIDTHS as readonly number[]).includes(w) ? w : 392,
    theme: theme === "light" ? "light" : "dark",
    scroll:
      scroll === "top" || (scroll !== "bottom" && (state === "strip" || state === "kv-wide")) ? "top" : "bottom",
  };
}

/** the interaction builder's seed for a state, null for the rest */
function interactFor(state: HarnessState): InteractSeed | null {
  return (INTERACT_STATES as readonly string[]).includes(state) ? interactSeed(state as InteractState) : null;
}

/** every store the pane reads, filled before the first render; a state's
 * exchange is the thread's one exchange (the echo states seed a whole thread),
 * the empty state has no thread. The `threads` state lists the shell
 * builder's five threads, the first of them the fixture thread, so the
 * answered exchange sits behind the sheet */
function seed({ state, w, theme }: Params) {
  const pid = FIXTURE.profile.id;
  const tid = FIXTURE.thread.id;
  const interact = interactFor(state);
  const exchange = interact?.exchange ?? exchangeFor(state);
  const echo = (ECHO_STATES as readonly string[]).includes(state) ? echoExchangesFor(state as EchoState) : null;
  const strip = (STRIP_STATES as readonly string[]).includes(state) ? stripSeed(state as StripState) : null;
  const choice = choiceFor(state);

  useSettings.setState({
    agentProvider: choice.provider,
    agentModel: choice.model,
    agentByConn: {},
    agentBaseUrls: {},
    gridDensity: "normal",
    uiZoom: 100,
    paletteId: DEFAULT_PALETTE,
    matchConnection: false,
    themeEverywhere: true,
  });
  useSettings.getState().setMode(theme);
  document.documentElement.dataset.theme = theme;

  useSchema.setState({
    snapshots: { [pid]: FIXTURE.snapshot },
    source: { [pid]: "server" },
    loading: {},
    errors: {},
  });

  useAgent.setState({
    activeProfileId: pid,
    threads: { [pid]: state === "threads" ? SHELL_THREADS : [FIXTURE.thread] },
    activeThread: { [pid]: exchange || echo ? tid : null },
    exchanges: echo ? { [tid]: echo } : exchange ? { [tid]: [exchange] } : {},
    sessions: {},
    pending: interact?.pending ?? {},
    phase: { [tid]: interact ? interact.phase : strip ? strip.phase : state === "busy" ? "tools" : null },
    busy: { [tid]: interact ? interact.busy : strip ? strip.busy : state === "busy" },
  });
  useStarterPools.setState(
    (STARTER_STATES as readonly string[]).includes(state)
      ? startersSeed(state as StarterState)
      : { pools: {}, cursors: {} },
  );

  useSidePane.setState({ mode: "ask", open: true, width: w });
  useAsk.setState({
    open: true,
    traceOpenFor: null,
    threadsOpen: false,
    pickerOpen: false,
    drafts: {},
    draftFor: null,
  });
}

function Harness({ state, w, scroll }: Params) {
  // the pane's own mount effects run first (child before parent): they close
  // the picker, the trace and the Threads sheet for a fresh connection and
  // pin the scroller to the bottom; so the transient chrome a state shows is
  // opened HERE, never seeded (a seeded target would be wiped), and
  // `scroll=top` re-parks the scroller, instantly. The sheet's keyboard step
  // and the strip's scroll position wait one frame for those opens to
  // commit (the sheet's key handler reads `open` from its last render), and
  // the ready mark follows them so a frame never lands between
  useEffect(() => {
    if (state === "picker") useAsk.getState().setPickerOpen(true);
    if (state === "threads") useAsk.getState().openThreads();
    const t = (ANATOMY_STATES as readonly string[]).includes(state) ? anatomyTraceFor(state as AnatomyState) : null;
    if (t) useAsk.getState().openTrace(t.exchangeId, t.stepId);
    if (scroll === "top") {
      const el = document.querySelector<HTMLElement>(".ask-scroll");
      if (el) el.scrollTop = 0;
    }
    const interact = interactFor(state);
    const id = requestAnimationFrame(() => {
      shellAfterMount(state);
      if (interact?.stripScroll != null) {
        const strip = document.querySelector<HTMLElement>(".ans-strip");
        if (strip) strip.scrollLeft = interact.stripScroll;
      }
      document.documentElement.dataset.harnessReady = "1";
    });
    return () => cancelAnimationFrame(id);
  }, [state, scroll]);
  return (
    <div className="harness">
      <aside className="card harness-card" style={{ width: w, height: CARD_H }}>
        <AskPanel profile={FIXTURE.profile} connected={state !== "disconnected"} />
      </aside>
    </div>
  );
}

export function mountAskHarness(root: HTMLElement): void {
  const params = paramsFrom(location.search);
  document.title = `Ask harness · ${params.state} · ${params.w} · ${params.theme}`;
  seed(params);
  ReactDOM.createRoot(root).render(<Harness {...params} />);
}
