// Provider presets for the OpenAI-compatible adapter (AGENT-SPEC section 7,
// W0 provider matrix). Every row is measured or sourced in
// qwry-agent-lab/docs/research/w0-provider-presets.md sections 1 and 5.
//
// The rule this file exists to enforce: quirks are DATA. openai.ts reads a
// preset and never branches on `preset.id`, so a new provider is a row here,
// not an `if`. Base URLs for local runtimes are defaults the user edits: a port
// is never hardcoded into behaviour.

import type { ImageRoute, ImageWire, PresetId, ProviderId, ProviderPreset } from "./types";

/** Mistral's tool-call ids must be exactly 9 alphanumerics or the API 400s
 * with `Tool call id was [id] but must be a-z, A-Z, 0-9, with a length of 9.`
 * The same constraint follows the model through a router (W0 section 1). */
export const MISTRAL_TOOL_ID_PATTERN = "^[A-Za-z0-9]{9}$";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "supported",
    imageWire: "image_url",
    quirks: {
      notes:
        "defines the wire format the rest of this table copies. We never send strict:true, so the additionalProperties rules that come with it never apply.",
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    // attribution headers OpenRouter documents; HTTP-Referer is omitted rather
    // than sent empty, since a desktop app has no site to attribute
    extraHeaders: { "X-Title": "qwry" },
    quirks: {
      notes:
        "a router: tool-call quirks are inherited from the model it routes to, so a Mistral model reached here inherits the 9-character id rule.",
    },
  },
  {
    id: "llama-server",
    label: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    authHeader: "none",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      reasoningDeltaField: "reasoning_content",
      requiresServerFlags: ["--jinja"],
      notes:
        "measured: canonical OpenAI tool-call chunking, plus ~40 reasoning_content deltas before the call. /v1/models reports ids as absolute gguf paths, so labels are derived from the file name.",
    },
  },
  {
    id: "vllm",
    label: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    authHeader: "none",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      requiresServerFlags: ["--enable-auto-tool-choice", "--tool-call-parser"],
      notes:
        "without a tool-call parser for the model family, tool calls are never parsed out of the raw text. The mistral parser also demands 9-character tool-call ids.",
    },
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    authHeader: "none",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      minVersion: "0.8.0",
      notes:
        "older installs buffer a tool call into one chunk instead of streaming it, and degrade silently rather than erroring.",
    },
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    authHeader: "none",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      notes:
        "the server is started by hand inside the LM Studio app and its port is user-changeable, so a refused connection is the normal first-run state.",
    },
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      notes:
        "the catalog rotates fast, so prefer a live /models call over the registry. groq/compound and groq/compound-mini support only built-in server tools.",
    },
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "supported",
    imageWire: "image_url",
    quirks: {
      toolCallIdPattern: MISTRAL_TOOL_ID_PATTERN,
      notes:
        "the single most-reported cross-provider breakage: any tool-call id we emit must be exactly 9 alphanumerics.",
    },
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.ai/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      notes:
        "a router over many open-weight families; quirks are inherited per underlying model, the Mistral id rule included.",
    },
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      notes:
        "model ids are full paths of the form accounts/fireworks/models/<name>, so a label has to strip the prefix.",
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      defaultModel: "deepseek-v4-flash",
      notes:
        "the reasoning model drops tool calls silently when tool_choice is set, so the non-reasoning flash id is the default tool-calling target.",
    },
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "supported",
    imageWire: "image_url",
    quirks: {
      rejectsStrictAdditionalProperties: true,
      notes:
        "400s on additionalProperties:false in a tool schema. Use /v1/chat/completions: /v1/responses returns tool calls whole rather than streamed.",
    },
  },
  {
    id: "gemini",
    label: "Gemini",
    // the trailing slash is Google's own documented base; joinUrl keeps paths
    // correct either way, and a test covers this row specifically
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    authHeader: "bearer",
    listsModels: true,
    parallelToolCalls: "per-model",
    imageWire: "image_url",
    quirks: {
      notes:
        "Google's OpenAI-compatible layer, chosen over a native functionCall adapter for v1 (DECISIONS 2026-09-05). The layer is beta and does not document parallel_tool_calls.",
    },
  },
];

const BY_ID = new Map<PresetId, ProviderPreset>(
  PROVIDER_PRESETS.map((p) => [p.id, p]),
);

