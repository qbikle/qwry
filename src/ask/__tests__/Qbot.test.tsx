// qbot (B4): what the markup promises and what the twinkle's generator is
// allowed to say. The loops themselves are CSS and are evidenced in pixels
// (the b4 frames) and by the CDP probe; this file guards the two things a
// refactor can quietly break: the affordance qbot must NOT have, and the
// cadence staying inside the sweep's jitter.
//
// The stylesheet import is stubbed (bun's runtime has no CSS loader); the side
// pane's store is the REAL one, because a module mock here is a mock for every
// file in the run and `stores/ask.ts` reads `useSidePane.getState()` at load.
// The pane ships defaulted to the Inspector and a static render reads that
// initial state, so the pause face here is the Inspector's; the browser's own
// faces are the probe's.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../qbot.css", () => ({}));

// Qbot reads the side pane's store, whose persist reads `window.localStorage`
// as that module evaluates; bun has neither, and a persist that finds no
// storage never attaches its own API, which the store's OWN test then asks
// for. So the same in-memory stand-in ask.test.ts uses goes in first (the
// dynamic import keeps the order) and leaves again after
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
const shimmed = ["window", "localStorage"].filter((k) => !(k in globalThis));
for (const k of shimmed) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : storage,
    configurable: true,
    writable: true,
  });
}
const { QBOT_NAME, Qbot, TWINKLE_SPANS, twinkleCycleMs } = await import("../Qbot");
afterAll(() => {
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

const html = () => renderToStaticMarkup(<Qbot />);


const BASE = TWINKLE_SPANS.reduce((a, b) => a + b, 0);

describe("Qbot", () => {
  test("he is the drawing: seven parts, in the drawn order, at the sketch's coordinates", () => {
    const out = html();
    expect(out).toContain('viewBox="0 0 56 70"');
    for (const part of [
      '<polyline class="qbot-antenna" points="35,14.5 42,4 52,4"',
      '<circle class="qbot-eye" cx="24" cy="31" r="10.5"',
      '<line class="qbot-leg-l" x1="8" y1="48" x2="8" y2="61.5"',
      '<line class="qbot-leg-r" x1="40.5" y1="31" x2="40.5" y2="62.5"',
      '<circle class="qbot-body" cx="24" cy="31" r="16.5"',
      '<circle class="qbot-hl qbot-hl-big" cx="22" cy="27" r="1.8"',
      '<circle class="qbot-hl qbot-hl-small"',
      '<circle class="qbot-bulb" cx="52" cy="4" r="3"',
    ]) {
      expect(out).toContain(part);
    }
    // the two marks travel together: the gaze moves the group, never the disc
    expect(out).toContain('<g class="qbot-hls">');
    const order = ["qbot-antenna", "qbot-eye", "qbot-leg-l", "qbot-leg-r", "qbot-body", "qbot-hls", "qbot-bulb"];
    expect(order.map((c) => out.indexOf(c))).toEqual([...order.map((c) => out.indexOf(c))].sort((a, b) => a - b));
  });

  test("he is not a control (rule 8's inverse): hidden from the tree, no name, no handle", () => {
    const out = html();
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("<title");
    expect(out).not.toContain("title=");
    expect(out).not.toContain("role=");
    expect(out).not.toContain("tabindex");
    expect(out).not.toContain("aria-label");
    // and no string at all: the empty state's words are the starters' (rule 11)
    expect(out.replace(/<[^>]*>/g, "").trim()).toBe("");
  });

  test("the gaze is an event and never the mount's face", () => {
    expect(html()).not.toContain("data-gaze");
  });

  test("the pause is the PANE's fact, read at render", () => {
    // a static render reads zustand's INITIAL state (react's server snapshot),
    // and the pane ships defaulted to the Inspector, so the paused face is the
    // one SSR shows however this test writes the store. That the loops RUN
    // while Ask is on screen, and pause and resume in place when it is not, is
    // the CDP probe's evidence (b4-probe.log passes 1 and 2), not this file's
    expect(html()).toContain('data-paused=""');
  });

  test("the twinkle carries its cycle's own length, in ms", () => {
    const out = html();
    const m = out.match(/--qbot-twinkle-dur:(\d+)ms/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
  });

  test("the name lives in one constant", () => {
    expect(QBOT_NAME).toBe("qbot");
  });
});

describe("twinkleCycleMs", () => {
  test("the cadence is the sweep's ten spans, no two consecutive ones equal", () => {
    expect(TWINKLE_SPANS).toHaveLength(10);
    for (let i = 1; i < TWINKLE_SPANS.length; i++) {
      expect(TWINKLE_SPANS[i]).not.toBe(TWINKLE_SPANS[i - 1]);
    }
  });

  test("every span is jittered by ±20% and no further: the extremes are the bounds", () => {
    expect(twinkleCycleMs(() => 0)).toBe(Math.round(BASE * 0.8));
    expect(twinkleCycleMs(() => 1)).toBe(Math.round(BASE * 1.2));
    expect(twinkleCycleMs(() => 0.5)).toBe(BASE);
  });

  test("a hundred cycles stay inside the bounds and no two are the same length", () => {
    const runs = Array.from({ length: 100 }, () => twinkleCycleMs());
    for (const ms of runs) {
      expect(ms).toBeGreaterThanOrEqual(Math.round(BASE * 0.8));
      expect(ms).toBeLessThanOrEqual(Math.round(BASE * 1.2));
    }
    // a metronome would repeat; ten jittered spans do not (a tie in 100 draws
    // over a ~3200 ms range would be luck, not a cadence)
    expect(new Set(runs).size).toBeGreaterThan(90);
  });
});
