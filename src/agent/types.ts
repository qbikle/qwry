// Shared value types for the agent (AGENT-SPEC section 9, AGENT-UX 3/4/5).
// Platform-neutral and runtime-free: this module imports nothing, so the app
// (tools.tauri.ts) and the headless eval harness (eval/tools.node.ts) can both
// speak it. See AGENT-SPEC section 2 rule 2.
//
// Wire twins: src/ipc/types.ts mirrors the Rust records with snake_case field
// names, because that is what crosses the IPC boundary. The types here are the
// parsed, camelCase domain shapes the loop and the store work in. tools.tauri.ts
// owns the one conversion between them (import the wire type aliased, e.g.
// `import type { AgentRun as AgentRunWire } from "../ipc/types"`).

/** The five tools, as named in tools.schema.json. Names are law (spec 5). */
export type ToolName =
  | "list_tables"
  | "describe_tables"
  | "peek_values"
  | "run_sql"
  | "probe";

/** One executed read-only statement. Cell values are wire text (what psql
 * shows); null = SQL NULL. `capped` = the result exceeded the row cap and the
 * surplus was never sent, so `rows.length` is not the whole answer. */
export interface AgentRun {
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  capped: boolean;
  ms: number;
}

/** Token accounting for one model turn. `cacheRead`/`cacheWrite` are absent on
 * providers that do not report caching; zero and absent mean different things
 * (a silent cache miss is a real failure mode, W0 registry facts). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** How a thread's question ended. The tokens are persisted verbatim in
 * `agent_answers.status`, so they never drift between store and appdb. */
export type AnswerStatus = "answered" | "failed" | "turn_cap" | "cancelled";

/** The loop's own verdict on a question. Every failing shape carries what the
 * UI needs to offer Fix It rather than a dead end (AGENT-UX 7, LESSONS 9). */
export type Verdict =
  | { status: "answered"; sql: string | null; rowCount: number | null }
  | { status: "failed"; sql: string | null; message: string }
  | { status: "turn_cap"; sql: string | null; turns: number }
  | { status: "cancelled"; sql: string | null };

/** One interpretation the agent made that the question did not state. Chips
 * are toggles: flipping one re-runs the query (AGENT-UX 3). `label` is Title
 * Case control register; `fragment` is the SQL the toggle adds or removes,
 * present only for code-detected filters. */
export interface Assumption {
  id: string;
  label: string;
  /** "model" = parsed from the mandated Assumptions: line; "detected" = found
   * in the SQL by code (is_deleted, <> 0, status filters) */
  source: "model" | "detected";
  /** the assumption is currently in effect */
  active: boolean;
  fragment?: string;
}

/** One dot-separated piece of the sanity line (AGENT-UX 4). `warn` fragments
 * carry the warning glyph and tier-1 contrast; `sql` is the probe that
 * produced the fragment, shown when the user clicks it. Nothing is
 * decorative: with no probe there is no fragment. */
export interface SanityFragment {
  text: string;
  warn: boolean;
  sql?: string;
  /** id of the tool call (trace step) that produced it, so the sanity line
   * opens the trace at its probe structurally (LESSONS 4) */
  stepId?: string;
}

/** One step of the trace drawer, in loop order (AGENT-UX 5). Everything the
 * model received is shown; nothing is summarised away. */
export type TraceStep =
  | {
      step: "context";
      ms: number;
      /** candidate tables the prefilter chose (spec 4.1) */
      candidates: string[];
      /** the exact CANDIDATE TABLES block sent to the model */
      text: string;
    }
  | {
      step: "turn";
      ms: number;
      /** 0-based turn index within the thread's turn cap */
      index: number;
      text: string;
      /** reasoning deltas: rendered in the thinking strip, never as answer */
      thinking?: string;
      usage?: TokenUsage;
    }
  | {
      step: "tool";
      ms: number;
      id: string;
      /** one of the five for calls the loop made; whatever the provider
       * reported for an `ownsLoop` provider, so a stray tool is visible */
      name: ToolName | string;
      /** raw argument JSON as the model wrote it, untouched */
      args: string;
      /** the text the model got back */
      result: string;
      isError: boolean;
    }
  | { step: "verdict"; ms: number; verdict: Verdict }
  | {
      /** the follow-up suggestions call (spec 4.6): one more model call after
       * the verdict, shown here because nothing sent to a provider is hidden
       * (spec 8.4) */
      step: "followups";
      ms: number;
      /** the exact user message sent */
      prompt: string;
      /** the model's raw reply */
      text: string;
      /** the questions parsed out of it */
      questions: string[];
      usage?: TokenUsage;
    };

/** One Ask thread. Threads belong to a connection: switching connections
 * switches threads (AGENT-UX 1). `id` is the thread's identity and the name
 * of its MCP session; `sessionKey` is the `claude -p` session it resumes,
 * re-minted by a cut so the provider never remembers a deleted turn. Absent
 * means the two are the same uuid, which is every thread until its first
 * cut. */
export interface Thread {
  id: string;
  profileId: string;
  title: string;
  createdAt: string;
  sessionKey?: string;
}

/** One recorded turn, with the loop structures already parsed out of the
 * appdb `*_json` columns. */
export interface Turn {
  id: number;
  threadId: string;
  idx: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  usage: TokenUsage | null;
  model: string;
  provider: string;
  promptVersion: string;
  ms: number;
  createdAt: string;
}

export interface ToolCallRecord {
  id: string;
  /** one of the five, or whatever an `ownsLoop` provider reported */
  name: ToolName | string;
  args: string;
}

export interface ToolResultRecord {
  id: string;
  /** one of the five, or whatever an `ownsLoop` provider reported */
  name: ToolName | string;
  result: string;
  isError: boolean;
}

/** The answer belonging to a turn: what ran, what came back, what was assumed,
 * what was checked. One per turn. */
export interface Answer {
  turnId: number;
  sql: string | null;
  rowCount: number | null;
  assumptions: Assumption[];
  sanity: SanityFragment[];
  status: AnswerStatus;
}
