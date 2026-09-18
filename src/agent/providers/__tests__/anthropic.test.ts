import { expect, test } from "bun:test";

import {
  ANTHROPIC_VERSION,
  MAX_TOKENS,
  createAnthropicProvider,
} from "../anthropic";
import { HttpStatusError } from "../types";
import type { Msg, ProviderConfig } from "../types";
import { ANTHROPIC_PARALLEL_TOOL_USE, ANTHROPIC_TEXT_TURN } from "./fixtures";
import {
  FakePlatform,
  collect,
  doneOf,
  errorOf,
  request,
  slice,
  textOf,
  thinkingOf,
  toolCalls,
  usageOf,
} from "./harness";

const config: ProviderConfig = {
  providerId: "anthropic",
  model: "claude-sonnet-5",
};

test("two parallel tool_use blocks become two tool calls, args accumulated", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_PARALLEL_TOOL_USE] });
  const events = await collect(
    createAnthropicProvider(config, platform).chat(
      request({ model: "claude-sonnet-5" }),
    ),
  );

  expect(toolCalls(events)).toEqual([
    {
      id: "toolu_01A09q90qw90lq917835lq9",
      name: "describe_tables",
      args: '{"names": ["film", "actor"]}',
    },
    {
      id: "toolu_01B22q90qw90lq917835lq9",
      name: "peek_values",
      args: '{"table": "film", "column": "rating"}',
    },
  ]);
  expect(doneOf(events)).toEqual({ stopReason: "toolCalls" });
});

test("thinking_delta is thinking, and the signature that trails it is dropped", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_PARALLEL_TOOL_USE] });
  const events = await collect(
    createAnthropicProvider(config, platform).chat(request()),
  );
  expect(thinkingOf(events)).toBe("The film table first.");
  expect(textOf(events)).toBe("");
  expect(JSON.stringify(events)).not.toContain("Eu8DCrIBCBEYAipA");
});

test("cache reads and writes are reported separately from the token counts", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_PARALLEL_TOOL_USE] });
  const events = await collect(
    createAnthropicProvider(config, platform).chat(request()),
  );
  expect(usageOf(events)).toEqual({
    input: 118,
    output: 137,
    cacheRead: 4381,
    cacheWrite: 4539,
  });
});

test("a text turn streams text and stops on end_turn", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_TEXT_TURN] });
  const events = await collect(
    createAnthropicProvider(config, platform).chat(request()),
  );
  expect(textOf(events)).toBe("1000 films in total.");
  expect(doneOf(events)).toEqual({ stopReason: "stop" });
});

test("the same stream split across chunk boundaries parses identically", async () => {
  for (const size of [1, 5, 64]) {
    const platform = new FakePlatform({
      chunks: slice(ANTHROPIC_PARALLEL_TOOL_USE, size),
    });
    const events = await collect(
      createAnthropicProvider(config, platform).chat(request()),
    );
    expect(toolCalls(events).map((c) => c.args)).toEqual([
      '{"names": ["film", "actor"]}',
      '{"table": "film", "column": "rating"}',
    ]);
  }
});

test("the request carries the version header, max_tokens, and no key", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_TEXT_TURN] });
  await collect(createAnthropicProvider(config, platform).chat(request()));
  const sent = platform.requests[0];
  expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
  expect(sent.providerId).toBe("anthropic");
  expect(sent.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
  expect(Object.keys(sent.headers).map((k) => k.toLowerCase())).not.toContain(
    "x-api-key",
  );
  expect(platform.lastBody().max_tokens).toBe(MAX_TOKENS);
});

test("the frozen prefix and the last tool carry the cache breakpoints", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_TEXT_TURN] });
  await collect(createAnthropicProvider(config, platform).chat(request()));
  const body = platform.lastBody();
  const system = body.system as { cache_control?: unknown }[];
  expect(system).toHaveLength(1);
  expect(system[0].cache_control).toEqual({ type: "ephemeral" });

  const tools = body.tools as { name: string; cache_control?: unknown }[];
  expect(tools).toHaveLength(2);
  expect(tools[0].cache_control).toBeUndefined();
  expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
  expect(tools[1].name).toBe("run_sql");
});

test("the 5-family gets no temperature and no top_p", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_TEXT_TURN] });
  await collect(
    createAnthropicProvider(config, platform).chat(
      request({ model: "claude-sonnet-5" }),
    ),
  );
  const body = platform.lastBody();
  expect(body.temperature).toBeUndefined();
  expect(body.top_p).toBeUndefined();
  expect(body.top_k).toBeUndefined();
});

test("a parallel tool turn puts every result in ONE user message", async () => {
  const history: Msg[] = [
    { role: "user", content: "how many films" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "toolu_a", name: "describe_tables", args: '{"names":["film"]}' },
        { id: "toolu_b", name: "peek_values", args: '{"table":"film"}' },
      ],
    },
    {
      role: "tool",
      results: [
        { id: "toolu_a", name: "describe_tables", result: "CREATE TABLE film" },
        { id: "toolu_b", name: "peek_values", result: "G, PG", isError: true },
      ],
    },
  ];
  const platform = new FakePlatform({ chunks: [ANTHROPIC_TEXT_TURN] });
  await collect(
    createAnthropicProvider(config, platform).chat(
      request({ messages: history }),
    ),
  );
  const messages = platform.lastBody().messages as {
    role: string;
    content: { type: string; is_error?: boolean }[];
  }[];
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(messages[1].content.map((b) => b.type)).toEqual([
    "tool_use",
    "tool_use",
  ]);
  expect(messages[2].content.map((b) => b.type)).toEqual([
    "tool_result",
    "tool_result",
  ]);
  expect(messages[2].content[1].is_error).toBe(true);
});

test("consecutive same-role messages are merged so the roles keep alternating", async () => {
  const platform = new FakePlatform({ chunks: [ANTHROPIC_TEXT_TURN] });
  await collect(
    createAnthropicProvider(config, platform).chat(
      request({
        messages: [
          {
            role: "tool",
            results: [{ id: "toolu_a", name: "run_sql", result: "count 1000" }],
          },
          { role: "user", content: "and by rating" },
        ],
      }),
    ),
  );
  const messages = platform.lastBody().messages as { role: string }[];
  expect(messages.map((m) => m.role)).toEqual(["user"]);
});

test("an in-band error event maps by its own type", async () => {
  const platform = new FakePlatform({
    chunks: [
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your limit"}}\n\n',
    ],
  });
  const events = await collect(
    createAnthropicProvider(config, platform).chat(request()),
  );
  expect(errorOf(events)).toEqual({
    kind: "rate",
    message: "Number of requests has exceeded your limit",
  });
  expect(doneOf(events)).toEqual({ stopReason: "error" });
});

test("a 401 is an auth error that does not echo the body", async () => {
  const platform = new FakePlatform({
    httpError: new HttpStatusError(
      401,
      '{"error":{"message":"invalid x-api-key sk-ant-secret"}}',
    ),
  });
  const events = await collect(
    createAnthropicProvider(config, platform).chat(request()),
  );
  expect(errorOf(events)?.kind).toBe("auth");
  expect(errorOf(events)?.message).not.toContain("sk-ant-secret");
});
