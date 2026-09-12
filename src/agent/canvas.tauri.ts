// CanvasTools over the read gate and the canvas document (canvas-agent-spec
// sections 1 and 2). The third file under src/agent allowed to import Tauri and
// a store, and the ONE implementation of the canvas tools: the `claude -p`
// child reaches these same functions over the MCP bridge rather than through a
// Rust mirror, so a cap or a reply format can never drift between the paths.
//
// LESSONS 3 is the rule this file is written around. `canvasId` is captured at
// construction and never re-read from a store after an await; no tool takes a
// canvas id, so a model cannot write outside the exchange's own target.
//
// The one wire-to-domain conversion still belongs to tools.tauri.ts: this file
// borrows `toDomainRun` rather than reading a snake_case field of its own.

import { agentCanvasResult, agentRunReadonly } from "../ipc/commands";
import type { CanvasToolCall, CanvasToolImage } from "../ipc/types";
import { useSettings } from "../stores/settings";
import {
  facesOf,
  useCanvas,
  type ModelBlockInput,
  type ResultBlock,
} from "../stores/canvas";
import { formatRun } from "./context";
import { toDomainRun } from "./tools.tauri";
import {
  CANVAS_BLOCK_ROWS,
  CANVAS_ECHO_ROWS,
  CANVAS_EXCHANGE_MAX,
  RUN_SQL_TIMEOUT_MS,
  blockLine,
  cellPart,
  clampPlace,
  gist,
  handleOf,
  outlineLine,
  outlineText,
  parseCanvasBlock,
  parseCanvasBlocks,
  resolveHandle,
  rowsPart,
  type CanvasOutline,
  type CanvasOutlineEntry,
  type CanvasTools,
  type CanvasWriteResult,
  type ModelBlock,
  type ModelCell,
  type ToolOutcome,
} from "./tools";
import type { AgentRun, CanvasFace } from "./types";

/** What the document must offer for a model's blocks to land (canvas-agent-spec
 * section 2.1), a subset of the canvas store's own surface. Every method is ONE
 * `setDoc`, so the debounce, the retry and the broken-document guard are
 * inherited whole and a batch of blocks is written or not written together.
 * `ModelBlockInput` is the DOCUMENT's declaration, imported rather than
 * restated: the status line and the row cap are its own, and a second copy of
 * the shape here would drift on the first field (DESIGN rule 14). */
export interface CanvasStore {
  /** append, at the end or after a named block; returns the ids in order */
  applyModelBlocks(
    canvasId: string,
    blocks: readonly ModelBlockInput[],
    after?: string,
  ): string[];
  /** how many columns wide this canvas is laid out, for `at` and for the
   * outline's head. ADVISORY: a canvas no tab is measuring answers the
   * fallback, and nothing refuses for it (LESSONS 5) */
  columns(canvasId: string): number;
  /** Replace one block, keeping its position and the `askedFrom` link the old
   * one carried. Returns the NEW block's id, or null when no block of that id
   * stands: the block that was there is gone, its name released and the
   * exchange that wrote it no longer counting it, so the handle changes and
   * the reply says the new one. */
  replaceBlock(canvasId: string, blockId: string, block: ModelBlockInput): string | null;
  /** the document as it stands, in reading order */
  outline(canvasId: string): CanvasOutlineEntry[];
  /** C2b: one drawing's PNG, or null when that block holds no ink. The
   * DOCUMENT renders it, because the document owns the strokes and the agent
   * layer must not import the canvas surface's renderer (`canvas/port.ts`'s
   * rule, in the other direction). Optional because a build whose canvas
   * cannot draw is a real state and not an error: `canvas_read` then answers
   * the block's line, which is what it answers for every other kind
   * (DESIGN rule 2's matrix). */
  drawingImage?(canvasId: string, blockId: string): Promise<CanvasToolImage | null>;
}

export type { ModelBlockInput };

