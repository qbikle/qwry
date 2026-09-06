// The Ask pane's content (AGENT-UX section 1): a header that says where you
// are (Ask · Threads · New Thread, DESIGN rule 12), the thread scroller of
// answer blocks, the two-row composer (textarea, then model pill · send) and
// the two slide-overs, the trace drawer and the Threads sheet, over the
// thread. The shell owns the pane (width, mode, ⌘J, focus restore); this
// component owns everything inside it.
//
// Keyboard contract (W2 plan, "focus and keyboard"):
//   ↩ sends, ⇧↩ newline; the composer stops only unmodified typing keys
//   (LESSONS 10), every ⌘ chord bubbles to the window handler.
//   Esc: close the Threads sheet → close trace → close picker → leave edit
//   mode (the words go home) → discard the pending assumption set while the
//   retry pill shows over an empty composer → blur the composer; never the
//   pane.
//   ⌘. while a turn streams cancels it when focus is inside the pane; the
//   menu accelerator path routes here from App.tsx by the same focus test.
// The chords are not written on the chrome (DESIGN rule 11): the send
// button's tooltip carries them, through the one glyph renderer.
// Focus is state-owned (LESSONS 7): useAsk.focusSeq, consumed with rAF so an
// overlay's escStack restore lands first and loses.
//
// Sending (round 3, ask 1): the draft's text LIFTS out of the composer into
// the new question bubble. ↩ renders a ghost of the text over the textarea
// (.ask-ghost: same glyphs, same place, the bubble's padding and ring around
// them) for one frame, then asks; the ghost carries a layout id of its own
// and the echo the store appends takes the same id, so motion's shared
// layout resumes the echo from the ghost's box (springs.layout, position
// only) while the bubble's fill fades in behind the words (ask.css). The
// draft clears in the very tick the exchange lands (a store subscription),
// so the composer's reflow and the echo's mount are one commit and the echo
// is measured where it will stay; until then the textarea keeps its text
// unpainted under the ghost. A chip pick never renders a ghost (the chip is
// the thing that travels, section 6); reduced motion renders none either.
// The thread scroller is a motion element with `layoutScroll`, so the pin
// that follows a landing is subtracted before any layoutId descendant is
// measured: the older exchanges' chips hold still and only the travelling
// node moves (the scroller's own comment, below).
//
// Edit mode (W4): a click on a bubble, or Jump Back, puts that question in
// the composer (useAsk.edit; AnswerBlock renders the fold: the edited
// exchange leaves, the later ones stand as dimmed bubbles). This component
// owns the mode's travel and its exits. The travel is the lift run backwards:
// the composer mounts an edit ghost (.ask-ghost[data-edit]) under the bubble's
// edit id in the commit the bubble unmounts, so the words spring from the
// bubble's box to the textarea's text origin while the fill fades out behind
// them; the textarea holds the same text unpainted until the spring settles.
// Esc, or the draft emptied, sends the words home: one frame with the ghost
// over the composer as the box the bubble will spring from, then the mode
// ends and the draft clears in one commit as the exchange remounts. ↩ from
// the mode is the lift with `from`: the store cuts the thread at the edited
// exchange and asks in its place (askFrom), with no confirm, because the fold
// was the preview. The mode ends on its own when its exchange leaves the
// thread on screen (a cut, a thread switch; the connection switch is the
// store's), the draft left where it is (LESSONS 4). Reduced motion renders no
// ghost either way: the textarea holds the text and the stack stands.
//
// @ context tags (W6): the textarea stays plain text and the truth. On every
// change and caret move it is read for the `@` token under the caret
// (mentionRows.ts mentionQueryAt) into useAsk.mentionQuery, and while that is
// set the MentionPopover hangs over the composer box; a pick splices the
// canonical token plus one space over the whole token and parks the caret
// after the space. The popover is the composer's completion and never an
// overlay (its header): onComposerKey offers it every key first and it takes
// only ↑↓ ↩ ⇥ and Esc while it is up, so the pane's Esc ladder gets the next
// Esc and ⌘ chords reach the window; a blur, a press outside it, Esc or the
// caret leaving the token closes it, and a query dismissed by Esc or a press
// stays dismissed until the caret's `@` or its fragment changes. The
// draft's chips are a backdrop (.ask-ta-back) behind the textarea: the same
// glyphs in the same font, lines and width with their colour transparent, its
// scrollTop mirrored, painting one .mention pill (Mention.tsx, the echo's own
// class) behind each mention that resolves against the connection's snapshot,
// visible saved queries and threads, and nothing behind one that does not.
// Both ghosts render the same segments, so the pills travel with the words.
// The wrap and the backdrop carry the same 2px side padding (ask.css, W7), so
// the pill's outdent has room at position 0 of the draft and the two glyph
// runs still start on the same pixel.
//
// Follow-ups (W7 item 3): the suggestions belong to the THREAD, not to each
// answer, and stand once, in the block at its end (useAgent.followUps, handed
// to that one AnswerBlock). This component owns when they go: the store empties
// them when a run starts, but a send is a frame earlier than that on the lift
// path, and a row of stale suggestions must not be what the new bubble lands
// beside.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, History, Plus, Square } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { mentionsIn, type Mention, type MentionCtx } from "../agent/mentions";
import type { Thread } from "../agent/types";
import { chordGlyphs } from "../design/Kbd";
import { prefersReducedMotion, spring, swapIn } from "../design/springs";
import type { Profile } from "../ipc/types";
import { modelChoice, pendingTarget, retryLabel, useAgent, type Exchange } from "../stores/agent";
import { useAsk, type MentionQuery } from "../stores/ask";
import { useSaved, visibleSaved } from "../stores/saved";
import { useSchema, type SchemaSnapshot } from "../stores/schema";
import { useSettings } from "../stores/settings";
import { AnswerBlock } from "./AnswerBlock";
import { editLiftId } from "./EchoActions";
import { FollowUps } from "./FollowUps";
import { MentionText } from "./Mention";
import { MentionPopover, type MentionPopoverHandle } from "./MentionPopover";
import { mentionQueryAt, mentionTokenEnd } from "./mentionRows";
import { ModelPicker } from "./ModelPicker";
import { RetryPill } from "./RetryPill";
import { SetupCard } from "./SetupCard";
import { ThreadsSheet } from "./ThreadsSheet";
import { TraceDrawer } from "./TraceDrawer";
import { useStarters } from "./useStarters";
import "./ask.css";

