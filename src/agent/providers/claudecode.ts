// The Claude Code adapter (AGENT-SPEC section 7, adapter 3): `claude -p` driven
// as a child process, talking back to qwry's own streamable-HTTP MCP server.
// `ownsLoop` is true, so this provider runs the whole tool loop itself and the
// loop records what it reports without ever re-executing a call.
//
// Every flag in FLAGS below is load-bearing, all measured in W0:
//   --tools ""            without it, 26 unrelated built-ins (SendMessage,
//                         CronCreate, RemoteTrigger, Task*) are reachable by a
//                         model in an app that promises read-only SQL, and a
//                         whole turn is burned on ToolSearch.
//   --allowedTools        without it every MCP call is permission-denied and
//                         the model gives up without saying so.
//   --setting-sources ""  without it the end user's own hooks and CLAUDE.md
//                         inject context qwry never sent and cannot show in the
//                         trace (AGENT-SPEC section 8.4).
//   --strict-mcp-config   keeps the user's other MCP servers out.
//   --max-turns           works and is measured (subtype error_max_turns) but
//                         is absent from `claude --help` as of CLI 2.1.261: a
//                         CLI bump must re-verify it before trusting the cap.
// `--exclude-dynamic-system-prompt-sections` is a documented no-op next to
// `--system-prompt`, and `--bare` needs an API key this machine does not have.
//
// The failure this file exists to catch: a dead MCP server is NOT an error to
// `claude -p`. It exits 0, reports `mcp_servers[].status: "failed"` with an
// empty tool list, and the model answers from nothing. So `system/init` is a
// precondition, checked before a single token of model text is emitted.

import { isAbort } from "./http";
import type {
  AgentEvent,
  ChatRequest,
  McpEndpoint,
  Msg,
  Platform,
  Provider,
  ProviderConfig,
  ProviderErrorKind,
  StopReason,
} from "./types";
import type { TokenUsage } from "../types";

/** The MCP server name inside the generated config. The allowlist pattern is
 * built from it, so the two can never drift apart. */
export const MCP_SERVER_NAME = "qwry";
export const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
export const ALLOWED_TOOLS = `${TOOL_PREFIX}*`;
export const CLAUDE_BIN = "claude";

/** AGENT-SPEC section 4.5. `--max-turns` is enforced per invocation, not across
 * resumes (measured), so the thread-level cap is ours to carry: every call
 * passes what is left of it. */
export const THREAD_TURN_CAP = 12;

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeLine {
  type?: string;
  subtype?: string;
  mcp_servers?: { name?: string; status?: string }[];
  message?: { id?: string; content?: ContentBlock[] };
  event?: {
    type?: string;
    message?: { id?: string };
    delta?: { type?: string; text?: string; thinking?: string };
  };
  usage?: ClaudeUsage;
  is_error?: boolean;
  result?: unknown;
}

/** The inline `--mcp-config` value. `claude --help`: "Load MCP servers from
 * JSON files or strings", so no temp file is written and nothing of this
 * endpoint touches disk. The bearer token reaches the server on every request
 * of the connection (measured) and dies with the thread. */
export function mcpConfigJson(endpoint: {
  url: string;
  token: string;
}): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: endpoint.url,
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    },
  });
}

export interface SpawnOptions {
  model: string;
  mcpConfig: string;
  maxTurns: number;
  system: string;
  threadId: string;
  /** first call of a thread mints the session; every later call resumes it */
  firstCall: boolean;
}

/** The exact argv. Direct exec, never a shell, so an empty string argument is
 * an empty argument and needs no quoting. */
export function buildArgs(options: SpawnOptions): string[] {
  return [
    "-p",
    "--model",
    options.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--mcp-config",
    options.mcpConfig,
    "--tools",
    "",
    "--allowedTools",
    ALLOWED_TOOLS,
    "--setting-sources",
    "",
    "--max-turns",
    String(options.maxTurns),
    "--system-prompt",
    options.system,
    options.firstCall ? "--session-id" : "--resume",
    options.threadId,
  ];
}

/** Whether qwry's own MCP server came up in this invocation. Any status other
 * than connected, or no entry at all, is a hard failure. */
