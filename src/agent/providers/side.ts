// One tool-less text call through whichever door the provider has (AGENT-SPEC
// section 7, side calls). The follow-up and starter-pool prompts want a single
// reply and no tools: a hosted adapter gives it through `chat` with an empty
// tools list, and an adapter that owns its loop, whose `chat` binds a thread
// and its MCP server, gives it through `sideChat`. Both callers treat every
// failure alike (the chips and the pool are a courtesy), so this resolves with
// the text or rejects, never both.

import type { TokenUsage } from "../types";
import {
  SideCallError,
  type Provider,
  type SideChatRequest,
  type SideChatResult,
} from "./types";

export function abortError(): Error {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}

export async function sideText(provider: Provider, req: SideChatRequest): Promise<SideChatResult> {
  if (req.signal.aborted) throw abortError();
  if (provider.ownsLoop) {
    if (!provider.sideChat) {
      throw new SideCallError("provider", `${provider.id} has no side call`);
    }
    return provider.sideChat(req);
  }
  const usage: TokenUsage = { input: 0, output: 0 };
  let sawUsage = false;
  let text = "";
  const stream = provider.chat({
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    tools: [],
    model: req.model,
    signal: req.signal,
  });
  for await (const ev of stream) {
    if (req.signal.aborted) throw abortError();
    if ("text" in ev) text += ev.text;
    else if ("usage" in ev) {
      usage.input += ev.usage.input;
      usage.output += ev.usage.output;
      sawUsage = true;
    } else if ("error" in ev) {
      throw new SideCallError(ev.error.kind, ev.error.message);
    }
  }
  return sawUsage ? { text, usage } : { text };
}
