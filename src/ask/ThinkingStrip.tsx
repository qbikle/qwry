// Thinking strip (AGENT-UX section 2, item 2): a FIXED-height row of tool
// chips, the only loading UI. Chips enter with the chips preset from
// springs.ts (section 10); the `run` chip wears the accent, an errored chip
// the danger tier. Consecutive calls with the same label collapse into one
// chip (`probe sent_at ×2`, `run ×3`), the way the sketch reads them. A chip
// is a status pill while the exchange streams (there is no trace to open
// yet) and becomes a button that opens the trace at its first call once it
// is done.
//
// A chip still running when the turn stops (⌘. / Stop) shows a hollow ring,
// never a spinner: a spinner on a cancelled exchange claims work that is not
// happening (LESSONS 9).
//
// While the exchange streams with no chip running and no answer text yet
// (just sent; the model thinking between calls) the row ends in `qwrying…`:
// status text, never a chip, in the muted tier with a lighter band swept
// across its letters (the sketch's .qwrying). The sweep is a Web Animations
// tween on background-position with the token's easing, in a cadence that
// never repeats exactly: a slow pass, a breath, a quick pass, sometimes a
// second, a long breath, every span jittered ±20%. It cancels the instant
// text streams, a chip starts or the strip unmounts; reduced motion is the
// static word. (Round 3, ask 3: "no infinite transition something"; the old
// lone `·` placeholder is gone.)
//
// Overflow never wraps and never grows the strip: the row scrolls sideways
// with its scrollbar hidden (round 2, finding 5: the faded older chips were
// unreachable). Both edges fade under a mask driven by the scroll position
// (.fade-l once older chips sit under the left edge, .fade-r while newer
// ones wait past the right). A vertical wheel over the strip scrolls it
// sideways, instantly, and is consumed only when the strip can still move
// that way, so the thread scrolls as usual at either end. While the exchange
// streams the newest chip (or the waiting word) is kept in view by an
// instant scrollLeft assignment (never animated), until the user scrolls the
// strip away from its right edge during that stream: from then on the position
// is theirs, until they bring it back to the right edge, which follows again.
// A landed exchange rests at its newest chip too: the first layout of a
// strip that is not streaming (a reloaded thread, a cancelled retry's
// restored chips) parks at the end once, so the same answer wears one strip
// whether it was streamed or reloaded (the sketch draws the newest-chip end
// at 320).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { menuIn, prefersReducedMotion } from "../design/springs";
import type { ToolChip } from "../stores/agent";
import type { AskPhase } from "../agent/loop";

export interface ThinkingStripProps {
  chips: ToolChip[];
  /** a turn is in flight */
  streaming: boolean;
  phase: AskPhase | null;
  /** no answer text has arrived for this exchange (the caller sees the
   * text, the strip does not): while the exchange streams with no chip
   * running, the strip ends in `qwrying…`; the instant text streams the word
   * goes. Omitted = not yet known, which the strip reads as no text yet */
  waiting?: boolean;
  /** a finished chip was clicked: open the trace at that tool step */
  onChipClick?: (chipId: string) => void;
}

interface ChipGroup {
  /** the first call's id: what the trace opens at */
  id: string;
  verb: string;
  /** the identifier after the verb (`users`, `payment_status`), mono */
  ident: string | null;
  count: number;
  running: boolean;
  isError: boolean;
  isRun: boolean;
}

/** `describe users` → verb `describe`, ident `users`; `run` → verb only */
function splitLabel(label: string): { verb: string; ident: string | null } {
  const sp = label.indexOf(" ");
  return sp === -1
    ? { verb: label, ident: null }
    : { verb: label.slice(0, sp), ident: label.slice(sp + 1) };
}

/** consecutive chips with the same label become one group; a group runs
 * while any member runs and errs when any member erred */
export function groupChips(chips: ToolChip[]): ChipGroup[] {
  const out: ChipGroup[] = [];
  for (const c of chips) {
    const { verb, ident } = splitLabel(c.label);
    const last = out[out.length - 1];
    if (last && last.verb === verb && last.ident === ident) {
      last.count++;
      last.running = last.running || c.ms === null;
      last.isError = last.isError || c.isError;
      continue;
    }
    out.push({
      id: c.id,
      verb,
      ident,
      count: 1,
      running: c.ms === null,
      isError: c.isError,
      // A4's dry run wears the run chip's accent: it is the one call in the
      // strip that touches the rows the answer is about
      isRun: c.name === "run_sql" || c.name === "preview",
    });
  }
  return out;
}

/** sub-pixel scroll positions count as the edge */
const EDGE = 1;

/** the waiting word's sweep, in ms and odds: a slow pass, a breath, a quick
 * pass, a second quick pass some of the time, a long breath; every span
 * jittered by ±JITTER so the word never reads as a metronome */
export const SWEEP = {
  slow: 1800,
  breath: 300,
  quick: 650,
  again: 0.4,
  pause: 150,
  long: 900,
  jitter: 0.2,
} as const;