export function mcpConnected(line: ClaudeLine): boolean {
  return (line.mcp_servers ?? []).some(
    (server) =>
      server.name === MCP_SERVER_NAME && server.status === "connected",
  );
}

function bareToolName(name: string | undefined): string {
  if (!name) return "";
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

/** A tool_result's payload is a string on some turns and a block array on
 * others; the loop wants the text the model was shown, either way. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

function mapUsage(usage: ClaudeUsage | undefined): TokenUsage | null {
  if (!usage) return null;
  const out: TokenUsage = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
  if (typeof usage.cache_read_input_tokens === "number") {
    out.cacheRead = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    out.cacheWrite = usage.cache_creation_input_tokens;
  }
  return out;
}

const NOT_SIGNED_IN =
  "Claude Code is not signed in. Run claude in a terminal and sign in";
const NOT_INSTALLED =
  "the claude command was not found. Install Claude Code to use this provider";

/** Map a failing `result` event, whose text the CLI writes for a human, onto
 * the error vocabulary the UI speaks (AGENT-UX 7). */
export function resultError(result: unknown): {
  kind: ProviderErrorKind;
  message: string;
} {
  const text = typeof result === "string" ? result.trim() : "";
  if (/not logged in|\/login/i.test(text)) {
    return { kind: "auth", message: NOT_SIGNED_IN };
  }
  return {
    kind: "provider",
    message: text === "" ? "Claude Code ended without an answer" : text,
  };
}

/** Map a non-zero exit, or a zero exit that produced no result, onto the same
 * vocabulary. `stderrTail` is the child's own words: shown, never invented. */
export function exitError(exit: {
  code: number | null;
  stderrTail: string;
}): { kind: ProviderErrorKind; message: string } {
  const tail = exit.stderrTail.trim();
  if (/not logged in|\/login/i.test(tail)) {
    return { kind: "auth", message: NOT_SIGNED_IN };
  }
  if (/enoent|command not found|no such file/i.test(tail)) {
    return { kind: "unreachable", message: NOT_INSTALLED };
  }
  const lastLine = tail.split("\n").filter(Boolean).pop();
  if (lastLine) return { kind: "provider", message: lastLine };
  return {
    kind: "provider",
    message:
      exit.code === null
        ? "Claude Code stopped before it answered"
        : `Claude Code exited with code ${exit.code}`,
  };
}

function lastUserMessage(messages: readonly Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") return msg.content;
  }
  return "";
}

class ClaudeCodeProvider implements Provider {
  readonly id = "claude-code" as const;
  readonly ownsLoop = true;

  constructor(
    private readonly config: ProviderConfig,
    private readonly platform: Platform,
  ) {}

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const thread = req.thread;
    if (!thread) {
      yield {
        error: {
          kind: "provider",
          message: "Claude Code needs a thread to resume. Start a new question",
        },
      };
      yield { done: { stopReason: "error" } };
      return;
    }
    if (thread.turnsRemaining <= 0) {
      yield {
        error: {
          kind: "provider",
          message: `this thread has used its ${THREAD_TURN_CAP} turns. Start a new question`,
        },
      };
      yield { done: { stopReason: "error" } };
      return;
    }

    let endpoint: McpEndpoint;
    try {
      endpoint = await this.platform.mcpServer(thread.id);
    } catch (err) {
      if (isAbort(err, req.signal)) {
        yield { done: { stopReason: "cancelled" } };
        return;
      }
      yield {
        error: {
          kind: "provider",
          message:
            err instanceof Error ? err.message : "agent tools did not start",
        },
      };
      yield { done: { stopReason: "error" } };
      return;
    }

    // our own handle on the child: an MCP server that did not connect has to be
    // killed by this adapter, which cannot abort the caller's signal
    const control = new AbortController();
    const onAbort = () => control.abort();
    if (req.signal.aborted) control.abort();
    else req.signal.addEventListener("abort", onAbort, { once: true });
    let settled = false;

