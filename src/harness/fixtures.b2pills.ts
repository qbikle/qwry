// Pills builder's fixture for the B2 context wave (row 5 of the "B2 · context"
// section of ask-sketch-b2.html): the `.mention` pill wearing its KIND, drawn
// in the one home where all three of the wave's geometry risks meet at once.
//
//   b2-pill-icons  the composer holds `@order_v2 refunds vs @"Unpaid orders
//                  older than a week" on @"August finance"`, focused, the
//                  caret at its end, no popover: THREE kinds of pill in one
//                  draft, a table at position 0, a saved query long enough to
//                  break across the line at 320 and 392, and a canvas last.
//                  What the frame has to prove: the icon in the `@` cell moved
//                  no glyph (the table pill's left edge stands where
//                  `mention-first`'s stands, outdent and all), the wrapped
//                  pill keeps rounded ends on both fragments with the icon on
//                  the FIRST, the quotes of a quoted name are still painted
//                  (they are the user's glyphs, not the costume), and one line
//                  holds the whole draft at 560
//
// Three kinds and not five: `column` and `thread` wear the same span through
// the same code path, and a fourth and fifth pill in one draft would test the
// textarea's wrap, not the pill (DESIGN rule 11's sense applied to a fixture).
// The three chosen are the three that differ GEOMETRICALLY: an unquoted token
// at position 0, a quoted token the line breaks, and a quoted token that
// closes the draft.
//
// The canvas rides the `@` ladder's fifth rung, `block` (stores/ask.ts
// AskBlock): a canvas named in a question resolves out of the pane's session
// blocks, so the seed registers it the way `Ask` on a block does and the pill
// wears the LayoutGrid the canvas tab wears. B2 mints no new MentionKind for
// it; the popover's `canvases/` rows are the popover's business and item 6
// leaves the block rows to B3.
//
// The thread behind the composer is the discussion thread's first exchange,
// the same still `mention-draft` and `mention-first` stand over, so the three
// frames are one comparison and the re-shot pair can be read against this one
// at the same width without a second background in the way.
//
// Wiring (fixtures.ts / AskHarness.tsx / ask-frames.ts / tauriShim.ts are the
// integrator's): add B2_PILL_STATES to HarnessState, HARNESS_STATES and
// ask-frames' ALL_STATES; `choiceFor` returns ACTIONS_CHOICE for the state
// (the footer reads Haiku 4.5, as every W6 composer state does); in `seed`,
// `b2PillsSeed()` gives the schema store its `snapshot`, the agent store its
// `exchanges` under the fixture thread (busy false, phase null) and its
// `threads` for the connection, `useSaved.setState({ queries: seed.saved })`
// and `useAsk.setState({ blocks: seed.blocks })` (every other state resets
// both, so neither leaks into another frame); tauriShim answers
// `agent_thread_list` with `mentionThreadRows()` for it too, else the mount's
// loadThreads overwrites the three with the one; and the post-mount rAF calls
// `b2PillsAfterMount(state)` beside `mentionsAfterMount(state)`. It writes the
// draft through the store and asks for focus, the `mention-draft` shape, and
// opens no popover: the pills are the subject.
//
// Imports fixtures.mentions.ts for the one schema, bookmarks and threads of
// the W6 composer states (fixtures.edit.ts's precedent: read them inside
// functions, never at module scope).

import type { AskBlock } from "../stores/ask";
import type { Exchange } from "../stores/agent";
import { useAsk } from "../stores/ask";
import type { SavedQuery } from "../stores/saved";
import type { SchemaSnapshot } from "../stores/schema";
import type { Thread } from "../agent/types";
import { FIXTURE } from "./fixtures";
import { echoExchangesFor } from "./fixtures.echo";
import { MENTION_SNAPSHOT, mentionSaved, mentionThreads } from "./fixtures.mentions";

export const B2_PILL_STATES = ["b2-pill-icons"] as const;
export type B2PillState = (typeof B2_PILL_STATES)[number];

export interface B2PillsSeed {
  /** the thread, one exchange: the discussion thread's first */
  exchanges: Exchange[];
  /** the connection's schema: the W6 orders shape, `order_v2` and all */
  snapshot: SchemaSnapshot;
  /** the connection's bookmarks: the W6 pair plus the long-named one the
   * draft tags and the line breaks */
  saved: SavedQuery[];
  /** the connection's threads, newest first */
  threads: Thread[];
  /** useAsk.blocks: the canvas the draft names on the ladder's fifth rung */
  blocks: Record<string, AskBlock>;
  /** the composer's text */
  draft: string;
}

/** the long bookmark: 31 characters of name inside its quotes, so the pill
 * cannot fit one line of the 320 floor's composer and has to break */
const UNPAID_NAME = "Unpaid orders older than a week";
const UNPAID_SQL = [
  "SELECT id, user_id, total_amount, created_at",
  "FROM order_v2",
  "WHERE payment_status <> 'paid'",
  "  AND created_at < now() - interval '7 days'",
  "ORDER BY created_at;",
].join("\n");

/** the canvas the draft names last. A canvas block's `name` is what the token
 * quotes, and this one is a month's board rather than a run, so it carries a
 * note's words and no statement (BlockRef: `sql` absent on a note) */
const AUGUST_FINANCE: AskBlock = {
  id: "harness-block-august-finance",
  name: "August finance",
  text: "Refunds ran 1.1% of August revenue, all of it INR.",
};

export function b2PillsSeed(): B2PillsSeed {
  const first = echoExchangesFor("echo")[0];
  if (!first) throw new Error("fixtures.b2pills: the echo thread is empty");
  return {
    exchanges: [first],
    snapshot: MENTION_SNAPSHOT,
    saved: [
      ...mentionSaved(),
      {
        id: "harness-saved-unpaid-orders",
        name: UNPAID_NAME,
        sql: UNPAID_SQL,
        created_at: "2026-08-28T10:15:00Z",
        profile_id: FIXTURE.profile.id,
      },
    ],
    threads: mentionThreads(),
    blocks: { [AUGUST_FINANCE.id]: AUGUST_FINANCE },
    draft: `@order_v2 refunds vs @"${UNPAID_NAME}" on @"${AUGUST_FINANCE.name}"`,
  };
}

/** the post-mount hook: the draft through the store and focus, the way a
 * keystroke leaves the composer; no popover (the pills are the subject) */
export function b2PillsAfterMount(state: string): void {
  if (!(B2_PILL_STATES as readonly string[]).includes(state)) return;
  const a = useAsk.getState();
  a.setDraft(b2PillsSeed().draft);
  a.requestFocus();
}
