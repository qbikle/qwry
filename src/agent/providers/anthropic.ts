// The Anthropic adapter (AGENT-SPEC section 7, adapter 2): native `tool_use`
// and `tool_result` blocks over /v1/messages, streamed.
//
// What this file has to get right, from the W0 report:
//   - Tool input streams as `input_json_delta.partial_json`, a PARTIAL JSON
//     STRING per index, not a partial object. Accumulate the string and hand
//     the raw text to the loop, which owns the parse and the parse error.
//   - `cache_control: {type: "ephemeral"}` goes on the system text block and on
//     the LAST tool. The hierarchy is tools then system then messages, so the
//     tools array must stay byte-identical between requests of a thread or the
//     whole prefix misses. A miss is silent: it shows up only as
//     `cache_creation_input_tokens`, never as an error.
//   - All tool results of one parallel turn go in ONE user message, in the
//     order their calls were made.
//   - `thinking_delta` is thinking, `text_delta` is the answer. The signature
//     that trails a thinking block is not text and is dropped.

import { joinUrl, isAbort, mapProviderError } from "./http";
import { modelInfo } from "./registry";
import { parseSse } from "./sse";
import type {
  AgentEvent,
  ChatRequest,
  Msg,
  Platform,
  Provider,
  ProviderConfig,
  ProviderErrorKind,
  StopReason,
  ToolSchema,
} from "./types";
import type { TokenUsage } from "../types";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** The Messages API version. Sent by the adapter because the adapter is what
 * knows which wire shapes it was written against; the platform adds only the
 * key (AGENT-SPEC section 8.3). */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Output cap for one turn. The answers this loop asks for are one SQL block
 * plus a short explanation, so this is a runaway guard, not a budget. */
export const MAX_TOKENS = 8000;

const CACHE_CONTROL = { type: "ephemeral" as const };

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface WireMessage {
  role: "user" | "assistant";
  content: Block[];
}

interface StreamEvent {
  type?: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** Tool arguments as the model wrote them, parsed for the wire. Anthropic
 * demands an object for `input`; history that cannot be parsed came from a
 * turn the model itself got wrong, and replaying it as `{}` keeps the
 * conversation well-formed rather than failing the whole request. */
function toolInput(args: string): unknown {
  const text = args.trim();
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Provider-neutral history to Anthropic messages. Consecutive messages of the
 * same role are merged: the API requires the roles to alternate, and a tool
 * turn followed by a user turn is otherwise two user messages in a row. */
export function renderMessages(messages: readonly Msg[]): {
  messages: WireMessage[];
  extraSystem: string[];
} {
  const out: WireMessage[] = [];
  const extraSystem: string[] = [];
  const push = (role: WireMessage["role"], content: Block[]) => {
    if (content.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      extraSystem.push(msg.content);
    } else if (msg.role === "user") {
      push("user", [{ type: "text", text: msg.content }]);
    } else if (msg.role === "assistant") {
      const blocks: Block[] = [];
      if (msg.content !== "") blocks.push({ type: "text", text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: toolInput(call.args),
        });
      }
      push("assistant", blocks);
    } else {
      push(
        "user",
        msg.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.id,
          content: result.result,
          ...(result.isError ? { is_error: true } : {}),
        })),
      );
    }
  }
  return { messages: out, extraSystem };
}

/** Tools in Anthropic shape, with the cache breakpoint on the last one so the
 * whole tools block is one cached prefix. */
export function renderTools(tools: readonly ToolSchema[]) {
  return tools.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(i === tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
  }));
}

function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") return "toolCalls";
  // the docs group context-window overflow with max_tokens as a truncation:
  // both mean the answer is incomplete, never a normal stop
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "maxTokens";
  return "stop";
}

function mapErrorType(type: string | undefined): ProviderErrorKind {
  if (type === "authentication_error" || type === "permission_error") {
    return "auth";
  }
  if (type === "rate_limit_error") return "rate";
  return "provider";
}

