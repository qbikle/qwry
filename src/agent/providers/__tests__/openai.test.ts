import { expect, test } from "bun:test";

import { createOpenAiProvider, idNormalizer, listModels } from "../openai";
import { presetFor } from "../presets";
import { HttpStatusError, HttpUnreachableError } from "../types";
import type { Msg, ProviderConfig } from "../types";
import { LLAMA_TOOLCALL_CHUNKS } from "./fixtures";
import {
  FakePlatform,
  collect,
  doneOf,
  errorOf,
  request,
  slice,
  sse,
  textOf,
  thinkingOf,
  toolCalls,
  usageOf,
} from "./harness";

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "llama-server",
  model: "LFM2.5-2.6B-Q4_K_M",
  ...over,
});

function bodyOf(platform: FakePlatform) {
  return platform.lastBody();
}

test("the llama-server capture yields thinking, one tool call, and toolCalls", async () => {
  const platform = new FakePlatform({
    chunks: [sse([...LLAMA_TOOLCALL_CHUNKS, "[DONE]"])],
  });
  const events = await collect(
    createOpenAiProvider(config(), platform).chat(request()),
  );

  expect(thinkingOf(events)).toBe("The user wants");
  expect(textOf(events)).toBe("");
  expect(toolCalls(events)).toEqual([
    {
      id: "pg65tsgq9aOPnNSqFvFQmr5iSQVQqeyj",
      name: "describe_tables",
      args: '{"names":["users", "orders"]}',
    },
  ]);
  expect(doneOf(events)).toEqual({ stopReason: "toolCalls" });
});

test("reasoning deltas never reach the answer text", async () => {
  const platform = new FakePlatform({
    chunks: [sse([...LLAMA_TOOLCALL_CHUNKS, "[DONE]"])],
  });
  const events = await collect(
    createOpenAiProvider(config(), platform).chat(request()),
  );
  expect(textOf(events)).toBe("");
  expect(thinkingOf(events).length).toBeGreaterThan(0);
});

test("the same capture split across chunk boundaries parses identically", async () => {
  const stream = sse([...LLAMA_TOOLCALL_CHUNKS, "[DONE]"]);
  for (const size of [1, 3, 17, 512]) {
    const platform = new FakePlatform({ chunks: slice(stream, size) });
    const events = await collect(
      createOpenAiProvider(config(), platform).chat(request()),
    );
    expect(toolCalls(events)).toEqual([
      {
        id: "pg65tsgq9aOPnNSqFvFQmr5iSQVQqeyj",
        name: "describe_tables",
        args: '{"names":["users", "orders"]}',
      },
    ]);
  }
});

test("two parallel tool calls are accumulated by index and emitted in order", async () => {
  const chunks = [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"peek_values","arguments":"{\\"table\\":"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"film\\"}"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"run_sql","arguments":"{\\"sql\\":\\"select 1\\"}"}}]}}]}',
    '{"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
    "[DONE]",
  ];
  const platform = new FakePlatform({ chunks: [sse(chunks)] });
  const events = await collect(
    createOpenAiProvider(config(), platform).chat(request()),
  );
  expect(toolCalls(events)).toEqual([
    { id: "call_a", name: "peek_values", args: '{"table":"film"}' },
    { id: "call_b", name: "run_sql", args: '{"sql":"select 1"}' },
  ]);
});

test("usage arrives on a final chunk that carries no choices", async () => {
  const platform = new FakePlatform({
    chunks: [
      sse([
        '{"choices":[{"delta":{"content":"1000"},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '{"choices":[],"usage":{"prompt_tokens":4039,"completion_tokens":274,"prompt_tokens_details":{"cached_tokens":4381}}}',
        "[DONE]",
      ]),
    ],
  });
  const events = await collect(
    createOpenAiProvider(config({ providerId: "openai" }), platform).chat(
      request(),
    ),
  );
  expect(textOf(events)).toBe("1000");
  expect(usageOf(events)).toEqual({
    input: 4039,
    output: 274,
    cacheRead: 4381,
  });
  expect(doneOf(events)).toEqual({ stopReason: "stop" });
});

test("openai asks for usage in the stream and for parallel tool calls", async () => {
  const platform = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(config({ providerId: "openai" }), platform).chat(
      request(),
    ),
  );
  const body = bodyOf(platform);
  expect(body.stream).toBe(true);
  expect(body.tool_choice).toBe("auto");
  expect(body.parallel_tool_calls).toBe(true);
  expect(body.stream_options).toEqual({ include_usage: true });
  expect(platform.requests[0].url).toBe(
    "https://api.openai.com/v1/chat/completions",
  );
});

test("presets that do not document include_usage are not sent it", async () => {
  const platform = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(config({ providerId: "ollama" }), platform).chat(
      request(),
    ),
  );
  const body = bodyOf(platform);
  expect(body.stream_options).toBeUndefined();
  expect(body.parallel_tool_calls).toBeUndefined();
});

