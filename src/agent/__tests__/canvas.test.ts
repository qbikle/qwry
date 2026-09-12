// The canvas tool family's PURE half (B3, canvas-agent-spec section 1): the
// schemas as prompt surface, the union the model may write, every refusal
// text, the short-id handles and the outline's one renderer. The tool itself,
// which reaches a store, is canvasTools.test.ts.
//
// The pin that matters most is the first: with no canvas target the five
// schemas must be byte-identical to what every EVAL.md baseline row was
// measured against, and the canvas family must be reachable only through
// toolsFor.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import schema from "../tools.schema.json";
import {
  CANVAS_BLOCK_ROWS,
  CANVAS_BRIDGE_LOST,
  CANVAS_BRIDGE_TIMEOUT_MS,
  CANVAS_ECHO_ROWS,
  CANVAS_EXCHANGE_MAX,
  CANVAS_HANDLE,
  CANVAS_NOTE_CAP,
  CANVAS_TOOL_NAMES,
  CANVAS_TOOL_SCHEMAS,
  CANVAS_WRITE_MAX,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  blockLine,
  handleOf,
  outlineText,
  parseCanvasBlock,
  parseCanvasBlocks,
  resolveHandle,
  toolsFor,
  type CanvasOutlineEntry,
} from "../tools";

// ---- the schemas are prompt surface ----------------------------------------

/** The five, as JSON.stringify writes them. Not a copy of the bytes (that
 * would be the same schema in two slots, DESIGN rule 14) but a hash of them:
 * this number moves only when the measured tool surface moves, and moving it
 * means re-baselining every row in EVAL.md section 4. If this test fails,
 * either the change belongs in `canvasTools` or a baseline is owed. */
const FIVE_SHA = "645b677d5a11a320a1397c0cde24aa2993dee29d620588a8a496d233e3bcf556";
const FIVE_BYTES = 2722;

/** The schema as the WIRE carries it, not as TypeScript infers it from the
 * literal: a test that walks a JSON Schema wants its own shape, not the union
 * of every arm the import happened to produce. */
interface WireSchema {
  tools: { name: string }[];
  canvasTools: {
    name: string;
    parameters: { properties: Record<string, Json> };
  }[];
}
interface Json {
  [k: string]: unknown;
}
const wire = JSON.parse(JSON.stringify(schema)) as unknown as WireSchema;
/** the inlined block union of canvas_write and of canvas_replace */
const union = (tool: number, prop: string): Json =>
  wire.canvasTools[tool].parameters.properties[prop];
/** the union's two arms, note first */
const arms = (u: Json): Json[] => u.anyOf as Json[];

