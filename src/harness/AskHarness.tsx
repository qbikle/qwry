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
//                       |qwrying|qwrying-trail|kv-wide
//                       |actions|actions-latest|actions-busy|edit|edit-latest
//                       |edit-stack|insight|insight-prose|insight-steps
//                       |insight-code|insight-stream|mention-popover
//                       |mention-draft|mention-first|mention-echo|mention-trace
//                       |result-table|result-sql|result-scalar|failure-cap
//                       |answer-actions|followups-end
//                       |a4-preview|a4-preview-warn|a4-preview-sql|a4-ran
//                       |a4-preview-busy|a4-writes-off
//                       |a2-explain|a2-knowledge-trace|a2-ask-why>
//             &w=<320|392|560>&theme=<dark|light>[&scroll=top|bottom]
//
// `scroll=top` parks the thread scroller at the question echo instead of the
// pane's own mount position (pinned to the newest content): a 640px card
// cannot hold the whole live answer, so the two ends are two frames. The
// `strip`, `kv-wide`, `insight*` and `result*` states park at the top unless
// the URL says `scroll=bottom`: their subject (the thinking strip; the one-row
// pairs; the answer text's blocks; the result block and the failure block)
// sits above the fold when the scroller is pinned to the newest content.
//
// Round 3 (W2d): the `echo` states seed a whole thread of exchanges
// (fixtures.echo.ts); the `starters` states seed the starter pools store
// (fixtures.starters.ts), and every other state resets it, so a pool
// persisted by an earlier harness page never reaches a frame; the strip
// states (fixtures.strip.ts) carry their own busy / phase.
//
// W4: the `actions` states seed the sketch's three-exchange thread with their
// own busy / phase (fixtures.actions.ts) and stamp the hot bubble's face after
// mount (a hover cannot be held in a still); `actions` parks the scroller at
// the hot exchange unless the URL says `scroll=top`. The `edit` states seed
// the same thread and enter edit mode after mount through the store's own
// door (fixtures.edit.ts: beginEdit writes the draft and asks for focus), so
// the frame shows the fold the product renders.
//
// W5: the `insight` states (fixtures.rich.ts) are one exchange each over the
// order_v2 thread with their own busy / phase (`insight-stream` streams with
// the run landed on its chip and the second bullet cut mid-sentence), so the
// frame shows the answer slot's blocks as the parser and AnswerText render
// them; a link click in a frame reaches the opener plugin, which tauriShim
// answers with nothing.
//
// W6: the `mention` states seed the discussion thread over the order_v2
// schema, the connection's saved queries and its threads (fixtures.mentions.ts
// and fixtures.mentions-echo.ts share the seed), and every other state resets
// the saved queries the way it resets the starter pools. `mention-popover`
// and `mention-draft` write the composer after mount through the store's own
// doors (setDraft, requestFocus, openMentions), so the frame shows the popover
// and the pills the product renders; `mention-echo` parks the scroller at the
// tagged exchange (the `actions` rest) and `mention-trace` opens the drawer
// at the context step, the anatomy precedent.
//
// W7: the `result` states (fixtures.result.ts) are one exchange each with the
// consolidated result block as the subject, parked at the top; a hover cannot
// be held in a still, so `resultAfterMount` stamps the block hot and, for
// `result-sql`, flips its face through the store's own door (useAsk.setFace).
// `failure-cap` is the turn cap over its four actions. The `answer` states
// (fixtures.answer.ts) are the discussion thread again: `answer-actions`
// reveals the prose cluster and parks itself at the top, `followups-end` keeps
// the bottom pin so the one follow-up row stands under the LAST answer.
// Follow-ups are the THREAD's now (useAgent.followUps): the answer states hand
// theirs over, every other state's row is the one its last exchange recorded
// (fixtures.ts `followUpsFor`), so a state that showed suggestions before W7
// shows them under its last answer alone.
//
// A4: the `a4-` states (fixtures.writes.ts) are one proposed change each,
// parked at the top like the `result` states, since the block and the headline
// standing over it are the subject. `a4-ran` seeds the query tab's own live
// transaction (useConnections.txTabs) so `uncommitted` reads what a live tab
// would say, and every other state clears it; `a4-preview-busy` is the dry
// run in flight, its `preview` chip spinning in the strip.
//
// A2: the `a2` states (fixtures.knowledge.ts) are one exchange each over the
// W6 schema and bookmarks, and the first to seed the TABS store, because the
// `Explain with Ask` exchange stands in a workspace with the tab it names
// open; every other state resets it, the saved-queries precedent.
// `a2-knowledge-trace` opens the drawer at its `knowledge` step (the anatomy
// precedent) and the two answered states park at the question.
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
import { useSaved } from "../stores/saved";
import { useSchema } from "../stores/schema";
import { useSettings } from "../stores/settings";
import { useSidePane } from "../stores/sidePane";
import { useStarterPools } from "../stores/starters";
import { useTabs } from "../stores/tabs";
import {
  FIXTURE,
  HARNESS_STATES,
  HARNESS_WIDTHS,
  choiceFor,
  exchangeFor,
  followUpsFor,
  type HarnessState,
  type HarnessTheme,
} from "./fixtures";
import { ACTIONS_STATES, actionsAfterMount, actionsSeed, type ActionsState } from "./fixtures.actions";
import { ANATOMY_STATES, anatomyTraceFor, type AnatomyState } from "./fixtures.anatomy";
import { ANSWER_STATES, answerAfterMount, answerSeed, type AnswerState } from "./fixtures.answer";
import { ECHO_STATES, echoExchangesFor, type EchoState } from "./fixtures.echo";
import { EDIT_STATES, editAfterMount, editSeed, type EditState } from "./fixtures.edit";
import { MENTION_STATES, mentionsAfterMount, mentionsSeed, type MentionState } from "./fixtures.mentions";
import {
  MENTIONS_ECHO_STATES,
  mentionsEchoAfterMount,
  mentionsEchoSeed,
  mentionsEchoTraceFor,
  type MentionsEchoState,
} from "./fixtures.mentions-echo";
import { INTERACT_STATES, interactSeed, type InteractSeed, type InteractState } from "./fixtures.interact";
import {
  KNOWLEDGE_STATES,
  knowledgeAfterMount,
  knowledgeSeed,
  knowledgeTraceFor,
  type KnowledgeState,
} from "./fixtures.knowledge";
import { RESULT_STATES, resultAfterMount, resultSeed, type ResultState } from "./fixtures.result";
import { RICH_STATES, richSeed, type RichState } from "./fixtures.rich";
import { SHELL_THREADS, shellAfterMount } from "./fixtures.shell";
import { STARTER_STATES, startersSeed, type StarterState } from "./fixtures.starters";
import { STRIP_STATES, stripSeed, type StripState } from "./fixtures.strip";
import { WRITES_STATES, writesAfterMount, writesSeed, type WritesState } from "./fixtures.writes";
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
      scroll === "top" ||
      (scroll !== "bottom" &&
        (state === "strip" ||
          state === "kv-wide" ||
          state.startsWith("insight") ||
          (RESULT_STATES as readonly string[]).includes(state) ||
          (WRITES_STATES as readonly string[]).includes(state)))
        ? "top"
        : "bottom",
  };
}

