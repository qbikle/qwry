// The follow-up suggestions call (AGENT-SPEC section 4.6): the parser that
// turns a model's reply into at most three unasked questions, and the call
// itself against a scripted provider, including the refusals that keep it a
// courtesy (an ownsLoop provider with no side call, errors, abort), the side
// call an ownsLoop provider offers instead, and the trace step that keeps it
// visible.

import { describe, expect, test } from "bun:test";
import { parseFollowUps, suggestFollowUps } from "../followups";
import { baseModelId, modelInfo, tierOf } from "../providers/registry";
import type { AgentEvent, ChatRequest, Provider, SideChatRequest } from "../providers/types";

function scripted(events: AgentEvent[], seen: ChatRequest[] = [], ownsLoop = false): Provider {
  return {
    id: "openai",
    ownsLoop,
    chat(req) {
      seen.push(req);
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

/** an ownsLoop provider whose only door is the side call: chat must never
 * carry a follow-up prompt (it would --resume the thread) */
function sided(text: string, seen: SideChatRequest[] = []): Provider {
  return {
    id: "claude-code",
    ownsLoop: true,
    chat() {
      throw new Error("chat must never carry a side call");
    },
    async sideChat(req) {
      seen.push(req);
      return { text, usage: { input: 459, output: 756 } };
    },
  };
}

/** the thread as the store hands it over (W7): replayOf's blocks, one per
 * exchange, no heading */
const THREAD =
  "Q: How many films are there?\nSQL: SELECT count(*) FROM film\nA: 1000 films.";

const base = {
  thread: THREAD,
  asked: ["How many films are there?"],
  model: "test-model",
  signal: new AbortController().signal,
};

describe("parseFollowUps", () => {
  test("one question per line, bullets and numbering stripped, at most three", () => {
    const text =
      "1. How many films per rating?\n- Which category has the most films?\n• What is the average length?\n4. A fourth?";
    expect(parseFollowUps(text)).toEqual([
      "How many films per rating?",
      "Which category has the most films?",
      "What is the average length?",
    ]);
  });

  test("lines that are not questions, repeats, and already-asked ones are dropped", () => {
    const text =
      "Here are three follow-ups:\nHow many films are there?\nHow many films per rating?\nhow many films per rating?\nSome commentary without a mark";
    expect(parseFollowUps(text, ["How many films are there?"])).toEqual([
      "How many films per rating?",
    ]);
  });

  test("quoted lines lose their quotes", () => {
    expect(parseFollowUps('"Which store rents the most?"')).toEqual(["Which store rents the most?"]);
  });
});

describe("suggestFollowUps", () => {
  test("one tool-less call, and the call is a trace step", async () => {
    const seen: ChatRequest[] = [];
    const provider = scripted(
      [
        { text: "How many films per rating?\n" },
        { text: "Which category has the most films?\nWhat is the average length?" },
        { usage: { input: 10, output: 20 } },
        { done: { stopReason: "stop" } },
      ],
      seen,
    );
    const out = await suggestFollowUps({ ...base, provider });
    expect(out.questions).toHaveLength(3);
    expect(seen).toHaveLength(1);
    expect(seen[0].tools).toEqual([]);
    expect(seen[0].messages).toHaveLength(1);
    expect(out.step).toMatchObject({
      step: "followups",
      questions: out.questions,
      usage: { input: 10, output: 20 },
    });
    // the WHOLE thread is the prompt, and it says every question once: the
    // chips stand at the thread's end, not under each answer (W7)
    expect(out.step?.prompt).toContain("SELECT count(*) FROM film");
    expect(out.step?.prompt).toContain("How many films are there?");
    expect(out.step?.prompt).not.toContain("Already asked");
  });

  test("an ownsLoop provider without a side call is never called: chat would resume the thread", async () => {
    const seen: ChatRequest[] = [];
    const out = await suggestFollowUps({ ...base, provider: scripted([], seen, true) });
    expect(out).toEqual({ questions: [], step: null });
    expect(seen).toHaveLength(0);
  });

  test("an ownsLoop provider with a side call gets the prompt there, and its reply is parsed", async () => {
    const seen: SideChatRequest[] = [];
    const out = await suggestFollowUps({
      ...base,
      provider: sided("How many films per rating?\nWhich category has the most films?\nWhat is the average length?", seen),
    });
    expect(out.questions).toEqual([
      "How many films per rating?",
      "Which category has the most films?",
      "What is the average length?",
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe("test-model");
    expect(seen[0].system).toContain("follow-up");
    expect(seen[0].user).toContain("SELECT count(*) FROM film");
    expect(out.step).toMatchObject({
      step: "followups",
      prompt: seen[0].user,
      questions: out.questions,
      usage: { input: 459, output: 756 },
    });
  });

  test("a side call that rejects costs the chips, never throws", async () => {
    const provider: Provider = {
      id: "claude-code",
      ownsLoop: true,
      chat() {
        throw new Error("chat must never carry a side call");
      },
      async sideChat() {
        throw new Error("Not logged in");
      },
    };
    expect(await suggestFollowUps({ ...base, provider })).toEqual({ questions: [], step: null });
  });

  test("a provider error costs the chips, never throws", async () => {
    const provider = scripted([{ error: { kind: "rate", message: "slow down" } }]);
    expect(await suggestFollowUps({ ...base, provider })).toEqual({ questions: [], step: null });
  });

  test("an aborted signal makes no call", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const seen: ChatRequest[] = [];
    const out = await suggestFollowUps({ ...base, provider: scripted([], seen), signal: ctl.signal });
    expect(out.step).toBeNull();
    expect(seen).toHaveLength(0);
  });

  test("the prompt carries the thread, and an empty one says so", async () => {
    const seen: ChatRequest[] = [];
    const provider = scripted(
      [{ text: "Which store rents the most?" }, { done: { stopReason: "stop" } }],
      seen,
    );
    const long =
      "Q: one?\nSQL: SELECT 1\nA: first.\n\nQ: two?\nSQL: SELECT 2\nA: second.";
    await suggestFollowUps({ ...base, thread: long, asked: ["one?", "two?"], provider });
    const sent = (seen[0].messages[0] as { content: string }).content;
    expect(sent).toContain("Q: one?");
    expect(sent).toContain("Q: two?");

    const empty: ChatRequest[] = [];
    await suggestFollowUps({
      ...base,
      thread: "",
      provider: scripted([{ text: "x?" }, { done: { stopReason: "stop" } }], empty),
    });
    expect((empty[0].messages[0] as { content: string }).content).toContain("(nothing yet)");
  });
});

describe("registry: path-shaped ids", () => {
  test("a llama-server gguf path matches its registry row on the file name", () => {
    expect(baseModelId("/Users/x/models/LFM2.5-2.6B-Q4_K_M.gguf")).toBe("LFM2.5-2.6B-Q4_K_M");
    expect(baseModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(modelInfo("/models/LFM2.5-2.6B-Q4_K_M.gguf", "llama-server")?.tier).toBe("small");
    expect(tierOf("/models/LFM2.5-2.6B-Q4_K_M.gguf", "llama-server")).toEqual({
      tier: "small",
      known: true,
    });
  });

  test("an unknown path stays unknown and reads mid", () => {
    expect(tierOf("/models/nothing-here.gguf", "llama-server")).toEqual({ tier: "mid", known: false });
  });
});
