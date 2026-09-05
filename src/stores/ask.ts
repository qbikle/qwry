// Ask panel UI state (AGENT-UX section 1). Chrome only: whether the card is
// open, how wide it is, which trace is showing, whether the picker is up, and
// the composer drafts, one per connection. Thread identity, exchanges, streaming status and every
// loop-facing fact stay in src/stores/agent.ts, which W1 built around LESSONS 3
// and which is not persisted; mixing a persisted width into it would force a
// partialize around the whole thread map. This store mirrors useInspector
// instead: same persist shape (open + width), same clamp discipline.
//
// Focus is state-owned (LESSONS 7): `focusSeq` is bumped by whoever wants the
// composer focused (the ⌘J handler, the palette, Ask Differently) and
// consumed by AskPanel, which is lazy-loaded and may not be mounted yet when
// the request lands.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const ASK_W_MIN = 320;
export const ASK_W_MAX = 560;
export const ASK_W_DEFAULT = 392;

/** which answer's trace is open, and which step it should reveal first
 * (a sanity fragment or a tool chip points at one step; the footer link at
 * none) */
export interface TraceTarget {
  exchangeId: string;
  stepId: string | null;
}

interface AskState {
  open: boolean;
  width: number;
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

  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (w: number) => void;
  openTrace: (exchangeId: string, stepId?: string | null) => void;
  closeTrace: () => void;
  setPickerOpen: (open: boolean) => void;
  setDraftFor: (profileId: string | null) => void;
  /** writes the on-screen connection's draft; a no-op with no composer on
   * screen, since text with no connection to belong to is text with no home */
  setDraft: (text: string) => void;
  requestFocus: () => void;
}

const clampWidth = (w: number) =>
  Number.isFinite(w) ? Math.max(ASK_W_MIN, Math.min(ASK_W_MAX, Math.round(w))) : ASK_W_DEFAULT;

export const useAsk = create<AskState>()(
  persist(
    (set) => ({
      // closed by default, unlike the inspector: a panel that appears
      // uninvited after an update is the wrong first impression
      open: false,
      width: ASK_W_DEFAULT,
      traceOpenFor: null,
      pickerOpen: false,
      drafts: {},
      draftFor: null,
      focusSeq: 0,

      setOpen: (open) => set(open ? { open } : { open, traceOpenFor: null, pickerOpen: false }),
      toggle: () =>
        set((s) => (s.open ? { open: false, traceOpenFor: null, pickerOpen: false } : { open: true })),
      setWidth: (w) => set({ width: clampWidth(w) }),
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
    }),
    {
      name: "qwry.ask",
      partialize: (s) => ({ open: s.open, width: s.width }),
      merge: (persisted, current) => {
        const p = (typeof persisted === "object" && persisted !== null ? persisted : {}) as {
          open?: unknown;
          width?: unknown;
        };
        return {
          ...current,
          open: typeof p.open === "boolean" ? p.open : current.open,
          width: typeof p.width === "number" ? clampWidth(p.width) : current.width,
        };
      },
    },
  ),
);
