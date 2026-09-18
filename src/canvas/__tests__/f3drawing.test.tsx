// F3: the drawing with the tool island at its top-left and the select tool
// in its hand (AGENT-UX 16x, 16jj). What a still can hold is read off the
// static markup, the repo's own rig for a component (NoteBlock.test.tsx: there
// is no DOM in this runner); what a gesture MEANS is read off the seams the
// handlers dispatch through (`sheetKeyAction`, `selectPress`, `selectDrag`,
// `restyleSel`, `cursorAt`), the same device f1drawing.test.ts uses for the
// ink path's `armSheet`; and the rules a stylesheet or a handler must carry
// are read off the source, as f1drawing.test.ts reads drawing.css. The probe
// (docs/research/f3-frames/f3-probe.ts) is what drives a real pointer.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mem = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => undefined,
});
for (const [k, value] of Object.entries({ window: globalThis, localStorage: storage, document: inert })) {
  if (k in globalThis) continue;
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { renderToStaticMarkup } = await import("react-dom/server");
const { Drawing, cursorAt, labelAt, restyleSel, selectDrag, selectPress, sheetKeyAction } = await import("../Drawing");
const { kindTools, toolForKey } = await import("../blockTools");
const { changed, overlayOf, PAD } = await import("../select");
type Stroke = import("../strokes").Stroke;
type DrawingData = import("../../stores/canvas").DrawingBlock;

afterAll(clearMocks);

const src = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

// ---- the ink under every test ---------------------------------------------

const ring: Stroke = { k: "ellipse", c: 0, t: 2, b: [40, 40, 160, 120] };
const turned: Stroke = { k: "ellipse", c: 1, t: 2, b: [220, 44, 340, 116], r: 0.5 };
const arrow: Stroke = { k: "arrow", c: 0, t: 2, b: [60, 210, 180, 150] };
const words: Stroke = { k: "text", c: 0, s: 13, at: [200, 200], v: "Gateway change, 12th" };
const line: Stroke = { k: "line", c: 2, t: 1, b: [40, 280, 300, 280] };
const INK: Stroke[] = [ring, turned, arrow, words, line];

const block = (over: Partial<DrawingData> = {}): DrawingData => ({
  id: "d1",
  kind: "drawing",
  strokes: INK,
  ink: 0,
  weight: 2,
  tool: "pen",
  ...over,
});

const html = (over: Partial<DrawingData> = {}) =>
  renderToStaticMarkup(
    <Drawing
      block={block(over)}
      canvasId="c1"
      cell={{ w: 4, h: 3 }}
      lead={<button type="button" className="iconbtn iconbtn-sm cvg-grip" aria-label="Move" />}
      ask={<button type="button" className="iconbtn iconbtn-sm" aria-label="Ask" />}
      onDelete={() => {}}
    />,
  );

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

// ---- the island on the block ------------------------------------------------

describe("the island stands on the block and the cluster is six", () => {
  test("the island is a DIRECT child of .blk.blk-draw, after the sheet, so the block's own reveal register reaches it", () => {
    const out = html();
    const root = out.indexOf('class="blk blk-draw noq"');
    const sheet = out.indexOf('class="dw-sheet"');
    const island = out.indexOf('class="dw-island"');
    const acts = out.indexOf('class="acts-float"');
    expect(root).toBeGreaterThanOrEqual(0);
    expect(sheet).toBeGreaterThan(root);
    expect(island).toBeGreaterThan(sheet);
    expect(acts).toBeGreaterThan(island);
    // the island's own reveal is written against `.blk > .dw-island`, which
    // only a direct child answers
    expect(src("toolIsland.css")).toContain(".blk:hover > .dw-island");
    const sheetClose = out.indexOf("</svg>", sheet);
    expect(island).toBeGreaterThan(sheetClose);
  });

  test("the rest button is the armed tool and its letter; a shape armed puts the Shapes slot at rest", () => {
    const pen = html({ tool: "pen" });
    expect(pen).toMatch(/data-slot="pen"[^>]*data-rest=""/);
    expect(pen).toContain('<span class="kbd">P</span>');
    const ellipse = html({ tool: "ellipse" });
    expect(ellipse).toMatch(/data-slot="shapes"[^>]*data-rest=""/);
    expect(ellipse).toContain('<span class="kbd">O</span>');
    const select = html({ tool: "select" });
    expect(select).toMatch(/data-slot="select"[^>]*data-rest=""/);
    expect(select).toContain('<span class="kbd">V</span>');
  });

  test("the island is seven slots and the Eraser is one of them", () => {
    const out = html();
    const slots = [...out.matchAll(/data-slot="([a-z]+)"/g)].map((m) => m[1]);
    expect(slots).toEqual(["select", "pen", "shapes", "text", "eraser", "ink", "weight"]);
    expect(out).toContain('<span class="kbd">E</span>');
    const eraser = html({ tool: "eraser" });
    expect(eraser).toMatch(/data-slot="eraser"[^>]*data-rest=""/);
    expect(eraser).toMatch(/class="dw-sheet"[^>]*data-tool="eraser"/);
    expect(src("drawing.css")).toContain('.dw-sheet[data-tool="eraser"]');
  });

  test("the cluster is six: Grip · Undo · Redo · Copy · Ask · More, and `Pen ▾` is gone", () => {
    expect(kindTools("drawing")).toEqual(["grip", "undo", "redo", "copy", "ask", "more"]);
    const out = html();
    const acts = out.slice(out.indexOf('class="acts-float"'));
    const labels = [...acts.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Move", "Undo", "Redo", "Copy", "Ask", "More"]);
    expect(out).not.toContain("dw-pick");
    expect(out).not.toContain('aria-haspopup="menu" title="Pen"');
  });

  test("the island wears the block's ink and weight, and the sheet says which tool is armed", () => {
    const out = html({ ink: 2, weight: 4, tool: "line" });
    expect(out).toMatch(/data-slot="ink"[\s\S]*?class="dw-dot" style="background:var\(--ink-2\)"/);
    expect(out).toMatch(/data-slot="weight"[\s\S]*?class="dw-rule" style="height:4px"/);
    expect(out).toMatch(/class="dw-sheet"[^>]*data-tool="line"/);
  });

  test("a stroke in the air folds the island by the pointerdown, before anything else, and the CSS takes it off the paper", () => {
    const drawing = src("Drawing.tsx");
    const onDown = drawing.slice(drawing.indexOf("const onDown = ("));
    const body = onDown.slice(0, onDown.indexOf("const at = point(e)"));
    expect(body).toContain("prox.close()");
    // and every tool goes through that one door: the text, select and full
    // branches all follow the close, none precedes it
    expect(body).not.toContain('tool === "text"');
    expect(src("toolIsland.css")).toMatch(/\.blk\[data-inking\] > \.dw-island[\s\S]*?pointer-events:\s*none/);
    // the block's own pointer is what the proximity hook reads
    expect(drawing).toContain("onPointerMove={prox.move}");
    expect(drawing).toContain("onPointerLeave={prox.leave}");
  });

  test("the menu's own two marks left drawing.css with the menu, so toolIsland.css's .dw-rule stands alone", () => {
    const css = src("drawing.css");
    expect(css).not.toContain(".dw-rule");
    expect(css).not.toContain(".dw-swatch");
    expect(src("toolIsland.css")).toContain(".dw-rule {");
  });
});

// ---- what a landed mark leaves armed -----------------------------------------

describe("a tool that lands goes back to Select; the pen and the eraser stay", () => {
  test("the commit carries the re-arm, so a gesture is still ONE write", () => {
    const drawing = src("Drawing.tsx");
    expect(drawing).toContain('const BACK = { tool: "select" } as const;');
    // the shape, the line, the arrow: sealed with the re-arm on the same commit
    expect(drawing).toContain(
      "commit([...strokes, { k: g.tool, c: ink, t: weight, b: [g.p[0], g.p[1], g.p[2], g.p[3]] }], true, BACK)",
    );
    // and a fresh label, the one other thing a hand PLACES
    expect(drawing).toContain('commit([...strokes, { k: "text", c: ink, s: TEXT_SIZE, at: [at.x, at.y], v }], true, BACK)');
    // the pen's own seal takes no patch: a sketch is many strokes
    expect(drawing).toContain("commit([...strokes, { k: \"pen\", c: ink, t: weight, p }], true);");
    // nor does the eraser's, for the same reason
    expect(drawing).toContain("commit(strokes.filter((_, i) => !hits.has(i)), true);");
    // one setDoc per gesture: the tool rides the strokes' own write
    expect(drawing).toContain("store.updateDrawing(canvasId, block.id, { strokes: next, ...also });");
  });
});

// ---- the eraser ---------------------------------------------------------------

describe("the eraser takes strokes, one step at a time", () => {
  test("a press dispatches to its own gesture, wearing the stroke while it runs", () => {
    const drawing = src("Drawing.tsx");
    const onDown = drawing.slice(drawing.indexOf("const onDown = ("), drawing.indexOf("const onMove = (ev: PointerEvent) => {"));
    expect(onDown).toContain('if (tool === "eraser") {');
    expect(onDown).toContain("onEraseDown(e, at);");
    const erase = drawing.slice(drawing.indexOf("const onEraseDown = ("), drawing.indexOf("// ---- the select tool's gesture"));
    // the block goes into the stroke exactly as the pen's path does (F1)
    expect(erase).toContain("armSheet(node, root.current)");
    expect(erase).toContain("restSheet(root.current)");
    // every stroke the pointer touches is dimmed as it is touched
    expect(erase).toContain("const i = hitAt(strokes, x, y);");
    expect(erase).toContain("setDoomed(new Set(hits))");
    // ONE commit, on the lift, and none for a press that touched nothing
    expect(erase.match(/commit\(/g)?.length).toBe(1);
    expect(erase).toContain("if (cancel || hits.size === 0) return;");
    // Esc cancels it whole, like every other gesture on this sheet
    expect(erase).toContain('if (ev.key !== "Escape") return;');
  });

  test("a doomed stroke is dimmed, not gone, and the tier is optical", () => {
    const drawing = src("Drawing.tsx");
    expect(drawing).toContain('const dim = doomed ? "dw-doomed" : undefined;');
    expect(drawing).toContain("doomed={doomed.has(i)}");
    expect(src("drawing.css")).toMatch(/\.dw-doomed \{\s*opacity: 0\.3; \/\* optical \*\//);
  });

  test("`e` arms it from the sheet, and it is the eighth tool and not a branch of the hand", () => {
    expect(toolForKey("e")).toBe("eraser");
    expect(sheetKeyAction(key("e"), { tool: "select", selected: true })).toEqual({ do: "arm", tool: "eraser" });
  });
});

// ---- the label, and its lines --------------------------------------------------

describe("a label is many lines if a hand asks for them", () => {
  test("the editor is a textarea: ↩ commits, ⇧↩ breaks the line", () => {
    const drawing = src("Drawing.tsx");
    expect(drawing).toContain('<textarea\n          className="dw-label"');
    expect(drawing).toContain('if (e.key === "Enter" && !e.shiftKey) {');
    // its rows and its line height are the label's own metric, not a guess
    expect(drawing).toContain("rows={textLines(label.v).length}");
    expect(drawing).toContain("lineHeight: TEXT_LINE");
    expect(drawing).toContain("width: labelWidth(label)");
    const css = src("drawing.css");
    expect(css).toMatch(/\.dw-label \{[^}]*resize: none/);
    expect(css).toMatch(/\.dw-label \{[^}]*overflow: hidden/);
  });

  test("the sheet draws one <tspan> per line, at the rows the box was measured by", () => {
    const out = html({ strokes: [{ k: "text", c: 0, s: 13, at: [20, 40], v: "first\nsecond" }] });
    expect(out).toContain('<tspan x="20" y="40">first</tspan>');
    expect(out).toContain('<tspan x="20" y="55.6">second</tspan>');
    // and a one-line label is still one row on its own baseline
    const one = html({ strokes: [words] });
    expect(one.match(/<tspan/g)?.length).toBe(1);
  });
});

// ---- the marks ---------------------------------------------------------------

describe("a turned stroke renders turned", () => {
  test("the sheet's own <path> and <text> carry the one rotate() string strokes.ts builds", () => {
    const out = html({ strokes: [turned, { ...words, r: -0.25 }] });
    expect(out).toMatch(/<path[^>]*transform="rotate\(28\.65 280 80\)"/);
    expect(out).toMatch(/<text[^>]*transform="rotate\(-14\.32 [\d.]+ [\d.]+\)"/);
    // and an unturned one carries none, byte for byte as before
    const plain = html({ strokes: [ring] });
    expect(plain).not.toContain("transform=");
  });
});

// ---- the keyboard --------------------------------------------------------------

describe("what a key on the sheet means (sheetKeyAction)", () => {
  test("v arms select, as p r o l a t arm the rest; a chord letter that arms nothing bubbles", () => {
    expect(toolForKey("v")).toBe("select");
    expect(sheetKeyAction(key("v"), { tool: "pen", selected: false })).toEqual({ do: "arm", tool: "select" });
    expect(sheetKeyAction(key("R"), { tool: "select", selected: true })).toEqual({ do: "arm", tool: "rect" });
    expect(sheetKeyAction(key("q"), { tool: "pen", selected: false })).toBeNull();
    // a modifier chord is the window's (LESSONS 10)
    expect(sheetKeyAction(key("v", { meta: true }), { tool: "pen", selected: false })).toBeNull();
    expect(sheetKeyAction(key("r", { alt: true }), { tool: "pen", selected: false })).toBeNull();
  });

  test("⌫ with a selection deletes it; with none, on the sheet, nothing at all", () => {
    expect(sheetKeyAction(key("Backspace"), { tool: "select", selected: true })).toEqual({ do: "delete" });
    expect(sheetKeyAction(key("Delete"), { tool: "select", selected: true })).toEqual({ do: "delete" });
    expect(sheetKeyAction(key("Backspace"), { tool: "select", selected: false })).toBeNull();
    expect(sheetKeyAction(key("Backspace"), { tool: "pen", selected: false })).toBeNull();
  });

  test("the delete is one commit: the handler filters once and commits once", () => {
    const drawing = src("Drawing.tsx");
    const branch = drawing.slice(drawing.indexOf('case "delete":'), drawing.indexOf('case "nudge":'));
    expect(branch.match(/commit\(/g)?.length).toBe(1);
    expect(branch).toContain("strokes.filter((_, i) => !sel.has(i))");
  });

  test("Esc clears a standing selection first, and only then leaves the sheet", () => {
    expect(sheetKeyAction(key("Escape"), { tool: "select", selected: true })).toEqual({ do: "clear" });
    expect(sheetKeyAction(key("Escape"), { tool: "select", selected: false })).toEqual({ do: "leave" });
    expect(sheetKeyAction(key("Escape"), { tool: "pen", selected: false })).toEqual({ do: "leave" });
  });

  test("arrows nudge 1px, 10 with shift, and only a selection answers them", () => {
    expect(sheetKeyAction(key("ArrowLeft"), { tool: "select", selected: true })).toEqual({ do: "nudge", dx: -1, dy: 0 });
    expect(sheetKeyAction(key("ArrowDown", { shift: true }), { tool: "select", selected: true })).toEqual({
      do: "nudge",
      dx: 0,
      dy: 10,
    });
    expect(sheetKeyAction(key("ArrowUp"), { tool: "select", selected: false })).toBeNull();
    // one commit per press, never per pixel
    const drawing = src("Drawing.tsx");
    const branch = drawing.slice(drawing.indexOf('case "nudge":'), drawing.indexOf('case "arm":'));
    expect(branch).toContain("commit(moveSel(strokes, sel, act.dx, act.dy), true)");
  });

  test("⌘A selects every stroke while select is armed, and stays the window's with a pen armed", () => {
    expect(sheetKeyAction(key("a", { meta: true }), { tool: "select", selected: false })).toEqual({ do: "selectAll" });
    expect(sheetKeyAction(key("a", { ctrl: true }), { tool: "select", selected: true })).toEqual({ do: "selectAll" });
    expect(sheetKeyAction(key("a", { meta: true }), { tool: "pen", selected: false })).toBeNull();
    // and a bare `a` is still the arrow
    expect(sheetKeyAction(key("a"), { tool: "select", selected: true })).toEqual({ do: "arm", tool: "arrow" });
  });

  test("⌘Z and ⇧⌘Z are the element's own, whatever is armed", () => {
    expect(sheetKeyAction(key("z", { meta: true }), { tool: "pen", selected: false })).toEqual({ do: "undo" });
    expect(sheetKeyAction(key("z", { meta: true, shift: true }), { tool: "select", selected: true })).toEqual({ do: "redo" });
  });
});

// ---- the press -------------------------------------------------------------------

describe("what a press on the sheet with select armed starts (selectPress)", () => {
  const none: ReadonlySet<number> = new Set();

  test("a click on a stroke selects it and starts a move; on paper it clears and starts a marquee", () => {
    const on = selectPress(INK, none, 100, 80, false);
    expect(on.gesture.kind).toBe("move");
    expect([...on.sel]).toEqual([0]);
    const off = selectPress(INK, new Set([0]), 400, 300, false);
    expect(off.gesture.kind).toBe("marquee");
    expect(off.sel.size).toBe(0);
  });

  test("shift adds to the selection rather than replacing it, and holds it through a marquee", () => {
    const added = selectPress(INK, new Set([0]), 120, 180, true);
    expect(added.gesture.kind).toBe("move");
    expect([...added.sel].sort()).toEqual([0, 2]);
    const kept = selectPress(INK, new Set([0]), 400, 300, true);
    expect(kept.gesture.kind).toBe("marquee");
    expect([...kept.sel]).toEqual([0]);
  });

  test("a press on a member of the selection keeps the whole group, so a group drags by any member", () => {
    const group = new Set([0, 2]);
    const press = selectPress(INK, group, 120, 180, false);
    expect(press.gesture.kind).toBe("move");
    expect(press.sel).toBe(group);
  });

  test("the knob rotates and a corner resizes, both answering before the stroke under them", () => {
    const sel = new Set([0]);
    const ov = overlayOf(INK, sel)!;
    const knob = selectPress(INK, sel, ov.knob.x, ov.knob.y, false);
    expect(knob.gesture.kind).toBe("rotate");
    expect(knob.gesture.kind === "rotate" && knob.gesture.cx).toBe(ov.cx);
    const se = ov.handles.find((h) => h.at === "se")!;
    const corner = selectPress(INK, sel, se.x, se.y, false);
    expect(corner.gesture.kind).toBe("resize");
    expect(corner.gesture.kind === "resize" && corner.gesture.handle).toBe("se");
    expect(corner.sel).toBe(sel);
  });

  test("a turned stroke's handles are where the turned box puts them", () => {
    const sel = new Set([1]);
    const ov = overlayOf(INK, sel)!;
    expect(ov.r).toBe(0.5);
    const knob = selectPress(INK, sel, ov.knob.x, ov.knob.y, false);
    // the knob's own coordinates are in the box's frame; the press lands in
    // the sheet's, so it must be turned first to hit
    expect(knob.gesture.kind).not.toBe("rotate");
    const cos = Math.cos(0.5);
    const sin = Math.sin(0.5);
    const wx = ov.cx + (ov.knob.x - ov.cx) * cos - (ov.knob.y - ov.cy) * sin;
    const wy = ov.cy + (ov.knob.x - ov.cx) * sin + (ov.knob.y - ov.cy) * cos;
    expect(selectPress(INK, sel, wx, wy, false).gesture.kind).toBe("rotate");
  });
});

describe("a drag re-applies one delta to the snapshot (selectDrag)", () => {
  test("a move by the pointer's own delta; a marquee moves nothing", () => {
    const sel = new Set([0]);
    const moved = selectDrag({ kind: "move", from: [100, 80] }, INK, sel, 110, 95, false)!;
    expect(moved[0]).toEqual({ ...ring, b: [50, 55, 170, 135] });
    expect(moved[1]).toBe(INK[1]);
    expect(selectDrag({ kind: "marquee", from: [0, 0], keep: new Set() }, INK, sel, 50, 50, false)).toBeNull();
  });

  test("a rotate by the angle swept about the box's centre, snapping to 15 degrees under shift", () => {
    const sel = new Set([0]);
    const ov = overlayOf(INK, sel)!;
    const g = { kind: "rotate" as const, from: [ov.knob.x, ov.knob.y] as const, cx: ov.cx, cy: ov.cy, a0: -Math.PI / 2 };
    const quarter = selectDrag(g, INK, sel, ov.cx + 30, ov.cy, false)!;
    expect(quarter[0].k === "ellipse" && quarter[0].r).toBeCloseTo(Math.PI / 2, 6);
    // 2px short of the quarter turn snaps up onto it; unsnapped it would not
    const snapped = selectDrag(g, INK, sel, ov.cx + 30, ov.cy + 2, true)!;
    expect(snapped[0].k === "ellipse" && snapped[0].r).toBeCloseTo(Math.PI / 2, 6);
    const loose = selectDrag(g, INK, sel, ov.cx + 30, ov.cy + 2, false)!;
    expect(loose[0].k === "ellipse" && loose[0].r).not.toBeCloseTo(Math.PI / 2, 3);
  });

  test("a corner drag grows the box and holds the opposite corner still", () => {
    const sel = new Set([0]);
    const ov = overlayOf(INK, sel)!;
    const se = ov.handles.find((h) => h.at === "se")!;
    const grown = selectDrag({ kind: "resize", from: [se.x, se.y], handle: "se" }, INK, sel, se.x + 24, se.y + 16, false)!;
    expect(grown[0].k === "ellipse" && grown[0].b).toEqual([40, 40, 184, 136]);
    expect(changed(INK, grown)).toBe(true);
    // a drag that goes nowhere hands the snapshot's own strokes back
    const still = selectDrag({ kind: "resize", from: [se.x, se.y], handle: "se" }, INK, sel, se.x, se.y, false)!;
    expect(changed(INK, still)).toBe(false);
  });
});

// ---- ink and weight on a selection ------------------------------------------------

describe("the island restyles a standing selection (restyleSel)", () => {
  test("ink lands on every selected stroke, words included; weight skips a label", () => {
    const sel = new Set([0, 3]);
    const inked = restyleSel(INK, sel, { c: 2 });
    expect(inked[0].c).toBe(2);
    expect(inked[3].c).toBe(2);
    expect(inked[1]).toBe(INK[1]);
    const weighed = restyleSel(INK, sel, { t: 4 });
    expect(weighed[0].k === "ellipse" && weighed[0].t).toBe(4);
    expect(weighed[3]).toBe(INK[3]);
  });

  test("a restyle that changes nothing is nothing: identity, so no commit follows it", () => {
    const same = restyleSel(INK, new Set([0]), { c: 0 });
    expect(changed(INK, same)).toBe(false);
    const drawing = src("Drawing.tsx");
    expect(drawing).toContain("if (changed(strokes, restyled)) commit(restyled, true);");
    // and with nothing selected the island writes the block's memory instead
    expect(drawing).toContain("setMemory({ ink: next })");
    expect(drawing).toContain("setMemory({ weight: next })");
  });
});

// ---- the hover, the cursor and the double-click ------------------------------------

describe("what the pointer reads before it presses", () => {
  test("the cursor is the knob's grab, a corner's diagonal, move over a stroke, nothing on paper", () => {
    const sel = new Set([0]);
    const ov = overlayOf(INK, sel)!;
    expect(cursorAt(INK, sel, ov.knob.x, ov.knob.y)).toBe("grab");
    expect(cursorAt(INK, sel, ov.handles[0].x, ov.handles[0].y)).toBe("nwse");
    expect(cursorAt(INK, sel, ov.handles[1].x, ov.handles[1].y)).toBe("nesw");
    expect(cursorAt(INK, sel, 100, 80)).toBe("move");
    expect(cursorAt(INK, sel, 400, 300)).toBeNull();
    // the sheet wears it as an attribute the stylesheet reads, never a style
    const css = src("drawing.css");
    for (const c of ["move", "grab", "grabbing", "nwse", "nesw"]) expect(css).toContain(`.dw-sheet[data-cursor="${c}"]`);
    expect(css).toContain('.dw-sheet[data-tool="select"]');
  });

  test("a double-click on a label opens it in place; on anything else, nothing", () => {
    expect(labelAt(INK, 240, 196)).toBe(3);
    expect(labelAt(INK, 100, 80)).toBe(-1);
    const drawing = src("Drawing.tsx");
    expect(drawing).toContain('onDoubleClick={tool === "select" ? onSheetDouble : undefined}');
    // the edit commits back into the label's own index, never appending
    expect(drawing).toContain("strokes.map((s, i) => (i === at.existing ? { ...s, v } : s))");
  });

  test("the hover box is the selection's own box, fainter, and none of the overlay takes a pointer", () => {
    const css = src("drawing.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.dw-sel,\s*\.dw-hover,\s*\.dw-marquee\s*\{\s*pointer-events:\s*none;/);
    expect(src("drawing.css")).toMatch(/\.dw-hover rect \{[^}]*opacity: 0\.5; \/\* optical \*\//);
    const drawing = src("Drawing.tsx");
    expect(drawing).toContain("overlayOf(strokes, [hover])");
    expect(drawing).toContain("overlayOf(shown, sel)");
  });

  test("the box stands PAD outside the ink", () => {
    const ov = overlayOf(INK, [0])!;
    expect(ov.box).toEqual([40 - PAD, 40 - PAD, 160 + PAD, 120 + PAD]);
    expect(PAD).toBe(4);
  });
});
