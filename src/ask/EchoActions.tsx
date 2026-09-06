// The three actions every question bubble carries (ROADMAP W4): Copy ·
// Restart · Jump Back, the icon-button species in its 18px tier, sitting left
// of the bubble and revealed by the bubble's hover, the cluster's own, focus
// within it, or the harness's forced face (ask.css .ans-echo-acts). Copy goes
// through the app's one copy path, cue included (LESSONS 9). Restart on the
// newest exchange is the retry shape and asks nothing; on an older one it
// asks through the danger confirm when a later exchange holds an answer or
// an error, the detail naming the count and the button naming the loss
// (WRITING rule 4, `Delete` because the rows are persisted like a thread's),
// then the store truncates after it and re-runs it. Jump Back is the bubble's
// own click made visible (DESIGN rule 8: a hidden gesture needs a visible
// route); the bubble owns the mode's entry (AnswerBlock arms the travel), so
// the button only asks for it. Restart and Jump Back disable while the thread
// is busy or the pane is in edit mode; Copy never does, and nothing hides
// (rule 2's matrix).
//
// Restart's glyph is lucide Repeat, not RotateCcw: at 12px the counter-
// clockwise arc is the header's Threads glyph (History) minus its hands, two
// verbs on one arc in one pane; RefreshCw is the app's refresh glyph
// (TableBrowser, UpdateToast) and would borrow a third meaning.

import { Copy, CornerUpLeft, Repeat } from "lucide-react";
import { copyCue } from "../lib/copyCue";
import { useAgent, type Exchange } from "../stores/agent";
import { confirmDanger } from "../stores/danger";

/** the shared layout id a bubble and the composer's edit ghost carry while
 * the words travel between them: AnswerBlock gives it to the bubble the frame
 * before edit begins, the composer side mounts under it while edit is on */
export const editLiftId = (exchangeId: string) => `ask-edit:${exchangeId}`;

/** the confirm's words for `later` exchanges after the restarted one (the
 * sketch's restart-confirm): a question for the title, one sentence naming
 * the count and both halves of the loss, a verb + object on the button */
export function restartConfirmText(later: number): { title: string; detail: string; label: string } {
  return {
    title: "Restart from Here?",
    detail:
      later === 1
        ? "The question after this one and its answer will be deleted."
        : `The ${later} questions after this one and their answers will be deleted.`,
    label: later === 1 ? "Delete 1 Question" : `Delete ${later} Questions`,
  };
}

/** the exchanges after one in its thread; empty for the newest */
function laterThan(threadId: string, exchangeId: string): Exchange[] {
  const list = useAgent.getState().exchanges[threadId] ?? [];
  const at = list.findIndex((e) => e.id === exchangeId);
  return at === -1 ? [] : list.slice(at + 1);
}

async function restart(threadId: string, exchangeId: string): Promise<void> {
  const later = laterThan(threadId, exchangeId);
  if (later.some((e) => e.answer !== null || e.error !== null)) {
    const t = restartConfirmText(later.length);
    if (!(await confirmDanger(t.title, t.detail, t.label))) return;
  }
  await useAgent.getState().restartFrom(exchangeId);
}

export interface EchoActionsProps {
  exchange: Exchange;
  threadId: string;
  /** a run is in flight on the thread, or the pane is in edit mode: Restart
   * and Jump Back wait, Copy stays live */
  held: boolean;
  onJumpBack: () => void;
}

export function EchoActions({ exchange, threadId, held, onJumpBack }: EchoActionsProps) {
  return (
    <div className="ans-echo-acts">
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Copy"
        aria-label="Copy"
        onClick={() => void copyCue(exchange.question)}
      >
        <Copy size={12} />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Restart"
        aria-label="Restart"
        disabled={held}
        onClick={() => void restart(threadId, exchange.id)}
      >
        <Repeat size={12} />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Jump Back"
        aria-label="Jump Back"
        disabled={held}
        onClick={onJumpBack}
      >
        <CornerUpLeft size={12} />
      </button>
    </div>
  );
}
