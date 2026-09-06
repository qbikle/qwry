// The composer draft carries its connection (LESSONS 4): text typed toward
// one connection never surfaces in another's composer, and comes back when
// its connection does. AskPanel pushes `draftFor` for the connection on
// screen; AnswerBlock's Ask Differently writes through `setDraft` blind.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// ask.ts no longer persists anything itself, but it imports sidePane.ts,
// whose persist reads `window.localStorage` when that module evaluates; bun
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

const reset = () => useAsk.setState({ drafts: {}, draftFor: null, edit: null });

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

// W4: clicking an older bubble puts its question in the composer and folds
// the thread from there. The store holds the mode; the fold, the travel and
// the truncation live elsewhere.
const EDIT = {
  profileId: "staging",
  threadId: "t-1",
  exchangeId: "ex-1",
  question: "how many orders shipped",
};

describe("useAsk edit mode", () => {
  beforeEach(reset);

  test("beginning an edit fills that connection's draft and asks for focus", () => {
    const seq = useAsk.getState().focusSeq;
    useAsk.getState().setDraftFor("staging");
    useAsk.getState().beginEdit(EDIT);
    expect(useAsk.getState().edit).toEqual(EDIT);
    expect(useAsk.getState().drafts["staging"]).toBe(EDIT.question);
    expect(useAsk.getState().focusSeq).toBe(seq + 1);
  });

  test("ending an edit leaves the draft where it is: the caller decides", () => {
    useAsk.getState().setDraftFor("staging");
    useAsk.getState().beginEdit(EDIT);
    useAsk.getState().endEdit();
    expect(useAsk.getState().edit).toBeNull();
    expect(useAsk.getState().drafts["staging"]).toBe(EDIT.question);
  });

  test("switching connection cancels the edit and leaves the draft behind", () => {
    useAsk.getState().setDraftFor("staging");
    useAsk.getState().beginEdit(EDIT);
    useAsk.getState().setDraftFor("staging");
    expect(useAsk.getState().edit).toEqual(EDIT);
    useAsk.getState().setDraftFor("prod");
    expect(useAsk.getState().edit).toBeNull();
    expect(useAsk.getState().drafts["staging"]).toBe(EDIT.question);
  });
});
