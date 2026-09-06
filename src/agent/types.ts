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

/** What kind of thing an `@` tag names (src/agent/mentions.ts). Declared
 * here because this module imports nothing: the grammar builds on it, the
 * trace's context step carries it. `tab` is the one kind the resolver never
 * mints: it is resolved once, when `Explain with Ask` fires, and carried on
 * the exchange, so a tab closed since cannot un-pill a bubble that already
 * reported what it sent (AGENT-UX 15). `block` is a canvas block (A3): the one
 * kind that names something the user built rather than something the
 * connection has, which is why it is the ladder's last rung. */
export type MentionKind = "table" | "column" | "saved" | "thread" | "tab" | "block";

/** How a thread's question ended. The tokens are persisted verbatim in
 * `agent_answers.status`, so they never drift between store and appdb.
 * `proposed` and `ran` are A4's: a change the model wrote and nothing ran,
 * and the same change once the user ran it in a query tab (AGENT-SPEC 9). */
export type AnswerStatus =
  | "answered"
  | "failed"
  | "turn_cap"
  | "cancelled"
  | "proposed"
  | "ran";

/** The loop's own verdict on a question. Every failing shape carries what the
 * UI needs to offer Fix It rather than a dead end (AGENT-UX 7, LESSONS 9).
 * `proposed` is not a failure and not an answer: the statement is real, it
 * cleared the write gate, and it has not run (AGENT-UX 13.2). `ran` is never
 * a verdict of the loop's, which never runs a write; the store writes that
 * status when the TAB reports its outcome (AGENT-UX 13.6). */
export type Verdict =
  | { status: "answered"; sql: string | null; rowCount: number | null }
  | { status: "proposed"; sql: string }
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
      /** the `@` tags the question carried, in the order they were typed
       * (W6). Absent when nothing was tagged, which is what keeps the
       * trace's summary line off the step; the tags themselves are already
       * inside `text`, under TAGGED BY THE USER. */
      mentions?: { kind: MentionKind; token: string }[];
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
    }
  | {
      /** what this connection's own knowledge added to the user message (A2
       * item 4, AGENT-SPEC section 4.2). `text` is the block as sent, headers
       * included; `counts` is read off the same data that built it, so the
       * drawer's label can never disagree with the body under it (LESSONS
       * 13). The step is absent when the profile added nothing. */
      step: "knowledge";
      ms: number;
      text: string;
      counts: KnowledgeCounts;
    };

/** What the knowledge step's label counts. A kind that contributed nothing is
 * ABSENT, never a zero: `2 hints · 1 earlier answer`, never `0 definitions`
 * (DESIGN rule 11). */
export interface KnowledgeCounts {
  hints?: number;
  definitions?: number;
  synonyms?: number;
  history?: number;
}

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

/** What the user told this connection that the schema does not say (A2 item
 * 1). `hint` and `synonym` name their object in `target` (`table` or
 * `table.column`, as the Structure view writes it); `definition` names no
 * object and carries `term = meaning` in `text`, the grammar the palette's
 * input reads back. The loop reads these three fields alone, so the store's
 * wire row (`KnowledgeRow` in src/ipc/types.ts), which also carries its id,
 * its profile and its timestamps, is one of these as it stands. Rows arrive
 * oldest first, which is the order a capped block drops from. */
export type KnowledgeKind = "hint" | "definition" | "synonym";

export interface KnowledgeRow {
  kind: KnowledgeKind;
  target: string | null;
  text: string;
}

/** One question this connection already answered, with the statement that
 * answered it (appdb `agent_history_pairs`, newest first). */
export interface HistoryPair {
  question: string;
  sql: string;
}

/** A word the user mapped to one of the connection's objects, and the object
 * it names (A2 item 4). Built from the `synonym` rows and merged over the
 * static SYN map for the run. */
export interface Synonym {
  word: string;
  /** `table` or `table.column`, as written */
  target: string;
}
