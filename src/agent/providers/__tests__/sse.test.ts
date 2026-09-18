import { expect, test } from "bun:test";

import { parseSse } from "../sse";
import { slice } from "./harness";

async function frames(chunks: readonly string[]) {
  const out: { event: string | null; data: string }[] = [];
  for await (const frame of parseSse(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  )) {
    out.push(frame);
  }
  return out;
}

test("reads one frame per blank line and strips the space after the colon", async () => {
  const got = await frames(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
  expect(got.map((f) => f.data)).toEqual(['{"a":1}', '{"a":2}']);
});

test("carries the event name when the server sends one", async () => {
  const got = await frames([
    'event: content_block_delta\ndata: {"index":0}\n\n',
    "event: ping\ndata: {}\n\n",
  ]);
  expect(got.map((f) => f.event)).toEqual(["content_block_delta", "ping"]);
});

test("survives a frame split across every possible chunk boundary", async () => {
  const stream = 'data: {"a":1}\n\ndata: {"b":22}\n\ndata: [DONE]\n\n';
  for (let size = 1; size <= stream.length; size++) {
    const got = await frames(slice(stream, size));
    expect(got.map((f) => f.data)).toEqual(['{"a":1}', '{"b":22}', "[DONE]"]);
  }
});

test("drops keep-alive comment lines", async () => {
  const got = await frames([": ping\n\n", 'data: {"a":1}\n\n', ":\n"]);
  expect(got.map((f) => f.data)).toEqual(['{"a":1}']);
});

test("handles CRLF line endings", async () => {
  const got = await frames(['data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n']);
  expect(got.map((f) => f.data)).toEqual(['{"a":1}', '{"a":2}']);
});

test("joins multiple data lines of one frame with a newline", async () => {
  const got = await frames(["data: one\ndata: two\n\n"]);
  expect(got).toEqual([{ event: null, data: "one\ntwo" }]);
});

test("still yields a final frame that never got its blank line", async () => {
  const got = await frames(['data: {"a":1}\n\ndata: [DONE]']);
  expect(got.map((f) => f.data)).toEqual(['{"a":1}', "[DONE]"]);
});
