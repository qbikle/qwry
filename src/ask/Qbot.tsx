// qbot (B4): the empty state's mascot, the maintainer's lowercase q read as a
// robot (qwry-agent-lab/docs/research/qbot-sketch.jpg; the geometry is locked
// in ask-sketch-b4.html section B4, which labels every part). He stands in the
// free space the three starters leave and says nothing: the empty state is
// qbot and the three starters, no sentence (DESIGN rule 11; AGENT-UX section 1
// amended). He is not a control and wears no affordance (rule 8's inverse):
// aria-hidden, no title, no tooltip, no handler, and the slot he sits in takes
// no pointer events.
//
// Colours are tokens only and the body is `--accent`: qbot wears the pane's
// own colour, never a mascot palette, because the pane speaks for the data's
// origin (LESSONS 4). Both themes read from the same tokens: the eye is
// `--bg-app` with `--fg` marks, so dark gives the drawing's dark eye with
// bright marks and light a pale iris with dark pupils.
//
// Motion is five CSS loops in qbot.css (one language, rule 6). Only three
// things are wired from here, and none of them touches the composer:
//   · the pause. Nothing animates while the pane is not on screen:
//     `data-paused` while `document.hidden` or the side pane is not showing
//     Ask (both mode holders stay mounted, AGENT-UX section 10) sets
//     animation-play-state on every loop, so each resumes in place, never
//     from the top.
//   · the twinkle's cadence. The small highlight blinks in the qwrying sweep's
//     uneven beat (ThinkingStrip's SWEEP, DECISIONS W2d). The KEYFRAMES hold
//     the cadence's shape (ten unlike spans, baked as percentages in
//     qbot.css); this file writes each CYCLE's own length. `twinkleCycleMs`
//     jitters the sweep's spans by ±20% and their sum lands on the mark as
//     `--qbot-twinkle-dur`, re-rolled at every animationend, so not even the
//     8 s cycle repeats. The mark re-keys per cycle because a duration written
//     mid-flight would jump the phase; a restart at the boundary cannot, the
//     rest pose and the keyframes' 0% being the same pose. Reduced motion
//     kills the animation, so no end fires, no roll runs and the mark rests;
//     the handler also checks `prefersReducedMotion()` itself, so a stylesheet
//     that lost the kill still can't re-arm the loop underneath it.
//   · the gaze (item 3): the two marks drop while the composer's textarea has
//     focus, read from the document's own focus events rather than from a
//     prop, so the mascot stays out of the composer's row.
//
// The enter and the leave are motion's, on the slot AskPanel renders round
// this svg: a CSS animation outranks the inline style motion writes, so an
// element carrying both the bob and the exit would lose its exit (the
// starters' own note in ask.css).

import { useEffect, useState, type CSSProperties } from "react";
import { prefersReducedMotion } from "../design/springs";
import { useSidePane } from "../stores/sidePane";
import { SWEEP } from "./ThinkingStrip";
import "./qbot.css";

/** the mascot's name, in one constant: the maintainer may rename him. It is
 * written nowhere visible today, since qbot carries no text and no label */
export const QBOT_NAME = "qbot";

/** the qwrying sweep's cadence twice over: a beat, a breath, a beat, a pause,
 * then the same pass with the second quick beat the sweep sometimes takes
 * (ThinkingStrip's SWEEP, DECISIONS W2d). The spans' RATIOS are baked into
 * `qbot-twinkle`'s keyframes; what this generator varies is the whole */
export const TWINKLE_SPANS: readonly number[] = [
  SWEEP.slow,
  SWEEP.breath,
  SWEEP.quick,
  SWEEP.long,
  SWEEP.slow,
  SWEEP.breath,
  SWEEP.quick,
  SWEEP.pause,
  SWEEP.quick,
  SWEEP.long,
];

/** one cycle's length in ms: every span jittered by ±SWEEP.jitter and summed,
 * so no two cycles run the same length and none of them is a metronome's */
export function twinkleCycleMs(rand: () => number = Math.random): number {
  let ms = 0;
  for (const span of TWINKLE_SPANS) ms += span * (1 - SWEEP.jitter + rand() * 2 * SWEEP.jitter);
  return Math.round(ms);
}

interface Cycle {
  /** the mark's key: a new cycle is a new element, so it starts at 0% */
  n: number;
  ms: number;
}

/** the composer's textarea, the one element the gaze answers to */
const isComposer = (el: EventTarget | null): boolean =>
  el instanceof Element && el.classList.contains("ask-ta");

export function Qbot() {
  // the pane's two holders stay mounted through a mode swap and a close, so
  // showing Ask is a fact to read, never the mount itself
  const showing = useSidePane((s) => s.open && s.mode === "ask");
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const [gaze, setGaze] = useState(false);
  const [cycle, setCycle] = useState<Cycle>(() => ({ n: 0, ms: twinkleCycleMs() }));

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    const on = (e: FocusEvent) => setGaze(isComposer(e.target));
    const off = () => setGaze(false);
    setGaze(isComposer(document.activeElement));
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", off);
    return () => {
      document.removeEventListener("focusin", on);
      document.removeEventListener("focusout", off);
    };
  }, []);

  return (
    <svg
      className="qbot"
      viewBox="0 0 56 70"
      aria-hidden="true"
      data-paused={hidden || !showing ? "" : undefined}
      data-gaze={gaze ? "" : undefined}
    >
      <polyline className="qbot-antenna" points="35,14.5 42,4 52,4" />
      {/* under the ring, so the ring's own anti-aliasing makes the eye's edge:
          a disc painted over the stroke leaves a panel-coloured hairline in
          light, and the extra half unit hides under the stroke */}
      <circle className="qbot-eye" cx="24" cy="31" r="10.5" />
      <line className="qbot-leg-l" x1="8" y1="48" x2="8" y2="61.5" />
      {/* the descender: its top cap spans radii 10 to 23, so it lies inside
          the ring's stroke at every sway angle (no seam, no gap) and its outer
          edge continues the ring's at x 47 */}
      <line className="qbot-leg-r" x1="40.5" y1="31" x2="40.5" y2="62.5" />
      <circle className="qbot-body" cx="24" cy="31" r="16.5" />
      <g className="qbot-hls">
        <circle className="qbot-hl qbot-hl-big" cx="22" cy="27" r="1.8" />
        <circle
          key={cycle.n}
          className="qbot-hl qbot-hl-small"
          cx="27"
          cy="29"
          r="1.1"
          style={{ "--qbot-twinkle-dur": `${cycle.ms}ms` } as CSSProperties}
          onAnimationEnd={() => {
            // reduced motion runs no animation to end; a stylesheet that lost
            // the kill must not re-arm the loop underneath it
            if (prefersReducedMotion()) return;
            setCycle((c) => ({ n: c.n + 1, ms: twinkleCycleMs() }));
          }}
        />
      </g>
      <circle className="qbot-bulb" cx="52" cy="4" r="3" />
    </svg>
  );
}
