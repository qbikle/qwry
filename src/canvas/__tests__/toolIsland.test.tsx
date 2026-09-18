// The tool island (F3): the drawing's tools as one button that unfolds
// (ToolIsland.tsx, toolIsland.css, DESIGN rule 1's "Tool island" row). What a
// still can hold of it is checked here on static markup, the repo's own rig
// for a component (NoteBlock.test.tsx: there is no DOM in this runner), and
// what a still cannot hold, the fold itself, is pinned by the numbers it is
// made of and by reading the source: springs.ts is the only home of a spring
// (DESIGN rule 6), and a hidden control takes no press (LESSONS 18). The
// probe (docs/research/f3-frames/f3-probe.ts) is what samples the motion.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => undefined,
});
for (const [k, value] of Object.entries({ window: globalThis, document: inert })) {
  if (k in globalThis) continue;
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}

const { renderToStaticMarkup } = await import("react-dom/server");
const island = await import("../ToolIsland");
const { spring } = await import("../../design/springs");
const {
  ToolIsland,
  ROSTER,
  SHAPES,
  GLYPH,
  chordOf,
  slotY,
  memberX,
  armW,
  withinReach,
  openFootprint,
  OPEN_H,
  SEP_Y,
  ISLAND_W,
  REACH,
  ARM_REACH,
  GRACE_MS,
  PITCH,
  TOOL,
  TOOL_SLOTS,
  PAD,
  SEP_H,
  GLYPH_PX,
} = island;
type Props = import("../ToolIsland").ToolIslandProps;

const noop = () => {};
const html = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(
    <ToolIsland
      tool="pen"
      shape="rect"
      ink={0}
      weight={2}
      onArm={noop}
      onInk={noop}
      onWeight={noop}
      open={false}
      onOpenChange={noop}
      inking={false}
      {...over}
    />,
  );

interface Slot {
  attrs: string;
  style: string;
  button: string;
}

/** every motion wrapper in the markup, with the button it holds */
function slotsOf(out: string, selector = "data-slot"): Slot[] {
  const found: Slot[] = [];
  const re = /<div class="dw-slot"([^>]*)>(<button[^>]*>)/g;
  for (const m of out.matchAll(re)) {
    if (!m[1].includes(selector)) continue;
    const style = /style="([^"]*)"/.exec(m[1])?.[1] ?? "";
    found.push({ attrs: m[1], style, button: m[2] });
  }
  return found;
}
const dataOf = (attrs: string, name: string): string | null => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
};
const translateOf = (style: string, axis: "X" | "Y"): number | null => {
  const m = new RegExp(`translate${axis}\\((-?[\\d.]+)px\\)`).exec(style);
  return m ? Number(m[1]) : null;
};

// ---- the numbers -----------------------------------------------------------

describe("the island's geometry is the sketch's", () => {
  test("24px tools on a 28px pitch in 4px of padding, a 9px separator row", () => {
    expect([TOOL, PITCH, PAD, ISLAND_W]).toEqual([24, 28, 4, 32]);
    expect(ROSTER.map((_, i) => slotY(i))).toEqual([4, 32, 60, 88, 116, 149, 177]);
    expect(SEP_Y).toBe(144);
  });

  test("205 open, inside the 211 a 2x2 widget leaves at the 640 floor", () => {
    expect(OPEN_H).toBe(205);
    expect(OPEN_H).toBeLessThan(211);
  });

  test("an arm is its members on the same pitch: 116 for the four shapes, 172 for six weights", () => {
    expect([0, 1, 2, 3].map(memberX)).toEqual([4, 32, 60, 88]);
    expect(armW(SHAPES.length)).toBe(116);
    expect(armW(3)).toBe(88);
    expect(armW(6)).toBe(172);
    // the last member's right edge plus the padding IS the width
    expect(memberX(3) + TOOL + PAD).toBe(armW(4));
  });

  test("reach is 40 around the open footprint, 24 around an open arm, and the grace 160ms", () => {
    expect(REACH).toBe(40);
    expect(ARM_REACH).toBe(24);
    expect(GRACE_MS).toBe(160);
    // one halo per box, and the arm's is read off the arm's own element
    const src = readFileSync(join(import.meta.dir, "../ToolIsland.tsx"), "utf8");
    expect(src).toContain("withinReach(x, y, arm.getBoundingClientRect(), ARM_REACH)");
    const fp = openFootprint({ left: 100, top: 50 });
    expect(fp).toEqual({ left: 100, top: 50, right: 132, bottom: 255 });
    // measured against where the tools are GOING, so a hand approaching a
    // folded island from below still opens it
    expect(withinReach(118, 240, fp)).toBe(true);
    expect(withinReach(60, 50, fp)).toBe(true);
    expect(withinReach(59, 50, fp)).toBe(false);
    expect(withinReach(118, 296, fp)).toBe(false);
    expect(withinReach(172, 150, fp)).toBe(true);
    expect(withinReach(173, 150, fp)).toBe(false);
    // and the tighter halo an arm answers to
    expect(withinReach(156, 150, fp, ARM_REACH)).toBe(true);
    expect(withinReach(157, 150, fp, ARM_REACH)).toBe(false);
  });
});