class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  readonly ownsLoop = false;

  constructor(
    private readonly config: ProviderConfig,
    private readonly platform: Platform,
  ) {}

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const base = this.config.baseUrl?.trim() || ANTHROPIC_BASE_URL;
    const { messages, extraSystem } = renderMessages(req.messages);
    const systemText = [req.system, ...extraSystem]
      .filter((part) => part.trim() !== "")
      .join("\n\n");

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages,
    };
    if (systemText !== "") {
      // the frozen prefix: prompt.ts text is byte-stable across a thread, which
      // is the whole reason this block is worth a cache breakpoint
      body.system = [
        { type: "text", text: systemText, cache_control: CACHE_CONTROL },
      ];
    }
    // No temperature or top_p: the loop asks for none, and the 5-family rejects
    // any non-default value outright (registry samplingParams, DECISIONS
    // 2026-09-05). `rejected` means omit the field, never send a default.
    const known = modelInfo(req.model, "anthropic");
    if (req.tools.length > 0) {
      body.tools = renderTools(req.tools);
      // parallel is the default and section 4.3 wants it; only a model the
      // registry knows cannot do it gets the opt-out
      if (known && !known.parallelTools) {
        body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
      }
    }

    const usage: TokenUsage = { input: 0, output: 0 };
    let sawUsage = false;
    const open = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: StopReason = "stop";
    let failed = false;

    try {
      const chunks = this.platform.httpStream({
        providerId: "anthropic",
        url: joinUrl(base, "v1/messages"),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });

      for await (const frame of parseSse(chunks)) {
        let event: StreamEvent;
        try {
          event = JSON.parse(frame.data) as StreamEvent;
        } catch {
          continue;
        }
        const type = event.type ?? frame.event ?? "";
        if (type === "ping") continue;

        if (type === "error") {
          yield {
            error: {
              kind: mapErrorType(event.error?.type),
              message: event.error?.message ?? "Anthropic reported an error",
            },
          };
          failed = true;
          break;
        }

        if (type === "message_start") {
          const reported = event.message?.usage;
          if (reported) {
            sawUsage = true;
            usage.input = reported.input_tokens ?? 0;
            usage.output = reported.output_tokens ?? 0;
            if (typeof reported.cache_read_input_tokens === "number") {
              usage.cacheRead = reported.cache_read_input_tokens;
            }
            if (typeof reported.cache_creation_input_tokens === "number") {
              usage.cacheWrite = reported.cache_creation_input_tokens;
            }
          }
          continue;
        }

        if (type === "content_block_start") {
          if (event.content_block?.type === "tool_use") {
            open.set(event.index ?? 0, {
              id: event.content_block.id ?? "",
              name: event.content_block.name ?? "",
              args: "",
            });
          }
          continue;
        }

        if (type === "content_block_delta") {
          const delta = event.delta ?? {};
          if (delta.type === "text_delta" && delta.text) {
            yield { text: delta.text };
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            yield { thinking: delta.thinking };
          } else if (delta.type === "input_json_delta") {
            const call = open.get(event.index ?? 0);
            if (call && typeof delta.partial_json === "string") {
              call.args += delta.partial_json;
            }
          }
          continue;
        }

        if (type === "content_block_stop") {
          const index = event.index ?? 0;
          const call = open.get(index);
          if (call) {
            open.delete(index);
            yield {
              toolCall: {
                id: call.id,
                name: call.name,
                args: call.args === "" ? "{}" : call.args,
              },
            };
          }
          continue;
        }

        if (type === "message_delta") {
          stopReason = mapStopReason(event.delta?.stop_reason);
          if (typeof event.usage?.output_tokens === "number") {
            sawUsage = true;
            usage.output = event.usage.output_tokens;
          }
          continue;
        }

        if (type === "message_stop") break;
      }
      // a stream cut short still owes the calls it had already opened
      for (const [index, call] of [...open.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        open.delete(index);
        yield {
          toolCall: {
            id: call.id,
            name: call.name,
            args: call.args === "" ? "{}" : call.args,
          },
        };
      }
    } catch (err) {
      if (isAbort(err, req.signal)) {
        yield { done: { stopReason: "cancelled" } };
        return;
      }
      yield {
        error: mapProviderError(err, { label: "Anthropic", url: base }),
      };
      yield { done: { stopReason: "error" } };
      return;
    }

    if (sawUsage) yield { usage };
    yield { done: { stopReason: failed ? "error" : stopReason } };
  }
}

export function createAnthropicProvider(
  config: ProviderConfig,
  platform: Platform,
): Provider {
  return new AnthropicProvider(config, platform);
}
