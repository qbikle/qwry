// The tool island (F3): the drawing's tools at the paper's top-left, as ONE
// button that unfolds. It is a new species (DESIGN rule 1, "Tool island"),
// because the app had no register for a raised box of tools that is one thing
// at rest and seven things in reach: the cluster is a row of ghosts on the
// surface it acts on, a menu is a list that opens and closes, and this is
// neither. It stands 12 in from both of the widget's lines (the block's own
// box already does, grid.css), and at rest it is the armed tool alone, 24px,
// its chord letter at its foot: what a press on the paper will make, legible
// without a single sentence (rule 11).
//
// It opens on REACH, not on a click. A pointer coming within 40px of the
// footprint the island will have once open is a hand coming for a tool, and
// the island meets it halfway: the armed tool slides DOWN to the slot that is
// its own (Select, Pen, Shapes, Text, Eraser, then a hairline, then Ink and
// Weight, one order for ever) while the others appear at theirs and drop in,
// and the body grows to hold them. A hand that leaves takes the island with it
// after 160ms, the siblings fading where they stand and the armed tool sliding
// home; a stroke starting takes it at once. A FAMILY (Shapes, Ink, Weight)
// never opens on reach: a click on its slot hands the slot's glyph to an arm
// that grows rightward at that row, the same fold turned sideways, and picking
// a member folds it again. Reach is a question of where the hand is; a family
// is a choice, and a choice is a click.
//
// The motion is two springs, asymmetric on purpose (springs.ts): the way OUT
// rides `spring.rail` (ζ .63, a whisper of overshoot into room the body has
// already made) and the way home rides `spring.snappy` (ζ .93, calm, and never
// past the island's own edge). ONLY THE ARMED TOOL TRAVELS. A sibling stands
// 6px above its own slot and drops into it; it never rides the column behind
// the armed tool, and on the way home it fades where it stands rather than
// flying back up under it. That is the maintainer's "double sliding" recording
// (2026-09-18) written as a rule: two things moving along one line at two
// speeds read as a list being shuffled, not as a box opening.
//
// What the sketch could not do and this tree can (its transitions ran on
// separate clocks) is COUPLE the fold to the box: the armed tool's rendered
// coordinate is clamped against the body's own motion value, so it can never
// stand outside the box that holds it, and a sibling is revealed by the BODY
// reaching its slot rather than by a stagger somebody typed, so nothing is
// ever drawn on paper the island has not grown over yet. The body's spring
// decelerates, so the reveal staggers itself, top to bottom, and the stagger
// is the spring's own shape instead of a second number to keep in step with it
// (LESSONS 7: write the value where it lives; DESIGN rule 14: one number, one
// home).
//
// State stays where it is: the tool, the ink and the weight are the block's
// (`updateDrawing`), the open flag is the host's, and the only thing this
// component owns is which arm stands open. A press on a tool never takes the
// focus off the paper (`onMouseDown` preventDefault, which is what WebKit does
// on its own): the chords go on answering after a pick, and Tab still reaches
// every visible slot, which is the keyboard's route in (rule 8).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { ArrowUpRight, Circle, Eraser, Minus, MousePointer2, Pen, Square, Type } from "lucide-react";
import { Kbd } from "../design/Kbd";
import { spring } from "../design/springs";
import { DRAW_TOOLS, INK_STEPS, WEIGHT_STEPS, toolForKey, type DrawTool } from "./blockTools";
import { INK_VAR, WEIGHTS } from "./strokes";
import "./toolIsland.css";

// ---- the roster ------------------------------------------------------------

/** the four the Shapes arm holds, in the arm's own order */
export type Shape = "rect" | "ellipse" | "line" | "arrow";
export const SHAPES: readonly Shape[] = ["rect", "ellipse", "line", "arrow"];

/** every tool the island can arm. `select` and `eraser` are F3's own and
 * stand in `DrawTool` beside C2b's six, so the island and the sheet's own
 * chord table speak one type (DESIGN rule 14) */
export type IslandTool = DrawTool;

/** the three slots that open an arm rather than arm a tool */
export type Family = "shapes" | "ink" | "weight";

/** the seven slots, top to bottom. One list, so the order the tools stand in
 * and the order they drop in are one fact */