/** the band's travel: from off the right of the word to off its left */
const SWEEP_FRAMES: Keyframe[] = [{ backgroundPosition: "120% 0" }, { backgroundPosition: "-40% 0" }];

export function ThinkingStrip({ chips, streaming, waiting, onChipClick }: ThinkingStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const waitRef = useRef<HTMLSpanElement>(null);
  const [fade, setFade] = useState({ l: false, r: false });
  // the user took the strip's scroll during this stream: the newest chip
  // stops chasing the right edge until the next stream begins
  const userScrolled = useRef(false);
  // a landed exchange has been parked at its newest chip; cleared by a stream
  // so the next landing (a restored prior, a fresh verdict) parks again
  const rested = useRef(false);
  const wasStreaming = useRef(streaming);
  const groups = groupChips(chips);
  const anyRunning = chips.some((c) => c.ms === null);
  const clickable = !streaming && !!onChipClick;
  const showWait = streaming && !anyRunning && waiting !== false;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const l = el.scrollLeft > EDGE;
    const r = el.scrollLeft < max - EDGE;
    // back at the right edge: the newest chip is followed again
    if (!r) userScrolled.current = false;
    setFade((f) => (f.l === l && f.r === r ? f : { l, r }));
  }, []);

  // every chip arrival, and the word's: the newest into view (streaming,
  // position not yet the user's; or the first layout of a landed strip,
  // once), then the masks from the position. A stream's start hands the
  // position back from the user before its first chip lands
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (streaming && !wasStreaming.current) userScrolled.current = false;
    wasStreaming.current = streaming;
    const park = streaming ? true : !rested.current;
    rested.current = !streaming;
    if (park && !userScrolled.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [chips.length, streaming, showWait, measure]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (streaming && !userScrolled.current) el.scrollLeft = el.scrollWidth;
      measure();
    });
    ro.observe(el);
    // native and non-passive: React's wheel listener is passive, and the
    // thread scroller behind the strip must not also move when the strip does
    const onWheel = (e: WheelEvent) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
        if (e.deltaX !== 0) userScrolled.current = true;
        return;
      }
      const next = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
      if (next === el.scrollLeft) return;
      e.preventDefault();
      el.scrollLeft = next;
      userScrolled.current = next < max - EDGE;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", measure);
    };
  }, [measure, streaming]);

  // the sweep: one Web Animation per pass on the word itself, the cadence
  // above between them; every pass reads the LIVE reduced-motion flag through
  // the preset getter's source, so the static word is what a reduced-motion
  // session ever sees. Cancelled with the word (cleanup) and on unmount
  useEffect(() => {
    const el = waitRef.current;
    if (!showWait || !el || prefersReducedMotion() || typeof el.animate !== "function") return;
    const easing = getComputedStyle(el).getPropertyValue("--ease-std").trim() || "ease-in-out";
    let live = true;
    let anim: Animation | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const jitter = (ms: number) => ms * (1 - SWEEP.jitter + Math.random() * 2 * SWEEP.jitter);
    const pass = (ms: number) =>
      new Promise<void>((resolve) => {
        anim = el.animate(SWEEP_FRAMES, { duration: jitter(ms), easing });
        anim.onfinish = () => resolve();
        anim.oncancel = () => resolve();
      });
    const rest = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, jitter(ms));
      });
    void (async () => {
      while (live) {
        await pass(SWEEP.slow);
        if (!live) break;
        await rest(SWEEP.breath);
        if (!live) break;
        await pass(SWEEP.quick);
        if (!live) break;
        if (Math.random() < SWEEP.again) {
          await rest(SWEEP.pause);
          if (!live) break;
          await pass(SWEEP.quick);
          if (!live) break;
        }
        await rest(SWEEP.long);
      }
    })();
    return () => {
      live = false;
      anim?.cancel();
      clearTimeout(timer);
    };
  }, [showWait]);

  return (
    <div
      ref={ref}
      className={`ans-strip${fade.l ? " fade-l" : ""}${fade.r ? " fade-r" : ""}`}
      role="status"
    >
      {groups.map((g) => (
        <motion.button
          key={g.id}
          type="button"
          className={`tchip${g.isRun ? " run" : ""}${g.isError ? " error" : ""}${clickable ? " clickable" : ""}`}
          initial={menuIn.initial}
          animate={menuIn.animate}
          transition={menuIn.transition}
          aria-disabled={!clickable}
          tabIndex={clickable ? 0 : -1}
          onClick={clickable ? () => onChipClick?.(g.id) : undefined}
        >
          {g.running ? (
            streaming ? (
              <span className="tchip-spin" />
            ) : (
              <span className="tchip-stop" aria-label="stopped" />
            )
          ) : (
            <span className="tchip-ok" />
          )}
          <span>{g.verb}</span>
          {g.ident !== null && <code className="tchip-id">{g.ident}</code>}
          {g.count > 1 && <span>×{g.count}</span>}
        </motion.button>
      ))}
      {showWait && (
        <span ref={waitRef} className="tchip-wait">
          qwrying…
        </span>
      )}
    </div>
  );
}
