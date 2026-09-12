// Server-sent events, parsed by hand (AGENT-SPEC section 7: no new runtime
// dependencies). Shared by the OpenAI-compatible adapter and the Anthropic one,
// because both speak SSE over Platform.httpStream and the framing bugs are the
// same on both: a frame split across two reads, a keep-alive comment line, a
// CRLF server, and a last frame that arrives without its terminating blank
// line. Everything here is protocol, never provider policy.

/** One dispatched SSE frame. `event` is the `event:` field when the server
 * sends one (Anthropic does, OpenAI does not); `data` is every `data:` line of
 * the frame joined with newlines, per the SSE spec. */
export interface SseFrame {
  event: string | null;
  data: string;
}

/** Frames from a stream of raw UTF-8 body chunks. Chunk boundaries are
 * meaningless: a frame may span any number of them, and one chunk may carry
 * many frames. Comment lines (`:` keep-alives) and unknown fields are dropped;
 * `id` and `retry` are not used by any provider we speak to. */
export async function* parseSse(
  chunks: AsyncIterable<string>,
): AsyncGenerator<SseFrame> {
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];

  const take = (): SseFrame | null => {
    if (data.length === 0 && event === null) return null;
    const frame: SseFrame = { event, data: data.join("\n") };
    event = null;
    data = [];
    return frame;
  };

  const feed = (raw: string): SseFrame | null => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") return take();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    return null;
  };

  for await (const chunk of chunks) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const frame = feed(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (frame) yield frame;
      nl = buffer.indexOf("\n");
    }
  }

  // a server that closes without the final blank line still owes us the frame
  if (buffer !== "") {
    const frame = feed(buffer);
    if (frame) yield frame;
  }
  const last = take();
  if (last) yield last;
}
