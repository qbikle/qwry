// The three actions every question bubble carries (ROADMAP W4): Copy ·
// Restart · Jump Back, the icon-button species in its 18px tier, sitting left
// of the bubble and revealed by the bubble's hover, the cluster's own, focus
// within it, or the harness's forced face (ask.css .ans-echo-acts). Copy goes
// through the app's one copy path, cue included (LESSONS 9). Restart re-mints
// the thread's session and asks the question again, so the model inspects the
// database instead of answering from memory (W7); on the newest exchange
// there is nothing after it to lose and it asks nothing, on an older one it
// asks through the danger confirm when a later exchange holds an answer or
// an error, the detail naming the count and the button naming the loss
// (WRITING rule 4, `Delete` because the rows are persisted like a thread's),
// then the store cuts after it and re-runs it. B3: the cut takes the canvas
// blocks those answers wrote too, so the detail counts them and its words
// live in the store, the one place that can count them (`restartConfirmText`,
// imported here and defined nowhere else). Jump Back is the bubble's own
// click made visible (DESIGN rule 8: a hidden gesture needs a visible route);
// the bubble owns the mode's entry (AnswerBlock arms the travel), so the
// button only asks for it. Restart and Jump Back disable while the thread
// is busy or the pane is in edit mode; Copy never does, and nothing hides
// (rule 2's matrix).
//
// Restart's glyph is lucide RotateCcw, reversing the W4 gate's call for the
// Repeat arrows (DECISIONS, W7): Restart now cuts the thread after this
// exchange, re-mints the session and asks the question again, and the
// counterclockwise arc is what rewind looks like. Threads keeps History, the
// same arc with clock hands: one pane, two verbs, told apart by the hands.
// RefreshCw stays the app's refresh glyph (TableBrowser, UpdateToast).

import { Copy, CornerUpLeft, RotateCcw } from "lucide-react";
import { copyCue } from "../lib/copyCue";
import { restartConfirmText, useAgent, type Exchange } from "../stores/agent";
import { confirmDanger } from "../stores/danger";

/** the shared layout id a bubble and the composer's edit ghost carry while
 * the words travel between them: AnswerBlock gives it to the bubble the frame
 * before edit begins, the composer side mounts under it while edit is on */
export const editLiftId = (exchangeId: string) => `ask-edit:${exchangeId}`;

/** the exchanges after one in its thread; empty for the newest */
function laterThan(threadId: string, exchangeId: string): Exchange[] {
  const list = useAgent.getState().exchanges[threadId] ?? [];
  const at = list.findIndex((e) => e.id === exchangeId);
  return at === -1 ? [] : list.slice(at + 1);
}

async function restart(threadId: string, exchangeId: string): Promise<void> {
  const later = laterThan(threadId, exchangeId);
  if (later.some((e) => e.answer !== null || e.error !== null)) {
    const t = restartConfirmText(later);
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
        <RotateCcw size={12} />
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
