// Module map for src/agent (AGENT-SPEC section 2 is the authority; this is the
// index, not a second spec). TypeScript owns the loop, Rust owns the database.
//
//   tools.schema.json   the five tool schemas, section 5. ONE source of truth:
//                       this file imports it and agent_mcp.rs include_str!s it
//   tools.ts            this file: TOOL_SCHEMAS + the AgentTools interface
//   tools.tauri.ts      AgentTools over Tauri commands (the app)
//   loop.ts             the turn loop, section 4; streams events to the store
//   context.ts          prefilter, index, candidate assembly, sections 4.1-4.2
//   risk.ts             risky-shape classifier, section 4.4
//   prompt.ts           frozen system prompt + PROMPT_VERSION, section 6
//   extract.ts          tolerant SQL/assumption/answer extraction, section 4.6
//   types.ts            shared value types (runs, verdicts, chips, trace)
//   platform.tauri.ts   Platform over Tauri commands
//   providers/          Provider interface, adapters, presets, registry (7)
//   ../stores/agent.ts  zustand: threads, turns, chips, sanity, trace, status
//   eval/tools.node.ts, eval/platform.node.ts   the same interfaces over pg
//
// Rules that bind every file here: only Rust talks to PostgreSQL; nothing under
// src/agent except *.tauri.ts imports Tauri or a store at runtime; keys live in
// the Keychain and never enter this layer.

import schema from "./tools.schema.json";
import type { ToolSchema } from "./providers/types";
import type {
  AgentRun,
  SanityFragment,
  ToolName,
} from "./types";

export type { ToolName } from "./types";

/** The five tools every provider sees, rendered per wire format by each
 * adapter. Byte-identical to what agent_mcp.rs serves, because both sides read
 * tools.schema.json. Anthropic caches the tools+system prefix, so the array
 * must stay stable between requests of a thread or the whole prefix misses. */
export const TOOL_SCHEMAS: readonly ToolSchema[] = schema.tools;

/** Bumped whenever tools.schema.json changes; EVAL baselines are tied to it
 * alongside PROMPT_VERSION. */
export const TOOL_SCHEMA_VERSION: number = schema.version;

export const TOOL_NAMES: readonly ToolName[] = [
  "list_tables",
  "describe_tables",
  "peek_values",
  "run_sql",
  "probe",
];

/** The gate's refusal for a `run_sql` argument that is not a statement at all
 * (agent.rs `PROSE_REASON`, served verbatim by both tool layers). Mirrored
 * here as a substring, not re-worded: the loop and the claude adapter count
 * two of these in a row and end the exchange with the model's own prose
 * rather than watching it re-explain itself to the turn cap (W7). */
export const PROSE_REFUSAL = "this is prose, not SQL";

/** Whether a tool result is that refusal. The text arrives wrapped as
 * `ERROR: <first line>` on every path, so the match is on the substring. */
export const isProseRefusal = (text: string): boolean => text.includes(PROSE_REFUSAL);

/** Two in a row ends the exchange. One is a mistake the model can correct on
 * the next turn; two is the spiral (W7: twelve turns of the same refusal). */
export const PROSE_STRIKES = 2;

/** Rows shown to the MODEL in a run_sql or probe result (section 5). Never
 * lower it to save tokens: the lean variant did and looped to the turn cap
 * re-querying what it could not see. Prune history instead. */
export const MODEL_ROW_CAP = 50;

/** Rows kept for the UI grid; the full result the user scrolls (section 5). */
export const UI_ROW_CAP = 2000;

/** peek_values upper bound, matching the schema's `maximum`. */
export const PEEK_MAX = 50;

/** probe takes at most this many queries, each capped at PROBE_ROW_CAP rows. */
export const PROBE_MAX = 6;
export const PROBE_ROW_CAP = 5;

/** run_sql's timeout when the statement_timeout setting names none (section 5).
 * The setting's 0 means "no timeout" for a SESSION, which is not a shape a tool
 * call has: agent.rs clamps a tool timeout to a one-second floor, so 0 has to
 * land here rather than there. agent_mcp.rs::RUN_SQL_TIMEOUT_MS is the same
 * number for the child process that cannot read the setting. */
export const RUN_SQL_TIMEOUT_MS = 10_000;

/** Every AgentTools method returns BOTH halves of a tool call: `textForModel`
 * is exactly what goes back into the conversation, `result` is the structured
 * data the UI keeps (grid rows, sanity fragments, trace entries). Neither is
 * derived from the other later: rendering a result twice from one source is
 * how a trace starts disagreeing with what the model actually saw.
 *
 * `error` is set when the call failed. It is not an exception: a failed tool
 * call is normal (the repair loop feeds `textForModel` straight back, in the
 * `ERROR: <first line>` shape section 5 mandates), so `textForModel` is always
 * present and `result` is null. */
export interface ToolOutcome<T> {
  textForModel: string;
  result: T | null;
  error?: string;
}

/** One table as `list_tables` reports it. */
export interface TableBrief {
  schema: string;
  name: string;
  /** planner estimate (reltuples), not a count */
  approxRows: number;
  comment: string | null;
}

/** One described table: the DDL text the model reads is composed by the
 * implementation from the cached schema snapshot plus pg_stats values, so the
 * structured half carries the pieces the UI wants to show. */
export interface TableDescription {
  schema: string;
  name: string;
  comment: string | null;
  columns: {
    name: string;
    type: string;
    notNull: boolean;
    isPrimaryKey: boolean;
    references: { schema: string; name: string; column: string } | null;
    comment: string | null;
    /** low-cardinality values from pg_stats, at most 20 */
    values: string[];
  }[];
}

export interface PeekOutcome {
  table: string;
  column: string;
  values: string[];
  /** more distinct values exist than were returned */
  more: boolean;
  /** a big table: the values come from a bounded sample, not the whole table */
  sampled: boolean;
}

export interface ProbeOutcome {
  sql: string;
  run: AgentRun | null;
  error: string | null;
  /** what this probe says about the data, for the sanity line (AGENT-UX 4) */
  fragment: SanityFragment | null;
}

/** The tool surface the loop calls. Implemented twice: over Tauri commands for
 * the app (tools.tauri.ts) and over `pg` for the headless harness
 * (eval/tools.node.ts). Both must behave identically, because EVAL.md scores
 * the app's own loop through the node one.
 *
 * Table and column names arrive as the MODEL wrote them: bare, unqualified,
 * possibly wrong. The implementation resolves a bare name against the schema
 * snapshot and carries schema and name separately from there on; it never
 * splits a dotted string (LESSONS 4). An unresolvable name is an `error`
 * naming the valid options, never a throw. */
export interface AgentTools {
  listTables(): Promise<ToolOutcome<TableBrief[]>>;
  describeTables(names: string[]): Promise<ToolOutcome<TableDescription[]>>;
  peekValues(
    table: string,
    column: string,
    limit?: number,
  ): Promise<ToolOutcome<PeekOutcome>>;
  /** the only method whose structured half feeds the results grid */
  runSql(sql: string): Promise<ToolOutcome<AgentRun>>;
  probe(sqls: string[]): Promise<ToolOutcome<ProbeOutcome[]>>;
}
