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
//                                           with the one, and the W6 / B2 states
//                                           their own connection's threads for the
//                                           same reason (a `@` box offers them)
//   agent_key_has                           false: ModelPicker.loadSourceState asks
//                                           per hosted provider; no key is saved
//   history_search                          no rows: the palette harness asks on
//                                           open, and a connection with no history
//                                           draws no History group
//   table_stats                             the canned order_v2 stats: the Structure
//                                           harness's view asks on mount, and the
//                                           hint line is framed in its real
//                                           neighbourhood rather than over an error
//   agent_http_stream                       the llama.cpp preset's GET /models is
//                                           answered over the Channel with the canned
//                                           LFM list (a `small` row with a ctx hint);
//                                           every other URL gets an `unreachable`
//                                           chunk, so the other local runtimes read
//                                           as not running (probeLocal yields [])
//   agent_http_abort                        no-op
//   agent_gate                              the AST gate, answered from the head
//                                           token alone: in `write` mode one
//                                           INSERT / UPDATE / DELETE is allowed
//                                           and carries its shape, in `read`
//                                           mode it is refused the way the real
//                                           gate refuses it. No pg_query in a
//                                           browser tab, and no probe needs one
//   agent_write_preview                     the canned dry run below: the same
//                                           twelve-row UPDATE the a4- fixtures
//                                           hold, so a probe that proposes one
//                                           lands the block the frames show
//   agent_thread_truncate / _session_set    nothing: a cut in the harness moves
//   / agent_turns_shift                     the fixture thread on screen and has
//                                           no appdb behind it, so the store's
//                                           idx bookkeeping writes nowhere
//   plugin:opener|open_url                  nothing: a link in the answer text
//                                           asks the opener plugin for the
//                                           browser, and a frame or a probe that
//                                           clicks one never rejects
//   canvas_list                             nothing: the canvas root seeds the
//                                           document AND `loaded`, so the store
//                                           never asks; an empty list is the
//                                           honest answer to a page that has no
//                                           appdb behind it
//   canvas_upsert                           recorded on `canvasUpserts` and
//                                           nothing else: every canvas edit is
//                                           written debounced, and a probe reads
//                                           back what the last one saved, and
//                                           counts them (one write per gesture)
//   canvas_delete                           nothing, for the same reason
//   agent_mcp_serve                         a canned endpoint, its `tools`
//                                           argument recorded on `mcpServed`:
//                                           the token serves exactly the tools
//                                           the run offered (AGENT-SPEC 7), so
//                                           a probe can read back which list a
//                                           canvas-targeted exchange handed it
//   agent_canvas_result                     recorded on `canvasResults` and
//                                           nothing else: the `claude -p`
//                                           bridge's answer to one parked call,
//                                           which in a browser tab has no Rust
//                                           to park it (canvas-agent-spec 2.2)
//   agent_connect / agent_run_readonly /    the `Compare With` path: a session
//   disconnect                              id, then the canned B side of the
//                                           revenue block (one row on B alone,
//                                           so the warn tier has a row), so a
//                                           comparison in the harness builds a
//                                           real diff through the store's own
//                                           buildDiff
//   plugin:clipboard-manager|write_text     recorded on `clipboardWrites` and
//                                           nothing else: every Copy in the pane
//                                           goes through copyCue, whose cue is
//                                           `copy failed` when the write throws,
//                                           so a refused clipboard would make
//                                           every Copy read as broken; a probe
//                                           reads back what the last one wrote
//                                           (the OS clipboard is not a headless
//                                           page's to touch)
//   introspect / execute_stream /           the refresh harness's backend (E2),
//   execute / session_probe / connect /     the only stubs here that take TIME:
//   fetch_cell / editability /              the sketch's timeline IS round trips
//   undo_log_latest                         landing at 700 / 900 / 500 ms, and a
//                                           shim that answered at once would draw
//                                           every surface's cycle in one frame.
//                                           `e2-dead` is the one state where the
//                                           probe answers false and connect
//                                           refuses, so a hard refresh sweeps and
//                                           nothing cycles (R6); the last two are
//                                           the browse path's own bookkeeping, so
//                                           a cell reads editable and no undo is
//                                           offered over a fixture commit
//   everything else                         rejects Error("harness: <cmd> has no fixture")

