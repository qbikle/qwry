// A Platform that answers from canned data and records what it was asked for.
// The adapters reach the outside world only through this interface, so a fake
// Platform is the whole test seam: no network, no Tauri, no child process.

import type {
  AgentEvent,
  ChatRequest,
  HttpStreamRequest,
  McpEndpoint,
  Msg,
  Platform,
  SpawnedProcess,
  ToolSchema,
} from "../types";

export interface SpawnRecord {
  cmd: string;
  args: string[];
  stdin: string;
  signal?: AbortSignal;
}

export interface FakePlatformOptions {
  /** body chunks for the next httpStream call, in order */
  chunks?: string[];
  /** thrown instead of streaming, to exercise the error paths */
  httpError?: unknown;
  /** stdout lines for the next spawn */
  lines?: string[];
  exit?: { code: number | null; stderrTail: string };
  mcp?: { url: string; token: string };
  mcpError?: unknown;
}

export class FakePlatform implements Platform {
  readonly requests: HttpStreamRequest[] = [];
  readonly spawns: SpawnRecord[] = [];
  readonly mcpRefs: string[] = [];
  mcpClosed = 0;

  constructor(private readonly options: FakePlatformOptions = {}) {}

  /** the body of the last request, parsed. Every assertion about what we SEND
   * goes through this rather than through a stringified blob. */
  lastBody(): Record<string, unknown> {
    const last = this.requests[this.requests.length - 1];
    if (!last?.body) throw new Error("no request body was captured");
    return JSON.parse(last.body) as Record<string, unknown>;
  }

  httpStream(req: HttpStreamRequest): AsyncIterable<string> {
    this.requests.push(req);
    const { chunks = [], httpError } = this.options;
    return (async function* () {
      if (httpError) throw httpError;
      for (const chunk of chunks) yield chunk;
    })();
  }

  spawn(
    cmd: string,
    args: string[],
    stdin: string,
    signal?: AbortSignal,
  ): SpawnedProcess {
    this.spawns.push({ cmd, args, stdin, signal });
    const { lines = [], exit = { code: 0, stderrTail: "" } } = this.options;
    return {
      lines: (async function* () {
        for (const line of lines) {
          if (signal?.aborted) return;
          yield line;
        }
      })(),
      exit: Promise.resolve(exit),
    };
  }

  async mcpServer(sessionRef: string): Promise<McpEndpoint> {
    this.mcpRefs.push(sessionRef);
    if (this.options.mcpError) throw this.options.mcpError;
    const { url = "http://127.0.0.1:51234/mcp", token = "tok-abc" } =
      this.options.mcp ?? {};
    return {
      url,
      token,
      close: async () => {
        this.mcpClosed += 1;
      },
    };
  }

  now(): number {
    return 0;
  }
}

/** Wrap payloads as SSE `data:` frames. Providers send exactly one data line
 * per frame; the parser's own tests cover the shapes that do not. */
export function sse(payloads: readonly string[]): string {
  return payloads.map((p) => `data: ${p}\n\n`).join("");
}

/** Cut a string into fixed-size pieces, so a test can prove that framing
 * survives a chunk boundary landing anywhere. */
export function slice(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function collect(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export function textOf(events: readonly AgentEvent[]): string {
  return events
    .map((e) => ("text" in e ? e.text : ""))
    .join("");
}

export function thinkingOf(events: readonly AgentEvent[]): string {
  return events
    .map((e) => ("thinking" in e ? e.thinking : ""))
    .join("");
}

export function toolCalls(events: readonly AgentEvent[]) {
  return events.flatMap((e) => ("toolCall" in e ? [e.toolCall] : []));
}

export function toolResults(events: readonly AgentEvent[]) {
  return events.flatMap((e) => ("toolResult" in e ? [e.toolResult] : []));
}

export function errorOf(events: readonly AgentEvent[]) {
  for (const event of events) if ("error" in event) return event.error;
  return undefined;
}

export function usageOf(events: readonly AgentEvent[]) {
  for (const event of events) if ("usage" in event) return event.usage;
  return undefined;
}

export function doneOf(events: readonly AgentEvent[]) {
  for (const event of events) if ("done" in event) return event.done;
  return undefined;
}

export const TOOLS: ToolSchema[] = [
  {
    name: "list_tables",
    description: "List every table.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "run_sql",
    description: "Run one read-only statement.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
];

export function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: "You answer questions about a PostgreSQL database.",
    messages: [{ role: "user", content: "how many films" }] as Msg[],
    tools: TOOLS,
    model: "test-model",
    signal: new AbortController().signal,
    ...over,
  };
}