export type SlotId = "select" | "pen" | "shapes" | "text" | "eraser" | "ink" | "weight";
interface SlotDef {
  id: SlotId;
  label: string;
  family?: Family;
}
export const ROSTER: readonly SlotDef[] = [
  { id: "select", label: "Select" },
  { id: "pen", label: "Pen" },
  { id: "shapes", label: "Shapes", family: "shapes" },
  { id: "text", label: "Text" },
  { id: "eraser", label: "Eraser" },
  { id: "ink", label: "Ink", family: "ink" },
  { id: "weight", label: "Weight", family: "weight" },
];
/** how many of the slots are TOOLS: the hairline stands after them, and the
 * two property slots after that */
export const TOOL_SLOTS = ROSTER.filter((s) => s.id !== "ink" && s.id !== "weight").length;

/** the glyph each tool wears, here and nowhere else now that `Pen ▾` has left
 * the cluster: the slot shows the armed tool's, the arm's members their own */
export const GLYPH: Record<IslandTool, typeof Pen> = {
  select: MousePointer2,
  pen: Pen,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: ArrowUpRight,
  text: Type,
  eraser: Eraser,
};

/** the one key that arms a tool, as a spec for <Kbd> (rule 7), and its name:
 * both read off the sheet's own chord table, never restated here */
const rowOf = (tool: IslandTool) => DRAW_TOOLS.find((t) => t.tool === tool);
export const chordOf = (tool: IslandTool): string => rowOf(tool)?.chord ?? "v";
export const labelOf = (tool: IslandTool): string => rowOf(tool)?.label ?? "Pen";

const isShape = (tool: IslandTool): tool is Shape => (SHAPES as readonly string[]).includes(tool);

/** the row a family's arm grows from: the roster's own ordinal, so adding a
 * slot moves the arms with it (DESIGN rule 14) */
export const rowOfFamily = (family: Family): number => ROSTER.findIndex((s) => s.family === family);

// ---- the geometry ------------------------------------------------------------
//
// 24px tools on a 28px pitch inside 4px of padding, a 9px separator row (4,
// a hairline, 4) between the five tools and the two properties. The body
// paints 1px OUTSIDE the padding box on every side, so its hairline never eats
// into the 4 and the numbers below stay the sketch's: 32 at rest, 205 open.
// The tool is 24 and not 28 because seven slots have to stand inside the 2x2
// floor (DESIGN rule 13, and the sketch's own addendum: a control the floor
// cannot show is a control that does not exist).

export const TOOL = 24;
export const PITCH = 28;
export const PAD = 4;
export const SEP_H = 9;
/** the glyph inside a tool: `--icon-sm`, the app's dense size (DESIGN rule
 * 5), restated as a number because lucide takes one. 12 and not 14 because
 * the tool is a 24px CIRCLE now and a 14px glyph in it leaves 5px of arc a
 * side, which is not room for the chord letter under it (toolIsland.css) */
export const GLYPH_PX = 12;
/** the island's padding box: one tool and its padding, both axes at rest */
export const ISLAND_W = TOOL + 2 * PAD;
/** how far the pointer may stand off the OPEN footprint and still be reaching */
export const REACH = 40;
/** how far a pointer may stand off an OPEN ARM and still be reaching. The
 * arm's own box is tighter than the island's because the arm is already the
 * answer to a click: a halo as wide as the island's would hold the island open
 * from most of the paper beside it */
export const ARM_REACH = 24;
/** how long the island waits for a hand that left before it folds */
export const GRACE_MS = 160;
/** how far above its own slot a folded sibling stands: it drops this far and
 * no further, and travels nothing else, ever */
const LIFT = 6;

/** slot i's top, inside the island's padding box */
export const slotY = (i: number): number => PAD + i * PITCH + (i >= TOOL_SLOTS ? SEP_H - PAD : 0);
/** member j's left, inside an arm's padding box */
export const memberX = (j: number): number => PAD + j * PITCH;
/** the separator's own line */
export const SEP_Y = slotY(TOOL_SLOTS - 1) + TOOL + PAD;
/** the island's padding box when open */
export const OPEN_H = slotY(ROSTER.length - 1) + TOOL + PAD;
/** an arm's padding box when open, for n members */
export const armW = (n: number): number => 2 * PAD + n * TOOL + (n - 1) * (PITCH - TOOL);

