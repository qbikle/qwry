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
// The drawing's TOOLS are not in this table (F3, AGENT-UX 16x): they stand in
// the tool island at the paper's top-left (ToolIsland.tsx), which reads the
// rows below for their labels and chords, so the cluster is the same six
// actions on a drawing as everywhere else, minus what the other kinds have no
// use for. C2b seated the tools here as one `Pen ▾` slot whose menu held the
// six; the island is that menu standing where the tools are used, and the
// slot went with the menu.

/** every action the cluster can carry, in the one order they stand in */
export type BlockTool = "grip" | "undo" | "redo" | "copy" | "flip" | "insert" | "ask" | "more";

/** the kinds a canvas holds. `drawing` is C2b's: ink is not a view of prose,
 * so it is the third species and not a second face of the note */
export type BlockKind = "result" | "note" | "drawing";

const RESULT: readonly BlockTool[] = ["grip", "copy", "flip", "insert", "ask", "more"];
const NOTE: readonly BlockTool[] = ["grip", "copy", "ask", "more"];
// 6 slots: 16 + 6 x 18 + 5 x 4 + 4 = 148px, inside the 235px a two-cell
// drawing stands on at the 640 floor (2 x 111.6 + 12). The kind's minimum
// stays the 2x2 the engine already holds it to, now for the island's sake as
// much as the cluster's: 201px open against the 202 a two-row block stands on
// (DESIGN rule 13; the frames c2-draw-small and f3-island-floor are the
// evidence)
const DRAWING: readonly BlockTool[] = ["grip", "undo", "redo", "copy", "ask", "more"];

/** the cluster's membership for a kind, in order. The grip is always its
 * first action: the one surface every kind drags by (DESIGN rule 8) */
export function kindTools(kind: BlockKind): readonly BlockTool[] {
  return kind === "result" ? RESULT : kind === "drawing" ? DRAWING : NOTE;
}

// ---- the drawing's own eight -----------------------------------------------

/** what a press on the sheet makes, or, for `select` and `eraser`, what it
 * takes hold of and what it takes away (F3, AGENT-UX 16x, 16jj). Six marks,
 * which is the least that covers marking up a chart and stops: a shape, a
 * line that points, a line that does not, and words; plus one hand and one
 * eraser. Undo takes the LAST stroke and `Clear…` takes them all; what
 * neither could do is take the third stroke of five without taking the two
 * after it, which is what a hand marking up a chart asks for most (the
 * maintainer's own call: the eraser is its own slot, never a branch of the
 * hand, "selection tool should never be branched, it should be 1 click"). */
export type DrawTool = "select" | "pen" | "rect" | "ellipse" | "line" | "arrow" | "text" | "eraser";

/** one tool the island can arm: what it is called and the one key that arms
 * it while the drawing has focus. The chord is a SPEC for <Kbd>, never a
 * glyph typed into JSX (DESIGN rule 7); the glyph itself lives with the
 * component that draws it (ToolIsland.tsx GLYPH). */
export interface DrawToolRow {
  tool: DrawTool;
  label: string;
  chord: string;
}

/** the tools, in the island's own order: the hand first, the freehand second
 * because it is what a sheet is for, then the two shapes, then the two lines,
 * then the words. The keys are the platform's own (Preview, Freeform,
 * Excalidraw all read `v` as select, `r` as a rectangle and `t` as text), so a
 * hand that has drawn anywhere else already knows them and no sentence
 * teaches them (DESIGN rule 11) */
export const DRAW_TOOLS: readonly DrawToolRow[] = [
  { tool: "select", label: "Select", chord: "v" },
  { tool: "pen", label: "Pen", chord: "p" },
  { tool: "rect", label: "Rectangle", chord: "r" },
  { tool: "ellipse", label: "Ellipse", chord: "o" },
  { tool: "line", label: "Line", chord: "l" },
  { tool: "arrow", label: "Arrow", chord: "a" },
  { tool: "text", label: "Text", chord: "t" },
  { tool: "eraser", label: "Eraser", chord: "e" },
];

/** the tool one key arms, or null for a key that is not one of the eight. The
 * drawing swallows only the keys it owns (LESSONS 10): every `⌘`/`⌃` chord
 * bubbles, and so does every letter this returns null for */
export function toolForKey(key: string): DrawTool | null {
  const k = key.toLowerCase();
  return DRAW_TOOLS.find((t) => t.chord === k)?.tool ?? null;
}

/** what the island's ink members are called, in the ladder's own order. The
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

/** and its weights, named rather than numbered: a tooltip saying `2` says
 * nothing, and the member's own rule draws the number anyway. The widths are
 * strokes.ts WEIGHTS, at the same six indexes: three rungs were a ladder with
 * no middle, and the middle is where a hand marking up a chart lives */
export const WEIGHT_STEPS: readonly { label: string }[] = [
  { label: "Hairline" },
  { label: "Fine" },
  { label: "Line" },
  { label: "Bold" },
  { label: "Marker" },
  { label: "Brush" },
];
