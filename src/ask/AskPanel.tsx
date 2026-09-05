// The Ask pane's content (AGENT-UX section 1): a header that says where you
// are (Ask · Threads · New Thread, DESIGN rule 12), the thread scroller of
// answer blocks, the two-row composer (textarea, then model pill · send) and
// the trace drawer sliding over the thread. The shell owns the pane (width,
// mode, ⌘J, focus restore); this component owns everything inside it.
//
// Keyboard contract (W2 plan, "focus and keyboard"):
//   ↩ sends, ⇧↩ newline; the composer stops only unmodified typing keys
//   (LESSONS 10), every ⌘ chord bubbles to the window handler.
//   Esc: close trace → close picker → blur the composer; never the pane.
//   ⌘. while a turn streams cancels it when focus is inside the pane; the
//   menu accelerator path routes here from App.tsx by the same focus test.
// The chords are not written on the chrome (DESIGN rule 11): the send
// button's tooltip carries them, through the one glyph renderer.
// Focus is state-owned (LESSONS 7): useAsk.focusSeq, consumed with rAF so an
// overlay's escStack restore lands first and loses.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowUp, History, Plus, Square } from "lucide-react";
import { chordGlyphs } from "../design/Kbd";
import { ContextMenu, type MenuNode } from "../app/overlay/ContextMenu";
import type { Profile } from "../ipc/types";
import { modelChoice, useAgent, type Exchange } from "../stores/agent";
import { useAsk } from "../stores/ask";
import { useSchema } from "../stores/schema";
import { useSettings } from "../stores/settings";
import { AnswerBlock } from "./AnswerBlock";
import { FollowUps } from "./FollowUps";
import { ModelPicker } from "./ModelPicker";
import { SetupCard } from "./SetupCard";
import { TraceDrawer } from "./TraceDrawer";
import { starterQuestions } from "./starters";
import "./ask.css";

const NO_EXCHANGES: Exchange[] = [];
const COMPOSER_MAX_H = 96;

/** a chord as tooltip text: the same canon <Kbd> renders, joined bare */
const chord = (spec: string) => chordGlyphs(spec).join("");
const SEND_TIP = `Ask ${chord("return")}`;
const STOP_TIP = `Stop ${chord("cmd+period")}`;