export function isPresetId(id: string): id is PresetId {
  return BY_ID.has(id as PresetId);
}

/** The preset row for an id. Throws rather than returning a default: an
 * unknown preset id means the config was written by something that does not
 * share this table, and guessing a base URL would send a key somewhere
 * unintended. */
export function presetFor(id: PresetId): ProviderPreset {
  const preset = BY_ID.get(id);
  if (!preset) throw new Error(`unknown provider preset: ${id}`);
  return preset;
}

/** How an image reaches this provider, or "none" when none can. The two
 * adapters with a wire format of their own are not preset rows, so their
 * answers sit here beside the table rather than in a second one; all three
 * shapes were read from the providers' own documentation (canvas-grid-spec
 * 5.2, re-verified this wave). An id this table has never seen answers
 * "none": a provider we cannot describe is one we do not send pictures to. */
export function imageWireFor(id: ProviderId): ImageWire {
  if (id === "anthropic") return "anthropic-blocks";
  if (id === "claude-code") return "mcp-image";
  return BY_ID.get(id as PresetId)?.imageWire ?? "none";
}

/** Whether an image can reach this provider at all, by whatever route. The
 * route is not the message everywhere: `claude -p` gets the PNG as MCP image
 * content from `canvas_read`, never on a Msg, because the child runs with
 * `--tools ""` and has no file-reading door to offer instead. */
export function carriesImages(id: ProviderId): boolean {
  return imageWireFor(id) !== "none";
}

/** How a picture reaches THIS run's model: on the message, through
 * `canvas_read`, or not at all. The wire decides the first two and the run's
 * own canvas target decides whether the second exists, because the canvas
 * family is offered only to a targeted run (loop.ts `toolsFor`) — a picture
 * whose only door is a tool nobody was handed is a picture that never
 * arrives, and saying it left would be the silent drop maintainer call 3
 * forbids. ONE derivation, read by the gate that hides `Ask`, by the line the
 * model is sent and by the trace, so those three can never disagree. */
export function imageRouteFor(id: ProviderId, canvasTarget: boolean): ImageRoute {
  const wire = imageWireFor(id);
  if (wire === "image_url" || wire === "anthropic-blocks") return "message";
  if (wire === "mcp-image") return canvasTarget ? "tool" : "none";
  return "none";
}

/** Presets that document `stream_options: {include_usage: true}`. The rest
 * either ignore the field or have not documented it; the adapter tolerates a
 * stream that never carries a usage chunk either way. */
export const USAGE_IN_STREAM: ReadonlySet<PresetId> = new Set<PresetId>([
  "openai",
  "openrouter",
  "groq",
  "together",
  "fireworks",
  "deepseek",
  "xai",
  "gemini",
  "llama-server",
]);

/** Runtimes the user starts on their own machine. A refused connection here is
 * not an outage, it is a server that was never started, and the error says so
 * (AGENT-UX 7). */
export const LOCAL_PRESETS: ReadonlySet<PresetId> = new Set<PresetId>([
  "llama-server",
  "vllm",
  "ollama",
  "lmstudio",
]);

/** Second sentence of the unreachable error, per preset. Sentence case, no
 * apology (WRITING.md): the user needs the command, not regret. */
export const START_HINTS: Readonly<Partial<Record<PresetId, string>>> = {
  "llama-server": "Start it with llama-server --jinja",
  vllm: "Start it with --enable-auto-tool-choice and --tool-call-parser",
  ollama: "Start it with ollama serve",
  lmstudio: "Start the local server from the Developer tab in LM Studio",
};

/** Routers whose tool-call quirks depend on the model they route to. */
const ROUTER_PRESETS: ReadonlySet<PresetId> = new Set<PresetId>([
  "openrouter",
  "together",
  "vllm",
]);

/** The pattern outgoing tool-call ids must match, or undefined when the
 * provider accepts any id. Mistral states the rule; a router inherits it from
 * the model id, which is the only signal a router gives us (W0 section 1,
 * DECISIONS 2026-09-05). */
export function toolCallIdPattern(
  preset: ProviderPreset,
  model: string,
): string | undefined {
  if (preset.quirks.toolCallIdPattern) return preset.quirks.toolCallIdPattern;
  if (ROUTER_PRESETS.has(preset.id) && /mistral/i.test(model)) {
    return MISTRAL_TOOL_ID_PATTERN;
  }
  return undefined;
}
