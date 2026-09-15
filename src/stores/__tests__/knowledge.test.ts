// The two grammars A2 stores user knowledge in, and the store that writes
// them. Both are write/parse pairs (LESSONS 1), so both are tested by
// round-tripping hostile text rather than by a handful of nice examples: a
// hint whose prose says "aka" mid-sentence, a clause with no hint in front of
// it, a meaning that contains its own `=`.
//
// The backend is Tauri's own mock transport, so every `invoke` the store makes
// is recorded in the order it made it, and `agent_knowledge_list` answers from
// the rows the mock kept: a save can be read back exactly as appdb would
// hand it over.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { KnowledgeRow } from "../../ipc/types";

// knowledge.ts persists nothing itself, but the ipc bridge it imports pulls in
// settings.ts, which paints the theme onto the document as it evaluates; bun
// has no window, storage or document, so stand-ins go in first (the dynamic
// imports keep the order) and leave again after: bun test shares one global
// scope across files
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
const shimmed = ["window", "localStorage", "document"].filter((k) => !(k in globalThis));
for (const k of shimmed) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });
}

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const {
  definitionsOf,
  hintLineFor,
  knowledgeTarget,
  parseDefinition,
  parseHintLine,
  removeDefinition,
  saveDefinition,
  saveHintLine,
  useKnowledge,
  writeDefinition,
  writeHintLine,
} = await import("../knowledge");

afterAll(() => {
  clearMocks();
  for (const k of shimmed) Reflect.deleteProperty(globalThis, k);
});

/** the rows appdb holds, in write order */
let stored: KnowledgeRow[] = [];
let calls: string[] = [];

