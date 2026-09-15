// The answer's own actions (W7 item 2, A3 item 3): Copy · Save Query · Add
// to Canvas, the icon-button species in its 18px tier, floating at the
// prose's top-right and revealed the
// way every cluster in the pane is (ask.css .acts-float, the block's and the
// bubble's). They act on the EXCHANGE, and the prose is the exchange's voice,
// so they ride it; on the thinking strip they would cover the newest chip and
// read as trace tools (DECISIONS, W7). Nothing else joins them: the SQL's
// three actions live on the result block, where the SQL is.
//
// Copy writes the answer as markdown, the prose the slot says (display's one
// projection, answerText) with the statement under it in a sql fence, through
// the app's one copy path so the cue is not optional (LESSONS 9). Save Query
// puts that statement in the sidebar under the question as its name; pressing
// it twice writes the same row, not a twin, because a saved query of one name
// over one statement is one saved query. It is DISABLED, never hidden, on an
// answer that ran nothing (DESIGN rule 2's matrix); Copy never disables.
//
// Save Query wears lucide Bookmark, the sidebar's saved-query glyph, so the
// verb and its noun carry one mark.
//
// W A2: the save also keeps the QUESTION on the row, which is what makes it a
// quick-ask; nothing new stands here for it (the button, its glyph and its cue
// are unchanged), because a second save action for a second kind of row is the
// second block DESIGN rule 15 refuses.
//
// Add to Canvas (A3 item 3) is the third, 2 hot to 3, still 0 at rest. It
// does not merge with Save Query: a saved query is the editor's artefact and
// a block is the document's, and a `Save ▾` would be a menu holding two rows
// (DECISIONS, A3). It wears lucide LayoutGrid, the canvas tab's own glyph, so
// the action and the place it lands carry one mark, and it does NOT switch
// tabs: the answer is added while the reader keeps reading. The cue says
// which canvas took it (`Added to Canvas` / `Added to a new canvas`), through
// the app's one cue path, because an action with no visible result is an
// action the user must go and check (LESSONS 9). The canvas document store
// owns WHERE the block lands (`addExchange` opens a canvas when the
// connection has none and drops a reply under the block it was asked from)
// and is reached through canvas/port.ts, so the pane never imports it; this
// file owns the button and what the cue says, and an add that lands nothing
// says the store's own sentence rather than a cheerful lie.

import { Bookmark, Copy, LayoutGrid } from "lucide-react";
import { loadCanvasPort } from "../canvas/port";
import { copyCue, copyCueShow } from "../lib/copyCue";
import { useSaved } from "../stores/saved";

/** the saved query's name is the question, capped where a thread's title is
 * capped (stores/agent): one length for a row named by what was asked */
const NAME_CAP = 80;

export function savedQueryName(question: string): string {
  const q = question.trim();
  return q.length > NAME_CAP ? `${q.slice(0, NAME_CAP)}…` : q;
}

/** the clipboard face of an answer: what the slot says, then the statement it
 * says it about, in the fence a reader can paste anywhere */
export function answerMarkdown(prose: string, sql: string | null): string {
  return sql ? `${prose ? `${prose}\n\n` : ""}\`\`\`sql\n${sql}\n\`\`\`` : prose;
}

async function saveQuery(question: string, sql: string): Promise<void> {
  const name = savedQueryName(question);
  const saved = useSaved.getState();
  const twin = saved.queries.find((q) => q.name === name && q.sql === sql);
  try {
    // the question travels with the statement (A2 item 6a): a saved query that
    // kept the question it answered is a quick-ask, told apart in the palette's
    // Saved group by the glyph it wears and asked again with ⌘↩. One save, one
    // list, no second action (DESIGN rule 15)
    await saved.upsert({
      id: twin?.id ?? crypto.randomUUID(),
      name,
      sql,
      profile_id: twin?.profile_id,
      question: question.trim(),
    });
    copyCueShow("Saved");
  } catch {
    copyCueShow("save failed");
  }
}

export interface AnswerActionsProps {
  /** the exchange Add to Canvas appends: the block is built from it, and the
   * canvas it lands on is that exchange's own connection's (LESSONS 4) */
  exchangeId: string;
  /** the exchange's question: the saved query's name */
  question: string;
  /** the prose exactly as the slot says it (agent/display answerText) */
  prose: string;
  /** the statement the answer ran, null when it answered without one: Save
   * Query is then disabled */
  sql: string | null;
}

export function AnswerActions({ exchangeId, question, prose, sql }: AnswerActionsProps) {
  return (
    <div className="acts-float">
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Copy"
        aria-label="Copy"
        onClick={() => void copyCue(answerMarkdown(prose, sql), "Copied answer")}
      >
        <Copy size={12} />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Save Query"
        aria-label="Save Query"
        disabled={sql === null}
        onClick={() => {
          if (sql !== null) void saveQuery(question, sql);
        }}
      >
        <Bookmark size={12} />
      </button>
      <button
        type="button"
        className="iconbtn iconbtn-sm"
        title="Add to Canvas"
        aria-label="Add to Canvas"
        onClick={() => {
          void loadCanvasPort().then((port) => {
            if (!port) return;
            const landing = port.addExchange(exchangeId);
            if (!landing.ok) copyCueShow(landing.message ?? "nothing to add");
            else copyCueShow(landing.created ? "Added to a new canvas" : "Added to Canvas");
          });
        }}
      >
        <LayoutGrid size={12} />
      </button>
    </div>
  );
}