test("tools are rendered without strict mode, and xAI loses additionalProperties", async () => {
  const plain = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(config({ providerId: "openai" }), plain).chat(
      request(),
    ),
  );
  const openaiTools = JSON.stringify(bodyOf(plain).tools);
  expect(openaiTools).toContain('"additionalProperties":false');
  expect(openaiTools).not.toContain('"strict"');

  const xai = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(config({ providerId: "xai" }), xai).chat(request()),
  );
  const xaiTools = JSON.stringify(bodyOf(xai).tools);
  expect(xaiTools).not.toContain("additionalProperties");
  expect(xaiTools).toContain('"name":"run_sql"');
});

test("Gemini's trailing-slash base URL joins without doubling the slash", async () => {
  const platform = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(
      config({ providerId: "gemini", model: "gemini-3.8-flash" }),
      platform,
    ).chat(request({ model: "gemini-3.8-flash" })),
  );
  expect(platform.requests[0].url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
});

test("a user base URL overrides the preset default", async () => {
  const platform = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(
      config({ providerId: "llama-server", baseUrl: "http://127.0.0.1:8089/v1/" }),
      platform,
    ).chat(request()),
  );
  expect(platform.requests[0].url).toBe(
    "http://127.0.0.1:8089/v1/chat/completions",
  );
});

const HISTORY: Msg[] = [
  { role: "user", content: "how many films" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "toolu_01UsV41nzxe6nSyt2xSRgz36", name: "run_sql", args: "{}" },
    ],
  },
  {
    role: "tool",
    results: [
      {
        id: "toolu_01UsV41nzxe6nSyt2xSRgz36",
        name: "run_sql",
        result: "count\n1000",
      },
    ],
  },
];

test("Mistral gets 9-character tool-call ids that still link to their results", async () => {
  const platform = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(
      config({ providerId: "mistral", model: "mistral-large-3" }),
      platform,
    ).chat(request({ messages: HISTORY, model: "mistral-large-3" })),
  );
  const messages = bodyOf(platform).messages as {
    role: string;
    tool_calls?: { id: string }[];
    tool_call_id?: string;
  }[];
  const sent = messages.find((m) => m.role === "assistant")?.tool_calls?.[0].id;
  const linked = messages.find((m) => m.role === "tool")?.tool_call_id;
  expect(sent).toMatch(/^[A-Za-z0-9]{9}$/);
  expect(linked).toBe(sent);
  expect(sent).not.toBe("toolu_01UsV41nzxe6nSyt2xSRgz36");
});

test("a Mistral model behind a router inherits the id rule, other models do not", async () => {
  const routed = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(
      config({ providerId: "openrouter", model: "mistralai/Mistral-Large-3" }),
      routed,
    ).chat(request({ messages: HISTORY, model: "mistralai/Mistral-Large-3" })),
  );
  const routedMessages = bodyOf(routed).messages as {
    role: string;
    tool_calls?: { id: string }[];
  }[];
  expect(
    routedMessages.find((m) => m.role === "assistant")?.tool_calls?.[0].id,
  ).toMatch(/^[A-Za-z0-9]{9}$/);

  const other = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(
      config({ providerId: "openrouter", model: "openai/gpt-5.6-sol" }),
      other,
    ).chat(request({ messages: HISTORY, model: "openai/gpt-5.6-sol" })),
  );
  const otherMessages = bodyOf(other).messages as {
    role: string;
    tool_calls?: { id: string }[];
  }[];
  expect(
    otherMessages.find((m) => m.role === "assistant")?.tool_calls?.[0].id,
  ).toBe("toolu_01UsV41nzxe6nSyt2xSRgz36");
});

test("id normalisation is stable and collision free", () => {
  const normalize = idNormalizer("^[A-Za-z0-9]{9}$");
  const first = normalize("call_one");
  expect(normalize("call_one")).toBe(first);
  expect(idNormalizer("^[A-Za-z0-9]{9}$")("call_one")).toBe(first);
  expect(normalize("call_two")).not.toBe(first);
  expect(normalize("abcdefghi")).toBe("abcdefghi");
  expect(idNormalizer(undefined)("call_one")).toBe("call_one");
});

test("a tool turn becomes one tool message per result", async () => {
  const platform = new FakePlatform({ chunks: [sse(["[DONE]"])] });
  await collect(
    createOpenAiProvider(config({ providerId: "openai" }), platform).chat(
      request({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "a", name: "run_sql", args: "{}" },
              { id: "b", name: "list_tables", args: "{}" },
            ],
          },
          {
            role: "tool",
            results: [
              { id: "a", name: "run_sql", result: "one" },
              { id: "b", name: "list_tables", result: "two" },
            ],
          },
        ],
      }),
    ),
  );
  const messages = bodyOf(platform).messages as { role: string }[];
  expect(messages.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "tool",
  ]);
});