export interface CanvasToolsInit {
  /** the thread's dedicated read-only session (agent_connect) */
  sessionId: string;
  /** FIXED here: no tool takes a canvas id */
  canvasId: string;
  /** the target's title, for the CANVAS block, the replies and the cue */
  title: string;
  /** the exchange these blocks belong to (`wroteBy`) */
  exchangeId: string;
  /** the question, worn by the first block this exchange writes */
  question: string;
  /** overrides the statement_timeout setting; 0 falls through to the
   * AGENT-SPEC 5 default, exactly as the setting's own 0 does */
  timeoutMs?: number;
  /** the document. Injectable so the contract is testable without a store */
  store?: CanvasStore;
  /** the read gate. Injectable for the same reason; nothing else may run SQL */
  run?: (sql: string, maxRows: number, timeoutMs: number) => Promise<AgentRun>;
}

const firstLine = (e: unknown): string => {
  const raw =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : ((e as { message?: string } | null)?.message ?? String(e));
  return raw.split("\n")[0].trim() || "the query failed";
};

const fail = (text: string): ToolOutcome<never> => ({
  textForModel: text,
  result: null,
  error: text.replace(/^ERROR: /, ""),
});

/** The block these rows are about to become, so every question about them is
 * asked of the DOCUMENT rather than answered a second time here (`facesOf`,
 * the store: a chart's own rule, and the four-column ceiling on a figure row
 * that ScalarResult draws to). */
function candidate(sql: string, run: AgentRun): ResultBlock {
  return {
    id: "",
    kind: "result",
    question: "",
    prose: "",
    sql,
    columns: run.columns,
    rows: run.rows,
    chips: [],
    status: "",
    ms: run.ms,
    face: "table",
  };
}

/** the order a model-written block PREFERS its faces in: the chart when the
 * rows make one, the values when they are one figure row, the table when
 * there are rows, the SQL always (canvas-agent 3.3) */
const FACE_ORDER: readonly CanvasFace[] = ["chart", "values", "table", "sql"];

/** Which faces these rows can wear, in that order. The set is the document's
 * own answer, filtered into the tool's preference: a face this reply names is
 * therefore a face the block will be standing on (LESSONS 13, one reading). */
function facesFor(sql: string, run: AgentRun): CanvasFace[] {
  const can = facesOf(candidate(sql, run));
  return FACE_ORDER.filter((f) => can.includes(f));
}

/** The face a block opens on, and what the reply says when the model asked for
 * one these rows cannot wear. Never a refusal and never an empty face: the
 * statement was good, only the guess was wrong (DESIGN rule 11). */
function faceFor(
  sql: string,
  run: AgentRun,
  wanted: CanvasFace | undefined,
): { face: CanvasFace; fell?: string } {
  const faces = facesFor(sql, run);
  if (wanted && faces.includes(wanted)) return { face: wanted };
  const face = faces[0];
  return wanted ? { face, fell: `no ${wanted} face for these rows, on its ${face}` } : { face };
}

/** The rows the model reads back: five, under the run's own total. The
 * document's own truncation is stated on the block's line, so this tail states
 * nothing but the echo's (`capped` is the document's fact, not the echo's). */
const echoOf = (run: AgentRun): string =>
  formatRun({ ...run, rows: run.rows.slice(0, CANVAS_ECHO_ROWS), capped: false });

/** `keeping 200 of 1,842 rows`, only when the document dropped some: the model
 * writing a note must not be able to claim it saw rows the block never kept. */
const keptPart = (run: AgentRun): string | null =>
  run.capped
    ? `keeping ${run.rows.length.toLocaleString()} of ${run.rowCount.toLocaleString()} rows`
    : null;

/** One block on its way to the document, with the two things the TOOL needs
 * that the document does not: the run WHOLE (its `capped` flag is the echo's
 * business, and the block keeps only the rows), and the face this call fell
 * back to when the model asked for one the rows cannot wear. */
interface Written {
  input: ModelBlockInput;
  run: AgentRun | null;
  fell?: string;
  /** what the canvas could not give of the place the model asked for, in the
   * same voice as `fell`: the geometry was out of reach, the block was not */
  said: string[];
  /** where the block stands NOW, read back off the document after it landed */
  cell?: ModelCell;
}

