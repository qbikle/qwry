// The providers package (AGENT-SPEC section 7). One entry point: give it a
// config and a Platform, get a Provider. Which wire protocol answers is a fact
// about the id, not something a caller decides.
//
//   openai.ts      the OpenAI-compatible adapter, thirteen presets
//   anthropic.ts   native /v1/messages with tool_use blocks and cache_control
//   claudecode.ts  `claude -p` over qwry's own MCP server, ownsLoop
//   presets.ts     preset rows: base URLs, auth form, measured quirks
//   registry.ts    model rows: tier, context window, sampling params
//   side.ts        one tool-less text call through the door the provider has
//   sse.ts         the shared server-sent-events parser
//   http.ts        URL joining and the transport-failure vocabulary
//
// There is deliberately no gemini.ts: Gemini is a preset of the
// OpenAI-compatible adapter (DECISIONS 2026-09-05).

import { createAnthropicProvider } from "./anthropic";
import { createClaudeCodeProvider } from "./claudecode";
import { createOpenAiProvider } from "./openai";
import type { Platform, Provider, ProviderConfig } from "./types";

/** The provider for a config. Throws on an id no adapter claims, rather than
 * defaulting: a wrong default would send a request, and a key, somewhere the
 * user never chose. */
export function createProvider(
  config: ProviderConfig,
  platform: Platform,
): Provider {
  if (config.providerId === "anthropic") {
    return createAnthropicProvider(config, platform);
  }
  if (config.providerId === "claude-code") {
    return createClaudeCodeProvider(config, platform);
  }
  return createOpenAiProvider(config, platform);
}

/** Name used by the W1 ownership map for the same function. */
export const providerFor = createProvider;

export { createAnthropicProvider } from "./anthropic";
export { createClaudeCodeProvider } from "./claudecode";
export { createOpenAiProvider, listModels, idNormalizer } from "./openai";
export type { ListedModel } from "./openai";
export {
  LOCAL_PRESETS,
  MISTRAL_TOOL_ID_PATTERN,
  PROVIDER_PRESETS,
  START_HINTS,
  USAGE_IN_STREAM,
  isPresetId,
  presetFor,
  toolCallIdPattern,
} from "./presets";
export {
  MODEL_REGISTRY,
  baseModelId,
  modelInfo,
  modelsForPreset,
  tierOf,
} from "./registry";
export type { ModelInfo, ParamSupport, Tier } from "./registry";
export { joinUrl, mapProviderError } from "./http";
export { sideText } from "./side";
export { parseSse } from "./sse";
export type { SseFrame } from "./sse";
export * from "./types";
