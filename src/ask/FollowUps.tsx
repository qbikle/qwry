// Follow-up chips (AGENT-UX section 6): up to three questions the user could
// have typed, the dashed-ghost species in pill shape. Picking one morphs the
// chip into the next question echo (shared layout spring: the chip and the
// echo carry the same motion layoutId) and asks; the composer stays free.
// Never a question already asked in the thread. The empty state renders its
// starters through this same component so the morph is one motion.

import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { spring } from "../design/springs";

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
  if (shown.length === 0) return null;
  return (
    <div className="ans-chips">
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
    </div>
  );
}
