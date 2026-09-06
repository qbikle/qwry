// Ask UI state (AGENT-UX section 1). Chrome only: which trace is showing,
// whether the Threads sheet or the picker is up, the composer drafts, one per
// connection, which exchange the composer is editing (W4 jump back: the
// mode, not the truncation, which is the agent store's), and the `@` the
// caret is inside (W6: the mention popover's query, not its rows).
// Whether Ask is on screen and how wide it is belong to the one right pane
// (src/stores/sidePane.ts: Ask is a MODE of it, not a card of its own); this
// store mirrors `open` for its readers and clears its transient chrome when
// the pane closes or switches away. Thread identity, exchanges, streaming
// status and every loop-facing fact stay in src/stores/agent.ts, which W1
// built around LESSONS 3 and which is not persisted. Nothing here persists.
//
// Focus is state-owned (LESSONS 7): `focusSeq` is bumped by whoever wants the
// composer focused (the ⌘J handler, the palette, Ask Differently) and
// consumed by AskPanel, which is lazy-loaded and may not be mounted yet when
// the request lands.

import { create } from "zustand";
import { useSidePane } from "./sidePane";

/** which answer's trace is open, and which step it should reveal first
 * (a sanity fragment or a tool chip points at one step; the footer link at
 * none) */
export interface TraceTarget {
  exchangeId: string;
  stepId: string | null;
}

/** The exchange the composer is editing (W4 jump back): its question is in
 * the draft, it and every later exchange are folded away, and sending cuts
 * the thread from it. The profile and thread are carried because a draft
 * belongs to its connection (LESSONS 4) and a fold belongs to its thread:
 * leaving either cancels the mode. */
export interface AskEdit {
  profileId: string;
  threadId: string;
  exchangeId: string;
  question: string;
}

/** The `@` token the composer's caret is inside (W6): where it starts in the
 * draft and the text typed after the `@` up to the caret. AskPanel derives it
 * from the textarea on every change and caret move; the MentionPopover
 * renders while it is set and unmounts when nothing matches. The harness
 * opens it through `openMentions` (a DOM-free door, like beginEdit). */
export interface MentionQuery {
  at: number;
  filter: string;
}

interface AskState {
  /** mirror: the side pane is open AND showing Ask. Read-only here; the
   * pane store is the truth and App.tsx drives it */
  open: boolean;
  traceOpenFor: TraceTarget | null;
  /** the Threads sheet (ThreadsSheet.tsx) is over the thread; it and the
   * trace are the pane's two slide-overs and never show together */
  threadsOpen: boolean;
  pickerOpen: boolean;
  /** null = the caret is not inside an `@` token; a slide-over, a blur, Esc,
   * a pick or a connection switch clears it */
  mentionQuery: MentionQuery | null;
  /** unsent composer text per connection (LESSONS 4: a draft typed toward one
   * connection carries that origin and never surfaces in another's
   * composer; it comes back when its connection does). Lives here so Ask
   * Differently can write into it from outside AskPanel */
  drafts: Record<string, string>;
  /** the connection whose composer is on screen, pushed by AskPanel the way
   * it pushes useAgent.setActiveProfile (the store never guesses from
   * navigation; this store cannot import the lazy agent store to share its
   * pointer). `setDraft` writes here */
  draftFor: string | null;
  /** bumped to ask AskPanel to focus the composer; consumed with rAF so an
   * overlay's focus-restore (escStack) lands first and loses */
  focusSeq: number;
  /** null = the composer is writing a new question at the end of the thread */
  edit: AskEdit | null;

  openTrace: (exchangeId: string, stepId?: string | null) => void;
  closeTrace: () => void;
  openThreads: () => void;
  closeThreads: () => void;
  setPickerOpen: (open: boolean) => void;
  openMentions: (at: number, filter: string) => void;
  closeMentions: () => void;
  setDraftFor: (profileId: string | null) => void;
  /** enter edit mode: the exchange's question becomes its connection's draft
   * and the composer takes focus. The fold and the travel are the panel's */
  beginEdit: (edit: AskEdit) => void;
  /** leave edit mode. The draft is the caller's to keep or clear: a cancel
   * puts the words back in the bubble, a send has already spent them */
  endEdit: () => void;
  /** writes the on-screen connection's draft; a no-op with no composer on
   * screen, since text with no connection to belong to is text with no home */
  setDraft: (text: string) => void;
  requestFocus: () => void;
}

const showing = () => {
  const p = useSidePane.getState();
  return p.open && p.mode === "ask";
};

export const useAsk = create<AskState>()((set) => ({
  open: showing(),
  traceOpenFor: null,
  threadsOpen: false,
  pickerOpen: false,
  mentionQuery: null,
  drafts: {},
  draftFor: null,
  focusSeq: 0,
  edit: null,

  openTrace: (exchangeId, stepId = null) =>
    set({ traceOpenFor: { exchangeId, stepId }, threadsOpen: false, pickerOpen: false, mentionQuery: null }),
  closeTrace: () => set({ traceOpenFor: null }),
  openThreads: () => set({ threadsOpen: true, traceOpenFor: null, pickerOpen: false, mentionQuery: null }),
  closeThreads: () => set({ threadsOpen: false }),
  // the two popovers over the composer never show together
  setPickerOpen: (pickerOpen) => set(pickerOpen ? { pickerOpen, mentionQuery: null } : { pickerOpen }),
  openMentions: (at, filter) =>
    set((s) =>
      s.mentionQuery?.at === at && s.mentionQuery.filter === filter ? {} : { mentionQuery: { at, filter } },
    ),
  closeMentions: () => set((s) => (s.mentionQuery === null ? {} : { mentionQuery: null })),
  // a connection change cancels the edit: the fold belongs to the thread on
  // screen, and the draft stays with the connection it was typed toward; the
  // `@` under the caret belongs to the composer that leaves with it
  setDraftFor: (draftFor) =>
    set((s) => ({ draftFor, edit: s.edit?.profileId === draftFor ? s.edit : null, mentionQuery: null })),
  beginEdit: (edit) =>
    set((s) => ({
      edit,
      drafts: { ...s.drafts, [edit.profileId]: edit.question },
      focusSeq: s.focusSeq + 1,
    })),
  endEdit: () => set({ edit: null }),
  setDraft: (text) =>
    set((s) => {
      if (!s.draftFor) return {};
      if (!text) {
        if (!(s.draftFor in s.drafts)) return {};
        const drafts = { ...s.drafts };
        delete drafts[s.draftFor];
        return { drafts };
      }
      return { drafts: { ...s.drafts, [s.draftFor]: text } };
    }),
  requestFocus: () => set((s) => ({ focusSeq: s.focusSeq + 1 })),
}));

// leaving the screen (pane closed, or switched to the inspector) takes the
// transient chrome with it, as the old setOpen(false) did
useSidePane.subscribe(() => {
  const open = showing();
  if (useAsk.getState().open === open) return;
  useAsk.setState(
    open ? { open } : { open, traceOpenFor: null, threadsOpen: false, pickerOpen: false, mentionQuery: null },
  );
});
