// Model registry (AGENT-SPEC section 3). Tier is a measured statement about
// LOOP RELIABILITY, not about parameter count or RAM: a hosted 8B model is
// "mid", and only a small local model that cannot survive a multi-turn tool
// loop is "small" (W0 provider matrix, section 4).
//
// Every hand-typed model id is `verified: false` until a live /models call
// confirms it. The failure class this exists for is real: `claude-haiku-4.5`
// looks right and does not exist, the id is `claude-haiku-4-5`. The picker
// prefers a live model list over this table; this table supplies the facts a
// list cannot (tier, sampling params, cache minimum).

import type { PresetId, ProviderId } from "./types";

export type Tier = "small" | "mid" | "large";

/** Whether a sampling parameter may be sent at all. The Claude 5 family 400s
 * on a non-default `temperature`, `top_p` or `top_k`; Haiku 4.5 accepts them
 * (W0 registry facts). This is per model, never per provider. */
export type ParamSupport = "supported" | "rejected";

export interface ModelInfo {
  /** the provider's own id string, verbatim, including path-shaped ids */
  id: string;
  /** which preset or native adapter reaches it */
  presetId: ProviderId;
  label: string;
  tier: Tier;
  /** tokens; 0 = unknown, ask the provider at connect time */
  contextWindow: number;
  parallelTools: boolean;
  samplingParams: { temperature: ParamSupport; topP: ParamSupport };
  /** Anthropic's minimum cacheable prefix for this model. Non-monotonic
   * across the family and a miss is SILENT (check cache_creation_input_tokens),
   * so it belongs to the model, not the provider. */
  cacheMinTokens?: number;
  /** a live /models call has confirmed this id exists */
  verified: boolean;
}

/** Seeded from the W0 report. Anthropic's three are the only verified rows:
 * each was accepted by a real `claude -p` invocation. Everything else is
 * hand-typed from documentation and stays unverified until proven. */