/** the same block under the id and the cell the document reported for it */
function landed(w: Written, id: string, cells: Map<string, ModelCell>): Written {
  const cell = cells.get(id);
  return { ...w, input: { ...w.input, id }, ...(cell ? { cell } : {}) };
}

/** where each block stands now, off the document. The engine may have pushed a
 * block down to clear the cells the model asked for, so the reply names where
 * the block IS and never where it was aimed (LESSONS 13). */
const cellsOf = (blocks: readonly CanvasOutlineEntry[]): Map<string, ModelCell> =>
  new Map(blocks.flatMap((b) => (b.cell ? ([[b.id, b.cell]] as [string, ModelCell][]) : [])));

/** One written block's stanza: its line, then a result's own rows under it. */
function stanzaOf(w: Written): string {
  const b = w.input;
  if (b.kind === "note" || w.run === null) {
    return blockLine(b.id, b.kind, [
      gist(b.kind === "note" ? b.text : (b.title ?? "")),
      cellPart(w.cell),
      ...w.said,
    ]);
  }
  const line = blockLine(b.id, "result", [
    gist(b.title ?? b.question ?? rowsPart(w.run.rowCount, w.run.columns)),
    `${b.face} face`,
    keptPart(w.run),
    w.fell,
    cellPart(w.cell),
    ...w.said,
  ]);
  return `${line}\n${echoOf(w.run)}`;
}

