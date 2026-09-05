// Platform over node for the headless harness (AGENT-SPEC section 2.4,
// EVAL.md section 3). The twin of src/agent/platform.tauri.ts: the adapters
// under src/agent/providers reach the outside world only through this
// interface, so the same loop runs in the app and on a bench machine.
//
// The one part that must MIRROR rather than merely satisfy the interface is
// `mcpServer`. `claude -p` is configured by a JSON document the adapter builds
// (claudecode.ts mcpConfigJson): one streamable-HTTP server, loopback only, a
// bearer token per thread. If the transport here differed from
// src-tauri/src/agent_mcp.rs, that config would be a different document and the
// eval would be scoring a different app. So: one listener per process, token as
// identity (never Mcp-Session-Id), Origin validated, stateless JSON responses,
// tools served verbatim from src/agent/tools.schema.json.

import { spawn as childSpawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import schema from "../src/agent/tools.schema.json";
import { PEEK_MAX, PROBE_MAX, type AgentTools } from "../src/agent/tools";
import {
  HttpStatusError,
  HttpUnreachableError,
  type HttpStreamRequest,
  type McpEndpoint,
  type Platform,
  type SpawnedProcess,
} from "../src/agent/providers/types";

/** Matches agent_mcp.rs: the token is the identity, so the path is cosmetic. */
export const MCP_PATH = "/mcp";
/** Matches agent_mcp.rs SERVER_NAME; claude -p exposes the tools as
 * `mcp__qwry__<tool>` and `--allowedTools 'mcp__qwry__*'` must match it. */
export const MCP_SERVER_NAME = "qwry";

export interface NodePlatformInit {
  /** the AgentTools a thread's MCP token speaks for. The harness registers one
   * per question, exactly as the app registers one per thread. */
  toolsFor: (sessionRef: string) => AgentTools | undefined;
  /** the `claude` binary; the adapter only ever asks for "claude" */
  claudeBin?: string;
  /** stderr of a spawned child, for the trace when a run dies */
  onStderr?: (line: string) => void;
}

// ---- http ------------------------------------------------------------------

/** The env var a provider's key comes from: `QWRY_EVAL_API_KEY_OPENAI`,
 * `QWRY_EVAL_API_KEY_CLAUDE_CODE`, and so on. The app reads the Keychain
 * through Rust; a bench machine has no Keychain and no app, so the key is
 * named explicitly per provider rather than inherited from whatever the shell
 * happens to export. */
export function apiKeyEnvVar(providerId: string): string {
  return `QWRY_EVAL_API_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function authHeader(providerId: string): Record<string, string> {
  const key = process.env[apiKeyEnvVar(providerId)];
  if (!key) return {};
  if (providerId === "anthropic") return { "x-api-key": key };
  return { authorization: `Bearer ${key}` };
}

/** The wait the provider STATED in Retry-After: delta-seconds or an HTTP-date,
 * both of which the header allows (platform.tauri.ts retryAfterFromHeaders). */
function retryAfterFrom(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

async function* httpStream(req: HttpStreamRequest): AsyncIterable<string> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: { ...req.headers, ...authHeader(req.providerId) },
      body: req.body,
      signal: req.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new HttpUnreachableError((e as Error).message);
  }
  const retryAfter = retryAfterFrom(res.headers);
  if (!res.ok) {
    throw new HttpStatusError(res.status, await res.text(), retryAfter);
  }
  if (!res.body) return;
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

// ---- spawn -----------------------------------------------------------------

/** Push to pull, with the reader parked when nothing has arrived yet
 * (platform.tauri.ts Pipe). */
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

/** stderr kept for the exit report: the child's own words, shown and never
 * invented (claudecode.ts exitError). */
const STDERR_TAIL = 4_000;

function makeSpawn(init: NodePlatformInit) {
  return function spawn(
    cmd: string,
    args: string[],
    stdin: string,
    signal?: AbortSignal,
  ): SpawnedProcess {
    // the adapter names the binary it wants; the harness decides where it is,
    // exactly as agent_claude.rs does for the app
    const bin = cmd === "claude" ? (init.claudeBin ?? "claude") : cmd;
    const child = childSpawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const pipe = new Pipe<string>();
    let stderrTail = "";
    let buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) pipe.push(line);
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
      init.onStderr?.(chunk.trimEnd());
    });

    const exit = new Promise<{ code: number | null; stderrTail: string }>((resolve) => {
      child.on("error", (e) => {
        stderrTail = (stderrTail + String(e)).slice(-STDERR_TAIL);
        if (buffer.trim()) pipe.push(buffer);
        pipe.close();
        resolve({ code: null, stderrTail });
      });
      child.on("close", (code) => {
        if (buffer.trim()) pipe.push(buffer);
        pipe.close();
        resolve({ code, stderrTail });
      });
    });

    const kill = () => child.kill("SIGTERM");
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });

    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
    return { lines: pipe, exit };
  };
}

// ---- the MCP server (agent_mcp.rs) -----------------------------------------

interface TokenEntry {
  sessionRef: string;
  tools: AgentTools;
}

/** What this listener actually served for one thread. The loop's trace counts
 * every tool call INCLUDING the final `run_sql` it runs itself, so the trace
 * alone cannot prove a `claude -p` child reached qwry's tools rather than
 * Claude Code's own. This tally can: nothing increments it but a tools/call
 * arriving over HTTP with that thread's bearer token. */
export interface McpTally {
  /** tools/call requests served, valid names and unknown ones alike */
  calls: number;
  byName: Record<string, number>;
  /** names the child asked for that are not one of the five (AGENT-SPEC
   * section 5): empty is the only acceptable value, and a non-empty one means
   * the `--tools ""` / `--allowedTools` flags stopped holding */
  unknown: string[];
}

/** The tally of a thread that was never served: zero, never undefined. */
export const emptyTally = (): McpTally => ({ calls: 0, byName: {}, unknown: [] });

const TOOLS_WIRE = schema.tools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.parameters,
}));

const TOOL_NAMES = TOOLS_WIRE.map((t) => t.name).join(", ");
/** The five names of AGENT-SPEC section 5, from the one schema both sides read. */
const KNOWN_TOOLS = new Set(TOOLS_WIRE.map((t) => t.name));

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`ERROR: '${key}' is required and must be a string`);
  }
  return v;
}

function requireStrings(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) {
    throw new Error(`ERROR: '${key}' is required and must be an array of strings`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(`ERROR: every entry of '${key}' must be a string`);
    }
  }
  return v as string[];
}

/** One tools/call, dispatched onto the AgentTools the token speaks for. The
 * result shape mirrors agent_mcp.rs: a failed tool call is TEXT the model
 * reads and repairs from, never a JSON-RPC error. */
async function dispatch(
  tools: AgentTools,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  try {
    switch (name) {
      case "list_tables": {
        const out = await tools.listTables();
        return { text: out.textForModel, isError: !!out.error };
      }
      case "describe_tables": {
        const out = await tools.describeTables(requireStrings(args, "names"));
        return { text: out.textForModel, isError: !!out.error };
      }
      case "peek_values": {
        const limit = typeof args.limit === "number" ? args.limit : 20;
        const out = await tools.peekValues(
          requireString(args, "table"),
          requireString(args, "column"),
          Math.max(1, Math.min(Math.trunc(limit), PEEK_MAX)),
        );
        return { text: out.textForModel, isError: !!out.error };
      }
      case "run_sql": {
        const out = await tools.runSql(requireString(args, "sql"));
        return { text: out.textForModel, isError: !!out.error };
      }
      case "probe": {
        const out = await tools.probe(requireStrings(args, "sqls").slice(0, PROBE_MAX));
        return { text: out.textForModel, isError: !!out.error };
      }
      default:
        return { text: `ERROR: unknown tool '${name}'. Valid tools: ${TOOL_NAMES}`, isError: true };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { text: message.startsWith("ERROR:") ? message : `ERROR: ${message}`, isError: true };
  }
}

/** MCP's DNS-rebinding defence, as agent_mcp.rs states it: an absent Origin is
 * a non-browser client (claude -p sends none) and passes; anything else must be
 * loopback over plain http, which is the only place this listener exists. */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const rest = origin.startsWith("http://") ? origin.slice("http://".length) : null;
  if (rest === null) return false;
  const host = rest.split(":")[0];
  return host === "127.0.0.1" || host === "localhost";
}

/** `Bearer` is read case-insensitively and nothing else is (agent_mcp.rs). */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const space = header.indexOf(" ");
  if (space === -1) return null;
  const scheme = header.slice(0, space);
  if (scheme.toLowerCase() !== "bearer") return null;
  return header.slice(space + 1).trim();
}

/** 32 bytes of entropy from two v4 uuids, as agent_mcp.rs mints them. */
const mintToken = () => `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

class McpRegistry {
  private listener: HttpServer | null = null;
  private port = 0;
  private readonly tokens = new Map<string, TokenEntry>();
  /** kept per thread rather than per token, and never cleared with the token:
   * the harness reads a question's tally after the thread has been released */
  private readonly served = new Map<string, McpTally>();

  private handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (!originAllowed(req.headers.origin)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden origin");
      return;
    }
    const token = bearerOf(req.headers.authorization);
    const entry = token ? this.tokens.get(token) : undefined;
    if (!entry) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("unauthorized");
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    // stateless, one server per request: the SDK's own guidance, and it is
    // what rmcp's `json_response: true` amounts to on the Rust side
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: "0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_WIRE }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const tally = this.served.get(entry.sessionRef) ?? emptyTally();
      tally.calls += 1;
      tally.byName[name] = (tally.byName[name] ?? 0) + 1;
      if (!KNOWN_TOOLS.has(name) && !tally.unknown.includes(name)) tally.unknown.push(name);
      this.served.set(entry.sessionRef, tally);
      const out = await dispatch(
        entry.tools,
        name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      );
      return { content: [{ type: "text" as const, text: out.text }], isError: out.isError };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  /** Bind a fresh loopback listener once; every token is served by it, so the
   * port only decides what the URL advertises (agent_mcp.rs ensure_listener). */
  private async ensureListener(): Promise<number> {
    if (this.listener) return this.port;
    const server = createServer((req, res) => {
      void this.handler(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("the tool server did not report a port");
    }
    server.unref();
    this.listener = server;
    this.port = addr.port;
    return this.port;
  }

  async serve(sessionRef: string, tools: AgentTools): Promise<McpEndpoint> {
    const port = await this.ensureListener();
    const token = mintToken();
    this.tokens.set(token, { sessionRef, tools });
    if (!this.served.has(sessionRef)) this.served.set(sessionRef, emptyTally());
    return {
      url: `http://127.0.0.1:${port}${MCP_PATH}`,
      token,
      close: async () => {
        this.tokens.delete(token);
      },
    };
  }

  /** What the listener served for one thread. A thread that never opened an
   * endpoint has no tally, which is a zero rather than a missing answer. */
  tally(sessionRef: string): McpTally {
    return this.served.get(sessionRef) ?? emptyTally();
  }

  /** Every listener dies with the process, but a bench run that finished
   * should not hold the loop open while the summary prints. */
  stop() {
    this.listener?.close();
    this.listener = null;
    this.tokens.clear();
  }
}

// ---- temp files ------------------------------------------------------------

let tempDir: string | null = null;

/** A file a child process has to read (an --mcp-config written to disk, a
 * captured trace). The app has no equivalent: claude -p takes its config
 * inline there, so nothing of an endpoint touches disk. */
export function writeTempFile(name: string, contents: string): string {
  if (tempDir === null) tempDir = mkdtempSync(join(tmpdir(), "qwry-eval-"));
  const path = join(tempDir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

// ---- the platform ----------------------------------------------------------

export interface NodePlatform extends Platform {
  writeTempFile(name: string, contents: string): string;
  /** tools/call requests this listener served for one thread: the harness's
   * only structural proof that a `claude -p` child spoke to qwry's five tools
   * (AGENT-SPEC section 5) rather than to its host's own */
  mcpCalls(sessionRef: string): McpTally;
  /** release the MCP listener when the run is over */
  stop(): void;
}

export function createNodePlatform(init: NodePlatformInit): NodePlatform {
  const registry = new McpRegistry();
  return {
    httpStream,
    spawn: makeSpawn(init),
    async mcpServer(sessionRef: string): Promise<McpEndpoint> {
      const tools = init.toolsFor(sessionRef);
      if (!tools) throw new Error(`no agent tools registered for ${sessionRef}`);
      return registry.serve(sessionRef, tools);
    },
    now: () => Date.now(),
    writeTempFile,
    mcpCalls: (sessionRef) => registry.tally(sessionRef),
    stop: () => registry.stop(),
  };
}