import type { Channel, InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type {
  EditabilityMap,
  ExecOutcome,
  GateVerdict,
  HttpChunk,
  HttpDone,
  QueryEvent,
  WritePreview,
  WriteVerb,
} from "../ipc/types";
import { useCanvas } from "../stores/canvas";
import { FIXTURE, LOCAL_MODELS_JSON, LOCAL_MODELS_URL } from "./fixtures";
import { B2_PILL_STATES } from "./fixtures.b2pills";
import { B2_POPOVER_STATES, b2ThreadRows } from "./fixtures.b2popover";
import {
  E2_COLUMNS,
  E2_LAT,
  E2_ROWS,
  E2_SESSION,
  E2_USERS as E2_TABLE,
  e2Snapshot,
  e2WidgetResult,
} from "./fixtures.e2";
import { MENTION_STATES, mentionThreadRows } from "./fixtures.mentions";
import { SHELL_THREAD_ROWS } from "./fixtures.shell";
import { structureStats } from "./fixtures.structure";

const harnessState = () => new URLSearchParams(location.search).get("state");

/** every clipboard write the pane has made, oldest first: the harness's
 * clipboard, read by a probe through this module (the frames never look) */
export const clipboardWrites: string[] = [];

/** every canvas the store has written, oldest first: the harness's appdb, read
 * by a probe through this module. A canvas edit is saved debounced, so a probe
 * that adds a block waits for a row here rather than for a repaint */
export const canvasUpserts: { id: string; doc_json: string }[] = [];

/** every canvas call the bridge has answered, oldest first: on the `claude -p`
 * path Rust parks the call and this is the reply it waits for, so a probe reads
 * back the very text the model would have been handed */
export const canvasResults: { callId: string; text: string; isError: boolean }[] = [];

/** the tool list every `agent_mcp_serve` was asked to serve, oldest first:
 * `undefined` is the five (`tools_for(None)`), and a canvas-targeted run's
 * entry names all eight */
export const mcpServed: (string[] | undefined)[] = [];

/** the sibling connection's answer to the revenue block's statement: the same
 * three columns, a currency each, with one row (GBP) on this side alone, so a
 * comparison run in the harness draws both the Δ cells and the warn tier */
const COMPARE_ROWS: (string | null)[][] = [
  ["2401880.00", "505", "INR"],
  ["1740.25", "6", "USD"],
  ["398.00", "2", "AUD"],
  ["312.00", "1", "EUR"],
  ["188.40", "1", "GBP"],
];

const record = (payload: unknown): Record<string, unknown> =>
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

/** the three verbs the write gate allows, read off the statement's head token:
 * the real gate parses, and a browser tab has no parser, but every probe here
 * hands it a statement whose first word is the whole question */
const headVerb = (sql: string): WriteVerb | null => {
  const head = sql.trim().replace(/^(--[^\n]*\n|\s)+/, "").split(/\s|\(/)[0]?.toUpperCase();
  return head === "INSERT" || head === "UPDATE" || head === "DELETE" ? head : null;
};

/** the gate, in whichever mode was asked for. A write in read mode is refused
 * in the read gate's own words, hint included, because that refusal is what
 * sends the model to the final fence (AGENT-SPEC 8.7) */
function gate(sql: string, mode: unknown): GateVerdict {
  const verb = headVerb(sql);
  if (mode !== "write") {
    return verb === null
      ? { allowed: true, reason: null, write: null }
      : {
          allowed: false,
          reason: `${verb[0]}${verb.slice(1).toLowerCase()}Stmt not allowed (only SELECT / WITH...SELECT / EXPLAIN); to change data, put the statement in the final sql fence instead of running it`,
          write: null,
        };
  }
  if (verb === null) {
    return { allowed: false, reason: "only INSERT / UPDATE / DELETE change data", write: null };
  }
  return {
    allowed: true,
    reason: null,
    write: {
      verb,
      table: /\b(?:UPDATE|INTO|FROM)\s+([A-Za-z_][\w.]*)/i.exec(sql)?.[1] ?? "order_v2",
      has_where: /\bWHERE\b/i.test(sql),
      has_returning: /\bRETURNING\b/i.test(sql),
    },
  };
}

/** the canned dry run: the twelve-row UPDATE the a4- fixtures hold, sampled
 * six rows deep (`WRITE_SAMPLE_ROWS`) with two columns moving on every row */
function writePreview(sql: string): WritePreview {
  const shape = gate(sql, "write").write;
  const ids = ["218841", "218903", "218977", "219012", "219054", "219118"];
  const amounts = ["4725.00", "2564.00", "1899.00", "3210.00", "6480.00", "1150.00"];
  const columns = ["id", "payment_status", "paid_at", "total_amount", "currency"];
  const verb = shape?.verb ?? "UPDATE";
  const before = { columns, rows: ids.map((id, i) => [id, "pending", null, amounts[i], "INR"]) };
  const after = {
    columns,
    rows: ids.map((id, i) => [id, "paid", "2026-09-06 16:52", amounts[i], "INR"]),
  };
  return {
    verb,
    table: shape?.table ?? "order_v2",
    has_where: shape?.has_where ?? true,
    exact_rows: 12,
    before: verb === "INSERT" ? { columns: [], rows: [] } : before,
    after: verb === "DELETE" ? { columns: [], rows: [] } : after,
    warnings: shape && !shape.has_where && verb !== "INSERT" ? ["missing_where"] : [],
  };
}

// ---- the refresh harness's backend (E2) ------------------------------------
//
// Five commands with LATENCY, because the sketch's whole timeline is round
// trips landing at different moments: a shim that answered instantly would
// draw every surface's cycle as one frame and prove nothing. `lat` scales all
// three together (0 = instant, for a probe reading the guards rather than the
// choreography); the defaults are the sketch's own 700 / 900 / 500.

const e2Lat = (which: keyof typeof E2_LAT): number => {
  const raw = new URLSearchParams(location.search).get("lat");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : E2_LAT[which];
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let e2Live = true;

/** Whether the refresh harness's connection answers. Flipped by the harness
 * AFTER it has armed heal through the product's own door, because `e2-dead`
 * has to be a connection that WAS alive and died: heal refuses a profile the
 * user never connected, and a harness that skipped the arming would get R6's
 * picture for the wrong reason. */
export function e2SetAlive(alive: boolean): void {
  e2Live = alive;
}

const e2Alive = (): boolean => e2Live;

/** what the refresh harness's backend was asked for, and WHEN. The DOM says
 * whether a surface blanked; only this says when the refetch behind it went
 * out — and R3's grace runs from that moment, not from the gesture, because
 * the hard tier cannot send anything until its heal has answered. A probe
 * with only the gesture's t0 would read every surface as late (the clipboard
 * recorder's own reason: the harness records what the product SENT) */
const e2Calls: { cmd: string; t: number }[] = [];

const e2Say = (cmd: string): void => {
  e2Calls.push({ cmd, t: performance.now() });
};

/** the log starts when the window is the window the gesture arrives at: the
 * seed's own connect and probe are the harness building the picture, and a
 * reader of this log is asking what the ACT sent */
export function e2ResetCalls(): void {
  e2Calls.length = 0;
}

const isWrite = (sql: string): boolean =>
  /^(insert|update|delete)\b/i.test(sql.trim().replace(/^(--[^\n]*\n|\s)+/, ""));

/** the fixture page, streamed as the driver streams one: a statement, its
 * columns, its rows and the two dones. A write gets the affected count and no
 * rows, which is what `e2-query-wrote` stands on */
async function e2Stream(payload: InvokeArgs | undefined): Promise<void> {
  const args = record(payload);
  const sql = typeof args.sql === "string" ? args.sql : "";
  const channel = args.onEvent as Channel<QueryEvent> | undefined;
  const send = (ev: QueryEvent) => channel?.onmessage(ev);
  await wait(e2Lat("rows"));
  send({ type: "statement_start", index: 0, sql });
  const write = isWrite(sql);
  if (!write) {
    send({ type: "columns", index: 0, columns: E2_COLUMNS });
    send({ type: "rows", index: 0, rows: E2_ROWS.map((r) => [...r]), truncated: [] });
  }
  send({
    type: "statement_done",
    index: 0,
    affected: write ? 1 : null,
    ms: 38.4,
    row_count: write ? 0 : E2_ROWS.length,
    capped: false,
  });
  send({ type: "finished", total_ms: 38.4 });
}

/** the one-shot commands: the browse footer's exact count, the switcher's
 * database list, a transaction's own COMMIT. One statement each, so nothing
 * on the read path has to special-case an empty outcome */
function e2Execute(sql: string): ExecOutcome {
  const count = /count\(/i.test(sql);
  return {
    statements: [
      {
        index: 0,
        sql,
        columns: count ? [{ name: "count", type_oid: 20, table_oid: 0, attnum: 1 }] : [],
        rows: count ? [[String(842_113)]] : [],
        affected: null,
        ms: 11.2,
      },
    ],
  };
}

/** the users result's own map: every column of the one table, the PK on `id`,
 * so a staged edit in the harness is the same staged edit the product makes */
function e2Editability(statementIndex: unknown): EditabilityMap {
  const oid = E2_TABLE.table_oid;
  return {
    statement_index: typeof statementIndex === "number" ? statementIndex : 0,
    columns: E2_COLUMNS.map((c, col) => ({
      col,
      table_oid: oid,
      attnum: c.attnum,
      editable: c.name !== "id",
      reason: c.name === "id" ? "primary key" : null,
      type_name: E2_TABLE.columns.find((t) => t.name === c.name)?.type ?? "text",
      cast: E2_TABLE.columns.find((t) => t.name === c.name)?.type ?? "text",
      is_ctid: false,
      warn: null,
    })),
    pk_cols: { [oid]: [0] },
    tables: { [oid]: `${E2_TABLE.schema}.${E2_TABLE.name}` },
    table_refs: { [oid]: { schema: E2_TABLE.schema, name: E2_TABLE.name } },
  };
}

export function installTauriShim(): void {
  mockWindows("main");
  // the recorders, on the window: a probe drives this page over CDP and has no
  // module handle, and these four arrays are the harness's whole record of
  // what the product wrote. The frames never look, and neither does the app.
  // Beside them, `canvas` is the document store itself, put here for the same
  // reason: a probe that drives a gesture has to read the cell the STORE
  // holds, not the cell the DOM happens to be animating toward (D4)
  (window as unknown as { __harness?: unknown }).__harness = {
    clipboardWrites,
    canvasUpserts,
    canvasResults,
    mcpServed,
    canvas: useCanvas,
    e2Calls,
  };
  mockIPC(
    (cmd, payload) => {
      switch (cmd) {
        case "agent_thread_list": {
          const st = harnessState() ?? "";
          if (st === "threads") return SHELL_THREAD_ROWS;
          // the W6 states and B2's pill draft share one connection's threads;
          // the B2 popover four have their own five, three of which fill the
          // box's `Threads` section
          if ((B2_POPOVER_STATES as readonly string[]).includes(st)) return b2ThreadRows();
          const w6 =
            (MENTION_STATES as readonly string[]).includes(st) ||
            (B2_PILL_STATES as readonly string[]).includes(st);
          return w6 ? mentionThreadRows() : [FIXTURE.threadRow];
        }
        case "agent_key_has":
          return false;
        // the palette's own history query (PaletteHarness): no rows, so the
        // History group is absent, which is what a fresh connection shows
        case "history_search":
          return [];
        // the Structure view asks for these on mount (StructureHarness): the
        // canned stats of the wave's order_v2
        case "table_stats":
          return structureStats();
        case "agent_http_stream":
          return httpStream(payload);
        // the refresh harness's five (E2): the schema, the rows, the one-shot
        // reads, and the two the hard tier's heal turns on
        case "introspect":
          e2Say("introspect");
          return wait(e2Lat("tree")).then(() => e2Snapshot);
        case "execute_stream":
          e2Say("execute_stream");
          return e2Stream(payload);
        case "execute": {
          const sql = typeof record(payload).sql === "string" ? String(record(payload).sql) : "";
          // a canvas widget's refetch is the one `execute` the sketch gives a
          // landing of its own: it waits that widget's round trip and answers
          // with that widget's rows, so the canvas frame shows a refetch that
          // LANDED rather than three error strips
          const w = e2WidgetResult(sql);
          e2Say(w ? `widget:${w.id}` : "execute");
          if (!w) return e2Execute(sql);
          return wait(w.lat).then(() => ({
            statements: [
              { index: 0, sql, columns: w.columns, rows: w.rows, affected: null, ms: w.ms },
            ],
          }));
        }
        case "session_probe":
          e2Say("session_probe");
          return e2Alive();
        case "connect":
          e2Say("connect");
          if (!e2Alive()) throw new Error("connection refused");
          return E2_SESSION;
        case "fetch_cell":
          return wait(e2Lat("cell")).then(() => null);
        // the browse path's bookkeeping: without a map every cell reads as
        // uneditable, which is a different picture from the product's
        case "editability":
          return e2Editability(record(payload).statementIndex);
        case "undo_log_latest":
          return null;
        case "agent_gate": {
          const args = record(payload);
          return gate(typeof args.sql === "string" ? args.sql : "", args.mode);
        }
        case "agent_write_preview": {
          const args = record(payload);
          return writePreview(typeof args.sql === "string" ? args.sql : "");
        }
        case "agent_mcp_serve": {
          const tools = record(payload).tools;
          mcpServed.push(Array.isArray(tools) ? tools.map(String) : undefined);
          return { url: "http://127.0.0.1:0/mcp", token: "harness-token" };
        }
        case "agent_canvas_result": {
          const args = record(payload);
          canvasResults.push({
            callId: typeof args.callId === "string" ? args.callId : "",
            text: typeof args.text === "string" ? args.text : "",
            isError: args.isError === true,
          });
          return undefined;
        }
        case "canvas_list":
          return [];
        case "canvas_upsert": {
          const row = record(record(payload).row);
          canvasUpserts.push({
            id: typeof row.id === "string" ? row.id : "",
            doc_json: typeof row.doc_json === "string" ? row.doc_json : "",
          });
          return undefined;
        }
        case "agent_connect":
          return "harness-session";
        case "agent_run_readonly":
          return {
            columns: ["revenue", "order_count", "currency"],
            rows: COMPARE_ROWS.map((r) => [...r]),
            row_count: COMPARE_ROWS.length,
            capped: false,
            ms: 388.1,
          };
        case "plugin:clipboard-manager|write_text": {
          const text = record(payload).text;
          clipboardWrites.push(typeof text === "string" ? text : "");
          return undefined;
        }
        case "agent_http_abort":
        case "canvas_delete":
        case "disconnect":
        case "agent_thread_truncate":
        case "agent_thread_session_set":
        case "agent_turns_shift":
        case "plugin:opener|open_url":
          return undefined;
        default:
          throw new Error(`harness: ${cmd} has no fixture`);
      }
    },
    { shouldMockEvents: true },
  );
}

installTauriShim();