export const MODEL_REGISTRY: readonly ModelInfo[] = [
  {
    id: "claude-haiku-4-5",
    presetId: "anthropic",
    label: "Claude Haiku 4.5",
    tier: "mid",
    contextWindow: 200_000,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    cacheMinTokens: 4096,
    verified: true,
  },
  {
    id: "claude-sonnet-5",
    presetId: "anthropic",
    label: "Claude Sonnet 5",
    tier: "large",
    contextWindow: 200_000,
    parallelTools: true,
    samplingParams: { temperature: "rejected", topP: "rejected" },
    cacheMinTokens: 1024,
    verified: true,
  },
  {
    id: "claude-opus-5",
    presetId: "anthropic",
    label: "Claude Opus 5",
    tier: "large",
    contextWindow: 200_000,
    parallelTools: true,
    samplingParams: { temperature: "rejected", topP: "rejected" },
    cacheMinTokens: 512,
    verified: true,
  },

  {
    id: "gpt-5.6-terra",
    presetId: "openai",
    label: "GPT-5.6 Terra",
    tier: "mid",
    contextWindow: 0,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "gpt-5.6-sol",
    presetId: "openai",
    label: "GPT-5.6 Sol",
    tier: "large",
    contextWindow: 1_050_000,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "gemini-3.8-flash",
    presetId: "gemini",
    label: "Gemini 3.8 Flash",
    tier: "mid",
    contextWindow: 1_048_576,
    parallelTools: false,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "gemini-3.1-pro",
    presetId: "gemini",
    label: "Gemini 3.1 Pro",
    tier: "large",
    contextWindow: 1_000_000,
    parallelTools: false,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "deepseek-v4-flash",
    presetId: "deepseek",
    label: "DeepSeek V4 Flash",
    tier: "mid",
    contextWindow: 1_000_000,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "deepseek-v4-pro",
    presetId: "deepseek",
    // reasoning mode drops tool calls silently; the picker must say so
    label: "DeepSeek V4 Pro (tools unreliable)",
    tier: "large",
    contextWindow: 1_000_000,
    parallelTools: false,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "mistral-large-3",
    presetId: "mistral",
    label: "Mistral Large 3",
    tier: "large",
    contextWindow: 128_000,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "mistral-medium-3.5",
    presetId: "mistral",
    label: "Mistral Medium 3.5",
    tier: "mid",
    contextWindow: 128_000,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    // 8B and hosted: parameter count does not earn the small tier
    id: "ministral-8b",
    presetId: "mistral",
    label: "Ministral 8B",
    tier: "mid",
    contextWindow: 128_000,
    parallelTools: false,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "qwen/qwen3.6-27b",
    presetId: "groq",
    label: "Qwen3.6 27B",
    tier: "mid",
    contextWindow: 0,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "openai/gpt-oss-120b",
    presetId: "groq",
    label: "GPT-OSS 120B",
    tier: "large",
    contextWindow: 0,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "grok-4.6",
    presetId: "xai",
    label: "Grok 4.6",
    tier: "large",
    contextWindow: 0,
    parallelTools: true,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },

  // local, small tier: the one-shot pipeline (spec 4.7), never the tool loop.
  // llama-server reports ids as absolute gguf paths, so the picker derives a
  // label from the file name and matches on the file name too.
  {
    id: "LFM2.5-2.6B-Q4_K_M",
    presetId: "llama-server",
    label: "LFM2.5 2.6B (local)",
    tier: "small",
    contextWindow: 8192,
    parallelTools: false,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
  {
    id: "Qwen3-4B-Q4_K_M",
    presetId: "llama-server",
    label: "Qwen3 4B (local)",
    tier: "small",
    contextWindow: 32_768,
    parallelTools: false,
    samplingParams: { temperature: "supported", topP: "supported" },
    verified: false,
  },
];

/** Providers that speak Claude model ids, so a registry row seeded under
 * "anthropic" also answers for `claude -p` (same ids, measured in W0). */
const CLAUDE_PROVIDERS: readonly ProviderId[] = ["anthropic", "claude-code"];

const sameFamily = (a: ProviderId, b: ProviderId) =>
  a === b || (CLAUDE_PROVIDERS.includes(a) && CLAUDE_PROVIDERS.includes(b));

/** llama-server reports ids as absolute gguf paths: the registry row is keyed
 * on the file name, so `/models/LFM2.5-2.6B-Q4_K_M.gguf` matches
 * `LFM2.5-2.6B-Q4_K_M`. Returns the id unchanged when it is not path-shaped. */
export function baseModelId(modelId: string): string {
  const tail = modelId.split("/").pop() ?? modelId;
  return tail.replace(/\.gguf$/i, "");
}

/** Exact match first, then the same model reached through a sibling provider,
 * then the same two lookups on the file name of a path-shaped id. Returns
 * undefined for a model the registry has never seen. */
export function modelInfo(
  modelId: string,
  presetId: ProviderId,
): ModelInfo | undefined {
  const lookup = (id: string) =>
    MODEL_REGISTRY.find((m) => m.id === id && m.presetId === presetId) ??
    MODEL_REGISTRY.find((m) => m.id === id && sameFamily(m.presetId, presetId));
  const exact = lookup(modelId);
  if (exact) return exact;
  const base = baseModelId(modelId);
  return base !== modelId ? lookup(base) : undefined;
}

/** Tier gate for the pipeline (spec 3). An unknown model is "mid" with
 * `known: false`, and the picker says so rather than guessing quietly. */
export function tierOf(
  modelId: string,
  presetId: ProviderId,
): { tier: Tier; known: boolean } {
  const found = modelInfo(modelId, presetId);
  return found ? { tier: found.tier, known: true } : { tier: "mid", known: false };
}

/** Models the registry knows for one preset, for seeding the picker before a
 * live /models call answers. */
export function modelsForPreset(presetId: PresetId | ProviderId): ModelInfo[] {
  return MODEL_REGISTRY.filter((m) => sameFamily(m.presetId, presetId));
}