test("a 401 becomes an auth error and never quotes the body", async () => {
  const platform = new FakePlatform({
    httpError: new HttpStatusError(
      401,
      '{"error":{"message":"Incorrect API key provided: sk-live-abcd1234. Check your key."}}',
    ),
  });
  const events = await collect(
    createOpenAiProvider(config({ providerId: "openai" }), platform).chat(
      request(),
    ),
  );
  const error = errorOf(events);
  expect(error?.kind).toBe("auth");
  expect(error?.message).not.toContain("sk-live-abcd1234");
  expect(error?.message).toContain("OpenAI");
  expect(doneOf(events)).toEqual({ stopReason: "error" });
});

test("a 429 becomes a rate error and carries the wait the body states", async () => {
  const platform = new FakePlatform({
    httpError: new HttpStatusError(
      429,
      '{"error":{"message":"Rate limit reached. Please try again in 1.5s."}}',
    ),
  });
  const events = await collect(
    createOpenAiProvider(config({ providerId: "groq" }), platform).chat(
      request(),
    ),
  );
  expect(errorOf(events)?.kind).toBe("rate");
  expect(errorOf(events)?.retryAfterMs).toBe(1500);
});

test("any other status surfaces the provider's own message", async () => {
  const platform = new FakePlatform({
    httpError: new HttpStatusError(
      400,
      '{"error":{"message":"tool parameters must be an object"}}',
    ),
  });
  const events = await collect(
    createOpenAiProvider(config({ providerId: "xai" }), platform).chat(
      request(),
    ),
  );
  expect(errorOf(events)).toEqual({
    kind: "provider",
    message: "tool parameters must be an object",
  });
});

test("an unreachable local runtime is told how to start", async () => {
  const platform = new FakePlatform({
    httpError: new HttpUnreachableError("connection refused"),
  });
  const events = await collect(
    createOpenAiProvider(config(), platform).chat(request()),
  );
  const error = errorOf(events);
  expect(error?.kind).toBe("unreachable");
  expect(error?.message).toContain("llama.cpp");
  expect(error?.message).toContain("http://127.0.0.1:8080/v1");
  expect(error?.message).toContain("llama-server --jinja");
});

test("an in-band error object ends the stream as a provider error", async () => {
  const platform = new FakePlatform({
    chunks: [sse(['{"error":{"message":"upstream is overloaded"}}'])],
  });
  const events = await collect(
    createOpenAiProvider(config({ providerId: "openrouter" }), platform).chat(
      request(),
    ),
  );
  expect(errorOf(events)).toEqual({
    kind: "provider",
    message: "upstream is overloaded",
  });
});

test("a cancel is not an error", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  const platform = new FakePlatform({ httpError: aborted });
  const events = await collect(
    createOpenAiProvider(config(), platform).chat(
      request({ signal: controller.signal }),
    ),
  );
  expect(errorOf(events)).toBeUndefined();
  expect(doneOf(events)).toEqual({ stopReason: "cancelled" });
});

test("listModels reads both the OpenAI and the Ollama shape and labels paths", async () => {
  const platform = new FakePlatform({
    chunks: [
      JSON.stringify({
        models: [{ id: "/Users/me/models/gguf/Mystery-7B-Q4.gguf" }],
        object: "list",
        data: [
          { id: "/Users/me/models/gguf/Mystery-7B-Q4.gguf" },
          { id: "/Users/me/models/gguf/LFM2.5-2.6B-Q4_K_M.gguf" },
        ],
      }),
    ],
  });
  const models = await listModels(platform, presetFor("llama-server"));
  expect(platform.requests[0].url).toBe("http://127.0.0.1:8080/v1/models");
  expect(models).toEqual([
    // a path the registry has never seen: labelled from its file name, unknown
    {
      id: "/Users/me/models/gguf/Mystery-7B-Q4.gguf",
      label: "Mystery-7B-Q4",
      tier: "mid",
      known: false,
    },
    // a path whose file name IS a registry row: the row's label and tier, so
    // the loop gates it as small and never runs the tool loop on it
    {
      id: "/Users/me/models/gguf/LFM2.5-2.6B-Q4_K_M.gguf",
      label: "LFM2.5 2.6B (local)",
      tier: "small",
      known: true,
    },
  ]);
});

test("listModels prefers the registry's label and tier for a known id", async () => {
  const platform = new FakePlatform({
    chunks: [JSON.stringify({ data: [{ id: "grok-4.6" }] })],
  });
  const models = await listModels(platform, presetFor("xai"));
  expect(models).toEqual([
    { id: "grok-4.6", label: "Grok 4.6", tier: "large", known: true },
  ]);
});
