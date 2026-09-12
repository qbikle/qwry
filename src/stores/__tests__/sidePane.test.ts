// The one right pane (AGENT-UX section 1): Inspector and Ask are modes of a
// single card. The radio press opens, switches or closes; the width is
// shared and clamps into the showing mode's range; the two mode stores
// mirror `open` for their own readers and Ask's transient chrome leaves with
// it.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";

// persist reads `window.localStorage` when the store module evaluates and the
// legacy-key read goes to the `localStorage` global at call time; bun has
// neither, so an in-memory stand-in goes in for the length of this file.
// bun test shares one module cache and one global scope across files, and
// another file (ask.test.ts pulls ask.ts, which pulls this store) may have
// evaluated the module against ITS shim first, so this file installs its own
// storage unconditionally, points the store's persist at it, rehydrates in
// the hydration tests, and puts the previous globals back after
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
const previous = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
};
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true, writable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
const { useSidePane, PANE_FLOOR, PANE_MAX, PANE_DEFAULT_W, clampPaneWidth } = await import(
  "../sidePane"
);
const { useAsk } = await import("../ask");
useSidePane.persist.setOptions({ storage: createJSONStorage(() => storage) });
afterAll(() => {
  for (const k of ["window", "localStorage"] as const) {
    const d = previous[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
});

const pane = () => useSidePane.getState();
const reset = () => useSidePane.setState({ mode: "inspector", open: false, width: 300 });
const legacy = JSON.stringify({ state: { open: false, width: 260 }, version: 0 });

describe("useSidePane hydration", () => {
  beforeEach(() => {
    // setState persists, so the slate is wiped AFTER the defaults go in
    useSidePane.setState({ mode: "inspector", open: true, width: 300 });
    mem.clear();
  });

  test("a store with nothing of its own adopts the persisted inspector shell", () => {
    mem.set("qwry.inspector", legacy);
    useSidePane.persist.rehydrate();
    expect(pane().mode).toBe("inspector");
    expect(pane().open).toBe(false);
    expect(pane().width).toBe(260);
  });

  test("its own key wins over the legacy one and clamps to its mode", () => {
    mem.set("qwry.inspector", legacy);
    mem.set(
      "qwry.sidePane",
      JSON.stringify({ state: { mode: "ask", open: true, width: 900 }, version: 0 }),
    );
    useSidePane.persist.rehydrate();
    expect(pane().mode).toBe("ask");
    expect(pane().open).toBe(true);
    expect(pane().width).toBe(PANE_MAX.ask);
  });

  test("garbage in either key leaves the defaults standing", () => {
    mem.set("qwry.inspector", "{not json");
    mem.set("qwry.sidePane", JSON.stringify({ state: { mode: "drawer", width: "wide" } }));
    useSidePane.persist.rehydrate();
    expect(pane().mode).toBe("inspector");
    expect(pane().open).toBe(true);
    expect(pane().width).toBe(300);
  });

  test("a write lands under qwry.sidePane with the three shell facts only", () => {
    pane().show("ask");
    const persisted = JSON.parse(mem.get("qwry.sidePane") ?? "{}") as { state: unknown };
    expect(persisted.state).toEqual({ mode: "ask", open: true, width: 320 });
  });
});

describe("useSidePane radio", () => {
  beforeEach(reset);

  test("closed → the chord opens the pane in that mode", () => {
    pane().toggle("ask");
    expect(pane().open).toBe(true);
    expect(pane().mode).toBe("ask");
  });

  test("the chord of the showing mode closes the pane and keeps the mode", () => {
    pane().toggle("ask");
    pane().toggle("ask");
    expect(pane().open).toBe(false);
    expect(pane().mode).toBe("ask");
  });

  test("the other chord switches the mode and keeps the pane open", () => {
    pane().toggle("inspector");
    pane().toggle("ask");
    expect(pane().open).toBe(true);
    expect(pane().mode).toBe("ask");
    pane().toggle("inspector");
    expect(pane().open).toBe(true);
    expect(pane().mode).toBe("inspector");
  });

  test("show opens or switches and never closes", () => {
    pane().show("ask");
    pane().show("ask");
    expect(pane().open).toBe(true);
    pane().show("inspector");
    expect(pane().open).toBe(true);
    expect(pane().mode).toBe("inspector");
  });

  test("close keeps the mode for the next open", () => {
    pane().show("ask");
    pane().close();
    expect(pane().open).toBe(false);
    expect(pane().mode).toBe("ask");
  });
});

describe("useSidePane width", () => {
  beforeEach(reset);

  test("the width is shared: switching keeps it when both modes allow it", () => {
    pane().show("ask");
    pane().setWidth(480);
    pane().toggle("inspector");
    expect(pane().width).toBe(480);
    pane().toggle("ask");
    expect(pane().width).toBe(480);
  });

  test("switching clamps into the new mode's range, both directions", () => {
    pane().show("inspector");
    pane().setWidth(240);
    pane().toggle("ask");
    expect(pane().width).toBe(PANE_FLOOR.ask);
    pane().toggle("inspector");
    pane().setWidth(PANE_MAX.inspector);
    expect(pane().width).toBe(640);
    pane().toggle("ask");
    expect(pane().width).toBe(PANE_MAX.ask);
  });

  test("a switch from Ask's floor leaves an inspector at 320, not its default", () => {
    pane().show("ask");
    pane().setWidth(100);
    expect(pane().width).toBe(320);
    pane().toggle("inspector");
    expect(pane().width).toBe(320);
  });

  test("setWidth clamps to the showing mode and rounds", () => {
    pane().show("inspector");
    pane().setWidth(100);
    expect(pane().width).toBe(PANE_FLOOR.inspector);
    pane().setWidth(9000);
    expect(pane().width).toBe(PANE_MAX.inspector);
    pane().setWidth(300.6);
    expect(pane().width).toBe(301);
  });

  test("a non-finite width falls back to the mode's default", () => {
    expect(clampPaneWidth("ask", Number.NaN)).toBe(PANE_DEFAULT_W.ask);
    expect(clampPaneWidth("inspector", Number.POSITIVE_INFINITY)).toBe(
      PANE_DEFAULT_W.inspector,
    );
  });
});

describe("useAsk mirrors the pane", () => {
  beforeEach(() => {
    reset();
    useAsk.setState({ traceOpenFor: null, pickerOpen: false });
  });

  test("open is true only while the pane shows Ask", () => {
    expect(useAsk.getState().open).toBe(false);
    pane().show("ask");
    expect(useAsk.getState().open).toBe(true);
    pane().toggle("inspector");
    expect(useAsk.getState().open).toBe(false);
    pane().toggle("ask");
    expect(useAsk.getState().open).toBe(true);
    pane().close();
    expect(useAsk.getState().open).toBe(false);
  });

  test("leaving the screen takes the trace and the picker with it", () => {
    pane().show("ask");
    useAsk.getState().openTrace("x1", "s1");
    useAsk.getState().setPickerOpen(true);
    pane().toggle("inspector");
    expect(useAsk.getState().traceOpenFor).toBeNull();
    expect(useAsk.getState().pickerOpen).toBe(false);
  });

  test("a width change alone leaves Ask's chrome untouched", () => {
    pane().show("ask");
    useAsk.getState().openTrace("x1");
    pane().setWidth(500);
    expect(useAsk.getState().traceOpenFor).toEqual({ exchangeId: "x1", stepId: null });
  });
});