/** the body's own extent along the fold's axis: the padding box plus the
 * hairline on each side */
const bodyOf = (inner: number): number => inner + 2;
/** how far a tool's leading edge may travel before it would cross the body's
 * inner padding: the body's far edge, less its hairline, its padding and the
 * tool itself. The clamp that makes "never clipped" arithmetic */
const LEAD_INSET = TOOL + PAD + 2;
/** the body has grown over the slot at `at`: past this, a sibling standing
 * there is inside the box, and before it, it would be ink on the paper. The
 * padding is added back on the body's side because a STANDING tool needs the
 * box to reach its own far edge and no further, where a TRAVELLING one (the
 * clamp above) keeps a padding of headroom. Without that, the last slot's
 * gate would sit exactly on the body's final value, and `snappy`'s own
 * 0.04% overshoot dips back under it for two frames: a hairline of arithmetic
 * that would read as a blink (LESSONS 7) */
const coversSlot = (body: number, at: number): boolean => body + PAD >= at + LEAD_INSET;

// ---- the fold ------------------------------------------------------------
//
// One choreography for the island (down) and for an arm (right), and two
// parts to it.
//
// The LEAD (the armed tool, the one thing standing at rest) is the only item
// that travels: it slides from the island's own edge to its slot on the way
// out and back on the way home, its rendered coordinate clamped against the
// body's own motion value, `max(PAD, min(own, body - LEAD_INSET))`, which is
// the invariant the probe reads and the reason it can never be drawn outside
// the box.
//
// A SIBLING never travels. It waits 6px above its own slot at .9 and drops in
// once the BODY has grown over that slot, and it fades where it stands on the
// way home. Two items sliding along one line at two speeds is the "double
// sliding" the maintainer's recording caught, and the cure is not a slower
// spring, it is one traveller. The reveal is gated on the body rather than on
// a stagger anybody typed (`coversSlot`): the body's spring decelerates, so
// the slots light up top to bottom on their own, and there is no second
// number to keep in step with the first. The same gate multiplies the fade,
// so a sibling the shrinking body has passed is gone whether or not its own
// fade has finished: the box is never drawn empty and nothing is ever drawn
// outside it (the maintainer's two recordings, both).
//
// A change of lead while the island is FOLDED is one rest button becoming
// another, so neither of the two rides anywhere: the incoming one stands at
// the rest seat at once and the outgoing one is put back above its own slot,
// unseen.

interface FoldProps {
  open: boolean;
  /** this tool is the one that stands alone at rest */
  lead: boolean;
  /** its coordinate once open */
  at: number;
  body: MotionValue<number>;
  axis: "y" | "x";
  className: string;
  data: Record<string, string | undefined>;
  children: ReactNode;
}

