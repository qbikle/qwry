// Image context on the wire (canvas-grid-spec 5, C2b calls 3 and 4). Three
// things are pinned here and nothing else belongs in this file:
//
//   1. A question with NO image serializes byte for byte as it did before the
//      field existed. The two golden strings below were captured from HEAD
//      (f53b518) by running the same request through the same adapters, so a
//      diff in this test is a diff in every request qwry has ever sent, for
//      fifteen providers, and the eval suite does not have to re-run to say so.
//   2. A question WITH one image lands in each wire's own documented shape:
//      an Anthropic base64 `image` block before the text block, an
//      OpenAI-compatible `image_url` part carrying a data URI after the text
//      part. Both formats re-verified against the providers' own docs this
//      wave (Anthropic vision guide; OpenAI images guide; Google's
//      OpenAI-compatibility page, whose example runs on gemini-3.8-flash at
//      the base URL presets.ts already holds).
//   3. The two flags: `imageWire` per preset, `vision` per model, and the one
//      install override that lifts an `"unknown"` model and nothing else.

import { expect, test } from "bun:test";

import { createAnthropicProvider } from "../anthropic";
import { createOpenAiProvider } from "../openai";
import {
  PROVIDER_PRESETS,
  carriesImages,
  imageRouteFor,
  imageWireFor,
  presetFor,
} from "../presets";
import { MODEL_REGISTRY, visionOf } from "../registry";
import type { ImagePart, Msg, ProviderConfig } from "../types";
import { FakePlatform, TOOLS, collect } from "./harness";

/** 1x1 transparent PNG: the smallest thing that is really a PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const IMAGE: ImagePart = { mime: "image/png", b64: PNG_B64 };

/** A thread far enough along to carry every message kind: a question, a tool
 * call, its result, and the follow-up question the image rides on. */
function history(images?: ImagePart[]): Msg[] {
  return [
    { role: "user", content: "how many films" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "run_sql", args: '{"sql":"select 1"}' }],
    },
    { role: "tool", results: [{ id: "call_1", name: "run_sql", result: "1" }] },
    { role: "user", content: "and how many actors", ...(images ? { images } : {}) },
  ];
}

function request(model: string, images?: ImagePart[]) {
  return {
    system: "You answer questions about a PostgreSQL database.",
    messages: history(images),
    tools: TOOLS,
    model,
    signal: new AbortController().signal,
  };
}

const ANTHROPIC: ProviderConfig = { providerId: "anthropic", model: "claude-sonnet-5" };
const OPENAI: ProviderConfig = { providerId: "openai", model: "gpt-5.6-sol" };

/** The body an adapter actually sent, as a string (byte identity) and parsed. */
async function sent(config: ProviderConfig, images?: ImagePart[]) {
  const platform = new FakePlatform({ chunks: [] });
  const provider =
    config.providerId === "anthropic"
      ? createAnthropicProvider(config, platform)
      : createOpenAiProvider(config, platform);
  await collect(provider.chat(request(config.model, images)));
  const raw = platform.requests[0]?.body ?? "";
  return { raw, body: JSON.parse(raw) as Record<string, unknown> };
}

// ── 1. byte identity ────────────────────────────────────────────────────────

const GOLDEN_ANTHROPIC =
  '{"model":"claude-sonnet-5","max_tokens":8000,"stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"how many films"}]},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"run_sql","input":{"sql":"select 1"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"1"},{"type":"text","text":"and how many actors"}]}],"system":[{"type":"text","text":"You answer questions about a PostgreSQL database.","cache_control":{"type":"ephemeral"}}],"tools":[{"name":"list_tables","description":"List every table.","input_schema":{"type":"object","properties":{},"required":[],"additionalProperties":false}},{"name":"run_sql","description":"Run one read-only statement.","input_schema":{"type":"object","properties":{"sql":{"type":"string"}},"required":["sql"],"additionalProperties":false},"cache_control":{"type":"ephemeral"}}]}';

const GOLDEN_OPENAI =
  '{"model":"gpt-5.6-sol","stream":true,"messages":[{"role":"system","content":"You answer questions about a PostgreSQL database."},{"role":"user","content":"how many films"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"run_sql","arguments":"{\\"sql\\":\\"select 1\\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"1"},{"role":"user","content":"and how many actors"}],"tools":[{"type":"function","function":{"name":"list_tables","description":"List every table.","parameters":{"type":"object","properties":{},"required":[],"additionalProperties":false}}},{"type":"function","function":{"name":"run_sql","description":"Run one read-only statement.","parameters":{"type":"object","properties":{"sql":{"type":"string"}},"required":["sql"],"additionalProperties":false}}}],"tool_choice":"auto","parallel_tool_calls":true,"stream_options":{"include_usage":true}}';

test("a question with no image is byte-identical to what HEAD sent (Anthropic)", async () => {
  expect((await sent(ANTHROPIC)).raw).toBe(GOLDEN_ANTHROPIC);
});

