// The Ask fixture harness (DESIGN rules 9 and 13, taste-gate skill step 1):
// the real <AskPanel/> with the real tokens.css and v2.css, inside a .card of
// a chosen width at 640px on the app background, fed from the stores with
// canned data (fixtures.ts) instead of a database and a model. Mounted by
// src/main.tsx instead of <App/> when the URL says so, DEV builds only:
//
//   /?harness=ask&state=<answer|empty|busy|picker|failure|disconnected|small>
//             &w=<320|392|560>&theme=<dark|light>[&scroll=top]
//
// `scroll=top` parks the thread scroller at the question echo instead of the
// pane's own mount position (pinned to the newest content): a 640px card
// cannot hold the whole live answer, so the two ends are two frames.
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
import {
  FIXTURE,
  HARNESS_STATES,
  HARNESS_WIDTHS,
  choiceFor,
  exchangeFor,
  type HarnessState,
  type HarnessTheme,
} from "./fixtures";
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
  const state = q.get("state");
  const w = Number(q.get("w"));
  const theme = q.get("theme");
  return {
    state: HARNESS_STATES.includes(state as HarnessState) ? (state as HarnessState) : "answer",
    w: (HARNESS_WIDTHS as readonly number[]).includes(w) ? w : 392,
    theme: theme === "light" ? "light" : "dark",
    scroll: q.get("scroll") === "top" ? "top" : "bottom",
  };
}

/** every store the pane reads, filled before the first render; a state's
 * exchange is the thread's one exchange, the empty state has no thread */
function seed({ state, w, theme }: Params) {
  const pid = FIXTURE.profile.id;
  const tid = FIXTURE.thread.id;
  const exchange = exchangeFor(state);
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
    threads: { [pid]: [FIXTURE.thread] },
    activeThread: { [pid]: exchange ? tid : null },
    exchanges: exchange ? { [tid]: [exchange] } : {},
    sessions: {},
    phase: { [tid]: state === "busy" ? "tools" : null },
    busy: { [tid]: state === "busy" },
  });

  useSidePane.setState({ mode: "ask", open: true, width: w });
  useAsk.setState({ open: true, traceOpenFor: null, pickerOpen: false, drafts: {}, draftFor: null });
}

function Harness({ state, w, scroll }: Params) {
  // the pane's own mount effects run first (child before parent): they close
  // the picker for a fresh connection and pin the scroller to the bottom; the
  // picker state reopens it and `scroll=top` re-parks the scroller, instantly
  useEffect(() => {
    if (state === "picker") useAsk.getState().setPickerOpen(true);
    if (scroll === "top") {
      const el = document.querySelector<HTMLElement>(".ask-scroll");
      if (el) el.scrollTop = 0;
    }
    document.documentElement.dataset.harnessReady = "1";
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
