// Platform over the Tauri agent commands (AGENT-SPEC section 2.4). One of the
// two files under src/agent allowed to import Tauri; the eval harness supplies
// eval/platform.node.ts against the same interface.
//
// Only Rust talks to the network, as only Rust talks to PostgreSQL: this file
// never sees an API key, and `httpStream` hands the relay a caller-minted
// request id so a cancel can land before the first chunk does.

import {
  agentClaudeKill,
  agentClaudeSpawn,
  agentHttpAbort,
  agentHttpStream,
  agentMcpServe,
  agentMcpStop,
} from "../ipc/commands";
import type { HttpChunk } from "../ipc/types";
import { useSettings } from "../stores/settings";
import {
  HttpStatusError,
  HttpUnreachableError,
  type HttpStreamRequest,
  type McpEndpoint,
  type Platform,
  type SpawnedProcess,
} from "./providers/types";

/** A Channel is push, an adapter wants pull. This is the one queue between
 * them: it buffers what Rust already sent and parks the reader otherwise. */
class Pipe<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private failure: unknown = null;

  push(item: T) {
    this.items.push(item);
    this.wake?.();
  }
  close() {
    this.ended = true;
    this.wake?.();
  }
  fail(e: unknown) {
    this.failure = e;
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift() as T;
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}

const ok = (status: number) => status >= 200 && status < 300;

/** The wait the provider STATED in `Retry-After`: delta-seconds or an
 * HTTP-date, both of which the header allows. Nothing readable yields nothing,
 * because a fabricated wait is worse than no wait at all. The value travels on
 * the error, never in a message: header-derived text is not ours to show
 * (providers/http.ts). */
function retryAfterFromHeaders(headers: [string, string][]): number | undefined {
  const raw = headers.find(([k]) => k.toLowerCase() === "retry-after")?.[1].trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** `crypto.randomUUID` in the webview; the ids only have to be unique per
 * process, and Rust keys its abort table on them. */
const mintId = () => crypto.randomUUID();

async function* httpStream(req: HttpStreamRequest): AsyncIterable<string> {
  const requestId = mintId();
  const pipe = new Pipe<HttpChunk>();
  const relay = agentHttpStream(
    requestId,
    req.providerId,
    req.url,
    req.method,
    Object.entries(req.headers),
    req.body ?? null,
    (chunk) => pipe.push(chunk),
  ).then(
    () => pipe.close(),
    (e) => pipe.fail(e),
  );
  const abort = () => {
    void agentHttpAbort(requestId).catch(() => {});
  };
  req.signal?.addEventListener("abort", abort, { once: true });

  let status: number | null = null;
  let retryAfter: number | undefined;
  let errorBody = "";
  try {
    for await (const chunk of pipe) {
      if (chunk.type === "start") {
        status = chunk.status;
        retryAfter = retryAfterFromHeaders(chunk.headers);
      } else if (chunk.type === "body") {
        // a non-2xx body is the provider's error payload: hold it so the
        // adapter can map status plus body to a ProviderErrorKind
        if (status !== null && !ok(status)) errorBody += chunk.text;
        else yield chunk.text;
      } else if (chunk.kind === "unreachable") {
        throw new HttpUnreachableError(chunk.message);
      } else if (chunk.kind === "cancelled") {
        const e = new Error(chunk.message);
        e.name = "AbortError";
        throw e;
      } else {
        throw new HttpStatusError(
          status ?? 0,
          chunk.message,
          chunk.retry_after_ms ?? retryAfter,
        );
      }
    }
    if (status !== null && !ok(status)) {
      throw new HttpStatusError(status, errorBody, retryAfter);
    }
  } finally {
    req.signal?.removeEventListener("abort", abort);
    await relay.catch(() => {});
  }
}

/** The relay spawns `claude` itself, so the binary is not the caller's to
 * choose; anything else is a wiring mistake and says so. */
function spawn(
  cmd: string,
  args: string[],
  stdin: string,
  signal?: AbortSignal,
): SpawnedProcess {
  if (cmd !== "claude") {
    throw new Error(`agent_claude_spawn only runs claude, not ${cmd}`);
  }
  const runId = mintId();
  const pipe = new Pipe<string>();
  const exit = agentClaudeSpawn(runId, args, stdin, (line) => pipe.push(line)).then(
    (e) => {
      pipe.close();
      return { code: e.code, stderrTail: e.stderr_tail };
    },
    (e) => {
      pipe.fail(e);
      throw e;
    },
  );
  signal?.addEventListener(
    "abort",
    () => {
      void agentClaudeKill(runId).catch(() => {});
    },
    { once: true },
  );
  return { lines: pipe, exit };
}

/** The child process cannot read `useSettings`, so the thread's MCP server is
 * told the statement_timeout once, when it is minted. A setting of 0 means "no
 * timeout", which is not a shape a tool call has: it falls through to the
 * AGENT-SPEC 5 default rather than down to the one-second floor. */
async function mcpServer(sessionRef: string): Promise<McpEndpoint> {
  const secs = useSettings.getState().statementTimeoutSecs;
  const endpoint = await agentMcpServe(sessionRef, secs > 0 ? secs * 1000 : undefined);
  return {
    url: endpoint.url,
    token: endpoint.token,
    close: () => agentMcpStop(endpoint.token),
  };
}

export const tauriPlatform: Platform = {
  httpStream,
  spawn,
  mcpServer,
  now: () => performance.now(),
};
