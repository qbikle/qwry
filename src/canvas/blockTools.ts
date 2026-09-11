// Which tools a block's floating cluster carries, and in what order. One
// table, read by both kinds (AGENT-UX 16s): the membership of `.acts-float`
// is a fact about the KIND, and a list re-authored inside each component is
// how two clusters drift into two different orders and a third kind arrives
// with neither.
//
// Two rules keep the table honest. A tool a block has no content for is
// ABSENT, not disabled - a result with one face has no flip, a note has no
// SQL to insert - which is the rule every cluster already followed. And a
// surface that does not offer a tool simply hands no node for it: the pane's
// result block has no grip (it is not on a page), no Ask and no More, and
// asks for the same roster, so the pane and the canvas can never disagree
// about the ORDER of the ones they share.

/** every action the cluster can carry, in the one order they stand in */
export type BlockTool = "grip" | "copy" | "flip" | "insert" | "ask" | "more";

/** the kinds a canvas holds. `drawing` is C2b's, and joins this table rather
 * than a third component's own list */
export type BlockKind = "result" | "note" | "drawing";

const RESULT: readonly BlockTool[] = ["grip", "copy", "flip", "insert", "ask", "more"];
const NOTE: readonly BlockTool[] = ["grip", "copy", "ask", "more"];

/** the cluster's membership for a kind, in order. The grip is always its
 * first action: the one surface every kind drags by (DESIGN rule 8) */
export function kindTools(kind: BlockKind): readonly BlockTool[] {
  return kind === "result" ? RESULT : NOTE;
}
