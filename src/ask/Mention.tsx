// The @ mention chip (W6; AGENT-UX section 2 item 1): a run of the user's own
// text wearing the pill that says it resolved to something (a table, a column,
// a saved query, a thread, or a canvas block). One face, two homes: the
// composer's backdrop paints it behind the draft's glyphs while the textarea
// stays the source of truth, and the question echo wears it in the bubble, so
// the lift on send carries one face into the exchange. The pill is a marked
// span of selectable text, never a control (DESIGN rule 8's inverse): no
// role, no hover, no font of its own. The glyphs stay the surrounding text's,
// because a backdrop set in mono would drift off the glyphs it paints behind;
// the `@`, the quotes around a two-word name and the accent-soft fill are the
// data costume (WRITING, identifiers inside chrome). An `@word` that resolved
// to nothing gets no span and renders as the plain text it is (LESSONS 5:
// stale never refuses).
//
// The cut of the text at its resolved spans is mentions.ts's one
// `mentionSegments`, which the backdrop renders over too, so the two homes
// cannot disagree about where a pill starts.
//
// A canvas block (A3 item 4) is the ladder's fifth rung and wears the SAME
// pill: a block named in a question is the same kind of fact as a table named
// in one, and a second pill face would be two costumes for one idea. Nothing
// here changed for it; the resolver grew a rung and this file kept drawing
// what it resolved.
//
// B2 item 4 reverses W7's icon-less pill: the pill wears its KIND, one face in
// all three homes. W7's objection was geometric and stands (an icon can be
// drawn only where a glyph is drawn, or the backdrop's pills drift off the
// textarea's letters), so the icon takes the `@`'s own cell: the `@` keeps its
// advance and goes transparent, the icon is centred on it, and not one glyph
// moves. The kind is what the popover's row showed at the moment of the pick
// (MentionPopover's rows, the same glyphs at the same --icon-sm), and it says
// what no name can: `@"August finance"` is a canvas or a saved query and the
// icon is the whole difference. One span inside the pill, no pixels of layout
// (rule 15: the cell was already paid for).
//
// The map is exported because the popover's rows and this pill must not drift:
// one kind, one glyph, wherever it is drawn (rule 1, one species).

import { Bookmark, Columns3, LayoutGrid, MessageSquare, SquareTerminal, Table2, type LucideIcon } from "lucide-react";
import { mentionSegments, type Mention } from "../agent/mentions";
import type { MentionKind } from "../agent/types";

/** The glyph each kind wears, the sidebar's and the titlebar's own: a saved
 * query is the Bookmark it is saved under, a thread the chat bubble Ask opens
 * with, a canvas block the LayoutGrid the canvas tab wears, a query tab the
 * SquareTerminal the tab strip gives it. All six kinds, `tab` included: a tab
 * is never TYPED (it is minted by `Explain with Ask`, so the popover has no
 * row for it, AGENT-UX 15) but it IS drawn, and a pill with no glyph would be
 * one kind wearing a different face. */
export const MENTION_ICON: Record<MentionKind, LucideIcon> = {
  table: Table2,
  column: Columns3,
  saved: Bookmark,
  thread: MessageSquare,
  tab: SquareTerminal,
  block: LayoutGrid,
};

export interface MentionTextProps {
  text: string;
  /** the mentions that resolved in `text`; empty renders the bare string */
  mentions: readonly Mention[];
}

/** one pill: the kind's glyph inside the `@`'s cell (ask.css .mention-at),
 * then the token exactly as the user typed it, quotes and all. The span's
 * text opens with the `@` by the grammar's own contract (mentions.ts: every
 * span carries its leading `@`), so the slice needs no guard */
function Pill({ text, kind }: { text: string; kind: MentionKind }) {
  const Kind = MENTION_ICON[kind];
  return (
    <span className="mention">
      <span className="mention-at">
        <Kind size={12} />
        {text.slice(0, 1)}
      </span>
      {text.slice(1)}
    </span>
  );
}

/** the text with a `.mention` span around each resolved mention and nothing
 * else changed: whitespace and line breaks are the parent's to keep
 * (`white-space: pre-wrap` on the bubble and the backdrop) */
export function MentionText({ text, mentions }: MentionTextProps) {
  if (mentions.length === 0) return text;
  return mentionSegments(text, mentions).map((s, i) =>
    s.mention ? <Pill key={i} text={s.text} kind={s.mention.kind} /> : s.text,
  );
}
