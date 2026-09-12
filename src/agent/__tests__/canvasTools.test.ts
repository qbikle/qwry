// createCanvasTools over a fake document and a fake read gate (B3,
// canvas-agent-spec sections 1.5 and 2.1). The store and the gate are injected,
// so every cap, every refusal text and the ordering rule are asserted without
// a database and without a canvas on screen. The pure half of the same family
// (the schemas, the union, the handles, the outline) is canvas.test.ts.
//
// The seam under test is the document's: applyModelBlocks, replaceBlock and
// outline, each one setDoc, which is what makes a batch of blocks land or not
// land together.

import { beforeEach, describe, expect, test } from "bun:test";

// settings.ts paints the theme onto the document at import and the canvas
// store reaches the window; bun has neither (toolTimeout.test.ts's precedent)
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
const STANDINS: Record<string, unknown> = {
  window: globalThis,
  localStorage: storage,
  document: inert,
};
const shimmed = new Set<string>();
function shim() {
  for (const [k, value] of Object.entries(STANDINS)) {
    if (k in globalThis) continue;
    Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
    shimmed.add(k);
  }
}
shim();

const { createCanvasTools } = await import("../canvas.tauri");
const { CANVAS_BLOCK_ROWS, CANVAS_ECHO_ROWS, RUN_SQL_TIMEOUT_MS } = await import("../tools");
const { useSettings } = await import("../../stores/settings");
type CanvasStore = import("../canvas.tauri").CanvasStore;
type ModelBlockInput = import("../canvas.tauri").ModelBlockInput;
type CanvasOutlineEntry = import("../tools").CanvasOutlineEntry;
type AgentRun = import("../types").AgentRun;

beforeEach(shim);

const RUN = (over: Partial<AgentRun> = {}): AgentRun => ({
  columns: ["month", "revenue"],
  rows: [
    ["2026-04", "41220"],
    ["2026-05", "44905"],
    ["2026-06", "39110"],
    ["2026-07", "47802"],
    ["2026-08", "52441"],
    ["2026-09", "51001"],
  ],
  rowCount: 6,
  capped: false,
  ms: 12,
  ...over,
});

interface Fake {
  doc: CanvasOutlineEntry[];
  applied: { blocks: readonly ModelBlockInput[]; after?: string }[];
  replaced: { blockId: string; block: ModelBlockInput }[];
  ran: { sql: string; maxRows: number; timeoutMs: number }[];
  tools: ReturnType<typeof createCanvasTools>;
}

/** A document that records what landed, and a gate that answers `runs`. */
function fake(
  runs: (sql: string) => AgentRun | Error = () => RUN(),
  doc: CanvasOutlineEntry[] = [],
): Fake {
  const applied: Fake["applied"] = [];
  const replaced: Fake["replaced"] = [];
  const ran: Fake["ran"] = [];
  const store: CanvasStore = {
    applyModelBlocks(_canvasId, blocks, after) {
      applied.push({ blocks, ...(after ? { after } : {}) });
      for (const b of blocks) {
        doc.push({
          id: b.id,
          kind: b.kind,
          line: b.kind === "note" ? b.text : (b.title ?? b.question ?? ""),
          modelWritten: true,
        });
      }
      return blocks.map((b) => b.id);
    },
    replaceBlock(_canvasId, blockId, block) {
      const at = doc.findIndex((b) => b.id === blockId);
      if (at === -1) return null;
      replaced.push({ blockId, block });
      // the document releases the old block's name and reports the new id
      doc[at] = { ...doc[at], id: block.id };
      return block.id;
    },
    outline: () => doc,
    // the grid the tool clamps `at` and `span` against, and the number
    // canvas_read prints; the placement itself is canvas-place.test.ts's
    columns: () => 7,
  };
  const tools = createCanvasTools({
    sessionId: "s1",
    canvasId: "cv-1",
    title: "Sales",
    exchangeId: "ex-1",
    question: "what stood out in orders last month",
    timeoutMs: 4000,
    store,
    run: async (sql, maxRows, timeoutMs) => {
      ran.push({ sql, maxRows, timeoutMs });
      const out = runs(sql);
      if (out instanceof Error) throw out;
      return out;
    },
  });
  return { doc, applied, replaced, ran, tools };
}