function Fold({ open, lead, at, body, axis, className, data, children }: FoldProps) {
  // folded, the lead stands at the rest seat and everything else just above
  // its own slot; open, everything stands at its own slot
  const pos = useMotionValue(open ? at : lead ? PAD : at - LIFT);
  const scale = useMotionValue(open || lead ? 1 : 0.9);
  const opacity = useMotionValue(open || lead ? 1 : 0);
  const was = useRef(lead);
  useLayoutEffect(() => {
    const swapped = lead !== was.current;
    was.current = lead;
    const stops: { stop: () => void }[] = [];
    if (lead) {
      opacity.jump(1);
      scale.jump(1);
      // a rest button becoming another rides nothing: it IS the rest button
      if (!open && swapped) pos.jump(PAD);
      else stops.push(animate(pos, open ? at : PAD, open ? spring.rail : spring.snappy));
    } else if (!open) {
      if (swapped) {
        pos.jump(at - LIFT);
        scale.jump(0.9);
        opacity.jump(0);
      } else {
        // the fade is in place: the 6px is the drop, not a journey home
        stops.push(animate(pos, at - LIFT, spring.quick), animate(scale, 0.9, spring.quick), animate(opacity, 0, spring.quick));
      }
    } else {
      // the body's own spring is the clock: the slot lights up the frame the
      // box reaches it, and the stagger is the spring's deceleration. The
      // subscription outlives the drop (a flag, not an unsubscribe inside the
      // callback): removing a listener DURING a notification skips the next
      // one, and under reduced motion the body's whole travel is one
      // notification, so the last member of an arm never heard it. A frame
      // caught that, not the reasoning (LESSONS 12: one review is not review)
      let dropped = false;
      const drop = (b: number) => {
        if (dropped || !coversSlot(b, at)) return;
        dropped = true;
        stops.push(animate(pos, at, spring.snappy), animate(scale, 1, spring.snappy), animate(opacity, 1, spring.quick));
      };
      stops.push({ stop: body.on("change", drop) });
      drop(body.get());
    }
    return () => stops.forEach((s) => s.stop());
  }, [open, lead, at, body, pos, scale, opacity]);
  // the LEAD's floor at PAD is absolute and its ceiling follows the body, in
  // that order: the body's own spring lands a hundredth of a pixel short of
  // home for a frame, and a ceiling that won there would stand the tool that
  // much above the island's edge, which is the one thing the fold promises
  // never to do (the probe caught 3.97)
  const clamped = useTransform([pos, body], ([p, b]) =>
    Math.max(PAD, Math.min(p as number, (b as number) - LEAD_INSET)),
  );
  // a sibling needs no clamp because it needs no journey: the body gates its
  // opacity instead, which is the same promise kept by not being SEEN outside
  // the box rather than by being dragged along its edge
  const gated = useTransform([opacity, body], ([o, b]) => (coversSlot(b as number, at) ? (o as number) : 0));
  const shown = lead ? clamped : pos;
  const seen = lead ? opacity : gated;
  const style = axis === "y" ? { y: shown, scale, opacity: seen } : { x: shown, scale, opacity: seen };
  return (
    <motion.div className={className} style={style} {...data}>
      {children}
    </motion.div>
  );
}

/** the body's own value, animated on `snappy` from the fold's host. `onHome`
 * hears the fold LAND (an arm hides itself only once its member is back
 * under the slot, below); a fold that is cut short by a reopen never fires it */
function useBody(open: boolean, to: number, onHome?: () => void): MotionValue<number> {
  const body = useMotionValue(bodyOf(open ? to : ISLAND_W));
  useLayoutEffect(() => {
    let live = true;
    const run = animate(body, bodyOf(open ? to : ISLAND_W), spring.snappy);
    if (!open && onHome)
      void run.then(() => {
        if (live) onHome();
      });
    return () => {
      live = false;
      run.stop();
    };
  }, [open, to, body, onHome]);
  return body;
}

// ---- the buttons ---------------------------------------------------------

interface ToolButtonProps {
  label: string;
  /** the chord, as a spec for <Kbd>; a property slot has none */
  chord?: string;
  active: boolean;
  /** the slot whose arm stands open: its glyph is the arm's now */
  handed?: boolean;
  tabIndex: number;
  onClick: () => void;
  haspopup?: boolean;
  expanded?: boolean;
  children: ReactNode;
}

function ToolButton({ label, chord, active, handed, tabIndex, onClick, haspopup, expanded, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`dw-tool${active ? " active" : ""}`}
      title={label}
      aria-label={label}
      aria-haspopup={haspopup ? "true" : undefined}
      aria-expanded={haspopup ? expanded : undefined}
      data-handed={handed ? "" : undefined}
      tabIndex={tabIndex}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
      {chord && (
        <span className="dw-key" aria-hidden="true">
          <Kbd chord={chord} />
        </span>
      )}
    </button>
  );
}

const Dot = ({ ink }: { ink: number }) => <span className="dw-dot" style={{ background: INK_VAR[ink] }} />;
const Rule = ({ weight }: { weight: number }) => <span className="dw-rule" style={{ height: weight }} />;

// ---- the island ------------------------------------------------------------