// ---- the roster ------------------------------------------------------------

describe("the roster", () => {
  test("seven slots, in one order for ever: Select, Pen, Shapes, Text, Eraser, Ink, Weight", () => {
    const ids = slotsOf(html()).map((s) => dataOf(s.attrs, "data-slot"));
    expect(ids).toEqual(["select", "pen", "shapes", "text", "eraser", "ink", "weight"]);
    expect(ROSTER.map((s) => s.label)).toEqual([
      "Select",
      "Pen",
      "Shapes",
      "Text",
      "Eraser",
      "Ink",
      "Weight",
    ]);
    // the hairline stands after the tools, and the properties after it
    expect(TOOL_SLOTS).toBe(5);
    expect(slotY(TOOL_SLOTS) - (slotY(TOOL_SLOTS - 1) + TOOL)).toBe(SEP_H);
  });

  test("every tool the island can arm has a glyph and a chord", () => {
    for (const tool of ["select", "pen", "rect", "ellipse", "line", "arrow", "text", "eraser"] as const) {
      expect(GLYPH[tool]).toBeDefined();
      expect(chordOf(tool)).toMatch(/^[a-z]$/);
    }
    expect(chordOf("select")).toBe("v");
    expect(SHAPES.map(chordOf)).toEqual(["r", "o", "l", "a"]);
  });
});

// ---- rest --------------------------------------------------------------------

describe("at rest the island is the armed tool alone", () => {
  test("the rest button is the armed tool, at 4, shown; every other slot stands folded under it, unseen", () => {
    const slots = slotsOf(html({ tool: "pen" }));
    const rest = slots.filter((s) => dataOf(s.attrs, "data-rest") !== null);
    expect(rest.length).toBe(1);
    expect(dataOf(rest[0].attrs, "data-slot")).toBe("pen");
    expect(translateOf(rest[0].style, "Y")).toBe(4);
    expect(rest[0].style).toContain("opacity:1");
    expect(rest[0].button).toContain('class="dw-tool active"');
    // a folded sibling waits 6px above its OWN slot and drops in from there:
    // it never rides the column behind the armed tool, in either direction
    // (the maintainer's "double sliding" recording, 2026-09-18)
    for (const [i, s] of slots.entries()) {
      if (s === rest[0]) continue;
      const y = translateOf(s.style, "Y");
      expect(y).toBe(slotY(i) - 6);
      expect(Math.abs((y ?? 0) - slotY(i))).toBeLessThanOrEqual(6);
      if (i > 0) expect(y).not.toBe(PAD);
      expect(s.style).toContain("opacity:0");
      expect(s.style).toContain("scale(0.9)");
    }
  });

  test("a shape armed puts the Shapes slot at rest, wearing that shape's glyph and its letter", () => {
    const slots = slotsOf(html({ tool: "ellipse" }));
    const rest = slots.find((s) => dataOf(s.attrs, "data-rest") !== null);
    expect(dataOf(rest?.attrs ?? "", "data-slot")).toBe("shapes");
    const out = html({ tool: "ellipse" });
    const shapes = /<div class="dw-slot"[^>]*data-slot="shapes"[^>]*>([\s\S]*?)<\/button>/.exec(out)?.[1] ?? "";
    expect(shapes).toContain("lucide-circle");
    expect(shapes).toContain('<span class="kbd">O</span>');
    expect(shapes).not.toContain("lucide-square");
  });

  test("with no shape armed the Shapes slot wears the remembered shape, Rectangle before any", () => {
    const out = html({ tool: "pen", shape: "arrow" });
    const shapes = /<div class="dw-slot"[^>]*data-slot="shapes"[^>]*>([\s\S]*?)<\/button>/.exec(out)?.[1] ?? "";
    expect(shapes).toContain("lucide-arrow-up-right");
    expect(shapes).toContain('<span class="kbd">A</span>');
  });

  test("the folded siblings are out of the tab order; the rest button is in it", () => {
    const slots = slotsOf(html());
    for (const s of slots) {
      const rest = dataOf(s.attrs, "data-rest") !== null;
      expect(s.button).toContain(`tabindex="${rest ? 0 : -1}"`);
    }
  });
});

