// sideText picks the door: a hosted provider's tool-less `chat`, an ownsLoop
// provider's `sideChat`, and a refusal for an ownsLoop provider that has
// neither, so no caller ever reaches a claude -p `chat` without a thread.

import { expect, test } from "bun:test";
import { sideText } from "../side";
import { SideCallError } from "../types";
import type { AgentEvent, ChatRequest, Provider, SideChatRequest } from "../types";

function hosted(events: AgentEvent[], seen: ChatRequest[] = []): Provider {
  return {
    id: "openai",
    ownsLoop: false,
    chat(req) {
      seen.push(req);
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

function owning(side?: { text: string; seen: SideChatRequest[] }): Provider {
  return {
    id: "claude-code",
    ownsLoop: true,
    chat() {
      throw new Error("chat must never carry a side call");
    },
    ...(side
      ? {
          async sideChat(req: SideChatRequest) {
            side.seen.push(req);
            return { text: side.text, usage: { input: 3, output: 4 } };
          },
        }
      : {}),
  };
}

const req = (over: Partial<SideChatRequest> = {}): SideChatRequest => ({
  system: "sys",
  user: "the prompt",
  model: "m",
  signal: new AbortController().signal,
  ...over,
});

test("a hosted provider answers through a tool-less chat, text joined and usage summed", async () => {
  const seen: ChatRequest[] = [];
  const out = await sideText(
    hosted(
      [
        { text: "one\n" },
        { thinking: "not text" },
        { text: "two" },
        { usage: { input: 10, output: 20 } },
        { usage: { input: 1, output: 2 } },
        { done: { stopReason: "stop" } },
      ],
      seen,
    ),
    req(),
  );
  expect(out).toEqual({ text: "one\ntwo", usage: { input: 11, output: 22 } });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    system: "sys",
    tools: [],
    model: "m",
    messages: [{ role: "user", content: "the prompt" }],
  });
  expect(seen[0].thread).toBeUndefined();
});

test("a hosted provider without a usage event yields no usage", async () => {
  const out = await sideText(hosted([{ text: "x" }, { done: { stopReason: "stop" } }]), req());
  expect(out).toEqual({ text: "x" });
});

test("a hosted provider's error event rejects with its kind", async () => {
  const err = await sideText(hosted([{ error: { kind: "rate", message: "slow down" } }]), req()).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SideCallError);
  expect((err as SideCallError).kind).toBe("rate");
  expect((err as SideCallError).message).toBe("slow down");
});

test("an ownsLoop provider is routed to its sideChat, chat untouched", async () => {
  const seen: SideChatRequest[] = [];
  const out = await sideText(owning({ text: "a?\nb?", seen }), req());
  expect(out).toEqual({ text: "a?\nb?", usage: { input: 3, output: 4 } });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ system: "sys", user: "the prompt", model: "m" });
});

test("an ownsLoop provider without a sideChat is refused, never called", async () => {
  const err = await sideText(owning(), req()).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SideCallError);
  expect((err as SideCallError).message).toBe("claude-code has no side call");
});

test("an aborted signal rejects before either door is opened", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const seen: ChatRequest[] = [];
  const err = await sideText(hosted([{ text: "x" }], seen), req({ signal: ctl.signal })).catch(
    (e: unknown) => e,
  );
  expect((err as Error).name).toBe("AbortError");
  expect(seen).toHaveLength(0);
});
