import { expect, test } from "bun:test";

import {
  ALLOWED_TOOLS,
  MCP_SERVER_NAME,
  THREAD_TURN_CAP,
  buildArgs,
  buildSideArgs,
  createClaudeCodeProvider,
  mcpConfigJson,
} from "../claudecode";
import { SideCallError } from "../types";
import type { AgentEvent, ProviderConfig, SideChatRequest, ThreadRef } from "../types";
import { CLAUDE_DEAD_MCP, CLAUDE_STREAM_JSON } from "./fixtures";
import {
  FakePlatform,
  collect,
  doneOf,
  errorOf,
  request,
  textOf,
  toolCalls,
  toolResults,
  usageOf,
} from "./harness";

const config: ProviderConfig = {
  providerId: "claude-code",
  model: "claude-haiku-4-5",
};

const thread = (over: Partial<ThreadRef> = {}): ThreadRef => ({
  id: "a0ad2909-06b1-44e7-b450-1053561d74dc",
  firstCall: true,
  turnsRemaining: THREAD_TURN_CAP,
  ...over,
});

function tags(events: readonly AgentEvent[]): string[] {
  return events.map((event) => Object.keys(event)[0]);
}

test("the provider owns its own loop", () => {
  const provider = createClaudeCodeProvider(config, new FakePlatform());
  expect(provider.ownsLoop).toBe(true);
  expect(provider.id).toBe("claude-code");
});

test("a captured run becomes the event sequence the loop expects", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );

  expect(tags(events)).toEqual([
    "toolCall",
    "toolResult",
    "toolCall",
    "toolResult",
    "text",
    "text",
    "text",
    "usage",
    "done",
  ]);
  expect(doneOf(events)).toEqual({ stopReason: "stop" });
});

test("MCP tool names reach the loop without the server prefix", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  expect(toolCalls(events)).toEqual([
    {
      id: "toolu_01V1kFzHzzM2QucDPmktQ7yz",
      name: "describe_tables",
      args: '{"names":["film"]}',
    },
    {
      id: "toolu_01Hw7QxbTPJjfHTehXWkZWoJ",
      name: "run_sql",
      args: '{"sql":"SELECT COUNT(*) as film_count FROM film;"}',
    },
  ]);
});

test("each tool result pairs with the call that made it", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  const results = toolResults(events);
  expect(results.map((r) => [r.id, r.name])).toEqual([
    ["toolu_01V1kFzHzzM2QucDPmktQ7yz", "describe_tables"],
    ["toolu_01Hw7QxbTPJjfHTehXWkZWoJ", "run_sql"],
  ]);
  expect(results[1].result).toBe('{"result":"film_count\\n1000\\n(1 rows)"}');
});

test("answer text streams once, not once per delta and again in the summary", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  expect(textOf(events)).toBe(
    "**1000 films** in Pagila database.\n\nFilm table: ~1000 rows, schema includes title, release_year, rating, length, rental details, language refs.",
  );
});

test("the result event carries cache reads and writes", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  expect(usageOf(events)).toEqual({
    input: 4039,
    output: 324,
    cacheRead: 4372,
    cacheWrite: 4549,
  });
});

test("a disconnected MCP server fails the turn before any model text", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_DEAD_MCP] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  expect(errorOf(events)).toEqual({
    kind: "provider",
    message: "agent tools did not connect",
  });
  expect(textOf(events)).toBe("");
  expect(tags(events)).toEqual(["error", "done"]);
  expect(doneOf(events)).toEqual({ stopReason: "error" });
  // the child is killed rather than left to answer from nothing
  expect(platform.spawns[0].signal?.aborted).toBe(true);
});

test("the thread's MCP endpoint is released when the turn ends", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  expect(platform.mcpRefs).toEqual(["a0ad2909-06b1-44e7-b450-1053561d74dc"]);
  expect(platform.mcpClosed).toBe(1);
});

test("the question goes on stdin, never in argv", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread(), messages: [{ role: "user", content: "how many films" }] }),
    ),
  );
  const spawn = platform.spawns[0];
  expect(spawn.cmd).toBe("claude");
  expect(spawn.stdin).toBe("how many films");
  expect(spawn.args).not.toContain("how many films");
});