export function AskPanel({ profile, connected }: { profile: Profile; connected: boolean }) {
  const profileId = profile.id;
  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // the shell pushes the connection whose threads are on screen (LESSONS 4:
  // provenance is structural; the store never guesses from navigation)
  const setActiveProfile = useAgent((s) => s.setActiveProfile);
  const loadThreads = useAgent((s) => s.loadThreads);
  useEffect(() => {
    setActiveProfile(profileId);
    void loadThreads(profileId);
  }, [profileId, setActiveProfile, loadThreads]);

  const threadId = useAgent((s) => s.activeThread[profileId] ?? null);
  const exchanges = useAgent((s) => (threadId ? s.exchanges[threadId] : undefined)) ?? NO_EXCHANGES;
  const busy = useAgent((s) => (threadId ? !!s.busy[threadId] : false));
  const phase = useAgent((s) => (threadId ? s.phase[threadId] ?? null : null));
  const threads = useAgent((s) => s.threads[profileId]);
  const snapshot = useSchema((s) => s.snapshots[profileId]);

  // the resolved provider/model, re-read whenever its inputs change
  const agentProvider = useSettings((s) => s.agentProvider);
  const agentModel = useSettings((s) => s.agentModel);
  const perConn = useSettings((s) => s.agentByConn[profileId]);
  const choice = useMemo(
    () => modelChoice(profileId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileId, agentProvider, agentModel, perConn],
  );

  const draft = useAsk((s) => s.drafts[profileId] ?? "");
  const setDraft = useAsk((s) => s.setDraft);
  const focusSeq = useAsk((s) => s.focusSeq);
  const traceOpenFor = useAsk((s) => s.traceOpenFor);
  const pickerOpen = useAsk((s) => s.pickerOpen);

  // a trace target from another thread (or a deleted exchange) closes itself
  const traceExchange = traceOpenFor
    ? exchanges.find((e) => e.id === traceOpenFor.exchangeId) ?? null
    : null;
  useEffect(() => {
    if (traceOpenFor && !traceExchange) useAsk.getState().closeTrace();
  }, [traceOpenFor, traceExchange]);
  // switching connections switches threads: transient chrome goes with it,
  // and the composer shows this connection's own unsent text (LESSONS 4)
  useEffect(() => {
    const a = useAsk.getState();
    a.closeTrace();
    a.setPickerOpen(false);
    a.setDraftFor(profileId);
    return () => useAsk.getState().setDraftFor(null);
  }, [profileId]);

  // focus requests (⌘J, palette, Ask Differently) land on the composer one
  // frame later, after any overlay's focus-restore microtask
  useEffect(() => {
    if (!focusSeq) return;
    const id = requestAnimationFrame(() => taRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [focusSeq]);

  // the composer grows with its text up to four lines, then scrolls inside
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_H)}px`;
  }, [draft]);

  // a new question echo pins the scroller to the bottom, instantly (never
  // animate scroll); streaming growth after that belongs to the user
  const exchangeCount = exchanges.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchangeCount, threadId]);

  const asked = useMemo(() => new Set(exchanges.map((e) => e.question)), [exchanges]);
  const starters = useMemo(() => starterQuestions(snapshot, asked), [snapshot, asked]);

  const canSend = connected && !busy && draft.trim() !== "";
  const send = useCallback(() => {
    const q = (useAsk.getState().drafts[profileId] ?? "").trim();
    if (!q || !connected) return;
    if (useAgent.getState().activeProfileId !== profileId) return;
    useAsk.getState().setDraft("");
    void useAgent.getState().ask(q);
  }, [connected, profileId]);

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") return; // the root handler owns the Esc ladder
    if (e.metaKey || e.ctrlKey || e.altKey) return; // chords belong to the window
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) send();
      return;
    }
    e.stopPropagation(); // unmodified typing keys are the composer's own
  };

  const onRootKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      const a = useAsk.getState();
      if (a.traceOpenFor) a.closeTrace();
      else if (a.pickerOpen) a.setPickerOpen(false);
      else if (document.activeElement === taRef.current)
        rootRef.current?.focus({ preventScroll: true });
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "." && busy) {
      e.preventDefault();
      useAgent.getState().cancel();
    }
  };

  const [threadsMenu, setThreadsMenu] = useState<{ x: number; y: number } | null>(null);
  const openThreadsMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setThreadsMenu({ x: r.left, y: r.bottom + 4 });
  };
  const threadItems = (): MenuNode[] => {
    const list = threads ?? [];
    const items: MenuNode[] = list.map((t) => ({
      kind: "item",
      label: t.title,
      hint: t.id === threadId ? "current" : undefined,
      onSelect: () => void useAgent.getState().openThread(profileId, t.id),
    }));
    items.push({ kind: "sep" });
    items.push({
      kind: "item",
      label: "Delete Current Thread…",
      danger: true,
      disabled: !threadId,
      onSelect: () => {
        const tid = threadId;
        if (!tid) return;
        void import("../stores/danger").then(async ({ confirmDanger }) => {
          const ok = await confirmDanger(
            "Delete This Thread?",
            "Its questions and answers leave the history on this Mac.",
            "Delete Thread",
          );
          if (ok) void useAgent.getState().deleteThread(profileId, tid);
        });
      },
    });
    return items;
  };

  const openSettings = () => useSettings.getState().setSettingsOpen(true, "models");

  return (
    <div
      ref={rootRef}
      className="ask-panel"
      tabIndex={-1}
      onKeyDown={onRootKey}
      // click-to-focus so Esc and ⌘. scope here: WKWebView never focuses
      // ancestors on click. Inputs and the grid keep their own focus.
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('input,textarea,select,[contenteditable="true"],.vgrid')) return;
        rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <header className="ask-head">
        <span className="ask-title">Ask</span>
        <button
          className="iconbtn"
          title="Threads"
          disabled={!threads || threads.length === 0}
          onClick={openThreadsMenu}
        >
          <History size={14} />
        </button>
        <button
          className="iconbtn"
          title="New Thread"
          disabled={!threadId}
          onClick={() => useAgent.getState().newThread(profileId)}
        >
          <Plus size={14} />
        </button>
      </header>

      {choice === null ? (
        <SetupCard
          profileId={profileId}
          onConfigured={() => useAsk.getState().requestFocus()}
          onManage={openSettings}
        />
      ) : exchanges.length === 0 ? (
        <div className="ask-starters">
          <FollowUps
            questions={starters}
            asked={asked}
            disabled={!connected}
            onPick={(q) => void useAgent.getState().ask(q)}
          />
        </div>
      ) : (
        <div className="ask-scroll" ref={scrollRef}>
          {exchanges.map((ex, i) => (
            <AnswerBlock
              key={ex.id}
              exchange={ex}
              profile={profile}
              threadId={threadId ?? ""}
              isLatest={i === exchanges.length - 1}
              busy={busy}
              phase={phase}
              asked={asked}
            />
          ))}
        </div>
      )}

      {choice !== null && (
        <div className="ask-input">
          <div className="ask-box">
            <textarea
              ref={taRef}
              className="ask-ta"
              rows={1}
              placeholder={connected ? `Ask about ${profile.dbname}…` : "Connect to ask"}
              aria-label="Ask"
              disabled={!connected}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
            />
            <div className="ask-ctl">
              <ModelPicker
                profileId={profileId}
                choice={choice}
                open={pickerOpen}
                disabled={!connected}
                onOpenChange={(o) => useAsk.getState().setPickerOpen(o)}
                onManage={openSettings}
              />
              <span className="ask-grow" />
              <button
                className={`iconbtn iconbtn-lg ask-send${busy ? " stop" : ""}`}
                title={busy ? STOP_TIP : SEND_TIP}
                aria-label={busy ? "Stop" : "Ask"}
                disabled={!busy && !canSend}
                onClick={() => (busy ? useAgent.getState().cancel() : send())}
              >
                {busy ? <Square size={12} fill="currentColor" /> : <ArrowUp size={14} />}
              </button>
            </div>
          </div>
        </div>
      )}

      <TraceDrawer
        open={traceExchange !== null}
        exchange={traceExchange}
        focusStepId={traceOpenFor?.stepId ?? null}
        onClose={() => useAsk.getState().closeTrace()}
      />

      {threadsMenu && (
        <ContextMenu point={threadsMenu} items={threadItems()} onClose={() => setThreadsMenu(null)} />
      )}
    </div>
  );
}