export interface ToolIslandProps {
  tool: IslandTool;
  /** the shape the Shapes slot wears while the armed tool is not one: the
   * last shape a hand armed, Rectangle before any */
  shape: Shape;
  ink: number;
  /** in pixels, one of strokes.ts WEIGHTS, as the block stores it */
  weight: number;
  /** with a selection standing, the slots wear ITS ink and weight and a pick
   * restyles it (the host decides; this only shows what it is told) */
  selectionInk?: number;
  selectionWeight?: number;
  onArm: (tool: IslandTool) => void;
  onInk: (ink: number) => void;
  onWeight: (weight: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** a stroke is in the air: the island is hidden, disarmed and folded */
  inking: boolean;
  /** the arm standing open at mount, for a fixture or a test that has no
   * pointer to click with; a hand opens one by a click and nothing else */
  defaultArm?: Family | null;
  ref?: RefObject<HTMLDivElement | null>;
}

export function ToolIsland({
  tool,
  shape,
  ink,
  weight,
  selectionInk,
  selectionWeight,
  onArm,
  onInk,
  onWeight,
  open,
  onOpenChange,
  inking,
  defaultArm = null,
  ref,
}: ToolIslandProps) {
  const own = useRef<HTMLDivElement>(null);
  const root = ref ?? own;
  const [arm, setArm] = useState<Family | null>(defaultArm);
  const shownArm = open && !inking ? arm : null;
  // a fold forgets its arm: an island that reopened onto the arm it was
  // folded with would be answering a click nobody made this time
  useEffect(() => {
    if (!open) setArm(null);
  }, [open]);

  const body = useBody(open, OPEN_H);

  const armedSlot: SlotId = isShape(tool) ? "shapes" : tool;
  const shownShape: Shape = isShape(tool) ? tool : shape;
  const shownInk = selectionInk ?? ink;
  const shownWeight = Math.max(0, WEIGHTS.indexOf(selectionWeight ?? weight));

  const pick = (member: string, family: Family) => {
    if (family === "shapes") onArm(member as Shape);
    else if (family === "ink") onInk(Number(member));
    else onWeight(WEIGHTS[Number(member)]);
    setArm(null);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const node = root.current;
    if (!node) return;
    const target = e.target as HTMLElement;
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape") {
      take();
      if (shownArm) {
        setArm(null);
        node.querySelector<HTMLElement>(`[data-slot="${shownArm}"] .dw-tool`)?.focus();
        return;
      }
      target.blur();
      onOpenChange(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const inArm = target.closest<HTMLElement>(".dw-arm");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (inArm) return;
      const slots = [...node.querySelectorAll<HTMLButtonElement>("[data-slot] > .dw-tool")];
      const next = slots[slots.indexOf(target as HTMLButtonElement) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      take();
      onOpenChange(true);
      next.focus();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (inArm) {
        const members = [...inArm.querySelectorAll<HTMLButtonElement>(".dw-tool")];
        const at = members.indexOf(target as HTMLButtonElement);
        const next = members[at + (e.key === "ArrowRight" ? 1 : -1)];
        take();
        if (next) next.focus();
        else if (e.key === "ArrowLeft") {
          const family = inArm.dataset.family;
          setArm(null);
          node.querySelector<HTMLElement>(`[data-slot="${family}"] .dw-tool`)?.focus();
        }
        return;
      }
      const family = target.closest<HTMLElement>("[data-slot]")?.dataset.slot as SlotId | undefined;
      const def = ROSTER.find((s) => s.id === family);
      if (e.key !== "ArrowRight" || !def?.family) return;
      take();
      setArm(def.family);
      // the arm's visible member is the one that stands where the slot did
      requestAnimationFrame(() =>
        node.querySelector<HTMLElement>(`.dw-arm[data-family="${def.family}"] [data-rest] .dw-tool`)?.focus(),
      );
      return;
    }
    // the chords answer here too, so a hand that tabbed in can still type `r`
    const armed = toolForKey(e.key);
    if (!armed) return;
    take();
    setArm(null);
    onArm(armed);
  };

  return (
    <div
      ref={root}
      className="dw-island"
      data-open={open ? "" : undefined}
      data-inking={inking ? "" : undefined}
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="vertical"
      onKeyDown={onKey}
    >
      <motion.div className="dw-island-body" style={{ height: body }} />
      <div className="dw-island-sep" style={{ top: SEP_Y }} />
      {ROSTER.map((slot, i) => {
        const lead = slot.id === armedSlot;
        const familyOpen = slot.family !== undefined && shownArm === slot.family;
        let glyph: ReactNode;
        let chord: string | undefined;
        if (slot.id === "shapes") {
          const Mark = GLYPH[shownShape];
          glyph = <Mark size={GLYPH_PX} />;
          chord = chordOf(shownShape);
        } else if (slot.id === "ink") glyph = <Dot ink={shownInk} />;
        else if (slot.id === "weight") glyph = <Rule weight={WEIGHTS[shownWeight]} />;
        else {
          const Mark = GLYPH[slot.id];
          glyph = <Mark size={GLYPH_PX} />;
          chord = chordOf(slot.id);
        }
        return (
          <Fold
            key={slot.id}
            open={open}
            lead={lead}
            at={slotY(i)}
            body={body}
            axis="y"
            className="dw-slot"
            data={{ "data-slot": slot.id, "data-rest": lead ? "" : undefined }}
          >
            <ToolButton
              label={slot.label}
              chord={chord}
              active={lead}
              handed={familyOpen}
              tabIndex={open || lead ? 0 : -1}
              haspopup={slot.family !== undefined}
              expanded={slot.family !== undefined ? familyOpen : undefined}
              onClick={() => {
                if (slot.family) {
                  setArm(shownArm === slot.family ? null : slot.family);
                  return;
                }
                setArm(null);
                onArm(slot.id as Exclude<SlotId, Family>);
              }}
            >
              {glyph}
            </ToolButton>
          </Fold>
        );
      })}
      <Arm
        family="shapes"
        row={rowOfFamily("shapes")}
        open={shownArm === "shapes"}
        visible={shownShape}
        active={isShape(tool) ? tool : null}
        members={SHAPES.map((s) => {
          const Mark = GLYPH[s];
          return { id: s, label: labelOf(s), chord: chordOf(s), glyph: <Mark size={GLYPH_PX} /> };
        })}
        onPick={(m) => pick(m, "shapes")}
      />
      <Arm
        family="ink"
        row={rowOfFamily("ink")}
        open={shownArm === "ink"}
        visible={String(shownInk)}
        active={String(shownInk)}
        members={INK_STEPS.map((step, j) => ({ id: String(j), label: step.label, glyph: <Dot ink={j} /> }))}
        onPick={(m) => pick(m, "ink")}
      />
      <Arm
        family="weight"
        row={rowOfFamily("weight")}
        open={shownArm === "weight"}
        visible={String(shownWeight)}
        active={String(shownWeight)}
        members={WEIGHT_STEPS.map((step, j) => ({
          id: String(j),
          label: step.label,
          glyph: <Rule weight={WEIGHTS[j]} />,
        }))}
        onPick={(m) => pick(m, "weight")}
      />
    </div>
  );
}

// ---- an arm ----------------------------------------------------------------

interface Member {
  id: string;
  label: string;
  chord?: string;
  glyph: ReactNode;
}

interface ArmProps {
  family: Family;
  /** the slot's ordinal: the arm stands at that row */
  row: number;
  open: boolean;
  /** the member standing where the slot is, at rest and as the fold begins */
  visible: string;
  /** the member wearing the selected state, if any */
  active: string | null;
  members: readonly Member[];
  onPick: (id: string) => void;
}

/** a family's arm: the island's fold turned sideways, at the family's own row.
 * Its root spans the arm's full OPEN width with nothing painted, so the
 * proximity rule can read the footprint off the element; the body inside it
 * is what grows.
 *
 * It is SHOWN from the click that opens it to the instant its fold lands, and
 * at no other time: it appears pixel for pixel over the slot it grows from
 * (the same glyph on the same 38px of body) and leaves once its member is
 * back there, so the handoff reads as one button and a folded island never
 * has three boxes standing under it where the arms' rest members wait */
function Arm({ family, row, open, visible, active, members, onPick }: ArmProps) {
  const width = armW(members.length);
  const [shown, setShown] = useState(open);
  const landed = useCallback(() => setShown(false), []);
  const body = useBody(open, width, landed);
  useLayoutEffect(() => {
    if (open) setShown(true);
  }, [open]);
  return (
    <div
      className="dw-arm"
      data-family={family}
      data-open={open ? "" : undefined}
      style={{ top: slotY(row) - PAD, width }}
      data-shown={shown ? "" : undefined}
      role="group"
      aria-label={ROSTER.find((s) => s.family === family)?.label}
    >
      <motion.div className="dw-arm-body" style={{ width: body }} />
      {members.map((m, j) => {
        const lead = m.id === visible;
        return (
          <Fold
            key={m.id}
            open={open}
            lead={lead}
            at={memberX(j)}
            body={body}
            axis="x"
            className="dw-slot"
            data={{ "data-member": m.id, "data-rest": lead ? "" : undefined }}
          >
            <ToolButton
              label={m.label}
              chord={m.chord}
              active={m.id === active}
              tabIndex={open ? 0 : -1}
              onClick={() => onPick(m.id)}
            >
              {m.glyph}
            </ToolButton>
          </Fold>
        );
      })}
    </div>
  );
}

// ---- reach -----------------------------------------------------------------

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** whether a point stands within `reach` of a box, edges inclusive */
export const withinReach = (x: number, y: number, box: Rect, reach = REACH): boolean =>
  x >= box.left - reach && x <= box.right + reach && y >= box.top - reach && y <= box.bottom + reach;

/** the footprint the island WILL have once open, off its anchor: reach is
 * measured against where the tools are going, not where the fold has got to */
export const openFootprint = (anchor: { left: number; top: number }): Rect => ({
  left: anchor.left,
  top: anchor.top,
  right: anchor.left + ISLAND_W,
  bottom: anchor.top + OPEN_H,
});

/** is this pointer reaching for the island: within 40px of its open footprint,
 * or within 24 of any arm standing open */
export function nearIsland(root: HTMLElement, x: number, y: number): boolean {
  const at = root.getBoundingClientRect();
  if (withinReach(x, y, openFootprint(at))) return true;
  for (const arm of root.querySelectorAll<HTMLElement>(".dw-arm[data-open]"))
    if (withinReach(x, y, arm.getBoundingClientRect(), ARM_REACH)) return true;
  return false;
}

export interface IslandProximity {
  /** every pointermove the host sees on the block */
  move: (e: { clientX: number; clientY: number }) => void;
  /** the pointer left the block */
  leave: () => void;
  /** a stroke started: fold now, no grace */
  close: () => void;
}

/** the proximity rule, as the host's hook: it is called with the block's own
 * pointer events, because the reach stands 40px past the island and only the
 * block hears a pointer there. Opens within reach and on focus landing
 * inside; folds 160ms after the pointer has left the reach, unless focus is
 * still inside; never opens while a stroke is in the air */
export function useIslandProximity(
  rootRef: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  inking?: () => boolean,
): IslandProximity {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const near = useRef(false);
  const latest = useRef({ open, setOpen, inking });
  latest.current = { open, setOpen, inking };

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const node = rootRef.current;
      if (near.current || (node && node.contains(node.ownerDocument.activeElement))) return;
      latest.current.setOpen(false);
    }, GRACE_MS);
  }, [rootRef]);

  const move = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const node = rootRef.current;
      if (!node) return;
      near.current = nearIsland(node, e.clientX, e.clientY);
      if (near.current) {
        cancel();
        if (!latest.current.open && !latest.current.inking?.()) latest.current.setOpen(true);
      } else if (latest.current.open) schedule();
    },
    [rootRef, cancel, schedule],
  );

  const leave = useCallback(() => {
    near.current = false;
    if (latest.current.open) schedule();
  }, [schedule]);

  const close = useCallback(() => {
    cancel();
    near.current = false;
    latest.current.setOpen(false);
  }, [cancel]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onIn = () => {
      cancel();
      if (!latest.current.inking?.()) latest.current.setOpen(true);
    };
    const onOut = (ev: FocusEvent) => {
      if (node.contains(ev.relatedTarget as Node | null)) return;
      if (!near.current && latest.current.open) schedule();
    };
    node.addEventListener("focusin", onIn);
    node.addEventListener("focusout", onOut);
    return () => {
      node.removeEventListener("focusin", onIn);
      node.removeEventListener("focusout", onOut);
      cancel();
    };
  }, [rootRef, cancel, schedule]);

  return { move, leave, close };
}
