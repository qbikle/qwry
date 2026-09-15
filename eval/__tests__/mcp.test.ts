// The harness's MCP listener (EVAL.md section 3), which is the twin of
// src-tauri/src/agent_mcp.rs. It is the seam `claude -p` reaches qwry's tools
// through, so what is pinned here is what a baseline number means: the five
// tools of AGENT-SPEC section 5 and nothing else, the bearer token as the only
// identity, and a tally that counts what the listener actually served.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createNodePlatform, bearerOf, emptyTally, originAllowed } from "../platform.node";
import type { AgentTools } from "../../src/agent/tools";

/** Every tool answers with its own name, so a dispatch that reached the wrong
 * one is visible in the text rather than in a count. */
function stubTools(): AgentTools {
  const ok = (text: string) => ({ textForModel: text, result: null, error: null });
  return {
    listTables: async () => ok("list_tables ran"),
    describeTables: async (names: string[]) => ok(`describe_tables ran: ${names.join(",")}`),
    peekValues: async () => ok("peek_values ran"),
    runSql: async () => ok("run_sql ran"),
    probe: async () => ok("probe ran"),
  } as unknown as AgentTools;
}

async function connectClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("the harness MCP listener", () => {
  test("serves the five tools and counts what it served", async () => {
    const tools = stubTools();
    const platform = createNodePlatform({ toolsFor: () => tools });
    const endpoint = await platform.mcpServer("thread-1");
    try {
      const client = await connectClient(endpoint.url, endpoint.token);
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([
        "describe_tables",
        "list_tables",
        "peek_values",
        "probe",
        "run_sql",
      ]);
      // listTools is not a tools/call and must not be counted as one
      expect(platform.mcpCalls("thread-1").calls).toBe(0);

      const out = await client.callTool({ name: "describe_tables", arguments: { names: ["film"] } });
      expect((out.content as { text: string }[])[0].text).toBe("describe_tables ran: film");

      const tally = platform.mcpCalls("thread-1");
      expect(tally.calls).toBe(1);
      expect(tally.byName).toEqual({ describe_tables: 1 });
      expect(tally.unknown).toEqual([]);
      await client.close();
    } finally {
      await endpoint.close();
      platform.stop();
    }
  });

  test("records a tool outside the five instead of silently absorbing it", async () => {
    const platform = createNodePlatform({ toolsFor: () => stubTools() });
    const endpoint = await platform.mcpServer("thread-2");
    try {
      const client = await connectClient(endpoint.url, endpoint.token);
      const out = await client.callTool({ name: "Bash", arguments: {} });
      expect(out.isError).toBe(true);
      expect(platform.mcpCalls("thread-2").unknown).toEqual(["Bash"]);
      await client.close();
    } finally {
      await endpoint.close();
      platform.stop();
    }
  });

  test("an unknown token is 401 and a foreign Origin is 403, before any dispatch", async () => {
    const platform = createNodePlatform({ toolsFor: () => stubTools() });
    const endpoint = await platform.mcpServer("thread-3");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_sql", arguments: { sql: "SELECT 1" } },
    });
    const post = (headers: Record<string, string>) =>
      fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body,
      });
    try {
      expect((await post({ Authorization: "Bearer not-the-token" })).status).toBe(401);
      expect((await post({})).status).toBe(401);
      expect(
        (await post({ Authorization: `Bearer ${endpoint.token}`, Origin: "http://evil.example.com" })).status,
      ).toBe(403);
      expect(platform.mcpCalls("thread-3").calls).toBe(0);
    } finally {
      await endpoint.close();
      platform.stop();
    }
  });

  test("a thread that never opened an endpoint tallies zero, not undefined", () => {
    const platform = createNodePlatform({ toolsFor: () => stubTools() });
    expect(platform.mcpCalls("never-served")).toEqual(emptyTally());
    platform.stop();
  });
});

describe("the auth gate agent_mcp.rs states", () => {
  test("reads the scheme case-insensitively and nothing else", () => {
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("bearer abc")).toBe("abc");
    expect(bearerOf("BEARER abc")).toBe("abc");
    expect(bearerOf("Basic abc")).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });

  test("an absent Origin passes and a non-loopback one does not", () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed("http://127.0.0.1:9999")).toBe(true);
    expect(originAllowed("http://localhost:9999")).toBe(true);
    expect(originAllowed("http://evil.example.com")).toBe(false);
    expect(originAllowed("https://127.0.0.1")).toBe(false);
  });
});