    try {
      const args = buildArgs({
        model: req.model || this.config.model,
        mcpConfig: mcpConfigJson(endpoint),
        maxTurns: Math.min(THREAD_TURN_CAP, thread.turnsRemaining),
        system: req.system,
        threadId: thread.id,
        firstCall: thread.firstCall,
      });
      const child = this.platform.spawn(
        CLAUDE_BIN,
        args,
        lastUserMessage(req.messages),
        control.signal,
      );

      const toolNames = new Map<string, string>();
      const streamed = new Set<string>();
      let streamingId = "";
      let sawResult = false;
      let failed = false;
      let stopReason: StopReason = "stop";

      for await (const raw of child.lines) {
        let line: ClaudeLine;
        try {
          line = JSON.parse(raw) as ClaudeLine;
        } catch {
          // the CLI writes only JSON on stdout; anything else is not ours
          continue;
        }

        if (line.type === "system") {
          if (line.subtype !== "init") continue;
          if (!mcpConnected(line)) {
            control.abort();
            yield {
              error: { kind: "provider", message: "agent tools did not connect" },
            };
            failed = true;
            break;
          }
          continue;
        }

        if (line.type === "stream_event") {
          const inner = line.event;
          if (inner?.type === "message_start") {
            streamingId = inner.message?.id ?? "";
          } else if (inner?.type === "content_block_delta") {
            const delta = inner.delta;
            if (delta?.type === "text_delta" && delta.text) {
              if (streamingId) streamed.add(streamingId);
              yield { text: delta.text };
            } else if (delta?.type === "thinking_delta" && delta.thinking) {
              if (streamingId) streamed.add(streamingId);
              yield { thinking: delta.thinking };
            }
          }
          continue;
        }

        if (line.type === "assistant") {
          const id = line.message?.id ?? "";
          const alreadyStreamed = id !== "" && streamed.has(id);
          for (const block of line.message?.content ?? []) {
            if (block.type === "text") {
              if (!alreadyStreamed && block.text) yield { text: block.text };
            } else if (block.type === "thinking") {
              if (!alreadyStreamed && block.thinking) {
                yield { thinking: block.thinking };
              }
            } else if (block.type === "tool_use") {
              const name = bareToolName(block.name);
              const callId = block.id ?? "";
              toolNames.set(callId, name);
              yield {
                toolCall: {
                  id: callId,
                  name,
                  args: JSON.stringify(block.input ?? {}),
                },
              };
            }
          }
          continue;
        }

        if (line.type === "user") {
          for (const block of line.message?.content ?? []) {
            if (block.type !== "tool_result") continue;
            const callId = block.tool_use_id ?? "";
            yield {
              toolResult: {
                id: callId,
                name: toolNames.get(callId) ?? "",
                result: resultText(block.content),
                ...(block.is_error ? { isError: true } : {}),
              },
            };
          }
          continue;
        }

        if (line.type === "result") {
          sawResult = true;
          const usage = mapUsage(line.usage);
          if (usage) yield { usage };
          if (line.subtype === "error_max_turns") {
            stopReason = "turnCap";
          } else if (line.is_error === true) {
            yield { error: resultError(line.result) };
            failed = true;
          }
          continue;
        }
      }

      const exit = await child.exit.catch(() => ({
        code: null as number | null,
        stderrTail: "",
      }));
      settled = true;

      if (req.signal.aborted) {
        yield { done: { stopReason: "cancelled" } };
        return;
      }
      if (!failed && !sawResult) {
        // no result event: either the child never started (not installed, not
        // signed in) or it died mid-turn. Either way its stderr is the truth
        yield { error: exitError(exit) };
        yield { done: { stopReason: "error" } };
        return;
      }
      yield { done: { stopReason: failed ? "error" : stopReason } };
    } catch (err) {
      if (isAbort(err, req.signal)) {
        yield { done: { stopReason: "cancelled" } };
        return;
      }
      yield {
        error: {
          kind: "provider",
          message: err instanceof Error ? err.message : String(err),
        },
      };
      yield { done: { stopReason: "error" } };
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      // a consumer that walked away from the stream leaves a live child behind
      if (!settled) control.abort();
      await endpoint.close().catch(() => undefined);
    }
  }
}

export function createClaudeCodeProvider(
  config: ProviderConfig,
  platform: Platform,
): Provider {
  return new ClaudeCodeProvider(config, platform);
}
