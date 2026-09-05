// The composer draft carries its connection (LESSONS 4): text typed toward
// one connection never surfaces in another's composer, and comes back when
// its connection does. AskPanel pushes `draftFor` for the connection on
// screen; AnswerBlock's Ask Differently writes through `setDraft` blind.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// persist reads `window.localStorage` when the store module evaluates; bun
// has neither, so an in-memory stand-in goes in first (the dynamic import
// keeps the order) and leaves again after: bun test shares one global scope
// across files, and the store keeps its own reference to the storage
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
const { useAsk } = await import("../ask");
afterAll(() => {
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

const reset = () => useAsk.setState({ drafts: {}, draftFor: null });

describe("useAsk drafts", () => {
  beforeEach(reset);

  test("a draft belongs to the connection whose composer is on screen", () => {
    const a = useAsk.getState();
    a.setDraftFor("staging");
    a.setDraft("how many orders shipped");
    a.setDraftFor("prod");
    expect(useAsk.getState().drafts["prod"]).toBeUndefined();
    expect(useAsk.getState().drafts["staging"]).toBe("how many orders shipped");
  });

  test("switching back restores the unsent text", () => {
    const a = useAsk.getState();
    a.setDraftFor("staging");
    a.setDraft("unsent");
    a.setDraftFor("prod");
    a.setDraft("other");
    a.setDraftFor("staging");
    expect(useAsk.getState().drafts["staging"]).toBe("unsent");
    expect(useAsk.getState().drafts["prod"]).toBe("other");
  });

  test("clearing removes only the on-screen connection's entry", () => {
    const a = useAsk.getState();
    a.setDraftFor("staging");
    a.setDraft("unsent");
    a.setDraftFor("prod");
    a.setDraft("other");
    a.setDraft("");
    expect(useAsk.getState().drafts).toEqual({ staging: "unsent" });
  });

  test("with no composer on screen a write has no home and is dropped", () => {
    const before = useAsk.getState().drafts;
    useAsk.getState().setDraft("orphan");
    expect(useAsk.getState().drafts).toBe(before);
  });
});
