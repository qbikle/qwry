// Truncation and cut-off stop reasons must never read as a finished answer.
// Three independent verifier findings (2026-09-05): claude -p's
// error_max_turns was reported as maxTokens (indistinguishable from a long
// answer), Anthropic's model_context_window_exceeded and OpenAI's
// content_filter both fell through to "stop".

import { expect, test } from "bun:test";
import { createAnthropicProvider } from "../anthropic";
import { createClaudeCodeProvider } from "../claudecode";
import { createOpenAiProvider } from "../openai";
import { FakePlatform, collect, doneOf, request, sse } from "./harness";

test("claude -p error_max_turns is a turn cap, not a long answer", async () => {
  const lines = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "qwry", status: "connected" }],
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "t1", name: "mcp__qwry__run_sql", input: { sql: "select 1" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ];
  const platform = new FakePlatform({ lines });
  const provider = createClaudeCodeProvider(
    { providerId: "claude-code", model: "claude-haiku-4-5" },
    platform,
  );
  const events = await collect(
    provider.chat(request({ thread: { id: "t", firstCall: true, turnsRemaining: 12 } })),
  );
  expect(doneOf(events)?.stopReason).toBe("turnCap");
});

test("anthropic model_context_window_exceeded is a truncation", async () => {
  const chunks = [
    sse([
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial answer cut off" },
      }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "model_context_window_exceeded" },
        usage: { output_tokens: 500 },
      }),
      JSON.stringify({ type: "message_stop" }),
    ]),
  ];
  const platform = new FakePlatform({ chunks });
  const provider = createAnthropicProvider(
    { providerId: "anthropic", model: "claude-sonnet-5" },
    platform,
  );
  const events = await collect(provider.chat(request()));
  expect(doneOf(events)?.stopReason).toBe("maxTokens");
});

test("openai content_filter is a truncation", async () => {
  const chunks = [
    sse([
      JSON.stringify({ choices: [{ delta: { content: "partial" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] }),
    ]),
    "data: [DONE]\n\n",
  ];
  const platform = new FakePlatform({ chunks });
  const provider = createOpenAiProvider({ providerId: "openai", model: "gpt-5.6-terra" }, platform);
  const events = await collect(provider.chat(request()));
  expect(doneOf(events)?.stopReason).toBe("maxTokens");
});
