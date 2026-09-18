// `Ask` on a canvas block (A3 item 4, AGENT-UX section 16d). There is no
// comment composer on the canvas: a comment on a result IS a question about
// it, so the block becomes one `@` token in the draft and the reply is a
// normal exchange. What is asserted here is the seam that makes that true:
// the block is registered where the resolver will look for it, the token
// lands at the END of whatever the connection's draft already held (never
// fused to the word before it, which the grammar would read as one word and
// not a tag), the pane opens in Ask and asks for focus, and a block the
// canvas deletes stops resolving without anything refusing (LESSONS 5).
//
// The shims are ask.test.ts's, plus what agent.ts wants at import (settings.ts
// paints the theme onto the document, saved.ts persists through localStorage).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

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
const STANDINS: Record<string, unknown> = { window: globalThis, localStorage: storage, document: inert };
const shimmed = new Set<string>();
for (const [k, value] of Object.entries(STANDINS)) {
  if (k in globalThis) continue;
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  shimmed.add(k);
}

const { useAsk } = await import("../ask");
const { useAgent } = await import("../agent");
const { useSidePane } = await import("../sidePane");
const { mentionsIn } = await import("../../agent/mentions");

afterAll(() => {
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

const PID = "p1";
const BLOCK = {
  id: "b1",
  name: "can you check the revenue in last month",
  sql: "SELECT 1",
  columns: ["revenue"],
  rowCount: 4,
};
const TOKEN = `@"${BLOCK.name}"`;

beforeEach(() => {
  useAsk.setState({ drafts: {}, draftFor: null, blocks: {}, focusSeq: 0, edit: null });
  useAgent.setState({ activeProfileId: PID, threads: {}, activeThread: {}, exchanges: {} });
  useSidePane.setState({ open: false, mode: "inspector" });
});

describe("askAbout", () => {
  test("registers the block, opens the pane in Ask and puts the token at the caret", () => {
    useAgent.getState().askAbout(BLOCK);
    expect(useAsk.getState().blocks[BLOCK.id]).toEqual(BLOCK);
    expect(useSidePane.getState()).toMatchObject({ open: true, mode: "ask" });
    expect(useAsk.getState().drafts[PID]).toBe(`${TOKEN} `);
    expect(useAsk.getState().focusSeq).toBe(1);
  });

  test("a draft already typed keeps its words, and a space keeps the token a token", () => {
    useAsk.setState({ drafts: { [PID]: "compare" } });
    useAgent.getState().askAbout(BLOCK);
    expect(useAsk.getState().drafts[PID]).toBe(`compare ${TOKEN} `);
    // the grammar reads `a@b` as one word: the space is what keeps the tag one
    expect(mentionsIn(useAsk.getState().drafts[PID], { snapshot: null, saved: [], threads: [], blocks: [BLOCK] })).toHaveLength(1);
  });

  test("a draft that already ends in a space gains no second one", () => {
    useAsk.setState({ drafts: { [PID]: "compare " } });
    useAgent.getState().askAbout(BLOCK);
    expect(useAsk.getState().drafts[PID]).toBe(`compare ${TOKEN} `);
  });

  test("a block with no name to quote gets the composer and no tag", () => {
    useAgent.getState().askAbout({ id: "b2", name: "   " });
    expect(useAsk.getState().drafts[PID]).toBeUndefined();
    expect(useAsk.getState().focusSeq).toBe(1);
    expect(useSidePane.getState().mode).toBe("ask");
  });

  test("no connection on screen is no draft with nowhere to belong", () => {
    useAgent.setState({ activeProfileId: null });
    useAgent.getState().askAbout(BLOCK);
    expect(useAsk.getState().drafts).toEqual({});
    expect(useSidePane.getState().open).toBe(false);
  });

  test("the draft belongs to its connection and never surfaces in another's", () => {
    useAgent.getState().askAbout(BLOCK);
    expect(useAsk.getState().drafts["p2"]).toBeUndefined();
  });
});

describe("the block registry", () => {
  test("a block the canvas dropped stops resolving and nothing refuses", () => {
    useAsk.getState().rememberBlock(BLOCK);
    const ctx = () => ({
      snapshot: null,
      saved: [],
      threads: [],
      blocks: Object.values(useAsk.getState().blocks),
    });
    expect(mentionsIn(TOKEN, ctx())).toHaveLength(1);
    useAsk.getState().forgetBlock(BLOCK.id);
    expect(useAsk.getState().blocks).toEqual({});
    expect(mentionsIn(TOKEN, ctx())).toEqual([]);
  });

  test("forgetting a block that was never held changes nothing", () => {
    const before = useAsk.getState().blocks;
    useAsk.getState().forgetBlock("nobody");
    expect(useAsk.getState().blocks).toBe(before);
  });

  test("a block asked about twice is one entry, the newest text", () => {
    useAsk.getState().rememberBlock(BLOCK);
    useAsk.getState().rememberBlock({ ...BLOCK, rowCount: 9 });
    expect(Object.keys(useAsk.getState().blocks)).toEqual([BLOCK.id]);
    expect(useAsk.getState().blocks[BLOCK.id].rowCount).toBe(9);
  });
});
