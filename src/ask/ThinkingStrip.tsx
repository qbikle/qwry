// Thinking strip (AGENT-UX section 2, item 2): a FIXED-height row of tool
// chips, the only loading UI. Chips enter with the chips preset from
// springs.ts (section 10); the `run` chip wears the accent, an errored chip
// the danger tier. Consecutive calls with the same label collapse into one
// chip (`probe ×2`, `run ×3`), the way the sketch reads them. A chip is a
// status pill while the exchange streams (there is no trace to open yet) and
// becomes a button that opens the trace at its first call once it is done.
// Overflow never wraps and never grows the strip: the newest chip is kept at
// the right edge by an instant scroll assignment (never animated) and the
// older chips fade under a mask on the left.

import { useLayoutEffect, useRef, useState } from "react";
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

export function ThinkingStrip({ chips, streaming, onChipClick }: ThinkingStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const groups = groupChips(chips);
  const anyRunning = chips.some((c) => c.ms === null);
  const clickable = !streaming && !!onChipClick;

  // the newest chip stays visible: an instant scrollLeft assignment on every
  // chip arrival and on resize; the mask class marks the clipped state
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const settle = () => {
      el.scrollLeft = el.scrollWidth;
      setOverflow(el.scrollWidth > el.clientWidth + 1);
    };
    settle();
    const ro = new ResizeObserver(settle);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chips.length, streaming]);

  return (
    <div ref={ref} className={`ans-strip${overflow ? " overflow" : ""}`} role="status">
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
          {g.running ? <span className="tchip-spin" /> : <span className="tchip-ok" />}
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
