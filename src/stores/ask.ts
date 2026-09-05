// Ask UI state (AGENT-UX section 1). Chrome only: which trace is showing,
// whether the picker is up, and the composer drafts, one per connection.
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

interface AskState {
  /** mirror: the side pane is open AND showing Ask. Read-only here; the
   * pane store is the truth and App.tsx drives it */
  open: boolean;
  traceOpenFor: TraceTarget | null;
  pickerOpen: boolean;
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

  openTrace: (exchangeId: string, stepId?: string | null) => void;
  closeTrace: () => void;
  setPickerOpen: (open: boolean) => void;
  setDraftFor: (profileId: string | null) => void;
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
  pickerOpen: false,
  drafts: {},
  draftFor: null,
  focusSeq: 0,

  openTrace: (exchangeId, stepId = null) =>
    set({ traceOpenFor: { exchangeId, stepId }, pickerOpen: false }),
  closeTrace: () => set({ traceOpenFor: null }),
  setPickerOpen: (pickerOpen) => set({ pickerOpen }),
  setDraftFor: (draftFor) => set({ draftFor }),
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
  useAsk.setState(open ? { open } : { open, traceOpenFor: null, pickerOpen: false });
});
