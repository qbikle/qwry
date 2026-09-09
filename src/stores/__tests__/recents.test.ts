// What a connection reached for last (B2 item 1, recents.ts): newest first,
// one row per thing, capped, per connection, and only the pointer stored
// (never the name, which is read off the live connection when the row is
// drawn). Also what a sent question contributes, which is where the `@`
// completion's `Recent` section gets most of its rows.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";

// the persist middleware reads localStorage at module evaluation and bun has
// none; an in-memory stand-in goes in for the length of this file and the
// previous globals come back after (bun test shares one global scope)
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
const { useRecents, recentOf, RECENTS_CAP } = await import("../recents");
type Mention = import("../../agent/mentions").Mention;
useRecents.persist.setOptions({ storage: createJSONStorage(() => storage) });
afterAll(() => {
  for (const [k, d] of Object.entries(previous)) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
});

const held = (profileId: string) => useRecents.getState().byProfile[profileId] ?? [];
const keys = (profileId: string) => held(profileId).map((r) => `${r.kind}:${r.key}`);

const mention = (m: Partial<Mention> & Pick<Mention, "kind" | "ref">): Mention =>
  ({ span: [0, 1], token: "t", ...m }) as Mention;

beforeEach(() => {
  useRecents.setState({ byProfile: {} });
  mem.clear();
});

describe("touch", () => {
  test("newest first, and a repeat moves rather than doubles", () => {
    useRecents.getState().touch("p", "table", "public.a");
    useRecents.getState().touch("p", "table", "public.b");
    useRecents.getState().touch("p", "table", "public.a");
    expect(keys("p")).toEqual(["table:public.a", "table:public.b"]);
  });

  test("one kind never shadows another at the same key", () => {
    useRecents.getState().touch("p", "saved", "x1");
    useRecents.getState().touch("p", "canvas", "x1");
    expect(keys("p")).toEqual(["canvas:x1", "saved:x1"]);
  });

  test("connections keep their own list, and a drop takes one away", () => {
    useRecents.getState().touch("p", "table", "public.a");
    useRecents.getState().touch("q", "table", "public.b");
    expect(keys("p")).toEqual(["table:public.a"]);
    expect(keys("q")).toEqual(["table:public.b"]);
    useRecents.getState().drop("p");
    expect(keys("p")).toEqual([]);
    expect(keys("q")).toEqual(["table:public.b"]);
  });

  test("no connection, no key: nothing is remembered and nothing throws", () => {
    useRecents.getState().touch(null, "table", "public.a");
    useRecents.getState().touch(undefined, "table", "public.a");
    useRecents.getState().touch("p", "table", "");
    expect(useRecents.getState().byProfile).toEqual({});
  });

  test("the list is capped, oldest out", () => {
    for (let i = 0; i < RECENTS_CAP + 5; i++) useRecents.getState().touch("p", "table", `public.t${i}`);
    expect(held("p")).toHaveLength(RECENTS_CAP);
    expect(keys("p")[0]).toBe(`table:public.t${RECENTS_CAP + 4}`);
    expect(keys("p")).not.toContain("table:public.t0");
  });

  test("what is gone is forgotten, and forgetting what was never there is a no-op", () => {
    useRecents.getState().touch("p", "canvas", "c1");
    useRecents.getState().touch("p", "canvas", "c2");
    useRecents.getState().forget("p", "canvas", "c1");
    expect(keys("p")).toEqual(["canvas:c2"]);
    const before = useRecents.getState().byProfile;
    useRecents.getState().forget("p", "canvas", "c1");
    useRecents.getState().forget("q", "canvas", "c2");
    expect(useRecents.getState().byProfile).toBe(before);
  });
});

describe("what a sent question contributes", () => {
  const table = mention({ kind: "table", ref: { schema: "public", table: "order_v2" } });
  const column = mention({ kind: "column", ref: { schema: "sales", table: "orders", column: "total" } });
  const query = mention({ kind: "saved", ref: { id: "s1", name: "Monthly revenue", sql: "" } });
  const thread = mention({ kind: "thread", ref: { id: "t1", title: "refunds" } });
  // B3: a canvas is the ladder's own kind now, not a flag inside a block ref
  const canvas = mention({ kind: "canvas", ref: { id: "cv1", title: "August finance" } });
  const block = mention({ kind: "block", ref: { id: "b1", name: "the revenue block" } });
  const tab = mention({ kind: "tab", ref: { name: "scratch.sql" } });

  test("every kind a row can be, in the order they were typed", () => {
    useRecents.getState().touchMentions("p", [table, column, query, thread, canvas]);
    expect(keys("p")).toEqual([
      "table:public.order_v2",
      "column:sales.orders.total",
      "saved:s1",
      "thread:t1",
      "canvas:cv1",
    ]);
  });

  test("a query tab and a canvas BLOCK are not rows, so they are not recents", () => {
    expect(recentOf(tab)).toBeNull();
    expect(recentOf(block)).toBeNull();
    useRecents.getState().touchMentions("p", [tab, block]);
    expect(keys("p")).toEqual([]);
  });

  test("the same thing tagged twice is one entry, and the newest question leads", () => {
    useRecents.getState().touchMentions("p", [query]);
    useRecents.getState().touchMentions("p", [table, table, query]);
    expect(keys("p")).toEqual(["table:public.order_v2", "saved:s1"]);
  });

  test("nothing tagged writes nothing", () => {
    const before = useRecents.getState().byProfile;
    useRecents.getState().touchMentions("p", []);
    useRecents.getState().touchMentions(null, [table]);
    expect(useRecents.getState().byProfile).toBe(before);
  });
});

describe("persistence", () => {
  test("only the pointers ride, and a half-written blob hydrates to nothing", async () => {
    useRecents.getState().touch("p", "table", "public.a");
    expect(JSON.parse(mem.get("qwry.recents") ?? "{}").state).toEqual({
      byProfile: { p: [{ kind: "table", key: "public.a" }] },
    });

    mem.set(
      "qwry.recents",
      JSON.stringify({
        state: {
          byProfile: {
            good: [
              { kind: "table", key: "public.a" },
              { kind: "table", key: "public.a" },
              { kind: "nope", key: "x" },
              { kind: "saved", key: "" },
              null,
              { kind: "canvas", key: "c1" },
            ],
            broken: "not a list",
            empty: [],
          },
        },
        version: 0,
      }),
    );
    await useRecents.persist.rehydrate();
    expect(Object.keys(useRecents.getState().byProfile)).toEqual(["good"]);
    expect(keys("good")).toEqual(["table:public.a", "canvas:c1"]);
  });

  test("a blob that is not an object at all hydrates to nothing", async () => {
    mem.set("qwry.recents", JSON.stringify({ state: null, version: 0 }));
    await useRecents.persist.rehydrate();
    expect(useRecents.getState().byProfile).toEqual({});
  });
});