/** the interaction builder's seed for a state, null for the rest */
function interactFor(state: HarnessState): InteractSeed | null {
  return (INTERACT_STATES as readonly string[]).includes(state) ? interactSeed(state as InteractState) : null;
}

/** every store the pane reads, filled before the first render; a state's
 * exchange is the thread's one exchange (the echo, actions and edit states
 * seed a whole thread), the empty state has no thread. The `threads` state
 * lists the shell builder's five threads, the first of them the fixture
 * thread, so the answered exchange sits behind the sheet */
function seed({ state, w, theme }: Params) {
  const pid = FIXTURE.profile.id;
  const tid = FIXTURE.thread.id;
  const interact = interactFor(state);
  const exchange = interact?.exchange ?? exchangeFor(state);
  const echo = (ECHO_STATES as readonly string[]).includes(state) ? echoExchangesFor(state as EchoState) : null;
  const strip = (STRIP_STATES as readonly string[]).includes(state) ? stripSeed(state as StripState) : null;
  const rich = (RICH_STATES as readonly string[]).includes(state) ? richSeed(state as RichState) : null;
  // the W4 thread: the actions seed carries busy / phase, the edit seed is a
  // landed thread whose mode is entered after mount
  const w4 = (ACTIONS_STATES as readonly string[]).includes(state)
    ? actionsSeed(state as ActionsState)
    : (EDIT_STATES as readonly string[]).includes(state)
      ? { exchanges: editSeed(state as EditState).exchanges, busy: false, phase: null }
      : null;
  // the W6 thread: the composer states and the sent states share one schema
  // and one saved query, so the tags resolve in every frame
  const mention = (MENTION_STATES as readonly string[]).includes(state) ? mentionsSeed(state as MentionState) : null;
  const me = (MENTIONS_ECHO_STATES as readonly string[]).includes(state)
    ? mentionsEchoSeed(state as MentionsEchoState)
    : null;
  const w6 = mention ?? me;
  // the W7 threads: the result states carry their own busy / phase (the
  // actions shape), the answer states carry the thread's follow-up row
  const result = (RESULT_STATES as readonly string[]).includes(state) ? resultSeed(state as ResultState) : null;
  const ans = (ANSWER_STATES as readonly string[]).includes(state) ? answerSeed(state as AnswerState) : null;
  // A4: one proposed change, with its own busy / phase (the result shape); the
  // seed also opens or clears the query tab's transaction `uncommitted` reads
  const writes = (WRITES_STATES as readonly string[]).includes(state) ? writesSeed(state as WritesState) : null;
  // the A2 thread: the W6 schema and bookmarks again, plus the workspace's
  // own tabs, which the `Explain with Ask` exchange was asked from
  const know = (KNOWLEDGE_STATES as readonly string[]).includes(state)
    ? knowledgeSeed(state as KnowledgeState)
    : null;
  // the thread a state shows, oldest first: one seed wins, and the same list
  // is the active thread, the exchanges and what the follow-up row reads
  const list =
    know?.exchanges ??
    w6?.exchanges ??
    w4?.exchanges ??
    result?.exchanges ??
    ans?.exchanges ??
    writes?.exchanges ??
    echo ??
    (exchange ? [exchange] : null);
  // the seed that carries this state's own busy and phase (a state matches at
  // most one of them); `busy` is the one state that runs without a seed
  const live = w4 ?? result ?? writes ?? interact ?? strip ?? rich;
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
    snapshots: { [pid]: know?.snapshot ?? w6?.snapshot ?? FIXTURE.snapshot },
    source: { [pid]: "server" },
    loading: {},
    errors: {},
  });

  useAgent.setState({
    activeProfileId: pid,
    threads: { [pid]: mention ? mention.threads : state === "threads" ? SHELL_THREADS : [FIXTURE.thread] },
    activeThread: { [pid]: list ? tid : null },
    exchanges: list ? { [tid]: list } : {},
    sessions: {},
    pending: interact?.pending ?? {},
    // the row is the THREAD's now (W7 item 3): the answer states hand theirs
    // over, every other state's is the one its last exchange recorded
    followUps: list ? { [tid]: ans ? ans.followUps : followUpsFor(list) } : {},
    phase: { [tid]: live ? live.phase : state === "busy" ? "tools" : null },
    busy: { [tid]: live ? live.busy : state === "busy" },
  });
  useStarterPools.setState(
    (STARTER_STATES as readonly string[]).includes(state)
      ? startersSeed(state as StarterState)
      : { pools: {}, cursors: {} },
  );

  // every other state resets the bookmarks (the starter pools precedent), so
  // one persisted by an earlier page never reaches a frame
  useSaved.setState({ queries: know?.saved ?? w6?.saved ?? [] });

  // the workspace behind the pane: only the A2 states have one, and every
  // other state clears it, so a tab persisted by an earlier page never
  // reaches a frame (the bookmarks' own rule, above)
  useTabs.setState({ tabs: know?.tabs ?? [], activeId: know?.activeTabId ?? null });

  useSidePane.setState({ mode: "ask", open: true, width: w });
  useAsk.setState({
    open: true,
    traceOpenFor: null,
    threadsOpen: false,
    pickerOpen: false,
    mentionQuery: null,
    drafts: {},
    draftFor: null,
    edit: null,
  });
}

