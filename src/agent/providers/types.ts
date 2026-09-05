// Provider contract (AGENT-SPEC section 7) and the Platform seam (section 2.4).
//
// One adapter per wire protocol, never one per vendor: quirks are data in
// presets.ts. Adapters reach the network ONLY through Platform.httpStream and
// Platform.spawn, so no API key and no user-supplied host ever enters this
// layer. Nothing here imports Tauri or a store.

import type { TokenUsage } from "../types";

/** OpenAI-compatible presets (W0 provider matrix). Gemini is a preset of that
 * adapter, not a native one: its OpenAI-compatible endpoint is documented,
 * streams, and calls tools (DECISIONS 2026-09-05). */
export type PresetId =
  | "openai"
  | "openrouter"
  | "llama-server"
  | "vllm"
  | "ollama"
  | "lmstudio"
  | "groq"
  | "mistral"
  | "together"
  | "fireworks"
  | "deepseek"
  | "xai"
  | "gemini";

/** Every provider the picker can select: the OpenAI-compatible presets plus
 * the two adapters with their own wire format. */
export type ProviderId = PresetId | "anthropic" | "claude-code";

export type AuthHeaderForm = "bearer" | "none";

/** Whether a preset can do more than one tool call per assistant turn.
 * "per-model" means the routed model decides, so the registry has the answer,
 * not the preset. */
export type ParallelToolCalls = "supported" | "per-model" | "unsupported";

/** Preset quirks are DATA, measured or sourced in W0, never branches in the
 * adapter. Fields are optional because absent means "no known quirk", which
 * is different from a quirk measured to be false. */
export interface PresetQuirks {
  /** outgoing tool-call ids must match this pattern (Mistral: exactly 9
   * alphanumerics, direct and when routed through OpenRouter or Together) */
  toolCallIdPattern?: string;
  /** the provider 400s on `additionalProperties: false` in tool schemas (xAI):
   * the adapter strips the keyword for this preset */
  rejectsStrictAdditionalProperties?: boolean;
  /** name of the streaming delta field carrying reasoning text, when the
   * runtime emits one (llama.cpp: "reasoning_content"). It renders in the
   * thinking strip, never as answer text. */
  reasoningDeltaField?: string;
  /** server flags the user must have launched with; documentation for the
   * connection hint, not something qwry can set (llama-server: --jinja) */
  requiresServerFlags?: string[];
  /** minimum runtime version for streamed tool calls (Ollama: 0.8.0). Older
   * installs degrade silently rather than erroring. */
  minVersion?: string;
  /** which model id to offer first when the user has not chosen one */
  defaultModel?: string;
  notes?: string;
}

/** One entry of presets.ts. `baseUrl` is a default: local runtimes are
 * user-editable (a port is never hardcoded into behaviour). */
export interface ProviderPreset {
  id: PresetId;
  label: string;
  baseUrl: string;
  authHeader: AuthHeaderForm;
  /** GET {baseUrl}/models can populate the picker */
  listsModels: boolean;
  parallelToolCalls: ParallelToolCalls;
  extraHeaders?: Record<string, string>;
  quirks: PresetQuirks;
}

/** A tool as the loop hands it to an adapter. `parameters` is JSON Schema;
 * each adapter renders it into its own wire shape (OpenAI nests it under
 * `function`, Anthropic calls it `input_schema`). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** raw JSON text as the model wrote it: untrusted, parse in a try and send
   * the parse error back to the model (AGENT-SPEC section 7) */
  args: string;
}

export interface ToolResult {
  id: string;
  name: string;
  result: string;
  isError?: boolean;
}

/** Conversation history in provider-neutral form. All results of one parallel
 * turn go in ONE tool message, in the order their calls were made. */
export type Msg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export type StopReason =
  | "stop"
  | "toolCalls"
  | "maxTokens"
  /** an `ownsLoop` provider ran out of its own per-invocation turn budget
   * mid-conversation (claude -p `error_max_turns`): the exchange is cut off,
   * not merely truncated, and the loop reports a turn cap, never an answer */
  | "turnCap"
  | "cancelled"
  | "error";

/** Why a provider call failed, in the vocabulary the UI speaks (AGENT-UX 7).
 * Mirrors agent_http.rs HttpErrorKind. */
export type ProviderErrorKind =
  | "auth"
  | "rate"
  | "unreachable"
  | "provider"
  | "cancelled";

/** What a provider streams. `thinking` renders in the thinking strip and the
 * trace, never as answer text. `toolResult` arrives only from providers with
 * `ownsLoop`: the loop records it and never re-executes the call. */
export type AgentEvent =
  | { text: string }
  | { thinking: string }
  | { toolCall: ToolCall }
  | { toolResult: ToolResult }
  | { usage: TokenUsage }
  | { done: { stopReason: StopReason } }
  | {
      error: {
        kind: ProviderErrorKind;
        message: string;
        /** present when the provider states a wait (AGENT-UX 7) */
        retryAfterMs?: number;
      };
    };

