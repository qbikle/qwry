// Follow-up chips (AGENT-UX section 6): up to three questions the user could
// have typed. Picking one morphs the chip into the next question echo (shared
// layout spring: the chip and the echo carry the same motion layoutId) and
// asks; the composer stays free. Never a question already asked in the thread.
// The empty state renders its starters through this same component so the
// morph is one motion.
//
// W7: the row stands ONCE, under the thread's last answer (AskPanel reads
// useAgent.followUps and hands it down), and it owns its own leave: emptied,
// it fades on the content-swap preset instead of vanishing, so a question sent
// takes its suggestions with it rather than leaving them beside the new
// bubble. The chip is no longer the dashed-ghost species (ask.css .chip.q): a
// dash is the add/create costume and a question the model wrote is not
// something you are being invited to create.

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { spring, swapIn } from "../design/springs";

export interface FollowUpsProps {
  questions: string[];
  /** questions already asked in this thread, filtered out before render */
  asked: ReadonlySet<string>;
  onPick: (question: string) => void;
  /** a run is in flight: a pick would abort it, so the chips wait */
  disabled?: boolean;
}

const SHOWN = 3;

/** the shared layout id a suggestion and the echo it becomes both carry */
export const questionLayoutId = (question: string) => `ask-q:${question}`;

export function FollowUps({ questions, asked, onPick, disabled = false }: FollowUpsProps) {
  const shown: string[] = [];
  for (const q of questions) {
    if (shown.length === SHOWN) break;
    if (!asked.has(q) && !shown.includes(q)) shown.push(q);
  }
  return (
    <AnimatePresence initial={false}>
      {shown.length > 0 && (
        <motion.div key="row" className="ans-chips" exit={{ opacity: 0 }} transition={swapIn.transition}>
          {shown.map((q) => (
            <motion.button
              key={q}
              type="button"
              className="chip q"
              layoutId={questionLayoutId(q)}
              transition={spring.layout}
              disabled={disabled}
              onClick={() => onPick(q)}
            >
              <ArrowRight size={12} />
              {q}
            </motion.button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
