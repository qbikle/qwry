// The init gate for claude -p: a connected MCP server is necessary, not
// sufficient. A live run on 2026-09-05 had status "connected" and an empty
// tool list; the model wrote <function_calls> as prose and made up the rows.

import { expect, test } from "bun:test";
import { mcpConnected } from "../claudecode";

const line = (over: Record<string, unknown>) => ({ type: "system", subtype: "init", ...over });

test("connected with our tools listed passes", () => {
  expect(
    mcpConnected(
      line({
        mcp_servers: [{ name: "qwry", status: "connected" }],
        tools: ["mcp__qwry__list_tables", "mcp__qwry__run_sql"],
      }),
    ),
  ).toBe(true);
});

test("connected but toolless fails", () => {
  expect(
    mcpConnected(line({ mcp_servers: [{ name: "qwry", status: "connected" }], tools: [] })),
  ).toBe(false);
  expect(
    mcpConnected(
      line({ mcp_servers: [{ name: "qwry", status: "connected" }], tools: ["ToolSearch"] }),
    ),
  ).toBe(false);
});

test("failed, missing, or foreign servers fail", () => {
  expect(mcpConnected(line({ mcp_servers: [{ name: "qwry", status: "failed" }] }))).toBe(false);
  expect(mcpConnected(line({ mcp_servers: [] }))).toBe(false);
  expect(
    mcpConnected(line({ mcp_servers: [{ name: "other", status: "connected" }], tools: ["mcp__other__x"] })),
  ).toBe(false);
});

test("an init line without a tools array is trusted on status alone", () => {
  expect(mcpConnected(line({ mcp_servers: [{ name: "qwry", status: "connected" }] }))).toBe(true);
});
