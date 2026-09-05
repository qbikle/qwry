// Thinking strip (AGENT-UX section 2, item 2): a FIXED-height row of tool
// chips, the only loading UI. Chips enter with the chips preset from
// springs.ts (section 10); the `run` chip wears the accent, an errored chip
// the danger tier. Consecutive calls with the same label collapse into one
// chip (`probe ×2`, `run ×3`), the way the sketch reads them. A chip is a
// status pill while the exchange streams (there is no trace to open yet) and
// becomes a button that opens the trace at its first call once it is done.
//
// A chip still running when the turn stops (⌘. / Stop) shows a hollow ring,
// never a spinner: a spinner on a cancelled exchange claims work that is not
// happening (LESSONS 9).
// Overflow never wraps and never grows the strip: the row scrolls sideways
// with its scrollbar hidden (round 2, finding 5: the faded older chips were
// unreachable). Both edges fade under a mask driven by the scroll position
// (.fade-l once older chips sit under the left edge, .fade-r while newer
// ones wait past the right). A vertical wheel over the strip scrolls it
// sideways, instantly, and is consumed only when the strip can still move
// that way, so the thread scrolls as usual at either end. While the exchange
// streams the newest chip is kept in view by an instant scrollLeft
// assignment (never animated), until the user scrolls the strip themselves
// during that stream: from then on the position is theirs. A landed
// exchange rests at its newest chip too: the first layout of a strip that is
// not streaming (a reloaded thread, a cancelled retry's restored chips)
// parks at the end once, so the same answer wears one strip whether it was
// streamed or reloaded (the sketch draws the newest-chip end at 320).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { menuIn } from "../design/springs";
import type { ToolChip } from "../stores/agent";
import type { AskPhase } from "../agent/loop";

export interface ThinkingStripProps {
  chips: ToolChip[];
  /** a turn is in flight: the strip may show a trailing `·` for the next call */
  streaming: boolean;
  phase: AskPhase | null;
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
      isRun: c.name === "run_sql",
    });
  }
  return out;
}

/** sub-pixel scroll positions count as the edge */
const EDGE = 1;

export function ThinkingStrip({ chips, streaming, onChipClick }: ThinkingStripProps) {
  const ref = useRef<HTMLDivElement>(null);
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

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const l = el.scrollLeft > EDGE;
    const r = el.scrollLeft < max - EDGE;
    setFade((f) => (f.l === l && f.r === r ? f : { l, r }));
  }, []);

  // every chip arrival: the newest chip into view (streaming, position not
  // yet the user's; or the first layout of a landed strip, once), then the
  // masks from the position. A stream's start hands the position back from
  // the user before its first chip lands
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (streaming && !wasStreaming.current) userScrolled.current = false;
    wasStreaming.current = streaming;
    const park = streaming ? true : !rested.current;
    rested.current = !streaming;
    if (park && !userScrolled.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [chips.length, streaming, measure]);

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
      userScrolled.current = true;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", measure);
    };
  }, [measure, streaming]);

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
      {streaming && !anyRunning && (
        <span className="ans-more" aria-hidden="true">
          ·
        </span>
      )}
    </div>
  );
}