describe("canvas_write", () => {
  test("the statement goes through the gate at the block cap, and one batch lands", async () => {
    const f = fake();
    const out = await f.tools.write({
      blocks: [
        { kind: "result", sql: "SELECT month, revenue FROM m" },
        { kind: "note", text: "**August, against the year:** COD took 22%." },
      ],
    });
    expect(f.ran).toEqual([
      { sql: "SELECT month, revenue FROM m", maxRows: CANVAS_BLOCK_ROWS, timeoutMs: 4000 },
    ]);
    expect(f.applied).toHaveLength(1);
    expect(f.applied[0].blocks.map((b) => b.kind)).toEqual(["result", "note"]);
    expect(out.result?.canvasId).toBe("cv-1");
    expect(out.result?.blockIds).toHaveLength(2);
    expect(out.error).toBeUndefined();
  });

  test("the reply heads with the count, then a stanza a block, then five rows", async () => {
    const f = fake();
    const out = await f.tools.write({
      blocks: [{ kind: "result", sql: "SELECT 1", face: "chart" }],
    });
    const lines = out.textForModel.split("\n");
    expect(lines[0]).toBe('Wrote 1 block to "Sales".');
    expect(lines[1]).toContain("result  what stood out in orders last month · chart face");
    expect(lines[2]).toBe("month | revenue");
    // the head, the stanza, then the grid: its header, five rows of six, and
    // a tail that says so rather than implying it saw all of them
    expect(lines).toHaveLength(3 + CANVAS_ECHO_ROWS + 1);
    expect(lines[lines.length - 1]).toBe("(6 rows total, showing 5)");
  });

  test("the question stands once, on the first block; later results wear their titles", async () => {
    const f = fake();
    await f.tools.write({
      blocks: [
        { kind: "result", sql: "SELECT 1" },
        { kind: "result", sql: "SELECT 2", title: "Failed payments by gateway" },
        { kind: "note", text: "a reading" },
      ],
    });
    const [a, b, c] = f.applied[0].blocks;
    expect(a).toMatchObject({ question: "what stood out in orders last month", wroteBy: "ex-1" });
    expect("question" in b).toBe(false);
    expect(b).toMatchObject({ title: "Failed payments by gateway", wroteBy: "ex-1" });
    expect("title" in c).toBe(false);
    expect(c).toMatchObject({ wroteBy: "ex-1" });
  });

  test("the face the rows deserve: chart, then values for one row, then table, then sql", async () => {
    const chart = fake();
    await chart.tools.write({ blocks: [{ kind: "result", sql: "SELECT 1" }] });
    expect(chart.applied[0].blocks[0]).toMatchObject({ face: "chart" });

    const one = fake(() => RUN({ columns: ["orders"], rows: [["2763"]], rowCount: 1 }));
    await one.tools.write({ blocks: [{ kind: "result", sql: "SELECT count(*)" }] });
    expect(one.applied[0].blocks[0]).toMatchObject({ face: "values" });

    const wide = fake(() =>
      RUN({
        columns: ["a", "b", "c", "d", "e"],
        rows: [
          ["1", "2", "3", "4", "5"],
          ["6", "7", "8", "9", "10"],
        ],
        rowCount: 2,
      }),
    );
    await wide.tools.write({ blocks: [{ kind: "result", sql: "SELECT *" }] });
    expect(wide.applied[0].blocks[0]).toMatchObject({ face: "table" });

    const none = fake(() => RUN({ rows: [], rowCount: 0 }));
    await none.tools.write({ blocks: [{ kind: "result", sql: "SELECT 1 WHERE false" }] });
    expect(none.applied[0].blocks[0]).toMatchObject({ face: "sql" });
  });

  test("a face these rows cannot wear falls back, and the reply says so", async () => {
    const f = fake(() => RUN({ columns: ["orders"], rows: [["2763"]], rowCount: 1 }));
    const out = await f.tools.write({
      blocks: [{ kind: "result", sql: "SELECT 1", face: "chart" }],
    });
    expect(f.applied[0].blocks[0]).toMatchObject({ face: "values" });
    expect(out.textForModel).toContain("no chart face for these rows, on its values");
    expect(out.error).toBeUndefined();
  });

  test("the values face stops where the document's does: five columns is a grid", async () => {
    const f = fake(() =>
      RUN({ columns: ["a", "b", "c", "d", "e"], rows: [["1", "2", "3", "4", "5"]], rowCount: 1 }),
    );
    const out = await f.tools.write({
      blocks: [{ kind: "result", sql: "SELECT *", face: "values" }],
    });
    // ScalarResult draws four pairs, so the fifth column makes it a table and
    // the reply says the face the block is standing on (LESSONS 13)
    expect(f.applied[0].blocks[0]).toMatchObject({ face: "table" });
    expect(out.textForModel).toContain("no values face for these rows, on its table");
  });

  test("a truncated result says what the block kept, so a note cannot claim otherwise", async () => {
    const f = fake(() => RUN({ rowCount: 1842, capped: true }));
    const out = await f.tools.write({ blocks: [{ kind: "result", sql: "SELECT 1" }] });
    expect(out.textForModel).toContain("keeping 6 of 1,842 rows");
  });

  test("a statement the gate refuses lands NO block, in the gate's own words", async () => {
    const f = fake(
      () =>
        new Error(
          "this is prose, not SQL. To answer without running a query, reply in text and call no tool\nsecond line",
        ),
    );
    const out = await f.tools.write({
      blocks: [{ kind: "result", sql: "the answer is 1000" }, { kind: "note", text: "a" }],
    });
    expect(out.textForModel).toBe(
      "ERROR: this is prose, not SQL. To answer without running a query, reply in text and call no tool",
    );
    expect(out.error).toBeTruthy();
    expect(f.applied).toEqual([]);
  });

  test("the exchange cap, counted off the blocks that landed", async () => {
    const f = fake();
    await f.tools.write({ blocks: new Array(6).fill({ kind: "note", text: "a" }) });
    const out = await f.tools.write({ blocks: new Array(3).fill({ kind: "note", text: "b" }) });
    expect(out.textForModel).toBe(
      'ERROR: this exchange has already written 6 blocks to "Sales"; 8 is the cap. Replace one instead of adding another',
    );
    // and what fits still fits
    const ok = await f.tools.write({ blocks: [{ kind: "note", text: "c" }] });
    expect(ok.error).toBeUndefined();
    expect(ok.result?.blockIds).toHaveLength(7);
  });

  test("`after` is resolved before any statement runs, and a gone block refuses", async () => {
    const seeded = (): CanvasOutlineEntry[] => [
      {
        id: "77de0000-0000-4000-8000-000000000009",
        kind: "result",
        line: "Top customers",
        modelWritten: true,
      },
    ];
    const f = fake(() => RUN(), seeded());
    const ok = await f.tools.write({ blocks: [{ kind: "note", text: "a" }], after: "77de" });
    expect(ok.error).toBeUndefined();
    expect(f.applied[0].after).toBe("77de0000-0000-4000-8000-000000000009");

    const g = fake(() => RUN(), seeded());
    const out = await g.tools.write({
      blocks: [{ kind: "result", sql: "SELECT 1" }],
      after: "77df",
    });
    expect(out.textForModel).toBe(
      "ERROR: no block '77df' on this canvas. Call canvas_read for the block ids",
    );
    expect(g.ran).toEqual([]);
  });

  test("two calls of one turn land as two contiguous batches, in completed-call order", async () => {
    const f = fake();
    await f.tools.write({
      blocks: [{ kind: "note", text: "one" }, { kind: "note", text: "two" }],
    });
    await f.tools.write({ blocks: [{ kind: "note", text: "three" }] });
    expect(f.applied.map((a) => a.blocks.length)).toEqual([2, 1]);
    expect(f.doc.map((b) => b.line)).toEqual(["one", "two", "three"]);
  });

  test("the reply's handles are the ids the document reported, not the ones minted", async () => {
    const applied: { blocks: readonly ModelBlockInput[] }[] = [];
    const tools = createCanvasTools({
      sessionId: "s1",
      canvasId: "cv-1",
      title: "Sales",
      exchangeId: "ex-1",
      question: "q",
      store: {
        applyModelBlocks(_c, blocks) {
          applied.push({ blocks });
          // a document that keyed the block elsewhere: the reply must follow it
          return ["dddd0000-0000-4000-8000-00000000000f"];
        },
        replaceBlock: () => null,
        outline: () => [],
        columns: () => 7,
      },
      run: async () => RUN(),
    });
    const out = await tools.write({ blocks: [{ kind: "note", text: "one" }] });
    expect(out.textForModel).toContain("dddd  note    one");
    expect(out.result?.blockIds).toEqual(["dddd0000-0000-4000-8000-00000000000f"]);
  });

  test("the count of blocks that stood in place of one already there", async () => {
    const f = fake(() => RUN(), [
      {
        id: "9c110000-0000-4000-8000-000000000002",
        kind: "note",
        line: "mine",
        modelWritten: true,
      },
    ]);
    const appended = await f.tools.write({ blocks: [{ kind: "note", text: "one" }] });
    expect(appended.result?.replaced).toBe(0);
    const over = await f.tools.replace({
      block_id: "9c11",
      block: { kind: "note", text: "two" },
    });
    expect(over.result?.replaced).toBe(1);
    // and it does not go back down: the record is the exchange's, whole
    const more = await f.tools.write({ blocks: [{ kind: "note", text: "three" }] });
    expect(more.result?.replaced).toBe(1);
    expect(more.result?.blockIds).toHaveLength(3);
  });

  test("the ids are the document's, reported whole, never parsed out of the text", async () => {
    const f = fake();
    await f.tools.write({ blocks: [{ kind: "note", text: "one" }] });
    const second = await f.tools.write({ blocks: [{ kind: "note", text: "two" }] });
    // every block the exchange has written, in write order: the record a cut
    // deletes and a re-run clears, so the store assigns it rather than appends
    expect(second.result?.blockIds).toEqual(f.doc.map((b) => b.id));
  });
});