test("a thread at its turn cap refuses to resume and never spawns", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread({ firstCall: false, turnsRemaining: 0 }) }),
    ),
  );
  expect(errorOf(events)?.kind).toBe("provider");
  expect(errorOf(events)?.message).toContain("turns");
  expect(platform.spawns).toHaveLength(0);
});

test("a resume passes what is left of the thread's turn budget", async () => {
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread({ firstCall: false, turnsRemaining: 5 }) }),
    ),
  );
  const args = platform.spawns[0].args;
  expect(args[args.indexOf("--max-turns") + 1]).toBe("5");
  expect(args).toContain("--resume");
  expect(args).not.toContain("--session-id");
});

test("every load-bearing flag is present, and the two banned ones are not", () => {
  const args = buildArgs({
    model: "claude-haiku-4-5",
    mcpConfig: "{}",
    maxTurns: 12,
    system: "system prompt",
    threadId: "thread-1",
    firstCall: true,
  });
  for (const flag of [
    "-p",
    "--output-format",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--mcp-config",
    "--tools",
    "--allowedTools",
    "--setting-sources",
    "--max-turns",
    "--system-prompt",
    "--session-id",
  ]) {
    expect(args).toContain(flag);
  }
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  expect(args[args.indexOf("--allowedTools") + 1]).toBe(ALLOWED_TOOLS);
  expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(args[args.indexOf("--session-id") + 1]).toBe("thread-1");
  expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
  expect(args).not.toContain("--bare");
});

test("the inline mcp-config names the server the allowlist expects", () => {
  const parsed = JSON.parse(
    mcpConfigJson({ url: "http://127.0.0.1:51234/mcp", token: "tok-abc" }),
  ) as {
    mcpServers: Record<
      string,
      { type: string; url: string; headers: Record<string, string> }
    >;
  };
  const server = parsed.mcpServers[MCP_SERVER_NAME];
  expect(ALLOWED_TOOLS).toBe(`mcp__${MCP_SERVER_NAME}__*`);
  expect(server.type).toBe("http");
  expect(server.url).toBe("http://127.0.0.1:51234/mcp");
  expect(server.headers.Authorization).toBe("Bearer tok-abc");
});

test("a child that exits without signing in gets an auth error", async () => {
  const platform = new FakePlatform({
    lines: [],
    exit: { code: 1, stderrTail: "Not logged in · Please run /login" },
  });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  expect(errorOf(events)?.kind).toBe("auth");
  expect(errorOf(events)?.message).toContain("sign in");
});

test("a missing claude binary reads as unreachable, not as a provider fault", async () => {
  const platform = new FakePlatform({
    lines: [],
    exit: { code: null, stderrTail: "spawn claude ENOENT" },
  });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread() }),
    ),
  );
  expect(errorOf(events)?.kind).toBe("unreachable");
  expect(errorOf(events)?.message).toContain("Install Claude Code");
});

test("a cancelled turn ends cancelled, with no error", async () => {
  const controller = new AbortController();
  controller.abort();
  const platform = new FakePlatform({ lines: [...CLAUDE_STREAM_JSON] });
  const events = await collect(
    createClaudeCodeProvider(config, platform).chat(
      request({ thread: thread(), signal: controller.signal }),
    ),
  );
  expect(errorOf(events)).toBeUndefined();
  expect(doneOf(events)).toEqual({ stopReason: "cancelled" });
});

// ---- the side call ------------------------------------------------------------
// Shapes from a live toolless run (2026-09-06): the init line carries
// `tools: []` and, under --strict-mcp-config with no --mcp-config, an empty
// mcp_servers array (dropped here to prove the gate needs none); the reply is
// one assistant message and the result line repeats it as a string.

const SIDE_TEXT =
  "How many films per rating?\nWhich category has the most films?\nWhat is the average length?";
const SIDE_INIT = JSON.stringify({ type: "system", subtype: "init", tools: [], model: "claude-haiku-4-5" });
const SIDE_ASSISTANT = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_side",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: SIDE_TEXT },
    ],
  },
});
const SIDE_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: SIDE_TEXT,
  usage: { input_tokens: 459, output_tokens: 756 },
});