describe("the tool surface B3 must not move", () => {
  test("the five schemas are byte-frozen", () => {
    const five = JSON.stringify(schema.tools);
    expect(five.length).toBe(FIVE_BYTES);
    expect(createHash("sha256").update(five).digest("hex")).toBe(FIVE_SHA);
  });

  test("canvasTools names exactly the three, in file order", () => {
    expect(CANVAS_TOOL_SCHEMAS.map((s) => s.name)).toEqual([...CANVAS_TOOL_NAMES]);
    expect([...CANVAS_TOOL_NAMES]).toEqual(["canvas_write", "canvas_replace", "canvas_read"]);
  });

  test("no create and no delete: neither is representable", () => {
    const names = [...TOOL_SCHEMAS, ...CANVAS_TOOL_SCHEMAS].map((s) => s.name);
    expect(names.some((n) => n.includes("create"))).toBe(false);
    expect(names.some((n) => n.includes("delete"))).toBe(false);
  });

  test("no tool takes a canvas id", () => {
    for (const tool of wire.canvasTools) {
      const props = Object.keys(tool.parameters.properties);
      expect(props).not.toContain("canvas_id");
      expect(props).not.toContain("canvas");
      expect(props).not.toContain("canvasId");
    }
  });

  test("every canvas schema is an object schema that refuses extra properties", () => {
    for (const s of CANVAS_TOOL_SCHEMAS) {
      expect(s.parameters.type).toBe("object");
      expect(s.parameters.additionalProperties).toBe(false);
      expect(s.description.length).toBeGreaterThan(40);
    }
  });

  // maintainer call 10, checked before a line was written: openai.ts's
  // renderTools, anthropic.ts's input_schema and agent_mcp.rs's parse_tools
  // each put `parameters` on the wire ALONE, so a $defs sibling of `tools`
  // never reaches the model and a `#/$defs/...` pointer cannot resolve. The
  // union is written out in both tools that take one; this is the deepEqual
  // that keeps the two copies one shape.
  test("the block union is inlined twice and the copies are identical", () => {
    const write = union(0, "blocks").items as Json;
    const replace = union(1, "block");
    expect(write).toEqual(replace);
    expect(arms(write).map((arm) => (arm.properties as Json).kind)).toEqual([
      { const: "note" },
      { const: "result" },
    ]);
  });

  test("no $ref and no $defs anywhere on the wire", () => {
    const sent = JSON.stringify([...wire.tools, ...wire.canvasTools]);
    expect(sent).not.toContain("$ref");
    expect(sent).not.toContain("$defs");
  });

  test("two block kinds, and the four faces the document knows", () => {
    const both = arms(union(0, "blocks").items as Json);
    expect(both).toHaveLength(2);
    const result = both[1].properties as Json;
    expect((result.face as Json).enum).toEqual(["chart", "table", "values", "sql"]);
    // the title is optional: the first block of an answer wears the question
    expect(both[1].required).toEqual(["kind", "sql"]);
  });

  test("the caps are one number each, and the schema states the same ones", () => {
    expect(CANVAS_WRITE_MAX).toBe(6);
    expect(CANVAS_EXCHANGE_MAX).toBe(8);
    expect(CANVAS_ECHO_ROWS).toBe(5);
    expect(CANVAS_BLOCK_ROWS).toBe(200);
    const blocks = union(0, "blocks");
    expect(blocks.maxItems).toBe(CANVAS_WRITE_MAX);
    expect(blocks.minItems).toBe(1);
    const note = arms(blocks.items as Json)[0].properties as Json;
    expect((note.text as Json).maxLength).toBe(CANVAS_NOTE_CAP);
  });
});

describe("toolsFor is the gate", () => {
  test("no target: deep-equal to TOOL_SCHEMAS, five, in order", () => {
    const offered = toolsFor(false);
    expect(offered).toEqual([...TOOL_SCHEMAS]);
    expect(offered.map((s) => s.name)).toEqual([...TOOL_NAMES]);
  });

  test("a target: eight, the five first, in file order", () => {
    const offered = toolsFor(true);
    expect(offered).toHaveLength(8);
    expect(offered.map((s) => s.name)).toEqual([...TOOL_NAMES, ...CANVAS_TOOL_NAMES]);
  });
});

// ---- what the model may write ----------------------------------------------

const err = (v: { ok: boolean } & Record<string, unknown>): string =>
  v.ok ? "(no error)" : String(v.error);