// ---- open ------------------------------------------------------------------

describe("open puts every slot at its own y", () => {
  test("five tools, a hairline, two properties", () => {
    const out = html({ open: true });
    expect(out).toContain('class="dw-island" data-open=""');
    const slots = slotsOf(out);
    expect(slots.map((s) => translateOf(s.style, "Y"))).toEqual([4, 32, 60, 88, 116, 149, 177]);
    for (const s of slots) {
      expect(s.style).toContain("opacity:1");
      expect(s.style).not.toContain("scale(0.9)");
      expect(s.button).toContain('tabindex="0"');
    }
  });

  test("the body is 207 tall: the 205 padding box and its hairline on each side", () => {
    expect(html({ open: true })).toContain('class="dw-island-body" style="height:207px"');
    expect(html()).toContain('class="dw-island-body" style="height:34px"');
    // and the hairline's own row is the component's number, not the stylesheet's
    expect(html({ open: true })).toContain(`class="dw-island-sep" style="top:${SEP_Y}px"`);
    expect(readFileSync(join(import.meta.dir, "../toolIsland.css"), "utf8")).not.toContain("top: 144px");
  });

  test("the chord letters stand on every tool that has one, and on neither property", () => {
    const out = html({ open: true });
    for (const letter of ["V", "P", "R", "T", "E"]) expect(out).toContain(`<span class="kbd">${letter}</span>`);
    const inkSlot = /<div class="dw-slot"[^>]*data-slot="ink"[^>]*>([\s\S]*?)<\/button>/.exec(out)?.[1] ?? "";
    const weightSlot = /<div class="dw-slot"[^>]*data-slot="weight"[^>]*>([\s\S]*?)<\/button>/.exec(out)?.[1] ?? "";
    expect(inkSlot).not.toContain('class="kbd"');
    expect(weightSlot).not.toContain('class="kbd"');
    expect(inkSlot).toContain('class="dw-dot"');
    expect(weightSlot).toContain('class="dw-rule"');
  });

  test("the letters are <Kbd>'s, never a glyph typed into JSX (DESIGN rule 7)", () => {
    const src = readFileSync(join(import.meta.dir, "../ToolIsland.tsx"), "utf8");
    expect(src).toContain("<Kbd chord={chord} />");
    expect(src).not.toMatch(/[\u2318\u21e7\u2325\u2303]/);
  });

  test("families never open on reach: an open island stands with every arm folded", () => {
    const out = html({ open: true });
    expect(out).not.toContain('class="dw-arm" data-family="shapes" data-open=""');
    expect(out).not.toMatch(/dw-arm"[^>]*data-open/);
    expect(out).not.toContain("data-handed");
    // and the proximity rule has no hand on the arms at all: it opens the
    // island and nothing else
    const src = readFileSync(join(import.meta.dir, "../ToolIsland.tsx"), "utf8");
    const hook = src.slice(src.indexOf("export function useIslandProximity"));
    expect(hook).not.toContain("setArm");
  });

  test("the Ink and Weight slots wear the selection's values when one stands, the next stroke's otherwise", () => {
    const own = html({ open: true, ink: 0, weight: 2 });
    expect(own).toContain('class="dw-dot" style="background:var(--ink-0)"');
    expect(own).toContain('class="dw-rule" style="height:2px"');
    const sel = html({ open: true, ink: 0, weight: 2, selectionInk: 2, selectionWeight: 4 });
    expect(sel).toMatch(/data-slot="ink"[\s\S]*?class="dw-dot" style="background:var\(--ink-2\)"/);
    expect(sel).toMatch(/data-slot="weight"[\s\S]*?class="dw-rule" style="height:4px"/);
  });
});

// ---- an arm ----------------------------------------------------------------

describe("an arm", () => {
  test("its members stand at their x, the visible one at rest, the armed one active", () => {
    const out = html({ open: true, tool: "ellipse", defaultArm: "shapes" });
    const arm = /<div class="dw-arm" data-family="shapes" data-open=""[^>]*>([\s\S]*?)<\/div><div class="dw-arm"/.exec(out)?.[1];
    expect(arm).toBeDefined();
    const members = slotsOf(arm ?? "", "data-member");
    expect(members.map((m) => dataOf(m.attrs, "data-member"))).toEqual(["rect", "ellipse", "line", "arrow"]);
    expect(members.map((m) => translateOf(m.style, "X"))).toEqual([4, 32, 60, 88]);
    const rest = members.filter((m) => dataOf(m.attrs, "data-rest") !== null);
    expect(rest.length).toBe(1);
    expect(dataOf(rest[0].attrs, "data-member")).toBe("ellipse");
    expect(rest[0].button).toContain('class="dw-tool active"');
    for (const m of members) expect(m.button).toContain('tabindex="0"');
    expect(arm).toContain('class="dw-arm-body" style="width:118px"');
  });

  test("the slot hands its glyph to the arm: handed, expanded, and disarmed by the stylesheet", () => {
    const out = html({ open: true, tool: "ellipse", defaultArm: "shapes" });
    const shapes = slotsOf(out).find((s) => dataOf(s.attrs, "data-slot") === "shapes");
    expect(shapes?.button).toContain('data-handed=""');
    expect(shapes?.button).toContain('aria-expanded="true"');
    const css = readFileSync(join(import.meta.dir, "../toolIsland.css"), "utf8");
    expect(css).toMatch(/\.dw-tool\[data-handed\]\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none/);
  });

  test("the arm's root is its open footprint, so reach can be read off the element while it grows", () => {
    const out = html({ open: true, defaultArm: "ink" });
    expect(out).toMatch(/class="dw-arm" data-family="ink" data-open="" style="top:145px;width:88px"/);
    expect(out).toMatch(/class="dw-arm" data-family="shapes" style="top:56px;width:116px"/);
    expect(out).toMatch(/class="dw-arm" data-family="weight" style="top:173px;width:172px"/);
  });

  test("a folded arm's members are out of the tab order and its rest member alone is shown", () => {
    const out = html({ open: true });
    const arm = /<div class="dw-arm" data-family="ink"[^>]*>([\s\S]*?)<\/div><div class="dw-arm"/.exec(out)?.[1] ?? "";
    const members = slotsOf(arm, "data-member");
    expect(members.length).toBe(3);
    for (const [j, m] of members.entries()) {
      expect(m.button).toContain('tabindex="-1"');
      const rest = dataOf(m.attrs, "data-rest") !== null;
      // the same rule sideways: a folded member waits beside its own ordinal
      expect(translateOf(m.style, "X")).toBe(rest ? 4 : memberX(j) - 6);
      expect(m.style).toContain(rest ? "opacity:1" : "opacity:0");
    }
    expect(arm).toContain('class="dw-arm-body" style="width:34px"');
  });

  test("an arm is SHOWN only while open: a folded island stands with no arm's box under it", () => {
    const folded = html({ tool: "pen" });
    expect(folded).not.toContain("data-shown");
    const open = html({ open: true });
    expect(open).not.toContain("data-shown");
    const armed = html({ open: true, defaultArm: "shapes" });
    expect(armed.match(/data-shown=""/g)?.length).toBe(1);
    expect(armed).toMatch(/class="dw-arm" data-family="shapes" data-open="" style="[^"]*" data-shown=""/);
    // and the stylesheet keeps an unshown arm off the paper and off the pointer
    const css = readFileSync(join(import.meta.dir, "../toolIsland.css"), "utf8");
    expect(css).toMatch(/\.dw-arm \{[^}]*opacity: 0;[^}]*pointer-events: none;/);
    expect(css).toMatch(/\.dw-arm\[data-shown\] \{[^}]*opacity: 1;[^}]*pointer-events: auto;/);
  });

  test("a stroke in the air folds every arm and marks the island", () => {
    const out = html({ open: true, defaultArm: "shapes", inking: true });
    expect(out).toContain('data-inking=""');
    expect(out).not.toMatch(/dw-arm"[^>]*data-open/);
    expect(out).not.toContain("data-handed");
  });
});

