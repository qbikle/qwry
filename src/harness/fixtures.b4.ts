// qbot builder's fixture for the Ask harness (B4): the empty state with the
// composer focused, so the gaze has a frame.
//
//   b4-empty   the configured empty state (qbot over the three heuristic
//              starters) with the textarea focused: the composer's ring is
//              the accent and qbot's two marks sit 2px lower
//
// It is NOT a second copy of `empty`. qbot ships in the product's empty state,
// so `empty` shows him too and stays the regression pair; this state is the
// one fact `empty` cannot hold, the gaze (two fixtures for one fact would be
// two slots for one fact, rule 14). Everything else about it is `empty`: no
// thread (`exchangeFor` returns null), no seeded pool, the fixture's own
// Claude Code choice from `choiceFor`'s default.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts): add B4_STATES to
// HARNESS_STATES, return null from `exchangeFor`, and call `b4AfterMount` in
// the harness's post-mount frame. The focus goes through the store's own door
// (useAsk.requestFocus, the mention states' precedent), never a DOM call, so
// the frame shows what a ⌘J focus shows; AskPanel consumes it one frame later
// and the shot waits out the harness's settle.

import { useAsk } from "../stores/ask";

export const B4_STATES = ["b4-empty"] as const;
export type B4State = (typeof B4_STATES)[number];

/** the composer takes focus after mount: a still cannot hold a click */
export function b4AfterMount(state: string): void {
  if (state !== "b4-empty") return;
  useAsk.getState().requestFocus();
}
