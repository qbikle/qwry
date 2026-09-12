// The OpenAI-compatible adapter (AGENT-SPEC section 7, adapter 1). ONE adapter
// for thirteen providers: OpenAI, OpenRouter, llama.cpp, vLLM, Ollama, LM
// Studio, Groq, Mistral, Together, Fireworks, DeepSeek, xAI and Gemini. Every
// difference between them is a field of the preset row, never a branch on an
// id here (presets.ts).
//
// Three streaming facts this file is built around, all measured in W0:
//   1. `tool_calls` deltas are keyed by `index`. `id`, `type` and
//      `function.name` arrive only on the FIRST chunk of an index; every later
//      chunk carries a fragment of `function.arguments` to append. The
//      concatenation is the model's raw JSON, untrusted, parsed by the loop.
//   2. Local runtimes stream reasoning text in a non-standard delta field
//      (llama.cpp: `reasoning_content`, ~40 chunks before the tool call). It is
//      thinking, never answer text: routing it to `{ text }` would put the
//      model's private deliberation in the answer.
//   3. The tool-call id is whatever the server says it is (a 32-character
//      random string on llama.cpp, `call_…` on OpenAI). Echo it back verbatim,
//      except where the provider constrains the ids WE emit (Mistral).

import { joinUrl, isAbort, mapProviderError } from "./http";
import {
  LOCAL_PRESETS,
  START_HINTS,
  USAGE_IN_STREAM,
  isPresetId,
  presetFor,
  toolCallIdPattern,
} from "./presets";
import { modelInfo, tierOf } from "./registry";
import type { Tier } from "./registry";
import { parseSse } from "./sse";
import type {
  AgentEvent,
  ChatRequest,
  ImageWire,
  Msg,
  Platform,
  Provider,
  ProviderConfig,
  ProviderPreset,
  StopReason,
  ToolCall,
  ToolSchema,
} from "./types";
import type { TokenUsage } from "../types";

/** The pieces of a `chat.completions.chunk` this adapter reads. Fields we do
 * not use (created, model, system_fingerprint, timings) are left undeclared
 * rather than typed and ignored. */
interface CompletionChunk {
  choices?: {
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
      [field: string]: unknown;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: unknown;
}

/** The content parts of a user message. A user message is a plain string
 * until an image rides with it: widening it always would change every request
 * this adapter has ever sent, for thirteen providers, to buy nothing. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Deterministic alphanumeric id of `length` characters derived from `seed`.
 * Deterministic on purpose: the same original id normalises the same way in
 * every turn of a thread, so a tool_result still points at its tool_call even
 * across a reconnect. */
function derivedId(seed: string, length: number): string {
  let hash = 0x811c9dc5;
  let out = "";
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < seed.length; c++) {
      hash ^= seed.charCodeAt(c) + i;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += ID_ALPHABET[hash % ID_ALPHABET.length];
  }
  return out;
}

/** Rewrites the tool-call ids this adapter SENDS so a strict provider accepts
 * them, and remembers the mapping so the matching tool_result carries the same
 * rewritten id. Ids we RECEIVE are never rewritten: the trace shows what the
 * provider actually said.
 *
 * With no pattern the identity function is returned, which is the case for
 * every provider except Mistral and the routers in front of a Mistral model. */
export function idNormalizer(
  pattern: string | undefined,
): (id: string) => string {
  if (!pattern) return (id) => id;
  const re = new RegExp(pattern);
  const length = Number(/\{(\d+)\}/.exec(pattern)?.[1] ?? 9);
  const seen = new Map<string, string>();
  const used = new Set<string>();
  return (id: string): string => {
    const known = seen.get(id);
    if (known) return known;
    if (re.test(id)) {
      seen.set(id, id);
      used.add(id);
      return id;
    }
    let candidate = derivedId(id, length);
    for (let salt = 1; used.has(candidate); salt++) {
      candidate = derivedId(`${id}#${salt}`, length);
    }
    seen.set(id, candidate);
    used.add(candidate);
    return candidate;
  };
}

/** Remove `additionalProperties` at every level of a JSON Schema. xAI 400s on
 * `additionalProperties: false`, and since we never send `strict: true` no
 * provider needs the keyword, so dropping it costs nothing. */
function stripAdditionalProperties(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripAdditionalProperties);
  if (typeof schema === "object" && schema !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "additionalProperties") continue;
      out[key] = stripAdditionalProperties(value);
    }
    return out;
  }
  return schema;
}

function renderTools(tools: readonly ToolSchema[], preset: ProviderPreset) {
  const strip = preset.quirks.rejectsStrictAdditionalProperties === true;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      // no `strict: true`: our schemas make no strict-mode promise, and asking
      // for one is what drags additionalProperties into the request
      parameters: (strip
        ? stripAdditionalProperties(tool.parameters)
        : tool.parameters) as Record<string, unknown>,
    },
  }));
}

