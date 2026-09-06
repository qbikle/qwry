// The structural rules the agent layer is built on, as tests rather than as
// review comments. Each one is a rule a parallel wave could break silently.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOL_NAMES, TOOL_SCHEMAS } from "../tools";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../prompt";
import { formatRun } from "../context";

const AGENT_DIR = join(import.meta.dir, "..");

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__") continue;
      yield* sources(path);
    } else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) {
      yield path;
    }
  }
}

// anchored at a line start, so the word "import" inside a doc comment is
// prose and only a real statement is scanned
const IMPORT = /^import\s+([\s\S]*?)\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT = /^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']/g;

/** A clause is type-only when the whole import is (`import type X from`) or
 * every binding it names is (`import { type A, type B } from`). */
function typeOnly(clause: string): boolean {
  const c = clause.trim();
  if (c.startsWith("type ") || c.startsWith("type{")) return true;
  const braces = c.match(/\{([\s\S]*)\}/);
  if (!braces) return false;
  return braces[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => s.startsWith("type "));
}

const forbidden = (spec: string) =>
  spec.startsWith("@tauri-apps") || spec.includes("/stores/") || spec.includes("/ipc/");

describe("AGENT-SPEC section 2 rule 2", () => {
  test("nothing under src/agent except *.tauri.ts reaches Tauri or a store at runtime", () => {
    const offenders: string[] = [];
    for (const path of sources(AGENT_DIR)) {
      if (path.endsWith(".tauri.ts")) continue;
      const src = readFileSync(path, "utf8");
      const rel = path.slice(AGENT_DIR.length + 1);
      for (const m of src.matchAll(IMPORT)) {
        if (forbidden(m[2]) && !typeOnly(m[1])) offenders.push(`${rel} imports ${m[2]}`);
      }
      for (const m of src.matchAll(SIDE_EFFECT)) {
        if (forbidden(m[1])) offenders.push(`${rel} side-effect imports ${m[1]}`);
      }
      for (const m of src.matchAll(DYNAMIC)) {
        if (forbidden(m[1])) offenders.push(`${rel} dynamically imports ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the rule has something to catch: the two .tauri.ts files do reach out", () => {
    const tauri = [...sources(AGENT_DIR)].filter((p) => p.endsWith(".tauri.ts"));
    expect(tauri).toHaveLength(2);
    for (const path of tauri) {
      expect(readFileSync(path, "utf8")).toContain("../ipc/commands");
    }
  });
});

describe("the tool contract", () => {
  test("TOOL_SCHEMAS names are exactly TOOL_NAMES, in order", () => {
    expect(TOOL_SCHEMAS.map((s) => s.name)).toEqual([...TOOL_NAMES]);
  });

  test("every schema is an object schema that refuses extra properties", () => {
    for (const schema of TOOL_SCHEMAS) {
      expect(schema.parameters.type).toBe("object");
      expect(schema.parameters.additionalProperties).toBe(false);
      expect(schema.description.length).toBeGreaterThan(40);
    }
  });
});

describe("the prompt is frozen", () => {
  test("no interpolation, so a provider can cache the prefix", () => {
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT.includes("${")).toBe(false);
    // v3: the answer shape again, now that the slot renders a markdown subset
    // (W5); the eval baselines are still v1 rows until the W3 re-run
    expect(PROMPT_VERSION).toBe("v3");
  });

  test("it carries the four rules section 6 mandates", () => {
    expect(SYSTEM_PROMPT).toContain("Do NOT add filters the question did not ask for");
    expect(SYSTEM_PROMPT).toContain("Return exactly the columns the question asks for");
    expect(SYSTEM_PROMPT).toContain("Tables marked LEGACY are never the answer");
    expect(SYSTEM_PROMPT).toContain("Assumptions:");
  });
});

describe("the wire and the domain meet exactly once", () => {
  test("only tools.tauri.ts speaks snake_case (w1-ownership deviation 2)", () => {
    const speakers: string[] = [];
    for (const path of sources(AGENT_DIR)) {
      if (readFileSync(path, "utf8").includes("row_count")) {
        speakers.push(path.slice(AGENT_DIR.length + 1));
      }
    }
    expect(speakers).toEqual(["tools.tauri.ts"]);
  });

  test("a null cell reads as a null, not as an empty string", () => {
    const run = { columns: ["id", "name"], rows: [["1", null]], rowCount: 1, capped: false, ms: 7 };
    expect(formatRun(run)).toBe("id | name\n1 | ∅\n(1 rows)");
  });

  test("a capped result says so rather than implying the rows are all of them", () => {
    const run = {
      columns: ["id", "name"],
      rows: [["1", "a"]],
      rowCount: 2000,
      capped: true,
      ms: 7,
    };
    expect(formatRun(run)).toContain("(2000 rows, capped at 2000; showing 1)");
  });
});
