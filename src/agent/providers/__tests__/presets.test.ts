import { expect, test } from "bun:test";

import { joinUrl } from "../http";
import {
  LOCAL_PRESETS,
  MISTRAL_TOOL_ID_PATTERN,
  PROVIDER_PRESETS,
  START_HINTS,
  isPresetId,
  presetFor,
  toolCallIdPattern,
} from "../presets";
import { createProvider } from "../index";
import { FakePlatform } from "./harness";

test("every preset in the W0 matrix has a row, with unique ids", () => {
  expect(PROVIDER_PRESETS).toHaveLength(13);
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(isPresetId(id)).toBe(true);
  expect(isPresetId("anthropic")).toBe(false);
});

test("local runtimes send no key, hosted ones send a bearer", () => {
  for (const preset of PROVIDER_PRESETS) {
    const expected = LOCAL_PRESETS.has(preset.id) ? "none" : "bearer";
    expect(preset.authHeader).toBe(expected);
  }
});

test("every local runtime can tell the user how to start it", () => {
  for (const id of LOCAL_PRESETS) expect(START_HINTS[id]).toBeDefined();
});

test("Gemini keeps its documented trailing slash and still joins cleanly", () => {
  const gemini = presetFor("gemini");
  expect(gemini.baseUrl).toBe(
    "https://generativelanguage.googleapis.com/v1beta/openai/",
  );
  expect(joinUrl(gemini.baseUrl, "chat/completions")).toBe(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  expect(joinUrl(gemini.baseUrl, "/models")).toBe(
    "https://generativelanguage.googleapis.com/v1beta/openai/models",
  );
  expect(joinUrl("https://api.openai.com/v1", "chat/completions")).toBe(
    "https://api.openai.com/v1/chat/completions",
  );
});

test("the tool-call id rule follows the model through a router", () => {
  expect(toolCallIdPattern(presetFor("mistral"), "mistral-large-3")).toBe(
    MISTRAL_TOOL_ID_PATTERN,
  );
  expect(
    toolCallIdPattern(presetFor("openrouter"), "mistralai/Mistral-Large-3"),
  ).toBe(MISTRAL_TOOL_ID_PATTERN);
  expect(toolCallIdPattern(presetFor("together"), "MISTRALAI/Mixtral")).toBe(
    MISTRAL_TOOL_ID_PATTERN,
  );
  expect(
    toolCallIdPattern(presetFor("openrouter"), "openai/gpt-5.6-sol"),
  ).toBeUndefined();
  expect(toolCallIdPattern(presetFor("openai"), "gpt-5.6-sol")).toBeUndefined();
});

test("only xAI asks for additionalProperties to be stripped", () => {
  const strict = PROVIDER_PRESETS.filter(
    (p) => p.quirks.rejectsStrictAdditionalProperties,
  );
  expect(strict.map((p) => p.id)).toEqual(["xai"]);
});

test("presetFor refuses an id it does not know", () => {
  // the cast is the point of the test: bad data must not silently pick a host
  expect(() => presetFor("bedrock" as never)).toThrow();
});

test("createProvider picks the adapter the id names", () => {
  const platform = new FakePlatform();
  expect(
    createProvider({ providerId: "anthropic", model: "claude-opus-5" }, platform)
      .ownsLoop,
  ).toBe(false);
  expect(
    createProvider(
      { providerId: "claude-code", model: "claude-opus-5" },
      platform,
    ).ownsLoop,
  ).toBe(true);
  expect(
    createProvider({ providerId: "groq", model: "qwen/qwen3.6-27b" }, platform)
      .id,
  ).toBe("groq");
});
