// Shared HTTP shims for the adapters: URL joining that survives a base with or
// without a trailing slash, and the one place a transport failure becomes the
// error vocabulary the UI speaks (AGENT-UX 7, AGENT-SPEC section 7).
//
// Two rules bind everything here. Nothing derived from a response HEADER ever
// reaches a message: headers carry the key echo and the rate-limit identity.
// And an authentication failure never quotes the provider's body, because a
// 401 body routinely contains a fragment of the key that was sent (AGENT-SPEC
// section 8.3: secrets never enter logs or the trace).

import { HttpStatusError, HttpUnreachableError } from "./types";
import type { ProviderErrorKind } from "./types";

export interface ProviderErrorEvent {
  kind: ProviderErrorKind;
  message: string;
  retryAfterMs?: number;
}

/** Join a base URL and a path with exactly one slash between them, whether or
 * not the base already ends in one. Gemini's documented base carries a
 * trailing slash and OpenAI's does not; both must produce one working URL. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** True when the failure is the caller's own abort rather than the provider's.
 * A cancel is not an error: it gets `done: cancelled`, not an error event
 * (LESSONS 9, feedback must match its register). */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

/** The human-readable half of an error body, without the parts that are not
 * ours to show. Providers nest it differently; a body that is not JSON is
 * returned trimmed and clipped, because a proxy's HTML page is not a message. */
export function bodyMessage(body: string): string | null {
  const text = body.trim();
  if (text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const found = digMessage(parsed);
    if (found) return found;
  } catch {
    // not JSON: fall through to the raw text
  }
  if (text.startsWith("<")) return null;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function digMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "error_message"]) {
    const found = digMessage(record[key]);
    if (found) return found;
  }
  return null;
}

/** Milliseconds the provider asked us to wait, when it said so somewhere we
 * can see. The Retry-After header itself is not reachable from this layer:
 * HttpStatusError carries status and body only, so a platform that attaches
 * `retryAfterMs` to the error is preferred and the body is the fallback. */
export function retryAfterMs(err: HttpStatusError): number | undefined {
  const carried = (err as unknown as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof carried === "number" && Number.isFinite(carried) && carried >= 0) {
    return Math.round(carried);
  }
  const fromField = /"retry[_-]?after(?:[_-]?(?:ms|seconds))?"\s*:\s*"?([\d.]+)/i.exec(
    err.body,
  );
  if (fromField) {
    const value = Number(fromField[1]);
    if (Number.isFinite(value)) {
      const isMs = /ms"?\s*:/i.test(fromField[0]);
      return Math.round(isMs ? value : value * 1000);
    }
  }
  const fromProse =
    /(?:try again|retry)(?:\s+\w+){0,3}?\s+([\d.]+)\s*(ms|s|sec|secs|seconds?|m|min|minutes?)\b/i.exec(
      err.body,
    );
  if (fromProse) {
    const value = Number(fromProse[1]);
    if (!Number.isFinite(value)) return undefined;
    const unit = fromProse[2].toLowerCase();
    if (unit === "ms") return Math.round(value);
    if (unit.startsWith("m") && unit !== "ms") return Math.round(value * 60_000);
    return Math.round(value * 1000);
  }
  return undefined;
}

export interface ErrorContext {
  /** the provider as the picker names it, e.g. "Groq" */
  label: string;
  /** the base URL the request went to, for an unreachable message */
  url: string;
  /** how to start a local server, when this provider is one */
  startHint?: string;
}

/** Map a transport failure onto the five error kinds. Status first, because a
 * 401 from a gateway and a 401 from the provider mean the same thing to the
 * person holding the key. */
export function mapProviderError(
  err: unknown,
  ctx: ErrorContext,
): ProviderErrorEvent {
  if (err instanceof HttpStatusError) {
    if (err.status === 401 || err.status === 403) {
      return {
        kind: "auth",
        message: `${ctx.label} rejected the API key. Add a working key in Settings`,
      };
    }
    if (err.status === 429) {
      const wait = retryAfterMs(err);
      return {
        kind: "rate",
        message: `${ctx.label} is rate limiting this key`,
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
      };
    }
    const stated = bodyMessage(err.body);
    return {
      kind: "provider",
      message: stated ?? `${ctx.label} returned HTTP ${err.status}`,
    };
  }
  if (err instanceof HttpUnreachableError) {
    const hint = ctx.startHint ?? "Check the base URL and your network";
    return {
      kind: "unreachable",
      message: `${ctx.label} is not reachable at ${ctx.url}. ${hint}`,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "provider", message: message || `${ctx.label} failed` };
}
