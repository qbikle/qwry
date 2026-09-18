// F1: the drawing answers the pointer (the maintainer's recording, 2026-09-18).
// Three claims the eye cannot check in a still and the suite could not check at
// all, because the sheet's whole gesture lived where only a browser reaches it:
//
//   the chrome  an invisible control is still a control. Nowhere the cluster or
//               the corner handle is hidden may it go on taking presses, and
//               the drawing's cluster reveals on the register every other kind
//               uses (AGENT-UX 16b) rather than on a carve-out of its own
//   the press   arms the sheet, so the tool chords answer after a stroke a HAND
//               made and not only after ↩ from the keyboard, and the block
//               wears `data-inking` for exactly as long as the stroke is in the
//               air: the state a frame, a test and a probe can all read
//   the tap     makes a mark or makes nothing. A stroke that counts in
//               `Drawing, N strokes`, in the undo stack and in the clear
//               confirm while rendering nothing at all is LESSONS 9's own bug
//
// The CSS half is read off the files themselves, which is this repo's own
// device for law that has no runtime (src/agent/__tests__/contracts.test.ts
// reads source and asserts a contract): a rule that hides a control IS the
// contract, and it is checkable without a browser. The pointer half is read off
// the seam the handler uses, since there is no DOM in this runner.
//
// What neither half reaches — that a real press on a real sheet lands where
// these rules say — is the probe's (docs/research/f1-frames/f1-probe.ts, driven
// over CDP against the canvas harness) and the frame `f1-draw-inking`'s.

import { describe, expect, test } from "bun:test";
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

// the canvas store reaches the theme and the Tauri bridge at import: the canvas
// tests' own seam (NoteBlock.test.tsx)
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
mockIPC(() => undefined);

const { INKING, armSheet, inkSaid, restSheet } = await import("../Drawing");
const { toolForKey } = await import("../blockTools");
const { marksOf, penPath, simplify } = await import("../strokes");
clearMocks();

// ---- the stylesheets, as rules -------------------------------------------

interface Rule {
  file: string;
  selector: string;
  body: string;
}

const CSS = ["ask/ask.css", "canvas/canvas.css", "canvas/note.css", "canvas/drawing.css", "canvas/grid.css"];

/** every rule in a stylesheet, comments stripped. A hand-rolled split is
 * enough for the one question asked here (does THIS block disarm what it
 * hides), and a CSS parser is a dependency for a reader that needs none */
