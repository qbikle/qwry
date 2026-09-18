// The retry pill (round 2, finding 3): assumption chips toggle locally and
// nothing runs until this one control is pressed. It floats over the
// composer's top edge (ask.css .ask-retry: absolute inside .ask-input, never
// in the flow, so it neither moves the box nor covers the send button); the
// thread scroller reserves the pill's footprint at its end while a set is
// pending (AskPanel's data-pill), so the footer and its Trace link scroll
// clear of the pill and nothing under it is unreachable. It wears the Action
// button species in pill shape, enters with the chips' snappy preset and
// leaves on the same spring as a fade (AnimatePresence). Its face names what
// the pending set does (retryLabel, stores/agent.ts); the host hands null
// when nothing is pending, the thread is busy or the connection is down. Esc
// over an empty composer discards the set (AskPanel's ladder).

import { AnimatePresence, motion } from "motion/react";
import { menuIn } from "../design/springs";

export interface RetryPillProps {
  /** the face to show, or null for no pill */
  label: string | null;
  onApply: () => void;
}

export function RetryPill({ label, onApply }: RetryPillProps) {
  return (
    <AnimatePresence>
      {label !== null && (
        <motion.button
          key="retry"
          type="button"
          className="btnish primary ask-retry"
          initial={menuIn.initial}
          animate={menuIn.animate}
          exit={{ opacity: 0 }}
          transition={menuIn.transition}
          onClick={onApply}
        >
          {label}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