test("a question with no image is byte-identical to what HEAD sent (OpenAI)", async () => {
  expect((await sent(OPENAI)).raw).toBe(GOLDEN_OPENAI);
});

test("an image-free user message stays a plain string on every OpenAI preset", async () => {
  for (const preset of PROVIDER_PRESETS) {
    const { body } = await sent({ providerId: preset.id, model: "some-model" });
    const messages = body.messages as { role: string; content: unknown }[];
    for (const message of messages) {
      if (message.role === "user") expect(typeof message.content).toBe("string");
    }
  }
});

// ── 2. one image, each wire's own shape ─────────────────────────────────────

test("Anthropic puts the base64 image block before the text block", async () => {
  const { body } = await sent(ANTHROPIC, [IMAGE]);
  const messages = body.messages as { role: string; content: unknown[] }[];
  // the tool result and the question merge into one user message, so the
  // image sits between them: still before the text it belongs to
  expect(messages[messages.length - 1].content).toEqual([
    { type: "tool_result", tool_use_id: "call_1", content: "1" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    },
    { type: "text", text: "and how many actors" },
  ]);
});

test("Anthropic sends no empty text block beside an image", async () => {
  const platform = new FakePlatform({ chunks: [] });
  await collect(
    createAnthropicProvider(ANTHROPIC, platform).chat({
      ...request("claude-sonnet-5"),
      messages: [{ role: "user", content: "", images: [IMAGE] }],
    }),
  );
  const body = JSON.parse(platform.requests[0].body ?? "") as {
    messages: { content: { type: string }[] }[];
  };
  expect(body.messages[0].content.map((b) => b.type)).toEqual(["image"]);
});

test("Anthropic's image rides the message and nothing else in the body moves", async () => {
  const plain = await sent(ANTHROPIC);
  const withImage = await sent(ANTHROPIC, [IMAGE]);
  for (const key of ["model", "max_tokens", "stream", "system", "tools"]) {
    expect(withImage.body[key]).toEqual(plain.body[key]);
  }
});

test("an OpenAI-compatible user message becomes parts, text then image_url", async () => {
  const { body } = await sent(OPENAI, [IMAGE]);
  const messages = body.messages as { role: string; content: unknown }[];
  expect(messages[messages.length - 1]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "and how many actors" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ],
  });
});

test("only the message carrying the image widens; the earlier question does not", async () => {
  const { body } = await sent(OPENAI, [IMAGE]);
  const messages = body.messages as { role: string; content: unknown }[];
  const users = messages.filter((m) => m.role === "user");
  expect(typeof users[0].content).toBe("string");
  expect(Array.isArray(users[1].content)).toBe(true);
});

test("Gemini's OpenAI-compatible endpoint takes the same data URI", async () => {
  const { body } = await sent({ providerId: "gemini", model: "gemini-3.8-flash" }, [IMAGE]);
  const messages = body.messages as { role: string; content: unknown }[];
  const last = messages[messages.length - 1].content as { type: string }[];
  expect(last.map((p) => p.type)).toEqual(["text", "image_url"]);
  expect(presetFor("gemini").baseUrl).toBe(
    "https://generativelanguage.googleapis.com/v1beta/openai/",
  );
});

test("two images keep their order and neither is dropped", async () => {
  const second: ImagePart = { mime: "image/png", b64: `${PNG_B64.slice(0, -4)}AAA=` };
  const { body } = await sent(OPENAI, [IMAGE, second]);
  const messages = body.messages as { content: { image_url?: { url: string } }[] }[];
  const parts = messages[messages.length - 1].content;
  expect(parts.filter((p) => p.image_url).map((p) => p.image_url?.url)).toEqual([
    `data:image/png;base64,${PNG_B64}`,
    `data:image/png;base64,${second.b64}`,
  ]);
});

// ── 3. the two flags ────────────────────────────────────────────────────────

test("every preset states a wire, and the two native adapters answer too", () => {
  for (const preset of PROVIDER_PRESETS) {
    expect(preset.imageWire).toBe("image_url");
    expect(imageWireFor(preset.id)).toBe("image_url");
  }
  expect(imageWireFor("anthropic")).toBe("anthropic-blocks");
  expect(imageWireFor("claude-code")).toBe("mcp-image");
  // an id this table has never seen is not a provider we send pictures to
  expect(imageWireFor("nonesuch" as never)).toBe("none");
  expect(carriesImages("nonesuch" as never)).toBe(false);
  expect(carriesImages("claude-code")).toBe(true);
});

test("the registry's vision flags are 4 true, 2 false, 11 unknown", () => {
  const count = (want: unknown) =>
    MODEL_REGISTRY.filter((m) => m.vision === want).length;
  expect([count(true), count(false), count("unknown")]).toEqual([4, 2, 11]);
  expect(visionOf("claude-opus-5", "anthropic")).toBe(true);
  expect(visionOf("gemini-3.8-flash", "gemini")).toBe(true);
  expect(visionOf("LFM2.5-2.6B-Q4_K_M", "llama-server")).toBe(false);
  expect(visionOf("grok-4.6", "xai")).toBe("unknown");
});