const sideRequest = (over: Partial<SideChatRequest> = {}): SideChatRequest => ({
  system: "Suggest three follow-up questions.",
  user: "Question: how many films\nAnswer: 1000 films.",
  model: "claude-haiku-4-5",
  signal: new AbortController().signal,
  ...over,
});

function sideChatOf(platform: FakePlatform) {
  const provider = createClaudeCodeProvider(config, platform);
  if (!provider.sideChat) throw new Error("the claude-code provider has no sideChat");
  return provider.sideChat.bind(provider);
}

test("a side call spawns toolless: no session, no MCP config, the strict flag, one turn", async () => {
  const platform = new FakePlatform({ lines: [SIDE_INIT, SIDE_ASSISTANT, SIDE_RESULT] });
  const out = await sideChatOf(platform)(sideRequest());

  expect(out.text).toBe(SIDE_TEXT);
  expect(out.usage).toEqual({ input: 459, output: 756 });
  expect(platform.mcpRefs).toEqual([]);

  const spawn = platform.spawns[0];
  expect(spawn.cmd).toBe("claude");
  expect(spawn.stdin).toBe("Question: how many films\nAnswer: 1000 films.");
  expect(spawn.args[spawn.args.indexOf("--tools") + 1]).toBe("");
  expect(spawn.args[spawn.args.indexOf("--setting-sources") + 1]).toBe("");
  expect(spawn.args[spawn.args.indexOf("--max-turns") + 1]).toBe("1");
  expect(spawn.args[spawn.args.indexOf("--system-prompt") + 1]).toBe("Suggest three follow-up questions.");
  expect(spawn.args[spawn.args.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
  expect(spawn.args).toContain("--strict-mcp-config");
  for (const flag of [
    "--mcp-config",
    "--allowedTools",
    "--session-id",
    "--resume",
    "--include-partial-messages",
    "--bare",
  ]) {
    expect(spawn.args).not.toContain(flag);
  }
  expect(spawn.args).toEqual(
    buildSideArgs({ model: "claude-haiku-4-5", system: "Suggest three follow-up questions." }),
  );
});

test("a side call's init line needs no MCP server, only an empty tool list", async () => {
  const platform = new FakePlatform({
    lines: [JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }), SIDE_ASSISTANT, SIDE_RESULT],
  });
  const out = await sideChatOf(platform)(sideRequest());
  expect(out.text).toBe(SIDE_TEXT);
  expect(platform.spawns[0].signal?.aborted).toBe(false);
});

test("a side call whose init lists a tool is killed before the model answers", async () => {
  const platform = new FakePlatform({
    lines: [JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] }), SIDE_ASSISTANT, SIDE_RESULT],
  });
  const err = await sideChatOf(platform)(sideRequest()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SideCallError);
  expect((err as SideCallError).message).toBe("a side call was given tools");
  expect(platform.spawns[0].signal?.aborted).toBe(true);
});

test("a side call falls back to the result line's text when no assistant line came", async () => {
  const platform = new FakePlatform({ lines: [SIDE_INIT, SIDE_RESULT] });
  const out = await sideChatOf(platform)(sideRequest());
  expect(out.text).toBe(SIDE_TEXT);
});

test("a side call that is not signed in rejects with an auth error", async () => {
  const platform = new FakePlatform({
    lines: [
      SIDE_INIT,
      JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }),
    ],
  });
  const err = await sideChatOf(platform)(sideRequest()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SideCallError);
  expect((err as SideCallError).kind).toBe("auth");
  expect((err as SideCallError).message).toContain("sign in");
});

test("a side call whose child dies without a result reads its stderr", async () => {
  const platform = new FakePlatform({ lines: [], exit: { code: null, stderrTail: "spawn claude ENOENT" } });
  const err = await sideChatOf(platform)(sideRequest()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SideCallError);
  expect((err as SideCallError).kind).toBe("unreachable");
});

test("an aborted side call rejects as cancelled and never spawns", async () => {
  const controller = new AbortController();
  controller.abort();
  const platform = new FakePlatform({ lines: [SIDE_INIT, SIDE_ASSISTANT, SIDE_RESULT] });
  const err = await sideChatOf(platform)(sideRequest({ signal: controller.signal })).catch((e: unknown) => e);
  expect((err as Error).name).toBe("AbortError");
  expect(platform.spawns).toHaveLength(0);
});