/** Which provider and model a thread is talking to. `baseUrl` overrides the
 * preset default (local runtimes, gateways). Keys are NOT here: they live in
 * the Keychain and are injected by Rust (section 8.3). */
export interface ProviderConfig {
  providerId: ProviderId;
  model: string;
  baseUrl?: string;
}

/** Thread continuity for providers that own their own session (`claude -p`
 * takes `--session-id` on the first call and `--resume` afterwards). Stateless
 * adapters ignore it. `turnsRemaining` is the thread-level cap minus the turns
 * already spent: `--max-turns` is per invocation, not cumulative (W0 section 9). */
export interface ThreadRef {
  id: string;
  firstCall: boolean;
  turnsRemaining: number;
}

export interface ChatRequest {
  system: string;
  messages: Msg[];
  tools: ToolSchema[];
  model: string;
  signal: AbortSignal;
  /** set for `ownsLoop` providers; ignored by the rest */
  thread?: ThreadRef;
}

/** A side call (AGENT-SPEC section 7): one text turn with no tools and no
 * thread, for the follow-up and starter-pool prompts. `user` is the one user
 * message; the reply is collected whole, nothing streams. */
export interface SideChatRequest {
  system: string;
  user: string;
  model: string;
  signal: AbortSignal;
}

export interface SideChatResult {
  text: string;
  usage?: TokenUsage;
}

export interface Provider {
  readonly id: ProviderId;
  /** true: the provider executes tools itself against its own MCP connection.
   * The loop renders the toolCall, waits for the provider's own toolResult for
   * the same id, and MUST NOT call AgentTools or re-execute anything. */
  readonly ownsLoop: boolean;
  chat(req: ChatRequest): AsyncIterable<AgentEvent>;
  /** The thread-free door for a side call. A hosted adapter needs none: its
   * `chat` with an empty tools list is the same thing. An `ownsLoop` adapter
   * whose `chat` binds a thread and its MCP server implements this instead;
   * without it, side calls are refused for that provider (side.ts). Resolves
   * with the whole reply; rejects with a SideCallError on any failure. */
  sideChat?(req: SideChatRequest): Promise<SideChatResult>;
}

/** A side call failed. `kind` is the vocabulary the UI speaks, `message` the
 * provider's own words (or the CLI's), never invented. */
export class SideCallError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SideCallError";
  }
}

/** The provider answered with a non-2xx status. `body` is the response text,
 * already read: adapters map status plus body to a ProviderErrorKind.
 * `retryAfterMs` is the wait the provider STATED in a header the platform
 * could see; absent means it said nothing there, not that it said zero, and
 * `http.ts` then falls back to reading the body. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`http ${status}`);
    this.name = "HttpStatusError";
  }
}

/** The request never reached a server (connection refused, DNS, timeout).
 * For a local preset the loop turns this into a "start the server" hint. */
export class HttpUnreachableError extends Error {
  readonly kind = "unreachable" as const;
  constructor(message: string) {
    super(message);
    this.name = "HttpUnreachableError";
  }
}

export interface HttpStreamRequest {
  /** picks the Keychain entry and the auth header form; the caller never
   * sees or sends the key itself */
  providerId: ProviderId;
  url: string;
  method: "GET" | "POST";
  /** the adapter's own headers (content type, preset extraHeaders). The auth
   * header is added by the platform and must NOT appear here. */
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface SpawnedProcess {
  /** stdout, one line per item, in order */
  lines: AsyncIterable<string>;
  exit: Promise<{ code: number | null; stderrTail: string }>;
}

/** Where a child process should point its MCP client. `close` revokes the
 * token; the endpoint dies with the thread. */
export interface McpEndpoint {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Everything the agent needs from the outside world. `platform.tauri.ts`
 * implements it over Tauri commands for the app; `eval/platform.node.ts`
 * implements it over node for the headless harness (EVAL.md section 3). */
export interface Platform {
  /** Raw UTF-8 body chunks as they arrive. The platform injects the auth
   * header for `providerId` from the Keychain (section 2.4, 8.3). A non-2xx
   * response rejects with HttpStatusError; a connection failure rejects with
   * HttpUnreachableError. */
  httpStream(req: HttpStreamRequest): AsyncIterable<string>;
  /** Direct exec, never a shell. `stdin` is written and the pipe closed. */
  spawn(
    cmd: string,
    args: string[],
    stdin: string,
    signal?: AbortSignal,
  ): SpawnedProcess;
  /** The MCP endpoint for this thread's database session: qwry's own Rust
   * server in the app, the node server in the eval harness. */
  mcpServer(sessionRef: string): Promise<McpEndpoint>;
  /** milliseconds, injectable so the harness can be deterministic */
  now(): number;
}