test("a Claude row answers for claude -p, and an unseen model is unknown", () => {
  expect(visionOf("claude-sonnet-5", "claude-code")).toBe(true);
  // a path-shaped gguf id matches its row on the file name
  expect(visionOf("/models/Qwen3-4B-Q4_K_M.gguf", "llama-server")).toBe(false);
  expect(visionOf("some-model-nobody-listed", "openai")).toBe("unknown");
});

// ── the gate the flags feed ─────────────────────────────────────────────────
//
// settings.ts paints the theme onto the document at import and persists
// through localStorage; bun has neither (canvasTools.test.ts's precedent).

const mem = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => undefined,
});
for (const [k, value] of Object.entries({
  window: globalThis,
  localStorage: storage,
  document: inert,
})) {
  if (k in globalThis) continue;
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}

const { imagesAllowed, useSettings, visionUnknown } = await import("../../../stores/settings");
const { canSeeImages } = await import("../../../stores/agent");

test("the flag decides, and the install override lifts only an unknown", () => {
  expect(imagesAllowed({}, "anthropic", "claude-opus-5")).toBe(true);
  expect(imagesAllowed({}, "openai", "gpt-5.6-sol")).toBe(false);
  expect(imagesAllowed({ "gpt-5.6-sol": true }, "openai", "gpt-5.6-sol")).toBe(true);
  // a measured no is not a question, so no switch answers it
  expect(imagesAllowed({ "Qwen3-4B-Q4_K_M": true }, "llama-server", "Qwen3-4B-Q4_K_M")).toBe(
    false,
  );
});

test("the Settings switch appears only for an unknown model", () => {
  expect(visionUnknown("openai", "gpt-5.6-sol")).toBe(true);
  expect(visionUnknown("anthropic", "claude-haiku-4-5")).toBe(false);
  expect(visionUnknown("llama-server", "LFM2.5-2.6B-Q4_K_M")).toBe(false);
  // a model the registry has never seen is exactly who the switch is for
  expect(visionUnknown("openai", "some-model-nobody-listed")).toBe(true);
});

test("canSeeImages reads the connection's own model first, then the app default", () => {
  const s = useSettings.getState();
  s.setAgentModel("openai", "gpt-5.6-sol");
  expect(canSeeImages("conn-1")).toBe(false);

  s.setAgentVision("gpt-5.6-sol", true);
  expect(canSeeImages("conn-1")).toBe(true);

  // the connection's own choice wins, and it has not been answered for
  s.setAgentConnModel("conn-1", "openai", "gpt-5.6-terra");
  expect(canSeeImages("conn-1")).toBe(false);
  expect(canSeeImages("conn-2")).toBe(true);

  s.setAgentVision("gpt-5.6-sol", false);
  s.dropAgentConn("conn-1");
  expect(canSeeImages("conn-1")).toBe(false);
  expect(useSettings.getState().agentVision).toEqual({});
});

test("an install with no model chosen at all has nothing to send an image to", () => {
  useSettings.getState().setAgentModel(null, null);
  expect(canSeeImages("conn-1")).toBe(false);
});

test("a gguf path and its file name are one answer, not two", () => {
  const s = useSettings.getState();
  s.setAgentVision("/models/vision-model-7b.gguf", true);
  expect(useSettings.getState().agentVision).toEqual({ "vision-model-7b": true });
  expect(
    imagesAllowed(useSettings.getState().agentVision, "llama-server", "vision-model-7b"),
  ).toBe(true);
  s.setAgentVision("vision-model-7b", false);
});

// 4. The ROUTE, which the wire alone cannot answer: `mcp-image` reaches the
//    model through `canvas_read` and that tool is offered only to a targeted
//    run, so the same connection carries a picture on one question and none
//    on the next. Ask's own gate, the TAGGED line and the trace all read this
//    one function, so a picture that cannot travel is never claimed to have.
test("the route knows what the wire cannot: a tool door needs a canvas", () => {
  expect(imageRouteFor("anthropic", false)).toBe("message");
  expect(imageRouteFor("openai", false)).toBe("message");
  // the `claude -p` child has no image half on stdin: the PNG comes back from
  // canvas_read, so with no canvas target there is no door at all
  expect(imageRouteFor("claude-code", true)).toBe("tool");
  expect(imageRouteFor("claude-code", false)).toBe("none");
  // and every preset agrees with the flag it publishes: a wire that carries
  // nothing has no route, and one that does has one
  for (const preset of PROVIDER_PRESETS) {
    expect(imageRouteFor(preset.id, true) === "none").toBe(!carriesImages(preset.id));
  }
});