describe("the block union, and every refusal", () => {
  test("a note", () => {
    expect(parseCanvasBlock({ kind: "note", text: "**August:**\n- COD took 22%" })).toEqual({
      ok: true,
      value: { kind: "note", text: "**August:**\n- COD took 22%" },
    });
  });

  test("a result, with and without its optional halves", () => {
    expect(parseCanvasBlock({ kind: "result", sql: "SELECT 1" })).toEqual({
      ok: true,
      value: { kind: "result", sql: "SELECT 1" },
    });
    expect(
      parseCanvasBlock({
        kind: "result",
        sql: "SELECT 1",
        title: "Revenue by month",
        note: "Paid orders carry the year.",
        face: "chart",
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "result",
        sql: "SELECT 1",
        title: "Revenue by month",
        note: "Paid orders carry the year.",
        face: "chart",
      },
    });
  });

  test("an unknown face is dropped, never refused: the statement was still good", () => {
    expect(parseCanvasBlock({ kind: "result", sql: "SELECT 1", face: "pie" })).toEqual({
      ok: true,
      value: { kind: "result", sql: "SELECT 1" },
    });
  });

  test("no kind, and a kind nothing knows", () => {
    expect(err(parseCanvasBlock({ text: "hi" }))).toBe(
      "ERROR: a block needs `kind`: 'note' or 'result'",
    );
    expect(err(parseCanvasBlock({ kind: "metric", figures: [] }))).toBe(
      "ERROR: a block needs `kind`: 'note' or 'result'",
    );
  });

  test("a result with no statement", () => {
    expect(err(parseCanvasBlock({ kind: "result", title: "Revenue" }))).toBe(
      "ERROR: a result block needs `sql`, one read-only statement",
    );
  });

  test("an empty note is refused, because emptying is not how a block dies", () => {
    expect(err(parseCanvasBlock({ kind: "note", text: "   " }))).toBe(
      "ERROR: a note block needs `text`, and it cannot be empty. Deleting a block is the user's own action",
    );
  });

  test("every cap names itself, its number and what to write instead", () => {
    expect(err(parseCanvasBlock({ kind: "note", text: "x".repeat(3140) }))).toBe(
      "ERROR: `text` is 3,140 characters; the cap is 2000. Write the finding, not the transcript",
    );
    expect(
      err(parseCanvasBlock({ kind: "result", sql: "SELECT 1", title: "t".repeat(140) })),
    ).toBe("ERROR: `title` is 140 characters; the cap is 120. Six words name a block");
    expect(err(parseCanvasBlock({ kind: "result", sql: "SELECT 1", note: "n".repeat(900) }))).toBe(
      "ERROR: `note` is 900 characters; the cap is 600. One sentence rides above a face",
    );
  });

  test("blocks: one to six, in order, and one bad block refuses the call", () => {
    const three = [
      { kind: "result", sql: "SELECT 1" },
      { kind: "note", text: "a" },
      { kind: "result", sql: "SELECT 2" },
    ];
    const out = parseCanvasBlocks(three);
    expect(out.ok && out.value.map((b) => b.kind)).toEqual(["result", "note", "result"]);
    expect(err(parseCanvasBlocks([]))).toBe(
      "ERROR: canvas_write needs `blocks`, an array of 1 to 6 blocks",
    );
    expect(err(parseCanvasBlocks(undefined))).toBe(
      "ERROR: canvas_write needs `blocks`, an array of 1 to 6 blocks",
    );
    expect(err(parseCanvasBlocks(new Array(7).fill({ kind: "note", text: "a" })))).toBe(
      "ERROR: canvas_write needs `blocks`, an array of 1 to 6 blocks",
    );
    expect(err(parseCanvasBlocks([{ kind: "note", text: "a" }, { kind: "note" }]))).toBe(
      "ERROR: a note block needs `text`, and it cannot be empty. Deleting a block is the user's own action",
    );
  });

  test("one block written without its array is read, not refused", () => {
    const out = parseCanvasBlocks({ kind: "note", text: "a" });
    expect(out.ok && out.value).toEqual([{ kind: "note", text: "a" }]);
  });
});

describe("short ids", () => {
  const ids = ["b3f2c1a0-0000-4000-8000-000000000001", "9c11aaaa-0000-4000-8000-000000000002", "9c11bbbb-0000-4000-8000-000000000003"];

  test("the handle is four characters of the id", () => {
    expect(handleOf(ids[0])).toBe("b3f2");
    expect(CANVAS_HANDLE).toBe(4);
  });

  test("the whole id, and a unique prefix", () => {
    expect(resolveHandle(ids, ids[1])).toEqual({ ok: true, value: ids[1] });
    expect(resolveHandle(ids, "b3f2")).toEqual({ ok: true, value: ids[0] });
    expect(resolveHandle(ids, "9c11a")).toEqual({ ok: true, value: ids[1] });
  });

  test("an unknown id, a short one and an ambiguous one each name the way out", () => {
    expect(err(resolveHandle(ids, "77df"))).toBe(
      "ERROR: no block '77df' on this canvas. Call canvas_read for the block ids",
    );
    expect(err(resolveHandle(ids, "7"))).toBe(
      "ERROR: '7' is too short. Use at least 4 characters of the id",
    );
    expect(err(resolveHandle(ids, "9c11"))).toBe(
      "ERROR: '9c11' matches 2 blocks. Use at least 4 characters of the id",
    );
    expect(err(resolveHandle(ids, ""))).toBe(
      "ERROR: `block_id` is the id, or its first 4 characters, as canvas_read printed it",
    );
  });
});