const NO_EXCHANGES: Exchange[] = [];
const NO_THREADS: Thread[] = [];
const NO_QUESTIONS: string[] = [];
const NO_MENTIONS: Mention[] = [];
const COMPOSER_MAX_H = 96;

/** a question on its way from the composer into the thread */
interface Lift {
  /** the layout id the ghost and the echo share; a nonce, never the
   * question, so an older echo of the same text in the thread never pairs.
   * Handed to exactly one echo: the exchange that lands (below), never one
   * matched by text */
  id: string;
  /** the connection the question was typed toward (LESSONS 3, 4) */
  profileId: string;
  question: string;
  /** the textarea's text as typed, so the ghost overlays it glyph for glyph */
  raw: string;
  /** the tags that resolved in `raw` at send: the ghost wears their pills */
  mentions: Mention[];
  /** the textarea's scroll at send: past four lines it shows its tail */
  scrollTop: number;
  /** exchanges in the thread at send; one more and the question has landed */
  count: number;
  /** sent from edit mode: the exchange the thread is cut at (askFrom), whose
   * index is `count`; `arrived` reads the landing against it */
  from?: string;
}

/** the lifted question is in the thread: one more exchange than at send and,
 * from edit mode, a different exchange at the cut. Before the cut the thread
 * is longer than `count` but still holds the edited exchange there; after it
 * the thread is exactly `count` long until the new one lands. Neither is a
 * landing, and reading either as one drops the ghost before the words move */
const arrived = (l: Lift, list: readonly Exchange[]) =>
  list.length > l.count && (l.from === undefined || list[l.count]?.id !== l.from);

/** the composer side of the edit travel: `in` while the words arrive from
 * the bubble, `out` for the one frame before they leave for it */
interface EditTravel {
  exchangeId: string;
  dir: "in" | "out";
}

/** the send net's timer, past spring.layout's settle: onLayoutAnimationComplete
 * fires only when a layout animation ran, and a bubble that entered the mode
 * without its arming frame would otherwise leave the words unpainted */
const EDIT_TRAVEL_NET_MS = 600;