describe("canvas_replace", () => {
  const own = (): CanvasOutlineEntry[] => [
    {
      id: "9c110000-0000-4000-8000-000000000002",
      kind: "result",
      line: "Revenue by month",
      modelWritten: true,
    },
    {
      id: "a0410000-0000-4000-8000-000000000004",
      kind: "note",
      line: "a note the user typed",
      modelWritten: false,
    },
  ];

  test("by prefix, keeping its place, and the statement runs again", async () => {
    const f = fake(() => RUN(), own());
    const out = await f.tools.replace({
      block_id: "9c11",
      block: { kind: "result", sql: "SELECT month, revenue FROM m2", title: "Revenue by month" },
    });
    expect(out.error).toBeUndefined();
    expect(f.ran.map((r) => r.sql)).toEqual(["SELECT month, revenue FROM m2"]);
    expect(f.replaced[0].blockId).toBe("9c110000-0000-4000-8000-000000000002");
    expect(out.textForModel).toStartWith('Replaced 9c11 in "Sales".');
    expect(out.result?.blockIds).toHaveLength(1);
  });

  test("a block the model did not write is the user's own, and is refused", async () => {
    const f = fake(() => RUN(), own());
    const out = await f.tools.replace({
      block_id: "a041",
      block: { kind: "note", text: "mine now" },
    });
    expect(out.textForModel).toBe(
      "ERROR: block 'a041' is the user's own. Write a new block instead of replacing one you did not write",
    );
    expect(f.replaced).toEqual([]);
    expect(f.ran).toEqual([]);
  });

  test("the reply names the handle the DOCUMENT reported for the new block", async () => {
    const f = fake(() => RUN(), own());
    const out = await f.tools.replace({
      block_id: "9c11",
      block: { kind: "note", text: "a better reading" },
    });
    const landed = f.replaced[0].block.id;
    // the block that stood there is gone, its name released: the head names
    // what was replaced and the stanza names what stands there now
    const [head, stanza] = out.textForModel.split("\n");
    expect(head).toBe('Replaced 9c11 in "Sales".');
    expect(stanza).toBe(`${landed.slice(0, 4)}  note    a better reading`);
    expect(f.doc[0].id).toBe(landed);
    expect(out.result?.blockIds).toEqual([landed]);
  });

  test("a replace does not spend the exchange budget: it is the cap's own way out", async () => {
    const f = fake(() => RUN(), own());
    await f.tools.write({ blocks: new Array(6).fill({ kind: "note", text: "a" }) });
    await f.tools.write({ blocks: [{ kind: "note", text: "b" }, { kind: "note", text: "c" }] });
    // eight appended, the cap reached
    for (let i = 0; i < 4; i++) {
      const out = await f.tools.replace({
        block_id: f.doc[0].id,
        block: { kind: "note", text: `r${i}` },
      });
      expect(out.error).toBeUndefined();
    }
    expect((await f.tools.write({ blocks: [{ kind: "note", text: "x" }] })).textForModel).toContain(
      "8 is the cap",
    );
  });

  test("a long note is named at the outline's own length, not at its own", async () => {
    const f = fake(() => RUN(), own());
    const out = await f.tools.replace({
      block_id: "9c11",
      block: { kind: "note", text: `**A reading:**\n- ${"x".repeat(200)}` },
    });
    const line = out.textForModel.split("\n")[1];
    expect(line).toEndWith("…");
    expect(line.length).toBeLessThan(80);
  });

  test("emptying a block is not a delete", async () => {
    const f = fake(() => RUN(), own());
    const out = await f.tools.replace({ block_id: "9c11", block: { kind: "note", text: "" } });
    expect(out.textForModel).toBe(
      "ERROR: a note block needs `text`, and it cannot be empty. Deleting a block is the user's own action",
    );
    expect(f.replaced).toEqual([]);
  });
});