function rulesOf(rel: string): Rule[] {
  const css = readFileSync(join(import.meta.dir, "../..", rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  for (const chunk of css.split("}")) {
    const at = chunk.lastIndexOf("{");
    if (at === -1) continue;
    const head = chunk.slice(0, at);
    out.push({ file: rel, selector: head.slice(head.lastIndexOf("{") + 1).trim(), body: chunk.slice(at + 1) });
  }
  return out;
}

const RULES = CSS.flatMap(rulesOf);

/** the two control species this wave is answering for: the floating cluster
 * and the one corner handle that rides its register (DESIGN rule 1) */
const CHROME = /\.acts-float|\.cvg-handle/;
const has = (body: string, prop: string, value: string) =>
  new RegExp(`(^|[;{\\s])${prop}\\s*:\\s*${value}\\s*(;|$)`).test(body);

const where = (r: Rule) => `${r.file}  ${r.selector.replace(/\s+/g, " ")}`;

describe("a hidden control takes no press (F1 rule c)", () => {
  test("every rule that hides the cluster or the handle disarms it in the same block", () => {
    const hiding = RULES.filter((r) => CHROME.test(r.selector) && has(r.body, "opacity", "0"));
    expect(hiding.length).toBeGreaterThan(0);
    const armed = hiding.filter((r) => !has(r.body, "pointer-events", "none"));
    expect(armed.map(where)).toEqual([]);
  });

  test("and every rule that reveals one hands the pointer back", () => {
    const showing = RULES.filter((r) => CHROME.test(r.selector) && has(r.body, "opacity", "1"));
    expect(showing.length).toBeGreaterThan(0);
    const dead = showing.filter((r) => !has(r.body, "pointer-events", "auto"));
    expect(dead.map(where)).toEqual([]);
  });

  test("the species' own rest state is the one place the cluster is disarmed", () => {
    const base = RULES.find((r) => r.file === "ask/ask.css" && r.selector === ".acts-float");
    expect(base).toBeDefined();
    expect(has(base?.body ?? "", "pointer-events", "none")).toBe(true);
  });
});

describe("the drawing's cluster reveals on every other kind's register (F1 rule a)", () => {
  test("no rule hides it on a bare hover any more", () => {
    const carve = RULES.filter(
      (r) => CHROME.test(r.selector) && /:hover/.test(r.selector) && has(r.body, "opacity", "0"),
    );
    expect(carve.map(where)).toEqual([]);
  });

  test("the one thing that hides it is a stroke in the air", () => {
    const hiding = RULES.filter(
      (r) => r.file === "canvas/drawing.css" && CHROME.test(r.selector) && has(r.body, "opacity", "0"),
    );
    expect(hiding.length).toBe(2);
    for (const r of hiding) expect(r.selector).toContain("[data-inking]");
  });

  test("and the block's own hover still reveals it, as it does on a note and a result", () => {
    const hover = RULES.filter(
      (r) => r.file === "canvas/canvas.css" && r.selector.includes(".blk:hover") && has(r.body, "opacity", "1"),
    );
    expect(hover.length).toBe(1);
    expect(hover[0].selector).toContain(":focus-within");
    expect(hover[0].selector).toContain("[data-hot]");
  });
});

// ---- the press ------------------------------------------------------------

interface Focused {
  calls: { preventScroll?: boolean }[];
}

const sheetStub = () => {
  const seen: Focused = { calls: [] };
  return { seen, node: { focus: (o: { preventScroll?: boolean } = {}) => void seen.calls.push(o) } };
};

const blockStub = () => {
  const attrs = new Set<string>();
  return { attrs, node: { toggleAttribute: (n: string, on?: boolean) => void (on ? attrs.add(n) : attrs.delete(n)) } };
};

describe("a press arms the sheet (F1 rule b)", () => {
  test("the sheet takes focus, and takes it without scrolling the page", () => {
    const sheet = sheetStub();
    armSheet(sheet.node, blockStub().node);
    expect(sheet.seen.calls.length).toBe(1);
    // LESSONS 7: every programmatic focus, in a scroller the canvas owns
    expect(sheet.seen.calls[0].preventScroll).toBe(true);
  });

  test("so the tool chords answer a hand's stroke, not only ↩ from the keyboard", () => {
    const sheet = sheetStub();
    armSheet(sheet.node, blockStub().node);
    // the sheet holds focus, so onSheetKey is the element that hears `r`
    expect(sheet.seen.calls.length).toBe(1);
    expect(toolForKey("r")).toBe("rect");
  });

  test("the block wears the stroke for as long as it is in the air", () => {
    const block = blockStub();
    armSheet(sheetStub().node, block.node);
    expect(block.attrs.has(INKING)).toBe(true);
    restSheet(block.node);
    expect(block.attrs.has(INKING)).toBe(false);
  });

  test("a cancelled stroke rests the block exactly as a finished one does", () => {
    // pointercancel, a lost capture and Esc all run the gesture's own `done`,
    // and what `done` owes the page is the attribute back off the block
    const block = blockStub();
    armSheet(sheetStub().node, block.node);
    restSheet(block.node);
    restSheet(block.node);
    expect(block.attrs.has(INKING)).toBe(false);
  });

  test("the attribute the CSS reads is the attribute the handler writes", () => {
    const drawing = readFileSync(join(import.meta.dir, "../drawing.css"), "utf8");
    expect(drawing).toContain(`[${INKING}]`);
  });
});

// ---- the tap --------------------------------------------------------------

describe("a tap makes a mark or makes nothing (F1 rule d)", () => {
  test("one point survives the simplifier, so the press the hand made is kept", () => {
    expect(simplify([120, 64])).toEqual([120, 64]);
  });

  test("and renders as a dot: a zero-length segment under a round cap", () => {
    const d = penPath([120, 64]);
    // `M120 64` alone paints nothing in SVG; the `l0 0` is the dot
    expect(d).toBe("M120 64l0 0");
    const mark = marksOf([{ k: "pen", c: 0, t: 2, p: [120, 64] }])[0];
    expect(mark.el).toBe("path");
    expect(mark.el === "path" && mark.round).toBe(true);
  });

  test("so the count the element says is a count of marks a reader can see", () => {
    expect(inkSaid([{ k: "pen", c: 0, t: 2, p: [120, 64] }])).toBe("Drawing, 1 stroke");
  });

  test("a tap with a SHAPE tool commits nothing at all, which is the other half of the rule", () => {
    // the shapes need a drag to exist (Drawing.tsx `seal`: no travel, no
    // stroke), so the dot is the pen's alone and a zero-area rectangle is
    // never written. What a zero-area box WOULD draw is nothing either way
    const mark = marksOf([{ k: "rect", c: 0, t: 2, b: [40, 40, 40, 40] }])[0];
    expect(mark.el === "path" && mark.round).toBe(false);
  });
});
