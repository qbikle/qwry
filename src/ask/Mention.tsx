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

import { mentionSegments, type Mention } from "../agent/mentions";

export interface MentionTextProps {
  text: string;
  /** the mentions that resolved in `text`; empty renders the bare string */
  mentions: readonly Mention[];
}

/** the text with a `.mention` span around each resolved mention and nothing
 * else changed: whitespace and line breaks are the parent's to keep
 * (`white-space: pre-wrap` on the bubble and the backdrop) */
export function MentionText({ text, mentions }: MentionTextProps) {
  if (mentions.length === 0) return text;
  return mentionSegments(text, mentions).map((s, i) =>
    s.mention ? (
      <span key={i} className="mention">
        {s.text}
      </span>
    ) : (
      s.text
    ),
  );
}