describe("the outline, one renderer", () => {
  const entry = (over: Partial<CanvasOutlineEntry> = {}): CanvasOutlineEntry => ({
    id: "b3f2c1a0-0000-4000-8000-000000000001",
    kind: "result",
    line: "Revenue by month",
    rows: 12,
    columns: ["month", "revenue"],
    face: "chart",
    modelWritten: true,
    ...over,
  });

  test("empty is one sentence, never a header over nothing", () => {
    expect(outlineText("Sales", [])).toBe('Canvas "Sales" is empty.');
  });

  test("a result names its shape, a note its first line", () => {
    expect(outlineText("Sales", [entry(), entry({ id: "a0410000-0000-4000-8000-000000000004", kind: "note", line: "**August, against the year:** COD took 22%", rows: undefined, columns: undefined, face: undefined })])).toBe(
      [
        'Canvas "Sales", 2 blocks.',
        "b3f2  result  Revenue by month · 12 rows: month, revenue · chart face",
        "a041  note    **August, against the year:** COD took 22%",
      ].join("\n"),
    );
  });

  test("singular at one, and a long first line is ellipsized", () => {
    const long = outlineText("Sales", [entry({ line: "x".repeat(90), rows: 1, columns: ["n"] })]);
    expect(long).toStartWith('Canvas "Sales", 1 block.');
    expect(long).toContain(`${"x".repeat(60)}… · 1 row: n`);
  });

  test("blockLine drops what a caller has nothing to say about", () => {
    expect(blockLine("b3f2c1a0", "note", ["said", null, undefined])).toBe("b3f2  note    said");
  });
});

// ---- the two sides of the bridge name the same things -----------------------
// agent_canvas.rs holds the oneshot and the timeout; this side holds the tools.
// Three facts cross that boundary, and each one is written twice by necessity
// (a Rust const cannot import a TypeScript one), so each is pinned here rather
// than left to drift on the first change (the tools.schema.json precedent).

describe("the MCP bridge, both sides", () => {
  const rust = readFileSync(
    join(import.meta.dir, "../../../src-tauri/src/agent_canvas.rs"),
    "utf8",
  );

  test("the three tool names are the same three", () => {
    expect(rust).toContain(
      `CANVAS_TOOL_NAMES: [&str; 3] = ["${CANVAS_TOOL_NAMES.join('", "')}"]`,
    );
  });

  test("the timeout is one number", () => {
    expect(CANVAS_BRIDGE_TIMEOUT_MS).toBe(20_000);
    expect(rust).toContain("CANVAS_BRIDGE_TIMEOUT_MS: u64 = 20_000;");
  });

  test("the timeout's own error text is the same sentence", () => {
    expect(CANVAS_BRIDGE_LOST).toBe(
      "ERROR: the canvas did not answer. Say your findings here instead",
    );
    expect(rust).toContain(`"${CANVAS_BRIDGE_LOST}"`);
  });

  test("the event is the one canvas.tauri.ts listens for", () => {
    expect(rust).toContain('CANVAS_TOOL_CALL_EVENT: &str = "canvas-tool-call"');
    const ts = readFileSync(join(import.meta.dir, "../canvas.tauri.ts"), "utf8");
    expect(ts).toContain('listen<CanvasToolCall>("canvas-tool-call"');
  });
});
