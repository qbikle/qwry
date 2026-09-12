// The init gate for claude -p: a connected MCP server is necessary, not
// sufficient. A live run on 2026-09-05 had status "connected" and an empty
// tool list; the model wrote <function_calls> as prose and made up the rows.

import { expect, test } from "bun:test";
import { mcpConnected, toollessInit } from "../claudecode";

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

// The side call's gate is the inverse: no server is required, and no tool is
// allowed. A live toolless run (2026-09-06) reports `tools: []`.

test("a toolless init passes with no mcp_servers at all", () => {
  expect(toollessInit(line({ tools: [] }))).toBe(true);
  expect(toollessInit(line({ tools: [], mcp_servers: [] }))).toBe(true);
});

test("a toolless init refuses any listed tool, ours included", () => {
  expect(toollessInit(line({ tools: ["Bash"] }))).toBe(false);
  expect(
    toollessInit(
      line({ mcp_servers: [{ name: "qwry", status: "connected" }], tools: ["mcp__qwry__run_sql"] }),
    ),
  ).toBe(false);
});

test("a toolless init without a tools array is trusted, as the main gate trusts it", () => {
  expect(toollessInit(line({}))).toBe(true);
});
