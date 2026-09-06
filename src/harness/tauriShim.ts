// The fixture harness runs AskPanel in a plain browser tab, where
// `window.__TAURI_INTERNALS__` does not exist and every `invoke` would throw.
// This installs Tauri's own mock transport (@tauri-apps/api/mocks) and answers
// the few commands the Ask tree fires on mount or on a picker open with
// fixture data. Every other command rejects with a named error, so a store
// action fails the way a lost backend would and nothing is silently a success.
// The harness itself never asks for a run: no `ask()`, no `agent_connect`.
//
// Import this module FIRST from src/harness/AskHarness.tsx: ES imports
// evaluate in order, so the mock is in place before the Ask stores load.
// (The entry chunk's stores evaluate before the harness is even imported, and
// two of them, edits.ts and results.ts, register Tauri event listeners at
// module load; those `listen` calls reject in the console before this mock
// exists. Nothing reads their result; the frames are unaffected.)
//
// Stubs, by command:
//   plugin:event|listen / unlisten / emit  mocks' own event table (shouldMockEvents)
//   agent_thread_list                       the fixture thread row: AskPanel calls
//                                           loadThreads on mount, and the Threads
//                                           button enables only with a row; the
//                                           `threads` state gets the shell builder's
//                                           five rows (fixtures.shell.ts), else the
//                                           mount would overwrite the seeded five
//                                           with the one
//   agent_key_has                           false: ModelPicker.loadSourceState asks
//                                           per hosted provider; no key is saved
//   agent_http_stream                       the llama.cpp preset's GET /models is
//                                           answered over the Channel with the canned
//                                           LFM list (a `small` row with a ctx hint);
//                                           every other URL gets an `unreachable`
//                                           chunk, so the other local runtimes read
//                                           as not running (probeLocal yields [])
//   agent_http_abort                        no-op
//   agent_thread_truncate / _session_set    nothing: a cut in the harness moves
//   / agent_turns_shift                     the fixture thread on screen and has
//                                           no appdb behind it, so the store's
//                                           idx bookkeeping writes nowhere
//   everything else                         rejects Error("harness: <cmd> has no fixture")

import type { Channel, InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { HttpChunk, HttpDone } from "../ipc/types";
import { FIXTURE, LOCAL_MODELS_JSON, LOCAL_MODELS_URL } from "./fixtures";
import { SHELL_THREAD_ROWS } from "./fixtures.shell";

const harnessState = () => new URLSearchParams(location.search).get("state");

const record = (payload: InvokeArgs | undefined): Record<string, unknown> =>
  payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};

function httpStream(payload: InvokeArgs | undefined): HttpDone {
  const args = record(payload);
  const url = typeof args.url === "string" ? args.url : "";
  const channel = args.onChunk as Channel<HttpChunk> | undefined;
  const send = (chunk: HttpChunk) => channel?.onmessage(chunk);
  const requestId = typeof args.requestId === "string" ? args.requestId : "";
  if (url.startsWith(LOCAL_MODELS_URL)) {
    send({ type: "start", status: 200, headers: [["content-type", "application/json"]] });
    send({ type: "body", text: LOCAL_MODELS_JSON });
    return { request_id: requestId, status: 200, ms: 4, bytes: LOCAL_MODELS_JSON.length };
  }
  send({
    type: "error",
    kind: "unreachable",
    message: `harness: nothing listens at ${url}`,
    retry_after_ms: null,
  });
  return { request_id: requestId, status: 0, ms: 1, bytes: 0 };
}

export function installTauriShim(): void {
  mockWindows("main");
  mockIPC(
    (cmd, payload) => {
      switch (cmd) {
        case "agent_thread_list":
          return harnessState() === "threads" ? SHELL_THREAD_ROWS : [FIXTURE.threadRow];
        case "agent_key_has":
          return false;
        case "agent_http_stream":
          return httpStream(payload);
        case "agent_http_abort":
        case "agent_thread_truncate":
        case "agent_thread_session_set":
        case "agent_turns_shift":
          return undefined;
        default:
          throw new Error(`harness: ${cmd} has no fixture`);
      }
    },
    { shouldMockEvents: true },
  );
}

installTauriShim();
