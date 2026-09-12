// C2b's one Settings row for the design harness. The vision switch is the
// only always-visible chrome this wave adds anywhere in the app, and chrome
// ships frames (DESIGN rule 9): a conditional row verified in code and never
// in pixels is a row nobody has looked at.
//
//   c2-settings-vision  Settings › Models with an `"unknown"` model chosen,
//                       read at its foot where the two defaults and the one
//                       switch stand. The row exists ONLY here: a model the
//                       registry documents either way has nothing left for a
//                       person to decide, so no switch is offered (AGENT-UX
//                       16y, DESIGN rule 2's matrix). The frame's whole
//                       subject is that this row is a row like the edits
//                       switch above it and not a second grammar
//
// The pane's own three widths, because this is pane-width chrome living in a
// modal that is never wider: the 320 floor is where a label, a two-line hint
// and a switch have to share one line, which is the thing worth framing.
//
// The chosen model is `gpt-5.6-terra` on `openai`: a row the registry carries
// with `vision: "unknown"`, which is the one state that opens this switch.
// Nothing here fakes the row - the product's own `visionUnknown` decides, off
// the registry the app ships with.
//
// Wiring (AskHarness.tsx / ask-frames.ts are the integrator's): add
// C2_VISION_STATES to the ask root's state list, call c2VisionSeed() before
// the first render, and render <ModelsSettings/> in the card for this state.

export const C2_VISION_STATES = ["c2-settings-vision"] as const;
export type C2VisionState = (typeof C2_VISION_STATES)[number];

/** the pane's own three widths: the modal this row lives in is never wider,
 * and the floor is where the row has to hold its shape */
export const C2_VISION_WIDTHS = [320, 392, 560] as const;

/** tall enough to read the foot of the pane and no taller: what the frame is
 * evidence of is one row among the rows it stands with */
export const C2_VISION_CARD_H = 560;

export interface C2VisionSeed {
  /** the app-wide choice: a model the registry cannot speak for, which is the
   * one condition the switch appears under */
  provider: string;
  model: string;
}

export const c2VisionSeed = (): C2VisionSeed => ({ provider: "openai", model: "gpt-5.6-terra" });