// ---- motion (DESIGN rule 6) ------------------------------------------------

describe("the fold speaks springs.ts and nothing else", () => {
  const src = readFileSync(join(import.meta.dir, "../ToolIsland.tsx"), "utf8");

  test("rail and quick are presets, by the numbers the sketch names", () => {
    expect(spring.rail).toEqual({ type: "spring", stiffness: 600, damping: 24, mass: 0.6 });
    expect(spring.snappy).toEqual({ type: "spring", stiffness: 700, damping: 38, mass: 0.6 });
    expect(spring.quick).toEqual({ duration: 0.12, ease: [0.2, 0, 0, 1] });
  });

  test("the component types no spring number of its own", () => {
    expect(src).not.toMatch(/stiffness|damping|mass:/);
    expect(src).not.toMatch(/duration:/);
    expect(src).not.toMatch(/ease:/);
  });

  test("every animation runs on a named preset", () => {
    const calls = src.split("\n").filter((line) => line.includes("animate("));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/spring\.(rail|snappy|quick)/);
  });

  test("the way out rides rail, the way home rides snappy; the body rides snappy both ways", () => {
    expect(src).toContain("open ? spring.rail : spring.snappy");
    expect(src).toMatch(/animate\(body, bodyOf\(open \? to : ISLAND_W\), spring\.snappy\)/);
  });

  test("only the LEAD travels: a sibling drops the 6px into its own slot and fades where it stands", () => {
    expect(src).toContain("const LIFT = 6");
    // the armed tool is the one item with a journey, and its own two springs
    expect(src).toContain("animate(pos, open ? at : PAD, open ? spring.rail : spring.snappy)");
    // a sibling's poses are its own slot and 6 above it, never the rest seat
    expect(src).toContain("animate(pos, at, spring.snappy)");
    expect(src).toContain("animate(pos, at - LIFT, spring.quick)");
    expect(src).not.toContain("animate(pos, PAD, spring.quick)");
    // and no typed stagger: the body's own spring is the clock
    expect(src).not.toContain("STAGGER");
    expect(src).not.toMatch(/delay:/);
  });

  test("the reveal is gated on the body, so nothing is drawn where the box has not grown", () => {
    expect(src).toContain("const coversSlot = (body: number, at: number): boolean => body + PAD >= at + LEAD_INSET");
    // the gate is the clock for the drop and the floor for the fade
    expect(src).toContain("drop(body.get());");
    expect(src).toContain('stops.push({ stop: body.on("change", drop) });');
    // the listener is never removed from inside its own notification: that
    // skips the next listener, and one notification is all reduced motion gets
    expect(src).not.toContain("off();");
    expect(src).toContain("coversSlot(b as number, at) ? (o as number) : 0");
  });

  test("the armed tool cannot stand outside the body: its rendered coordinate is clamped against it", () => {
    expect(src).toContain("Math.max(PAD, Math.min(p as number, (b as number) - LEAD_INSET))");
    expect(src).toContain("const LEAD_INSET = TOOL + PAD + 2");
    expect(src).toContain("const shown = lead ? clamped : pos;");
  });
});

