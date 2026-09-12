// Which tools a block's floating cluster carries, and in what order. One
// table, read by all three kinds (AGENT-UX 16s): the membership of
// `.acts-float` is a fact about the KIND, and a list re-authored inside each
// component is how two clusters drift into two different orders and a third
// kind arrives with neither.
//
// Two rules keep the table honest. A tool a block has no content for is
// ABSENT, not disabled - a result with one face has no flip, a note has no
// SQL to insert, a drawing has no Ask where the chosen model cannot read an
// image (C2b, DESIGN rule 2's matrix: a capability that does not exist has no
// button) - which is the rule every cluster already followed. And a surface
// that does not offer a tool simply hands no node for it: the pane's result
// block has no grip (it is not on a page), no Ask and no More, and asks for
// the same roster, so the pane and the canvas can never disagree about the
// ORDER of the ones they share.
//
// The drawing's picker is IN this table rather than beside it (C2b call 2):
// its tools stand in the cluster the other two kinds already have, so the
// canvas gains 0 strips and 0 controls at rest for a kind that draws. Its
// REVEAL is the one thing that differs: focus-within and [data-hot] only,
// never a bare hover, because a pointer crossing a sheet mid-stroke is not a
// request to see the picker (AGENT-UX 16x, drawing.css). `Pen ▾` is ONE slot and not six: the tool and its ink
// are its menu (DESIGN rule 15, consolidate before you add), which is what
// holds the drawing's cluster to seven slots and its floor to two cells.

/** every action the cluster can carry, in the one order they stand in */
export type BlockTool = "grip" | "pen" | "undo" | "redo" | "copy" | "flip" | "insert" | "ask" | "more";

/** the kinds a canvas holds. `drawing` is C2b's: ink is not a view of prose,
 * so it is the third species and not a second face of the note */
export type BlockKind = "result" | "note" | "drawing";

const RESULT: readonly BlockTool[] = ["grip", "copy", "flip", "insert", "ask", "more"];
const NOTE: readonly BlockTool[] = ["grip", "copy", "ask", "more"];
// 7 slots: 16 + 7 x 18 + 6 x 4 + 4 = 170px, inside the 235px a two-cell
// drawing stands on at the 640 floor (2 x 111.6 + 12), so the kind's minimum
// is the 2x2 the engine already holds it to and no cluster changes shape
// under it (DESIGN rule 13; the frame c2-draw-small is the evidence)
const DRAWING: readonly BlockTool[] = ["grip", "pen", "undo", "redo", "copy", "ask", "more"];

/** the cluster's membership for a kind, in order. The grip is always its
 * first action: the one surface every kind drags by (DESIGN rule 8) */
export function kindTools(kind: BlockKind): readonly BlockTool[] {
  return kind === "result" ? RESULT : kind === "drawing" ? DRAWING : NOTE;
}

// ---- the drawing's own six -------------------------------------------------

/** what a press on the sheet makes. Six, which is the least that covers
 * marking up a chart and stops: a shape, a line that points, a line that does
 * not, and words. There is no eraser (Undo takes the last stroke and `Clear…`
 * takes them all) and no select tool this wave (AGENT-UX 16v, open). */
export type DrawTool = "pen" | "rect" | "ellipse" | "line" | "arrow" | "text";

/** one row of the `Pen ▾` menu: what the tool is called and the one key that
 * arms it while the drawing has focus. The chord is a SPEC for <Kbd>, never a
 * glyph typed into JSX (DESIGN rule 7). The glyph itself lives with the
 * component that draws it (Drawing.tsx GLYPH), and this is the one menu in
 * the app whose rows wear one: elsewhere a row carries a label, a hint and an
 * arrow and no icon column (compareMenu.tsx's reading), but here the glyph IS
 * the shape the row hands you (AGENT-UX 16x). */
export interface DrawToolRow {
  tool: DrawTool;
  label: string;
  chord: string;
}

/** the ladder, in the order the menu stands in: the freehand first because it
 * is what a sheet is for, then the two shapes, then the two lines, then the
 * words. The keys are the platform's own (Preview, Freeform, Excalidraw all
 * read `r` as a rectangle and `t` as text), so a hand that has drawn anywhere
 * else already knows them and no sentence teaches them (DESIGN rule 11) */
export const DRAW_TOOLS: readonly DrawToolRow[] = [
  { tool: "pen", label: "Pen", chord: "p" },
  { tool: "rect", label: "Rectangle", chord: "r" },
  { tool: "ellipse", label: "Ellipse", chord: "o" },
  { tool: "line", label: "Line", chord: "l" },
  { tool: "arrow", label: "Arrow", chord: "a" },
  { tool: "text", label: "Text", chord: "t" },
];

/** the tool one key arms, or null for a key that is not one of the six. The
 * drawing swallows only the keys it owns (LESSONS 10): every `⌘`/`⌃` chord
 * bubbles, and so does every letter this returns null for */
export function toolForKey(key: string): DrawTool | null {
  const k = key.toLowerCase();
  return DRAW_TOOLS.find((t) => t.chord === k)?.tool ?? null;
}

/** what the picker's ink rows are called, in the ladder's own order. The
 * ladder itself is the drawing's (strokes.ts INK_VAR: the accent at three
 * alphas, defined in CSS so a theme flip repaints the ink and the chart
 * beside it together); these are the words for it, and the index into both is
 * what the document stores. Numbered where the weights are named, because a
 * percentage of the accent says exactly what it is and `2` does not */
export const INK_STEPS: readonly { label: string }[] = [
  { label: "Accent" },
  { label: "Accent 78%" },
  { label: "Accent 56%" },
];

/** and its weights, named rather than numbered: a menu row saying `2` says
 * nothing, and the rule in its hint slot draws the number anyway. The widths
 * are strokes.ts WEIGHTS, at the same three indexes */
export const WEIGHT_STEPS: readonly { label: string }[] = [
  { label: "Hairline" },
  { label: "Line" },
  { label: "Marker" },
];