describe("the statement_timeout a block's run carries", () => {
  /** the timeout one write put on the wire, with no override */
  const sentFor = async (secs: number): Promise<number> => {
    useSettings.getState().setStatementTimeoutSecs(secs);
    const ran: number[] = [];
    const tools = createCanvasTools({
      sessionId: "s1",
      canvasId: "cv-1",
      title: "Sales",
      exchangeId: "ex-1",
      question: "q",
      store: {
        applyModelBlocks: () => [],
        replaceBlock: () => null,
        outline: () => [],
        columns: () => 7,
      },
      run: async (_sql, _rows, timeoutMs) => {
        ran.push(timeoutMs);
        return RUN();
      },
    });
    await tools.write({ blocks: [{ kind: "result", sql: "SELECT 1" }] });
    return ran[0];
  };

  test("the setting travels in milliseconds, and its 0 falls to the section 5 default", async () => {
    const real = useSettings.getState().statementTimeoutSecs;
    try {
      expect(await sentFor(30)).toBe(30_000);
      // the setting's 0 means "no timeout" for a SESSION, which is not a shape
      // a tool call has: agent.rs would clamp it to the one-second FLOOR
      expect(await sentFor(0)).toBe(RUN_SQL_TIMEOUT_MS);
    } finally {
      useSettings.getState().setStatementTimeoutSecs(real);
    }
  });
});

describe("canvas_read", () => {
  test("the outline, and the same lines the CANVAS block prints", async () => {
    const f = fake(() => RUN(), [
      {
        id: "9c110000-0000-4000-8000-000000000002",
        kind: "result",
        line: "Revenue by month",
        rows: 12,
        columns: ["month", "revenue"],
        face: "chart",
        modelWritten: true,
      },
    ]);
    const out = await f.tools.read();
    expect(out.textForModel).toBe(
      [
        'Canvas "Sales", 1 block, 7 columns wide.',
        "9c11  result  Revenue by month · 12 rows: month, revenue · chart face",
      ].join("\n"),
    );
    expect(out.result?.blocks).toHaveLength(1);
    expect(f.tools.outline()).toHaveLength(1);
  });

  test("an empty canvas", async () => {
    const f = fake();
    expect((await f.tools.read()).textForModel).toBe('Canvas "Sales" is empty, 7 columns wide.');
  });

  test("the canvas is captured, and nothing on the wire names one", () => {
    const f = fake();
    expect(f.tools.canvasId).toBe("cv-1");
    expect(f.tools.title).toBe("Sales");
  });
});