// ---- the stylesheet ----------------------------------------------------------

describe("the stylesheet", () => {
  const css = readFileSync(join(import.meta.dir, "../toolIsland.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = css
    .split("}")
    .map((chunk) => {
      const at = chunk.lastIndexOf("{");
      return at === -1 ? null : { selector: chunk.slice(0, at).trim(), body: chunk.slice(at + 1) };
    })
    .filter((r): r is { selector: string; body: string } => r !== null);
  const has = (body: string, prop: string, value: string) =>
    new RegExp(`(^|[;{\\s])${prop}\\s*:\\s*${value}\\s*(;|$)`).test(body);
  /** the species' controls: the island, a slot, a tool, an arm. The body and
   * the separator are paint, not controls, and answer no pointer at all */
  const CONTROL = /^\.dw-(island|slot|tool|arm)(?![-\w])/;
  /** a rule's subject: the last compound of its (first) selector */
  const subject = (selector: string): string => selector.split(",")[0].trim().split(/[\s>]+/).pop() ?? "";

  test("every rule that hides a control disarms it in the same block (LESSONS 18)", () => {
    const hiding = rules.filter((r) => CONTROL.test(subject(r.selector)) && has(r.body, "opacity", "0"));
    expect(hiding.length).toBeGreaterThan(0);
    expect(hiding.filter((r) => !has(r.body, "pointer-events", "none")).map((r) => r.selector)).toEqual([]);
  });

  test("and every rule that reveals one hands the pointer back", () => {
    const showing = rules.filter((r) => CONTROL.test(subject(r.selector)) && has(r.body, "opacity", "1"));
    expect(showing.length).toBeGreaterThan(0);
    expect(showing.filter((r) => !has(r.body, "pointer-events", "auto")).map((r) => r.selector)).toEqual([]);
  });

  test("the reveal register is the block's own: hover, focus-within, [data-hot]; the stroke takes it away", () => {
    const reveal = rules.find((r) => r.selector.includes(".blk:hover > .dw-island"));
    expect(reveal?.selector).toContain(".blk:focus-within > .dw-island");
    expect(reveal?.selector).toContain(".blk[data-hot] > .dw-island");
    const gone = rules.find((r) => r.selector.includes(".blk[data-inking] > .dw-island"));
    expect(gone).toBeDefined();
    expect(has(gone?.body ?? "", "pointer-events", "none")).toBe(true);
    // the stroke's rule stands AFTER the reveal's, at the same weight, so it wins
    expect(rules.indexOf(gone!)).toBeGreaterThan(rules.indexOf(reveal!));
  });

  test("the button ships the whole matrix (DESIGN rule 2)", () => {
    const sel = rules.map((r) => r.selector);
    expect(sel).toContain(".dw-tool");
    expect(sel).toContain(".dw-tool:hover:not(:disabled)");
    expect(sel).toContain(".dw-tool:active:not(:disabled)");
    expect(sel).toContain(".dw-tool.active");
    expect(sel).toContain(".dw-tool:disabled");
    expect(has(rules.find((r) => r.selector === ".dw-tool:disabled")?.body ?? "", "opacity", "var\\(--o-disabled\\)")).toBe(true);
    expect(rules.find((r) => r.selector === ".dw-tool:active:not(:disabled)")?.body).toContain("scale(0.97)");
  });

  test("the island and its arms are one recipe: glass, a pill, and the hairline (the maintainer's call)", () => {
    const glass = rules.find((r) => r.selector.includes(".dw-island-body"));
    expect(glass?.selector).toContain(".dw-arm-body");
    expect(glass?.body).toContain("var(--radius-pill)");
    expect(glass?.body).toContain("color-mix(in srgb, var(--bg-raised) 72%, transparent)");
    expect(glass?.body).toContain("backdrop-filter: blur(14px) saturate(1.25)");
    expect(glass?.body).toContain("-webkit-backdrop-filter");
    expect(glass?.body).toContain("1px solid var(--border)");
    expect(glass?.body).toContain("var(--shadow-sm)");
  });

  test("the tool is a CIRCLE, concentric with the pill (inner radius = outer less the inset)", () => {
    // 17 on the pill's 34px short side, less the 5 of hairline and padding,
    // is 12, which is half of TOOL: the pill token gives the circle
    expect(TOOL / 2).toBe(17 - (1 + PAD));
    expect(rules.find((r) => r.selector === ".dw-tool")?.body).toContain("border-radius: var(--radius-pill)");
    expect(GLYPH_PX).toBe(12);
    // the weight rung is as wide as the glyph beside it and no wider
    expect(rules.find((r) => r.selector === ".dw-rule")?.body).toContain(`width: ${GLYPH_PX}px`);
  });

  test("the chord letter sits under the glyph, not in the circle's corner (the maintainer's own call)", () => {
    const seat = rules.find((r) => r.selector === ".dw-key");
    expect(seat?.body).toContain("left: 50%");
    expect(seat?.body).toContain("translateX(-50%)");
    expect(seat?.body).not.toContain("left: 2px");
    expect(rules.find((r) => r.selector === ".dw-key .kbd")?.body).toContain("font-size: 6px");
  });

  test("the chord letter is tier 2, never faint (WRITING glyph register 4), and no raw opacity fakes a tier", () => {
    const key = rules.find((r) => r.selector === ".dw-key .kbd");
    expect(key?.body).toContain("var(--fg-muted)");
    expect(css).not.toContain("--fg-faint");
    // one colour per button: the armed letter is its own glyph's accent at
    // full strength, never a fourth tier mixed out of an opacity (rule 3)
    const armed = rules.find((r) => r.selector === ".dw-tool.active .dw-key .kbd");
    expect(armed?.body).toContain("color: var(--accent)");
    expect(armed?.body).not.toContain("color-mix");
    const tiers = rules.filter((r) => /opacity\s*:\s*(0?\.\d+)/.test(r.body));
    expect(tiers.map((r) => r.selector)).toEqual([]);
  });

  test("motion here is the tokens' (rule 6): every transition names --dur-quick and no literal", () => {
    const declared = [...css.matchAll(/transition\s*:([^;]*);/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const value of declared) {
      expect(value).toContain("var(--dur-quick)");
      expect(value).not.toMatch(/\d+m?s\b/);
    }
  });
});