export function createCanvasTools(init: CanvasToolsInit): CanvasTools {
  const { canvasId, title, exchangeId } = init;
  const store: CanvasStore = init.store ?? liveStore();
  // the same rule as tools.tauri.ts: the setting's 0 means "no timeout" for a
  // SESSION, which is not a shape a tool call has, so it falls through to the
  // section 5 default rather than down to agent.rs's one-second floor
  const timeout = () => {
    const ms = init.timeoutMs ?? useSettings.getState().statementTimeoutSecs * 1000;
    return ms > 0 ? ms : RUN_SQL_TIMEOUT_MS;
  };
  const runSql =
    init.run ??
    (async (sql: string, maxRows: number, timeoutMs: number) =>
      toDomainRun(await agentRunReadonly(init.sessionId, sql, maxRows, timeoutMs)));

  /** Every block this exchange put on the canvas, in write order, read off
   * the seam that landed them and never off the model's own count of what it
   * meant to write (LESSONS 13). This is the provenance record a cut deletes.
   * The exchange CAP is a separate count, of appends alone: a replace is the
   * way out the cap's own refusal names, so it cannot spend the budget. */
  const written: string[] = [];
  let appended = 0;
  let replaced = 0;
  const outline = () => store.outline(canvasId);
  const columns = () => store.columns(canvasId);
  const result = (): CanvasWriteResult => ({ canvasId, blockIds: [...written], replaced });

  /** Build the document's input for one block, running a result's statement
   * through the read gate first. A refused statement lands no block and comes
   * back in the gate's own words, first line, exactly as run_sql's does. */
  async function buildOne(
    block: ModelBlock,
    first: boolean,
    cols: number,
  ): Promise<Written | string> {
    // minted HERE, in one place: Rust never mints a block id (it is a bridge)
    // and the document never mints one for a model block
    const id = crypto.randomUUID();
    const question = first ? init.question : undefined;
    // the place, as far as this side can know it: the column count is the one
    // bound a tool holds, and the cells a block would overlap are the
    // document's own business (the engine pushes them down, never refuses)
    const { at, span, said } = clampPlace(block, cols);
    const place = { ...(at ? { at } : {}), ...(span ? { span } : {}) };
    if (block.kind === "note") {
      return {
        input: {
          id,
          kind: "note",
          text: block.text,
          ...(question ? { question } : {}),
          wroteBy: exchangeId,
          ...place,
        },
        run: null,
        said,
      };
    }
    let run: AgentRun;
    try {
      run = await runSql(block.sql, CANVAS_BLOCK_ROWS, timeout());
    } catch (e) {
      return `ERROR: ${firstLine(e)}`;
    }
    const { face, fell } = faceFor(block.sql, run, block.face);
    return {
      input: {
        id,
        kind: "result",
        sql: block.sql,
        run,
        face,
        ...(block.title ? { title: block.title } : {}),
        ...(block.note ? { note: block.note } : {}),
        ...(question ? { question } : {}),
        wroteBy: exchangeId,
        ...place,
      },
      run,
      ...(fell ? { fell } : {}),
      said,
    };
  }

  const tools: CanvasTools = {
    canvasId,
    title,
    outline,
    columns,

    async write(args: unknown): Promise<ToolOutcome<CanvasWriteResult>> {
      const a = record(args);
      const parsed = parseCanvasBlocks(a.blocks);
      if (!parsed.ok) return fail(parsed.error);
      const blocks = parsed.value;
      if (appended + blocks.length > CANVAS_EXCHANGE_MAX) {
        return fail(
          `ERROR: this exchange has already written ${appended} ` +
            `${appended === 1 ? "block" : "blocks"} to "${title}"; ` +
            `${CANVAS_EXCHANGE_MAX} is the cap. Replace one instead of adding another`,
        );
      }
      // resolved BEFORE the runs: an `after` that named a block the user
      // deleted meanwhile is a refusal, never a silent append at the end
      let after: string | undefined;
      if (a.after !== undefined) {
        const at = resolveHandle(idsOf(outline()), a.after);
        if (!at.ok) return fail(at.error);
        after = at.value;
      }
      // read once, before the first statement runs: a measure that arrives
      // mid-call would clamp two blocks of one batch against two grids
      const cols = columns();
      const built: Written[] = [];
      for (const block of blocks) {
        const one = await buildOne(block, appended === 0 && built.length === 0, cols);
        if (typeof one === "string") return fail(one);
        built.push(one);
      }
      // one synchronous batch, after every await has settled: two calls of one
      // turn interleave at CALL granularity and never at block granularity
      const ids = store.applyModelBlocks(canvasId, built.map((b) => b.input), after);
      written.push(...ids);
      appended += ids.length;
      const cells = cellsOf(outline());
      const head = `Wrote ${ids.length} ${ids.length === 1 ? "block" : "blocks"} to "${title}".`;
      // the handles come from the ids the DOCUMENT reports, so the reply can
      // never name a block the canvas does not hold under that name
      return {
        textForModel: [
          head,
          ...built.map((b, i) => stanzaOf(ids[i] ? landed(b, ids[i], cells) : b)),
        ].join("\n"),
        result: result(),
      };
    },

    async replace(args: unknown): Promise<ToolOutcome<CanvasWriteResult>> {
      const a = record(args);
      const standing = outline();
      const at = resolveHandle(idsOf(standing), a.block_id);
      if (!at.ok) return fail(at.error);
      const target = standing.find((b) => b.id === at.value);
      // the consent rule as a gate rather than a sentence: a block with no
      // exchange behind it is the user's own work, and a model never rewrites
      // that. Its own blocks, and another model answer's, stay replaceable
      if (target && !target.modelWritten) {
        return fail(
          `ERROR: block '${handleOf(at.value)}' is the user's own. ` +
            `Write a new block instead of replacing one you did not write`,
        );
      }
      const parsed = parseCanvasBlock(a.block);
      if (!parsed.ok) return fail(parsed.error);
      // a replace never wears the question: the document carries the old
      // block's provenance link over, which is its own to carry
      const one = await buildOne(parsed.value, false, columns());
      if (typeof one === "string") return fail(one);
      const newId = store.replaceBlock(canvasId, at.value, one.input);
      if (newId === null) {
        return fail(
          `ERROR: no block '${handleOf(at.value)}' on this canvas. Call canvas_read for the block ids`,
        );
      }
      // a replace is a write: this exchange is answerable for what stands
      // there now, so a cut of it takes the block with it. The handle is the
      // document's new one, printed on the stanza the model reads next
      if (!written.includes(newId)) written.push(newId);
      replaced += 1;
      return {
        textForModel: [
          `Replaced ${handleOf(at.value)} in "${title}".`,
          stanzaOf(landed(one, newId, cellsOf(outline()))),
        ].join("\n"),
        result: result(),
      };
    },

    async read(args: unknown): Promise<ToolOutcome<CanvasOutline>> {
      const blocks = outline();
      const cols = columns();
      // `null` reads as absent, not as a refusal: it is what a client that
      // cannot omit a field sends for one, and the whole canvas is what that
      // model asked for (LESSONS 5)
      const asked = record(args).block_id ?? undefined;
      if (asked === undefined) {
        return {
          textForModel: outlineText(title, blocks, cols),
          result: { canvasId, title, columns: cols, blocks },
        };
      }
      const at = resolveHandle(idsOf(blocks), asked);
      if (!at.ok) return fail(at.error);
      const one = blocks.find((b) => b.id === at.value);
      // the handle was resolved against THESE ids, so the miss is the type's
      // and not the document's; it still names the way out rather than throwing
      if (!one) {
        return fail(
          `ERROR: no block '${handleOf(at.value)}' on this canvas. Call canvas_read for the block ids`,
        );
      }
      // one block, one line, no head over it: the column count and the block
      // count reached the model with the CANVAS block of its own question, and
      // a header repeating them above a single line is text that says nothing
      // (DESIGN rule 11). A drawing adds its picture; every other kind reads
      // exactly as it reads inside the whole outline (LESSONS 13).
      const ink = one.kind === "drawing" ? await inkOf(store, canvasId, one.id) : {};
      return {
        textForModel: ink.said ? `${outlineLine(one)}\n${ink.said}` : outlineLine(one),
        result: { canvasId, title, columns: cols, blocks: [one] },
        ...(ink.image ? { image: ink.image } : {}),
      };
    },

    serve(onWrite: (out: CanvasWriteResult) => void): () => void {
      return listenForCalls(init.sessionId, tools, onWrite);
    },
  };
  return tools;
}

