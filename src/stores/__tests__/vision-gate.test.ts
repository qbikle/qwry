// The one gate the drawing's `Ask` stands behind (C2b call 4). Two facts have
// to agree - the preset's wire and the model's own row - and `"unknown"` is a
// no until this install says otherwise. What is pinned here is that a no is a
// no on every route into it, because the cost of a wrong yes is the user's
// turn spent on a provider's 400.

import { beforeEach, expect, test } from "bun:test";

// the store pulls in settings.ts, which paints the theme onto the document at
// import, and sidePane.ts, which reads localStorage; bun has neither
// (agent-writes.test.ts's own preamble, the house shim)
const mem = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : inert),
  set: () => true,
  apply: () => undefined,
});
for (const k of ["window", "localStorage", "document"].filter((n) => !(n in globalThis))) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? globalThis : k === "localStorage" ? storage : inert,
    configurable: true,
    writable: true,
  });
}

const { canSeeImages } = await import("../agent");
const { useSettings } = await import("../settings");

const PID = "conn-1";

const choose = (provider: string, model: string) =>
  useSettings.setState({ agentProvider: provider, agentModel: model, agentByConn: {}, agentVision: {} });

beforeEach(() => {
  useSettings.setState({ agentProvider: null, agentModel: null, agentByConn: {}, agentVision: {} });
});

test("a documented vision model on a wire that carries one: yes", () => {
  choose("anthropic", "claude-opus-5");
  expect(canSeeImages(PID)).toBe(true);
  // the `claude -p` child takes the picture as MCP image content, which is a
  // different route and the same answer
  choose("claude-code", "claude-sonnet-5");
  expect(canSeeImages(PID)).toBe(true);
});

test("a model documented WITHOUT vision: no, and the switch cannot argue", () => {
  choose("llama-server", "LFM2.5-2.6B-Q4_K_M");
  expect(canSeeImages(PID)).toBe(false);
  useSettings.getState().setAgentVision("LFM2.5-2.6B-Q4_K_M", true);
  expect(canSeeImages(PID)).toBe(false);
});

test("an unknown row is a no until this install answers for it", () => {
  choose("openai", "gpt-5.6-terra");
  expect(canSeeImages(PID)).toBe(false);
  useSettings.getState().setAgentVision("gpt-5.6-terra", true);
  expect(canSeeImages(PID)).toBe(true);
  // and off again: the switch is the whole record, so turning it off takes
  // the button away again
  useSettings.getState().setAgentVision("gpt-5.6-terra", false);
  expect(canSeeImages(PID)).toBe(false);
});

test("the switch answers for the model the registry matched, path-shaped ids included", () => {
  choose("lmstudio", "vendor/some-vlm-7b.gguf");
  expect(canSeeImages(PID)).toBe(false);
  useSettings.getState().setAgentVision("vendor/some-vlm-7b.gguf", true);
  expect(canSeeImages(PID)).toBe(true);
});

test("this connection's own model answers, not the app-wide one", () => {
  choose("anthropic", "claude-opus-5");
  useSettings.setState({ agentByConn: { [PID]: { provider: "llama-server", model: "Qwen3-4B-Q4_K_M" } } });
  expect(canSeeImages(PID)).toBe(false);
  expect(canSeeImages("conn-2")).toBe(true);
});

test("no model chosen at all is a no, never a throw", () => {
  expect(canSeeImages(PID)).toBe(false);
});