/** the empty state (section 1): three starters docked above the composer and
 * nothing else. Its own component so useStarters mounts with the empty state
 * (each show advances the connection's cursor by three) and unmounts with it.
 * The row re-keys when the three change (a generated pool landing mid-view, a
 * deleted thread freeing a title) and the two triples CROSSFADE: popLayout
 * parks the leaving row where it stood (absolute, inside .ask-starters) while
 * the arriving row takes its place in the flow, both on the app's one
 * content-swap preset (swapIn: the breadcrumb's and the results' crossfade,
 * DESIGN rule 6). A picked chip never crosses: the whole empty state unmounts
 * with the first exchange, so the chip's shared-layout travel into the echo
 * (section 6) is untouched. Reduced motion is the instant swap */
function Starters({
  profileId,
  snapshot,
  asked,
  connected,
}: {
  profileId: string;
  snapshot: SchemaSnapshot | undefined;
  asked: ReadonlySet<string>;
  connected: boolean;
}) {
  const { questions, key } = useStarters(profileId, snapshot, asked);
  return (
    <div className="ask-starters">
      <AnimatePresence mode="popLayout">
        <motion.div
          key={key}
          className="ask-starters-row"
          initial={swapIn.initial}
          animate={swapIn.animate}
          exit={{ opacity: 0 }}
          transition={swapIn.transition}
        >
          <FollowUps
            questions={questions}
            asked={asked}
            disabled={!connected}
            onPick={(q) => void useAgent.getState().ask(q)}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** a chord as tooltip text: the same canon <Kbd> renders, joined bare */
const chord = (spec: string) => chordGlyphs(spec).join("");
const SEND_TIP = `Ask ${chord("return")}`;
const STOP_TIP = `Stop ${chord("cmd+period")}`;

export function AskPanel({ profile, connected }: { profile: Profile; connected: boolean }) {
  const profileId = profile.id;
  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const mentionPop = useRef<MentionPopoverHandle>(null);

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
  const threadsOpen = useAsk((s) => s.threadsOpen);
  const mentionQuery = useAsk((s) => s.mentionQuery);

  // the draft's tags (file header): what they resolve against is what the
  // store's ask() will resolve against, captured here per render so the
  // pills and the context agree; the ctx ref serves the send, whose callback
  // must not re-bind on every keystroke
  const savedAll = useSaved((s) => s.queries);
  const saved = useMemo(() => visibleSaved(savedAll, profileId), [savedAll, profileId]);
  const blocks = useAsk((s) => s.blocks);
  const mentionCtx = useMemo<MentionCtx>(
    () => ({
      snapshot,
      saved,
      threads: threads ?? NO_THREADS,
      currentThreadId: threadId,
      blocks: Object.values(blocks),
    }),
    [snapshot, saved, threads, blocks, threadId],
  );
  const mentionCtxRef = useRef(mentionCtx);
  mentionCtxRef.current = mentionCtx;
  const mentions = useMemo(() => (draft ? mentionsIn(draft, mentionCtx) : NO_MENTIONS), [draft, mentionCtx]);

  // the `@` under the caret: read from the textarea itself, never derived
  // from the draft alone (a selection is not a caret, and the caret moves
  // without the text changing). A query Esc dismissed is remembered until
  // the caret's `@` or the fragment differs, else the very next keyup would
  // reopen what Esc just closed
  const dismissed = useRef<MentionQuery | null>(null);
  const syncMentions = useCallback(() => {
    const ta = taRef.current;
    const a = useAsk.getState();
    const q =
      ta && document.activeElement === ta && ta.selectionStart === ta.selectionEnd
        ? mentionQueryAt(ta.value, ta.selectionStart)
        : null;
    if (q === null) {
      dismissed.current = null;
      a.closeMentions();
      return;
    }
    const d = dismissed.current;
    if (d !== null && d.at === q.at && d.filter === q.filter) return;
    dismissed.current = null;
    a.openMentions(q.at, q.filter);
  }, []);
  const dismissMentions = useCallback(() => {
    const a = useAsk.getState();
    dismissed.current = a.mentionQuery;
    a.closeMentions();
  }, []);

  // a pick: the canonical token and one space over the whole token the caret
  // sits in; the caret lands after the space once the textarea holds the new
  // text (the layout effect below), so the next keyup reads no token
  const pendingCaret = useRef<number | null>(null);
  const pickMention = useCallback(
    (token: string) => {
      const a = useAsk.getState();
      const q = a.mentionQuery;
      const ta = taRef.current;
      if (q === null || !ta || a.draftFor !== profileId) return;
      const text = ta.value;
      const end = mentionTokenEnd(text, q.at, Math.max(ta.selectionStart, q.at + 1));
      pendingCaret.current = q.at + token.length + 1;
      dismissed.current = null;
      a.setDraft(`${text.slice(0, q.at)}${token} ${text.slice(end)}`);
      a.closeMentions();
    },
    [profileId],
  );
  useLayoutEffect(() => {
    const p = pendingCaret.current;
    if (p === null) return;
    pendingCaret.current = null;
    taRef.current?.setSelectionRange(p, p);
  }, [draft]);

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
    a.closeThreads();
    a.setPickerOpen(false);
    a.setDraftFor(profileId);
    return () => useAsk.getState().setDraftFor(null);
  }, [profileId]);

  // edit mode (file header): on while the edited exchange is in the thread on
  // screen. A cut, a thread switch or New Thread takes it out and the mode
  // ends with it, the draft staying where it was typed (LESSONS 4); the
  // connection switch ends it in the store (setDraftFor)
  const edit = useAsk((s) => s.edit);
  const editAt =
    edit !== null && edit.threadId === threadId ? exchanges.findIndex((e) => e.id === edit.exchangeId) : -1;
  const editing = editAt !== -1;
  useEffect(() => {
    if (edit !== null && edit.profileId === profileId && !editing) useAsk.getState().endEdit();
  }, [edit, profileId, editing]);

  // the travel's composer side, derived in render and not in an effect: the
  // ghost must mount in the very commit the bubble unmounts (motion pairs the
  // two through the snapshot it takes of a layoutId node as it leaves) and
  // leave in the commit the bubble returns
  const [travel, setTravel] = useState<EditTravel | null>(null);
  const editKey = editing && edit ? edit.exchangeId : null;
  const [seenEdit, setSeenEdit] = useState<string | null>(null);
  if (editKey !== seenEdit) {
    setSeenEdit(editKey);
    setTravel(editKey !== null && !prefersReducedMotion() ? { exchangeId: editKey, dir: "in" } : null);
  }
  const settleTravel = useCallback(() => setTravel((t) => (t?.dir === "in" ? null : t)), []);
  useEffect(() => {
    if (travel?.dir !== "in") return;
    const t = setTimeout(settleTravel, EDIT_TRAVEL_NET_MS);
    return () => clearTimeout(t);
  }, [travel, settleTravel]);

  // Esc, or the draft emptied: the words go home. The ghost stands over the
  // composer for one frame as the box motion will pair from, then the mode
  // ends and the draft clears in one commit, so the exchange remounts (its
  // bubble under the edit id) as the ghost leaves and the fold unfolds
  const cancelEdit = useCallback(() => {
    const e = useAsk.getState().edit;
    if (!e) return;
    const finish = () => {
      const a = useAsk.getState();
      if (a.edit?.exchangeId !== e.exchangeId) return;
      if (a.draftFor === e.profileId) a.setDraft("");
      a.endEdit();
    };
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    setTravel({ exchangeId: e.exchangeId, dir: "out" });
    requestAnimationFrame(finish);
  }, []);

  // focus requests (⌘J, palette, Ask Differently) land on the composer one
  // frame later, after any overlay's focus-restore microtask. A question
  // brought back for editing takes the caret after its last word
  useEffect(() => {
    if (!focusSeq) return;
    const id = requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const arriving = document.activeElement !== ta;
      ta.focus({ preventScroll: true });
      if (arriving && useAsk.getState().edit) ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    return () => cancelAnimationFrame(id);
  }, [focusSeq]);

  // the composer grows with its text up to four lines, then scrolls inside.
  // A thread read to its end stays read to its end: the composer's growth
  // shrinks the scroller from below, which would hide the last footer behind
  // it (a three-line question brought back for editing at 320 took 40px of
  // thread with it), so a scroller at its end is re-pinned, instantly; one
  // the user has scrolled up is left where it is
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const sc = scrollRef.current;
    const atEnd = sc !== null && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_H)}px`;
    if (sc && atEnd) sc.scrollTop = sc.scrollHeight;
    // the backdrop follows the textarea's own scroll (a paste past four lines)
    if (backRef.current) backRef.current.scrollTop = ta.scrollTop;
  }, [draft]);
  const mirrorScroll = useCallback(() => {
    if (backRef.current && taRef.current) backRef.current.scrollTop = taRef.current.scrollTop;
  }, []);

  // a new question echo pins the scroller to the bottom, instantly (never
  // animate scroll); streaming growth after that belongs to the user
  const exchangeCount = exchanges.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchangeCount, threadId]);

  // the questions asked, read shallowly so a streamed delta (a new array, the
  // same questions) leaves the Set's identity alone and the settled blocks
  // skip their render (AnswerBlock's memo)
  const questions = useAgent(
    useShallow((s) => (threadId ? s.exchanges[threadId] ?? NO_EXCHANGES : NO_EXCHANGES).map((e) => e.question)),
  );
  const asked = useMemo<ReadonlySet<string>>(() => new Set(questions), [questions]);

  // the lift (file header): `lift` is the ghost's data from ↩ until the
  // exchange lands, and the id the newest echo takes in the render that
  // mounts it. `landed` is that render: the id goes to the exchange at the
  // end of the thread and nowhere else. Never matched by question text: the
  // user may retype the thread's latest question word for word, and that
  // older echo, still the latest until the new one lands, must not wear the
  // ghost's id beside the ghost (one node per shared id, DESIGN rule 6).
  // `sending` refuses a second ↩ while one is on its way, so a new thread is
  // never created twice
  const [lift, setLift] = useState<Lift | null>(null);
  const sending = useRef(false);
  // a send from edit mode cuts the thread before it asks (askFrom): while the
  // cut is out, a thread emptied by it keeps its scroller, so the starters
  // never flash between the cut and the landing
  const [cutFrom, setCutFrom] = useState<string | null>(null);
  const landed = lift !== null && arrived(lift, exchanges);
  useEffect(() => {
    if (!landed) return;
    sending.current = false;
    setLift(null);
    setCutFrom(null);
  }, [landed]);
  useEffect(() => {
    if (!lift) return;
    // the pane switched connections under a question on its way: it stays
    // in its own composer, unsent (LESSONS 4)
    if (lift.profileId !== profileId) {
      sending.current = false;
      setLift(null);
      setCutFrom(null);
      return;
    }
    // one frame with the ghost in the DOM: motion snapshots a layout node as
    // it unmounts, and the echo that mounts in that same commit resumes from
    // the snapshot. The draft clears inside the store notification that
    // appends the exchange (same tick, one React commit): the textarea's
    // shrink and the scroller's pin land before motion measures the echo.
    // Anything typed after ↩ (a new thread's row takes a moment) stays
    const id = requestAnimationFrame(() => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        unsub();
      };
      const unsub = useAgent.subscribe((s) => {
        const tid = s.activeThread[profileId];
        if (!arrived(lift, tid ? s.exchanges[tid] ?? [] : [])) return;
        settle();
        const a = useAsk.getState();
        if (a.draftFor !== profileId) return;
        const typed = a.drafts[profileId] ?? "";
        a.setDraft(typed.startsWith(lift.raw) ? typed.slice(lift.raw.length) : "");
      });
      // ask() resolves without appending when it refuses (the thread went
      // busy, the connection changed) and rejects when the thread cannot be
      // created: either way the ghost leaves and the draft stays, unsent.
      // From edit mode the same send goes through askFrom (the cut, then
      // the ask), so the new exchange lands where the edited one stood
      const agent = useAgent.getState();
      (lift.from ? agent.askFrom(lift.from, lift.question) : agent.ask(lift.question))
        .catch(() => {})
        .finally(() => {
          if (done) return;
          settle();
          sending.current = false;
          setLift(null);
          setCutFrom(null);
        });
    });
    return () => cancelAnimationFrame(id);
  }, [lift, profileId]);

  // the follow-up row (file header): the thread's questions, in the block at
  // its end. It renders one commit behind both the store's list and the send,
  // and that lag is the point: a chip picked out of the row has to unmount in
  // the very commit the echo it becomes mounts (one node per shared layout id,
  // DESIGN rule 6), and by that render `asked` has already taken the picked
  // question out of the row, so what fades is the two nobody chose. The list
  // carries the thread it came from, so a thread switch never shows the other
  // thread's questions for a frame (LESSONS 4)
  const threadFollowUps = useAgent((s) => (threadId ? s.followUps[threadId] : undefined)) ?? NO_QUESTIONS;
  const asking = busy || lift !== null || editing;
  const nextFollowUps = asking ? NO_QUESTIONS : threadFollowUps;
  const [fupRow, setFupRow] = useState<{ threadId: string | null; questions: string[] }>({
    threadId,
    questions: NO_QUESTIONS,
  });
  useEffect(() => {
    setFupRow({ threadId, questions: nextFollowUps });
  }, [threadId, nextFollowUps]);
  const followUps = fupRow.threadId === threadId ? fupRow.questions : NO_QUESTIONS;

  // the retry pill targets the newest exchange with a pending assumption
  // set; it hides while the thread is busy (the Stop face is the one control
  // then) and comes back when a cancelled retry restores the prior answer
  const pending = useAgent((s) => s.pending);
  const pillFor = useMemo(() => pendingTarget(exchanges, pending), [exchanges, pending]);
  // in edit mode the pill hides with the anatomy: a set on a folded exchange
  // has nothing on screen to retry
  const pillLabel =
    pillFor !== null && !busy && connected && !editing ? retryLabel(pending[pillFor] ?? {}) : null;
  const applyPill = useCallback(() => {
    if (pillFor === null) return;
    void useAgent.getState().applyPending(pillFor);
    // the pill leaves with the run; the composer takes focus so ⌘. still
    // reaches the pane and the next question has somewhere to go
    useAsk.getState().requestFocus();
  }, [pillFor]);

  const canSend = connected && !busy && draft.trim() !== "";
  const send = useCallback(() => {
    if (sending.current) return;
    const raw = useAsk.getState().drafts[profileId] ?? "";
    const q = raw.trim();
    if (!q || !connected) return;
    const agent = useAgent.getState();
    if (agent.activeProfileId !== profileId) return;
    const tid = agent.activeThread[profileId];
    if (tid && agent.busy[tid]) return;
    const list = tid ? agent.exchanges[tid] ?? [] : [];
    // from edit mode the send replaces the thread from the edited exchange;
    // the fold was the preview, so nothing asks again here
    const e = useAsk.getState().edit;
    const at = e && e.threadId === tid ? list.findIndex((x) => x.id === e.exchangeId) : -1;
    const from = e && at !== -1 ? e.exchangeId : undefined;
    if (from) setCutFrom(from);
    // reduced motion: nothing travels, the bubble simply appears
    if (prefersReducedMotion()) {
      useAsk.getState().setDraft("");
      if (from) void agent.askFrom(from, q).finally(() => setCutFrom(null));
      else void agent.ask(q);
      return;
    }
    sending.current = true;
    setLift({
      id: `ask-lift:${crypto.randomUUID()}`,
      profileId,
      question: q,
      raw,
      mentions: mentionsIn(raw, mentionCtxRef.current),
      scrollTop: taRef.current?.scrollTop ?? 0,
      count: from ? at : list.length,
      from,
    });
  }, [connected, profileId]);

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (mentionPop.current?.onKey(e)) return; // the popover's own keys, while it is up
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
      if (a.threadsOpen) a.closeThreads();
      else if (a.traceOpenFor) a.closeTrace();
      else if (a.pickerOpen) a.setPickerOpen(false);
      else if (editing) cancelEdit();
      else if (pillFor !== null && pillLabel !== null && (a.drafts[profileId] ?? "").trim() === "")
        useAgent.getState().discardPending(pillFor);
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

  const openSettings = () => useSettings.getState().setSettingsOpen(true, "models");

  // a ghost is on screen: the textarea and its backdrop paint nothing, so the
  // words and their pills exist once
  const ghosted = (lift !== null && !landed) || travel !== null;

  return (
    <div
      ref={rootRef}
      className="ask-panel"
      tabIndex={-1}
      onKeyDown={onRootKey}
      // click-to-focus so Esc and ⌘. scope here: WKWebView never focuses
      // ancestors on click. Inputs and the grid keep their own focus, and so
      // does the @ popover, whose press reaches here through the React tree
      // (a portal bubbles by ownership, not by DOM) and must leave the caret
      // in the textarea for the pick
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('input,textarea,select,[contenteditable="true"],.vgrid,.mention-pop')) return;
        rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <header className="ask-head">
        <span className="ask-title">Ask</span>
        <button
          className="iconbtn"
          title="Threads"
          aria-label="Threads"
          disabled={!threads || threads.length === 0}
          onClick={() => useAsk.getState().openThreads()}
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
      ) : exchanges.length === 0 && cutFrom === null ? (
        <Starters profileId={profileId} snapshot={snapshot} asked={asked} connected={connected} />
      ) : (
        // a pending set reserves the pill's footprint at the scroller's end
        // (ask.css) for as long as the set lives, the run it starts included,
        // so the footer scrolls clear of the pill and the pill's leave and
        // return around a cancelled retry move nothing.
        // layoutScroll: the scroller declares its own scroll to motion's
        // projection tree, which then measures every layoutId descendant
        // (the follow-up chips, the echo) net of this element's scrollTop.
        // Without it the pin below reads as a layout change: every chip of
        // every older exchange springs up through its footer by the pinned
        // distance while its plain siblings jump (DESIGN rule 2: an
        // interaction that moves its own container). The scroller itself
        // carries no layout prop, so it never animates or wears a transform
        <motion.div
          className="ask-scroll"
          layoutScroll
          ref={scrollRef}
          data-pill={pillFor !== null && !editing ? "" : undefined}
        >
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
              followUps={i === exchanges.length - 1 ? followUps : NO_QUESTIONS}
              liftId={lift !== null && landed && i === exchanges.length - 1 ? lift.id : undefined}
            />
          ))}
        </motion.div>
      )}

      {choice !== null && (
        <div className="ask-input">
          <RetryPill label={pillLabel} onApply={applyPill} />
          {lift !== null && !landed && (
            <motion.div
              className="ask-ghost"
              layoutId={lift.id}
              layout="position"
              transition={spring.layout}
              aria-hidden="true"
            >
              <span style={{ translate: `0 ${-lift.scrollTop}px` }}>
                <MentionText text={lift.raw} mentions={lift.mentions} />
              </span>
            </motion.div>
          )}
          {/* the edit ghost (file header): the words of the bubble that left,
              over the textarea's text, under the bubble's edit id; `in` wears
              the fill that fades out, `out` is bare (the returning bubble's
              own fill fades in as it lands) */}
          {travel !== null && (
            <motion.div
              className="ask-ghost"
              data-edit={travel.dir}
              layoutId={editLiftId(travel.exchangeId)}
              layout="position"
              transition={spring.layout}
              onLayoutAnimationComplete={settleTravel}
              aria-hidden="true"
            >
              <span>
                <MentionText text={draft} mentions={mentions} />
              </span>
            </motion.div>
          )}
          <div className="ask-box" ref={boxRef}>
            <div className="ask-ta-wrap">
              {/* the draft's pills (file header): the textarea's glyphs again,
                  transparent, a .mention span around each resolved tag; the
                  trailing newline gives a draft that ends in one the empty
                  last line the textarea shows, so the two scroll as one. The
                  wrap pads the outdent's 2px and this pays them back, so a
                  first-token pill keeps its left edge */}
              {connected && (
                <div ref={backRef} className={`ask-ta-back${ghosted ? " ghosted" : ""}`} aria-hidden="true">
                  <MentionText text={draft} mentions={mentions} />
                  {"\n"}
                </div>
              )}
              <textarea
                ref={taRef}
                className={`ask-ta${ghosted ? " ghosted" : ""}`}
                rows={1}
                placeholder={connected ? `Ask about ${profile.dbname}…` : "Connect to ask"}
                aria-label="Ask"
                disabled={!connected}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (editing && e.target.value === "") cancelEdit();
                  syncMentions();
                }}
                onKeyDown={onComposerKey}
                onKeyUp={syncMentions}
                onClick={syncMentions}
                onSelect={syncMentions}
                onBlur={() => useAsk.getState().closeMentions()}
                onScroll={mirrorScroll}
              />
            </div>
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
          {mentionQuery !== null && connected && (
            <MentionPopover
              ref={mentionPop}
              query={mentionQuery}
              draft={draft}
              boxRef={boxRef}
              textareaRef={taRef}
              ctx={mentionCtx}
              onPick={pickMention}
              onClose={dismissMentions}
            />
          )}
        </div>
      )}

      <TraceDrawer
        open={traceExchange !== null}
        exchange={traceExchange}
        focusStepId={traceOpenFor?.stepId ?? null}
        onClose={() => useAsk.getState().closeTrace()}
      />

      <ThreadsSheet
        profileId={profileId}
        open={threadsOpen}
        onClose={() => useAsk.getState().closeThreads()}
      />
    </div>
  );
}
