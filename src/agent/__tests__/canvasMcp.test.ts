// The `claude -p` path's half of the gate (canvas-agent-spec section 1.6): the
// child reaches its tools through qwry's own MCP server, so the list that
// token serves has to be the list the run offered. Anything else and the two
// provider paths present different tool surfaces for one exchange, which is
// the drift the single schema file exists to prevent.
//
// Only the handover is asserted here: what Rust does with the names is
// agent_mcp.rs's own test (`tools_for(None)` is the byte-identical five).

import { describe, expect, test } from "bun:test";
import { createClaudeCodeProvider } from "../providers/claudecode";
import { TOOL_NAMES, toolsFor } from "../tools";
import type {
  HttpStreamRequest,
  McpEndpoint,
  Platform,
  SpawnedProcess,
} from "../providers/types";

/** A platform that records the tool list each token was minted for. The child
 * never starts: `mcpServer` is called before the spawn, which is all this pin
 * is about. */
function recordingPlatform() {
  const served: (readonly string[] | undefined)[] = [];
  const platform: Platform = {
    httpStream(_req: HttpStreamRequest) {
      return (async function* () {})();
    },
    spawn(): SpawnedProcess {
      return {
        lines: (async function* () {})(),
        exit: Promise.resolve({ code: 0, stderrTail: "" }),
      };
    },
    async mcpServer(_ref: string, toolNames?: readonly string[]): Promise<McpEndpoint> {
      served.push(toolNames);
      return { url: "http://127.0.0.1:1/mcp", token: "tok", close: async () => {} };
    },
    now: () => 0,
  };
  return { platform, served };
}

async function drain(offered: ReturnType<typeof toolsFor>) {
  const { platform, served } = recordingPlatform();
  const provider = createClaudeCodeProvider(
    { providerId: "claude-code", model: "sonnet" },
    platform,
  );
  const stream = provider.chat({
    system: "s",
    messages: [{ role: "user", content: "how many films" }],
    tools: offered,
    model: "sonnet",
    signal: new AbortController().signal,
    thread: { id: "t-1", firstCall: true, turnsRemaining: 12 },
  });
  // the child writes nothing, so the adapter ends with its own init failure;
  // the token was already minted by then, which is what is under test
  for await (const _ev of stream) void _ev;
  return served;
}

describe("the MCP token serves the run's own tools", () => {
  test("no target: exactly the five, in file order", async () => {
    expect(await drain(toolsFor(false))).toEqual([[...TOOL_NAMES]]);
  });

  test("a target: the eight it offered, the five first", async () => {
    expect(await drain(toolsFor(true))).toEqual([
      [
        "list_tables",
        "describe_tables",
        "peek_values",
        "run_sql",
        "probe",
        "canvas_write",
        "canvas_replace",
        "canvas_read",
      ],
    ]);
  });
});