function Harness({ state, w, scroll }: Params) {
  // the pane's own mount effects run first (child before parent): they close
  // the picker, the trace and the Threads sheet for a fresh connection and
  // pin the scroller to the bottom; so the transient chrome a state shows is
  // opened HERE, never seeded (a seeded target would be wiped). The sheet's
  // keyboard step, the W4 hooks (the hot face, edit mode, the `actions`
  // rest) and the strip's scroll position wait one frame for those opens to
  // commit (the sheet's key handler reads `open` from its last render);
  // `scroll=top` re-parks the scroller after them, instantly, so it wins
  // over the `actions` rest; and the ready mark follows them all so a frame
  // never lands between
  useEffect(() => {
    if (state === "picker") useAsk.getState().setPickerOpen(true);
    if (state === "threads") useAsk.getState().openThreads();
    const t = (ANATOMY_STATES as readonly string[]).includes(state)
      ? anatomyTraceFor(state as AnatomyState)
      : (MENTIONS_ECHO_STATES as readonly string[]).includes(state)
        ? mentionsEchoTraceFor(state as MentionsEchoState)
        : (KNOWLEDGE_STATES as readonly string[]).includes(state)
          ? knowledgeTraceFor(state as KnowledgeState)
          : null;
    if (t) useAsk.getState().openTrace(t.exchangeId, t.stepId);
    const interact = interactFor(state);
    const id = requestAnimationFrame(() => {
      // the follow-up row lands one commit after the pane's own mount pin
      // (AskPanel holds the thread's questions a render so a picked chip can
      // pair with the echo it becomes), and growth after that pin belongs to
      // the user, never to the pane. A still of a SETTLED thread has to show
      // its end, so the harness re-pins here; the states that park elsewhere
      // (the `actions` rest, `mention-echo`, `scroll=top`) run after this and
      // win
      if (scroll === "bottom") {
        const sc = document.querySelector<HTMLElement>(".ask-scroll");
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
      shellAfterMount(state);
      actionsAfterMount(state);
      answerAfterMount(state);
      resultAfterMount(state);
      writesAfterMount(state);
      editAfterMount(state);
      mentionsAfterMount(state);
      mentionsEchoAfterMount(state);
      knowledgeAfterMount(state);
      if (scroll === "top") {
        const el = document.querySelector<HTMLElement>(".ask-scroll");
        if (el) el.scrollTop = 0;
      }
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