const idsOf = (blocks: readonly CanvasOutlineEntry[]): string[] => blocks.map((b) => b.id);

/** what a drawing read found: a picture, or a line saying why there is none.
 * Both are absent for an empty drawing, which its own outline line already
 * reports as empty and which needs no second sentence about it. */
interface Ink {
  image?: CanvasToolImage;
  said?: string;
}

/** One drawing's PNG, through the document. A renderer that throws costs the
 * PICTURE and not the answer: the block's line still stands, the model is told
 * in one line why it is reading one, and the cause reaches the console rather
 * than nowhere (LESSONS 9, the tx-state precedent). The same wording the Rust
 * door uses when an image cannot travel, because it is the same fact. */
async function inkOf(store: CanvasStore, canvasId: string, blockId: string): Promise<Ink> {
  if (!store.drawingImage) return {};
  try {
    const image = await store.drawingImage(canvasId, blockId);
    return image ? { image } : {};
  } catch (e) {
    console.error("drawingImage failed", e);
    return { said: "the drawing could not be rendered, so this reply carries the text alone" };
  }
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The document, through the store. Each method reads the store at the moment
 * it is called rather than capturing it (LESSONS 3; the canvas ID is what IS
 * captured, in createCanvasTools). */
function liveStore(): CanvasStore {
  return {
    applyModelBlocks: (canvasId, blocks, after) =>
      useCanvas.getState().applyModelBlocks(canvasId, blocks, after),
    replaceBlock: (canvasId, blockId, block) =>
      useCanvas.getState().replaceBlock(canvasId, blockId, block),
    outline: (canvasId) => useCanvas.getState().outline(canvasId),
    // the document's own count, which the surface writes as it measures. A
    // canvas no tab is laid out on has none yet, and the fallback informs the
    // model rather than refusing it a place (LESSONS 5)
    columns: (canvasId) => useCanvas.getState().columnsOf(canvasId),
    // the drawing's PNG, rendered by the DOCUMENT: the same call the `Ask`
    // button beside the element makes, so a person and a model are handed one
    // picture and not two (LESSONS 13)
    drawingImage: (canvasId, blockId) => useCanvas.getState().drawingImage(canvasId, blockId),
  };
}

// ---- the `claude -p` bridge (canvas-agent-spec section 2.2) -----------------
//
// The child talks to qwry's own MCP server, which holds no canvas logic at all
// (a mirrored implementation in Rust would double the file's largest debt and
// drift on the first cap change). Rust emits one event per canvas call and
// parks a oneshot; this answers it with the very text the HTTP path returns.

/** the answer to a call for a session that has no tools any more: its
 * exchange ended, or it never had a target. Spec 2.2's own text, and the
 * reason this side answers instead of returning early - an event nobody
 * answers costs the child its whole 20 s and then tells it the canvas did not
 * answer, which is a worse account of the same fact (LESSONS 9). */
const CANVAS_NOT_OPEN = "ERROR: the canvas is not open for this thread";

/** the sessions serving canvas calls right now, one registration each: a
 * second `serve` for a session replaces the first, since a thread runs one
 * exchange at a time and the newer tools are the live ones. */
const serving = new Map<string, { tools: CanvasTools; onWrite: (out: CanvasWriteResult) => void }>();
/** the one listener the whole app needs, up while any session is registered */
let unlistenAll: (() => void) | null = null;
let listening = false;

/** Serve this session's canvas calls until the returned stop is called. The
 * registration's life is the exchange's: the loop starts it before the child
 * exists and stops it in the same `finally` that ends the run. Every event
 * that arrives while ANY session is registered is answered, the registered
 * ones by their own tools and the rest by CANVAS_NOT_OPEN, so a disposed
 * session's late call reads as what it is rather than as silence. */
function listenForCalls(
  sessionId: string,
  tools: CanvasTools,
  onWrite: (out: CanvasWriteResult) => void,
): () => void {
  serving.set(sessionId, { tools, onWrite });
  if (!listening) {
    listening = true;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<CanvasToolCall>("canvas-tool-call", (ev) => {
          const held = serving.get(ev.payload.session_id);
          if (held) void answer(ev.payload, held.tools, held.onWrite);
          else void reply(ev.payload.call_id, CANVAS_NOT_OPEN, true);
        }),
      )
      .then((un) => {
        if (serving.size === 0) {
          listening = false;
          un();
        } else unlistenAll = un;
      })
      // a subscription that cannot be made is reported, never left to reject
      // unhandled: what goes quiet is the child's canvas call, and silence is
      // what a failure must never be (LESSONS 9, the tx-state precedent)
      .catch((e) => {
        listening = false;
        console.error("canvas-tool-call listen failed", e);
      });
  }
  return () => {
    // only this registration's own entry: a newer exchange on the same session
    // has already replaced it, and stopping the old run must not silence the
    // new one
    if (serving.get(sessionId)?.tools === tools) serving.delete(sessionId);
    if (serving.size === 0 && unlistenAll) {
      unlistenAll();
      unlistenAll = null;
      listening = false;
    }
  };
}