function backend() {
  mockIPC((cmd, args) => {
    calls.push(cmd);
    const a = args as Record<string, never>;
    if (cmd === "agent_knowledge_list") {
      const pid = a.profileId as unknown as string;
      return stored.filter((r) => r.profile_id === pid);
    }
    if (cmd === "agent_knowledge_upsert") {
      const row = a.row as unknown as KnowledgeRow;
      const at = stored.findIndex((r) => r.id === row.id);
      if (at >= 0) stored[at] = { ...stored[at], ...row };
      else stored.push({ ...row, created_at: `t${stored.length}` });
      return null;
    }
    if (cmd === "agent_knowledge_delete") {
      stored = stored.filter((r) => r.id !== (a.id as unknown as string));
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

beforeEach(() => {
  stored = [];
  calls = [];
  useKnowledge.setState({ rows: {} });
  backend();
});

const rowsOf = (pid = "p1") => useKnowledge.getState().rows[pid] ?? [];
const kinds = (pid = "p1") => rowsOf(pid).map((r) => `${r.kind}:${r.target}:${r.text}`);

describe("the hint line grammar", () => {
  const HOSTILE = [
    "",
    "   ",
    "Checkout attempts, failed included",
    "Checkout attempts aka orders, purchases",
    "aka orders",
    "aka orders, purchases",
    // the word mid-sentence: what follows is prose, not a list of names
    "Known aka the aborted ones, mostly",
    "Failed ones stay, aka the aborted ones aka orders",
    // a bare "aka" at the end names nothing
    "call it aka",
    "one aka a,b ,  c ",
    "Revenue questions want payment_status <> 'failed' aka sales",
    "aka _private, t2$x",
    "hint with = in it aka orders",
  ];

  test("parse(write(parse(s))) is parse(s) for every line", () => {
    for (const s of HOSTILE) {
      const once = parseHintLine(s);
      expect(parseHintLine(writeHintLine(once))).toEqual(once);
    }
  });

  test("the LAST clause wins and prose keeps its own aka", () => {
    expect(parseHintLine("Known aka the aborted ones, mostly")).toEqual({
      hint: "Known aka the aborted ones, mostly",
      synonyms: [],
    });
    expect(parseHintLine("Failed ones stay, aka the aborted ones aka orders")).toEqual({
      hint: "Failed ones stay, aka the aborted ones",
      synonyms: ["orders"],
    });
    expect(parseHintLine("call it aka")).toEqual({ hint: "call it aka", synonyms: [] });
  });

  test("a clause with no hint in front of it is still a clause", () => {
    expect(parseHintLine("aka orders, purchases")).toEqual({
      hint: "",
      synonyms: ["orders", "purchases"],
    });
    expect(writeHintLine({ hint: "", synonyms: ["orders"] })).toBe("aka orders");
  });

  test("names are trimmed and the same name twice is one name", () => {
    expect(parseHintLine("x aka a , b,  a ").synonyms).toEqual(["a", "b"]);
  });
});

describe("the definition grammar", () => {
  test("the first = splits it; the meaning keeps its own", () => {
    expect(parseDefinition("AOV = revenue / orders = per head")).toEqual({
      term: "AOV",
      meaning: "revenue / orders = per head",
    });
    expect(parseDefinition("aov=paid orders")).toEqual({ term: "aov", meaning: "paid orders" });
  });

  test("half a line is not a definition: it is a delete", () => {
    expect(parseDefinition("AOV = ")).toBeNull();
    expect(parseDefinition(" = revenue")).toBeNull();
    expect(parseDefinition("AOV")).toBeNull();
  });

  test("parse(write(x)) is x", () => {
    for (const [t, m] of [
      ["AOV", "revenue over orders"],
      ["churn", "no order in 90 days = gone"],
      ["MRR", "  padded  "],
    ]) {
      expect(parseDefinition(writeDefinition(t, m))).toEqual({ term: t.trim(), meaning: m.trim() });
    }
  });
});

describe("targets", () => {
  test("a column target carries its schema, so it cannot read as a table", () => {
    expect(knowledgeTarget("public", "order_v2")).toBe("public.order_v2");
    expect(knowledgeTarget("public", "order_v2", "status")).toBe("public.order_v2.status");
    expect(knowledgeTarget("orders", "status")).not.toBe(
      knowledgeTarget("public", "orders", "status"),
    );
  });
});

describe("saveHintLine", () => {
  const target = knowledgeTarget("public", "order_v2");

  test("one line becomes a hint row and one row per name", async () => {
    await saveHintLine("p1", target, "Checkout attempts aka orders, purchases");
    expect(kinds()).toEqual([
      `hint:${target}:Checkout attempts`,
      `synonym:${target}:orders`,
      `synonym:${target}:purchases`,
    ]);
    expect(hintLineFor(rowsOf(), target)).toBe("Checkout attempts aka orders, purchases");
  });

  test("a name the line drops goes; the ones it keeps keep their rows", async () => {
    await saveHintLine("p1", target, "Attempts aka orders, purchases");
    const before = rowsOf().find((r) => r.text === "orders")?.id;
    calls = [];
    await saveHintLine("p1", target, "Attempts aka orders, sales");
    expect(kinds()).toEqual([
      `hint:${target}:Attempts`,
      `synonym:${target}:orders`,
      `synonym:${target}:sales`,
    ]);
    expect(rowsOf().find((r) => r.text === "orders")?.id).toBe(before);
    expect(calls.filter((c) => c === "agent_knowledge_upsert")).toHaveLength(1);
  });

  test("an emptied line deletes everything the object carried", async () => {
    await saveHintLine("p1", target, "Attempts aka orders");
    await saveHintLine("p1", target, "   ");
    expect(kinds()).toEqual([]);
    expect(hintLineFor(rowsOf(), target)).toBe("");
  });

  test("a column's line is its own, and another connection sees neither", async () => {
    const col = knowledgeTarget("public", "order_v2", "paid_at");
    await saveHintLine("p1", target, "Attempts");
    await saveHintLine("p1", col, "Null for COD in transit aka settled");
    await saveHintLine("p2", target, "Another connection");
    expect(hintLineFor(rowsOf(), target)).toBe("Attempts");
    expect(hintLineFor(rowsOf(), col)).toBe("Null for COD in transit aka settled");
    expect(hintLineFor(rowsOf("p2"), col)).toBe("");
  });
});

describe("definitions", () => {
  test("a term defined twice is one row, rewritten where it stands", async () => {
    await saveDefinition("p1", "AOV", "revenue over orders");
    await saveDefinition("p1", "aov", "paid revenue over paid orders");
    expect(definitionsOf(rowsOf())).toEqual([
      { id: expect.any(String), term: "aov", meaning: "paid revenue over paid orders" },
    ]);
  });

  test("definitions hang on no object and read back in write order", async () => {
    await saveDefinition("p1", "AOV", "revenue over orders");
    await saveDefinition("p1", "churn", "no order in 90 days");
    expect(rowsOf().every((r) => r.target === null)).toBe(true);
    expect(definitionsOf(rowsOf()).map((d) => d.term)).toEqual(["AOV", "churn"]);
  });

  test("removing a term is not case-sensitive, and an unknown one is no error", async () => {
    await saveDefinition("p1", "AOV", "revenue over orders");
    await removeDefinition("p1", "  aov ");
    expect(definitionsOf(rowsOf())).toEqual([]);
    await removeDefinition("p1", "never defined");
    expect(definitionsOf(rowsOf())).toEqual([]);
  });

  test("a row whose text no longer parses is dropped, not shown half-read", () => {
    const rows: KnowledgeRow[] = [
      { id: "d1", profile_id: "p1", kind: "definition", target: null, text: "AOV" },
      { id: "d2", profile_id: "p1", kind: "definition", target: null, text: "AOV = per head" },
    ];
    expect(definitionsOf(rows).map((d) => d.id)).toEqual(["d2"]);
  });
});
