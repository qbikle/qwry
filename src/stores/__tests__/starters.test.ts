// The generated starter pools store (W2d): one generation per connection at a
// time, a no-op when a pool for the current schema shape exists, failures and
// thin replies swallowed so the heuristic pool stands, the cursor stepping by
// three and wrapping, and only pools + cursors persisted. The generator is
// stood in through the store's `generator` seam (agent.ts's `runner`
// precedent); everything else is the real store.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";

// starters.ts pulls in platform.tauri.ts, which pulls settings.ts (paints the
// theme onto the document at import) and the persist middleware reads
// localStorage at module evaluation; bun has neither. In-memory stand-ins go
// in for the length of this file and the previous globals come back after
// (bun test shares one global scope across files)
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
const previous = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
};
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true, writable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
if (!previous.document) {
  Object.defineProperty(globalThis, "document", { value: inert, configurable: true, writable: true });
}
const { useStarterPools, generator, CURSOR_STEP, CURSOR_WRAP } = await import("../starters");
const { STARTER_POOL_MIN, schemaHash } = await import("../../agent/starterPool");
type SchemaSnapshot = import("../schema").SchemaSnapshot;
type ModelChoice = import("../agent").ModelChoice;
useStarterPools.persist.setOptions({ storage: createJSONStorage(() => storage) });
afterAll(() => {
  for (const [k, d] of Object.entries(previous)) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
});

const realGenerate = generator.generateStarters;

const col = (name: string) => ({ name, attnum: 1, type: "text", type_oid: 0, not_null: false, default: null });
const snapshot: SchemaSnapshot = {
  tables: [
    { table_oid: 1, schema: "public", name: "users", kind: "r", columns: [col("id"), col("email")], pk: ["id"], reltuples: 100 },
  ],
  foreign_keys: [],
  functions: [],
  schemas: ["public"],
  indexes: [],
  enums: [],
};
const grown: SchemaSnapshot = {
  ...snapshot,
  tables: [{ ...snapshot.tables[0], columns: [...snapshot.tables[0].columns, col("created_at")] }],
};
const choice: ModelChoice = { providerId: "openai", model: "gpt-test" };
const twelve = Array.from({ length: 12 }, (_, i) => `Question number ${i + 1}?`);

/** a generator the test resolves by hand, counting calls */
function deferred() {
  let resolve!: (qs: string[]) => void;
  let reject!: (e: unknown) => void;
  let calls = 0;
  const p = new Promise<string[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  generator.generateStarters = () => {
    calls++;
    return p;
  };
  return { resolve, reject, calls: () => calls };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  useStarterPools.setState({ pools: {}, cursors: {} });
  generator.generateStarters = realGenerate;
});

describe("useStarterPools.ensurePool", () => {
  test("one generation lands as the connection's pool, keyed to the schema hash", async () => {
    const d = deferred();
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    expect(d.calls()).toBe(1);
    d.resolve(twelve);
    await settle();
    const pool = useStarterPools.getState().pools["p1"];
    expect(pool?.questions).toEqual(twelve);
    expect(pool?.schemaHash).toBe(schemaHash(snapshot));
    expect(typeof pool?.generatedAt).toBe("number");
  });

  test("a pool for the current shape is a no-op; a new shape generates again", async () => {
    const d1 = deferred();
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    d1.resolve(twelve);
    await settle();
    let calls = 0;
    generator.generateStarters = async () => {
      calls++;
      return twelve;
    };
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    expect(calls).toBe(0);
    useStarterPools.getState().ensurePool("p1", grown, choice);
    await settle();
    expect(calls).toBe(1);
    expect(useStarterPools.getState().pools["p1"]?.schemaHash).toBe(schemaHash(grown));
  });

  test("a thin reply, an empty reply and a rejection leave no pool and free the connection", async () => {
    generator.generateStarters = async () => twelve.slice(0, STARTER_POOL_MIN - 1);
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    await settle();
    expect(useStarterPools.getState().pools["p1"]).toBeUndefined();

    const d = deferred();
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    expect(d.calls()).toBe(1);
    d.reject(new Error("boom"));
    await settle();
    expect(useStarterPools.getState().pools["p1"]).toBeUndefined();

    // the connection is free again: the next ask generates
    let calls = 0;
    generator.generateStarters = async () => {
      calls++;
      return [];
    };
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    await settle();
    expect(calls).toBe(1);
    expect(useStarterPools.getState().pools["p1"]).toBeUndefined();
  });

  test("no snapshot, no model or an unknown provider makes no call", () => {
    let calls = 0;
    generator.generateStarters = async () => {
      calls++;
      return twelve;
    };
    useStarterPools.getState().ensurePool("p1", undefined, choice);
    useStarterPools.getState().ensurePool("p1", snapshot, null);
    useStarterPools.getState().ensurePool("p1", snapshot, { providerId: "no-such-provider" as ModelChoice["providerId"], model: "x" });
    expect(calls).toBe(0);
  });

  test("connections generate independently", async () => {
    let calls = 0;
    generator.generateStarters = async () => {
      calls++;
      return twelve;
    };
    useStarterPools.getState().ensurePool("p1", snapshot, choice);
    useStarterPools.getState().ensurePool("p2", snapshot, choice);
    await settle();
    expect(calls).toBe(2);
    expect(Object.keys(useStarterPools.getState().pools).sort()).toEqual(["p1", "p2"]);
  });
});

describe("useStarterPools.advance", () => {
  test("steps by three per connection and wraps at the twelve-friendly bound", () => {
    const s = useStarterPools.getState();
    s.advance("p1");
    s.advance("p1");
    s.advance("p2");
    expect(useStarterPools.getState().cursors).toEqual({ p1: 2 * CURSOR_STEP, p2: CURSOR_STEP });
    useStarterPools.setState({ cursors: { p1: CURSOR_WRAP - CURSOR_STEP } });
    useStarterPools.getState().advance("p1");
    expect(useStarterPools.getState().cursors["p1"]).toBe(0);
    for (let n = 1; n <= 12; n++) expect(CURSOR_WRAP % n).toBe(0);
  });
});

describe("persistence", () => {
  test("only pools and cursors are written, and a corrupt blob hydrates to what is well-formed", async () => {
    const opts = useStarterPools.persist.getOptions();
    const written = opts.partialize!(useStarterPools.getState());
    expect(Object.keys(written).sort()).toEqual(["cursors", "pools"]);

    mem.set(
      "qwry.starters",
      JSON.stringify({
        state: {
          pools: {
            good: { schemaHash: "abcd1234", questions: twelve, generatedAt: 1 },
            bad: { schemaHash: 7, questions: "nope" },
            worse: null,
          },
          cursors: { good: 9, bad: "3", nan: Number.NaN, neg: -3 },
        },
        version: 0,
      }),
    );
    await useStarterPools.persist.rehydrate();
    const st = useStarterPools.getState();
    expect(Object.keys(st.pools)).toEqual(["good"]);
    expect(st.pools["good"].questions).toEqual(twelve);
    expect(st.cursors).toEqual({ good: 9, neg: CURSOR_WRAP - 3 });
  });
});