/** A user message's content: the plain string, or the parts array when the
 * question carries an image this wire can hold. Text part first, then the
 * image, which is the order OpenAI's own guide and Google's OpenAI-compatible
 * example both write. A preset whose wire carries nothing keeps the string and
 * the image never leaves the app: the door it would have gone through is shut
 * further up, where `Ask` on a drawing is only offered to a model flagged as
 * reading one. */
function userContent(
  msg: Extract<Msg, { role: "user" }>,
  wire: ImageWire,
): string | ContentPart[] {
  const images = wire === "image_url" ? msg.images ?? [] : [];
  if (images.length === 0) return msg.content;
  const parts: ContentPart[] = msg.content === "" ? [] : [{ type: "text", text: msg.content }];
  for (const image of images) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${image.b64}` },
    });
  }
  return parts;
}

/** Provider-neutral history to OpenAI wire shape. One `tool` message per
 * result: the neutral `Msg` keeps all results of a parallel turn together, but
 * this wire format wants them separate, each pointing at its own call id. */
function renderMessages(
  system: string,
  messages: readonly Msg[],
  normalize: (id: string) => string,
  wire: ImageWire,
): WireMessage[] {
  const out: WireMessage[] = [];
  if (system.trim() !== "") out.push({ role: "system", content: system });
  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: msg.content });
    } else if (msg.role === "user") {
      out.push({ role: "user", content: userContent(msg, wire) });
    } else if (msg.role === "assistant") {
      const calls = msg.toolCalls ?? [];
      out.push({
        role: "assistant",
        content: msg.content === "" ? null : msg.content,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((call) => ({
                id: normalize(call.id),
                type: "function" as const,
                function: { name: call.name, arguments: call.args },
              })),
            }),
      });
    } else {
      for (const result of msg.results) {
        out.push({
          role: "tool",
          tool_call_id: normalize(result.id),
          content: result.result,
        });
      }
    }
  }
  return out;
}

function mapStopReason(finish: string): StopReason {
  if (finish === "tool_calls" || finish === "function_call") return "toolCalls";
  if (finish === "length" || finish === "max_tokens") return "maxTokens";
  // a moderation cut is an incomplete answer too; thirteen presets share this
  // adapter, so a silent "stop" here would read as a finished answer on all of them
  if (finish === "content_filter") return "maxTokens";
  return "stop";
}

function mapUsage(usage: NonNullable<CompletionChunk["usage"]>): TokenUsage {
  const out: TokenUsage = {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") out.cacheRead = cached;
  return out;
}

/** Reasoning delta field names, in the order they are read. The preset states
 * the one its runtime uses; the two conventional names cover routers that pass
 * a reasoning model through without saying so. */
function reasoningFields(preset: ProviderPreset): string[] {
  const declared = preset.quirks.reasoningDeltaField;
  const fields = ["reasoning_content", "reasoning"];
  if (declared && !fields.includes(declared)) fields.unshift(declared);
  return fields;
}

function baseUrlFor(config: ProviderConfig, preset: ProviderPreset): string {
  const chosen = config.baseUrl?.trim();
  return chosen && chosen !== "" ? chosen : preset.baseUrl;
}

class OpenAiProvider implements Provider {
  readonly ownsLoop = false;

  constructor(
    readonly id: ProviderConfig["providerId"],
    private readonly preset: ProviderPreset,
    private readonly config: ProviderConfig,
    private readonly platform: Platform,
  ) {}

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const base = baseUrlFor(this.config, this.preset);
    // the turn names its model; the config's is the fallback for a caller that
    // only ever picks one
    const model = req.model || this.config.model;
    const normalize = idNormalizer(toolCallIdPattern(this.preset, model));
    const known = modelInfo(model, this.preset.id);
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: renderMessages(req.system, req.messages, normalize, this.preset.imageWire),
    };
    if (req.tools.length > 0) {
      body.tools = renderTools(req.tools, this.preset);
      body.tool_choice = "auto";
      // only where the preset itself documents the flag: a router that passes
      // it through to a model that does not know it turns a turn into a 400
      if (this.preset.parallelToolCalls === "supported") {
        body.parallel_tool_calls = known?.parallelTools !== false;
      }
    }
    if (USAGE_IN_STREAM.has(this.preset.id)) {
      body.stream_options = { include_usage: true };
    }

    const pending = new Map<number, ToolCall>();
    const emitted = new Set<number>();
    const drain = (below: number | null): ToolCall[] => {
      const ready = [...pending.entries()]
        .filter(([index]) => below === null || index < below)
        .sort((a, b) => a[0] - b[0]);
      const calls: ToolCall[] = [];
      for (const [index, call] of ready) {
        pending.delete(index);
        emitted.add(index);
        calls.push({
          id: call.id === "" ? `call_${index}` : call.id,
          name: call.name,
          args: call.args,
        });
      }
      return calls;
    };

    const fields = reasoningFields(this.preset);
    let stopReason: StopReason = "stop";
    let failed = false;

    try {
      const chunks = this.platform.httpStream({
        providerId: this.config.providerId,
        url: joinUrl(base, "chat/completions"),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.preset.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });

      for await (const frame of parseSse(chunks)) {
        if (frame.data === "[DONE]") break;
        let chunk: CompletionChunk;
        try {
          chunk = JSON.parse(frame.data) as CompletionChunk;
        } catch {
          // a keep-alive or a heartbeat that is not JSON: nothing to report
          continue;
        }
        if (chunk.error) {
          yield {
            error: {
              kind: "provider",
              message: errorText(chunk.error, this.preset.label),
            },
          };
          failed = true;
          break;
        }
        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta ?? {};
          for (const field of fields) {
            const value = delta[field];
            if (typeof value === "string" && value !== "") {
              yield { thinking: value };
            }
          }
          if (typeof delta.content === "string" && delta.content !== "") {
            yield { text: delta.content };
          }
          for (const part of delta.tool_calls ?? []) {
            const index = typeof part.index === "number" ? part.index : 0;
            const open = pending.get(index);
            if (!open) {
              // a chunk for an index already emitted can only come from a
              // provider that interleaves indices, which none of the thirteen
              // does. Dropping it beats inventing a second, nameless call
              if (emitted.has(index)) continue;
              // a new index opening means every lower index is complete
              for (const call of drain(index)) yield { toolCall: call };
              pending.set(index, {
                id: part.id ?? "",
                name: part.function?.name ?? "",
                args: part.function?.arguments ?? "",
              });
              continue;
            }
            if (part.id) open.id = part.id;
            if (part.function?.name) open.name = part.function.name;
            if (typeof part.function?.arguments === "string") {
              open.args += part.function.arguments;
            }
          }
          if (choice.finish_reason) {
            for (const call of drain(null)) yield { toolCall: call };
            stopReason = mapStopReason(choice.finish_reason);
          }
        }
        if (chunk.usage) yield { usage: mapUsage(chunk.usage) };
      }
      // a stream that ended without a finish_reason still owes its calls
      for (const call of drain(null)) yield { toolCall: call };
    } catch (err) {
      if (isAbort(err, req.signal)) {
        yield { done: { stopReason: "cancelled" } };
        return;
      }
      yield {
        error: mapProviderError(err, {
          label: this.preset.label,
          url: base,
          startHint: LOCAL_PRESETS.has(this.preset.id)
            ? START_HINTS[this.preset.id]
            : undefined,
        }),
      };
      yield { done: { stopReason: "error" } };
      return;
    }

    yield { done: { stopReason: failed ? "error" : stopReason } };
  }
}

function errorText(error: unknown, label: string): string {
  if (typeof error === "string" && error.trim() !== "") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return `${label} reported an error`;
}

/** One row of a live `/models` answer, already carrying the facts a raw id
 * cannot: the tier that gates the pipeline, and whether the registry has ever
 * heard of the model (AGENT-SPEC section 3). */
export interface ListedModel {
  id: string;
  label: string;
  tier: Tier;
  known: boolean;
}

/** Models the provider itself reports. The picker calls this FIRST and falls
 * back to the registry: a hand-typed id is a guess, and `claude-haiku-4.5`
 * looked exactly as right as the real `claude-haiku-4-5`.
 *
 * llama.cpp and Ollama answer with the model's file path, so the label is
 * derived from the file name; everything else labels itself. */
export async function listModels(
  platform: Platform,
  preset: ProviderPreset,
  baseUrl?: string,
): Promise<ListedModel[]> {
  if (!preset.listsModels) return [];
  const base = baseUrl?.trim() || preset.baseUrl;
  let text = "";
  for await (const chunk of platform.httpStream({
    providerId: preset.id,
    url: joinUrl(base, "models"),
    method: "GET",
    headers: { Accept: "application/json" },
  })) {
    text += chunk;
  }
  const parsed: unknown = JSON.parse(text);
  const rows = modelRows(parsed);
  return rows.map((id) => {
    const found = modelInfo(id, preset.id);
    const { tier, known } = tierOf(id, preset.id);
    return { id, label: found?.label ?? labelFor(id), tier, known };
  });
}

function modelRows(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as { data?: unknown; models?: unknown };
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const ids: string[] = [];
  for (const row of list) {
    if (typeof row === "string") {
      ids.push(row);
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const id = (row as { id?: unknown; name?: unknown }).id;
    const name = (row as { name?: unknown }).name;
    if (typeof id === "string") ids.push(id);
    else if (typeof name === "string") ids.push(name);
  }
  return [...new Set(ids)];
}

/** A readable name for a path-shaped id. Fireworks ids are
 * `accounts/fireworks/models/<name>`; llama.cpp ids are absolute gguf paths. */
function labelFor(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/\.gguf$/i, "");
}

export function createOpenAiProvider(
  config: ProviderConfig,
  platform: Platform,
): Provider {
  if (!isPresetId(config.providerId)) {
    throw new Error(`not an OpenAI-compatible preset: ${config.providerId}`);
  }
  return new OpenAiProvider(
    config.providerId,
    presetFor(config.providerId),
    config,
    platform,
  );
}