async function answer(
  call: CanvasToolCall,
  tools: CanvasTools,
  onWrite: (out: CanvasWriteResult) => void,
): Promise<void> {
  let out: ToolOutcome<CanvasWriteResult | CanvasOutline>;
  const args = safeParse(call.args_json);
  if (args === undefined) {
    out = fail(`ERROR: arguments were not valid JSON: ${call.args_json.slice(0, 200)}`);
  } else if (call.name === "canvas_write") {
    out = await tools.write(args);
  } else if (call.name === "canvas_replace") {
    out = await tools.replace(args);
  } else if (call.name === "canvas_read") {
    out = await tools.read(args);
  } else {
    out = fail(`ERROR: unknown tool '${call.name}'`);
  }
  if (out.result && "blockIds" in out.result) onWrite(out.result);
  await reply(call.call_id, out.textForModel, !!out.error, out.image);
}

async function reply(
  callId: string,
  text: string,
  isError: boolean,
  image?: CanvasToolImage,
): Promise<void> {
  try {
    await agentCanvasResult(callId, text, isError, image);
  } catch (e) {
    // the child's own timeout is then the only answer, and it says the same
    // thing this side would have said (tools.ts CANVAS_BRIDGE_LOST); report it
    // here so the cause is visible rather than a 20 s pause (LESSONS 9)
    console.error("agent_canvas_result failed", e);
  }
}

function safeParse(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
