# AGENT-SPEC.md: the in-app agent (v1 "Ask")

Fourth law file. Governs the agent's architecture, pipeline, tools, providers,
safety, and tier gating. Binding like the others: reviews cite it by section,
and a change that violates a measured result below needs a new measurement,
not an argument. Companion files: `AGENT-UX.md` (what the user sees),
`EVAL.md` (how quality is measured and gated).

Basis: the qwry-agent-lab research (2026-09-01 → 09-03), 28-question benches
on Pagila and on a real 202-table staging schema. Headline numbers that shaped
this spec: Haiku-class models write correct SQL at ceiling (23/23) once the
harness is right; the hybrid pipeline below scored 23/23 (Haiku) and 22/23
(Sonnet) on 202 tables with no allowlist; four table comments recovered 3
points lost to legacy-twin confusion; one prompt rule removed unrequested
filters entirely. Full results: `~/projects/qwry-agent-lab/docs/agent-design.html`.

## 1. Scope

**v1 = Ask.** A natural-language question about the active connection →
executed read-only SQL → answer, in a panel. Ships with: assumption chips,
data-sanity line, trace ("how did it get this"), follow-up suggestions,
provider/model picker with tier badge, Fix It on a failing query.

**Not v1** (spec'd in `docs/ROADMAP.md` › Agent as later phases): Quiz
(guided Q&A flow; saved quick-asks; data-check quizzes), Knowledge layer
(table hints, business definitions, query-history memory), Explain/audit any
SQL, canvas + comments, two-connection diff, writes, watchers, Modelling and
Optimization modes.

## 2. Placement

TypeScript owns the loop; Rust owns the database.

```
src/agent/
  loop.ts          the turn loop (§4); streaming events to the store
  context.ts       prefilter + index + candidate assembly (§4.1–4.2)
  risk.ts          risky-shape classifier (§4.4)
  prompt.ts        system prompt + rules (§6), frozen text, cache-friendly
  tools.ts         tool schemas (§5) + AgentTools interface
  tools.tauri.ts   AgentTools over Tauri commands (the app)
  platform.ts      Platform interface: http relay, process spawn, MCP endpoint
  platform.tauri.ts  Platform over Tauri commands (the app)
  providers/       Provider interface + adapters (§7), presets, registry
  extract.ts       SQL/assumption/answer extraction from model text
src/stores/agent.ts   zustand: threads, turns, chips, sanity, trace, status
src-tauri/src/agent.rs        commands: agent_connect, agent_describe,
                              agent_peek_values, agent_run_readonly (AST gate),
                              agent_probe, agent_gate, agent_key_* (§5, §8)
src-tauri/src/agent_http.rs   agent_http_stream: key-injecting SSE relay (§7)
src-tauri/src/agent_claude.rs agent_claude_spawn/kill: the claude -p child
src-tauri/src/agent_mcp.rs    streamable-HTTP MCP server for claude -p (§7)
eval/tools.node.ts, eval/platform.node.ts   the same interfaces over pg/node
```

Rules:
1. Only Rust talks to PostgreSQL. No pg client in the frontend.
2. `AgentTools` and `Platform` are interfaces. `tools.tauri.ts` /
   `platform.tauri.ts` implement them for the app; `eval/tools.node.ts` /
   `eval/platform.node.ts` implement them over `pg` and node for headless
   evaluation (EVAL.md). Nothing under `src/agent/` except `*.tauri.ts`
   imports Tauri or a store at runtime (a test enforces it).
3. Agent sessions are dedicated PG sessions from the existing spare pool
   (ARCHITECTURE › Sessions), one per thread, with
   `default_transaction_read_only=on` set server-side **regardless of the
   prod flag** in v1. Cancel = the session's CancelToken (⌘. like queries).
4. API keys live in the Keychain through `secrets.rs` (`agent:<provider>`
   entries), never in appdb, settings, prompts, or logs. Provider HTTP runs
   through Rust (`agent_http_stream`), which injects the key: TS never
   holds it, and Tauri's http scope never has to allowlist user-supplied
   hosts (DECISIONS 2026-09-05). Only Rust talks to the network.
5. IPC types once in Rust, mirrored in `src/ipc/types.ts` (CLAUDE.md rule).

## 3. Tier gating (measured)

| tier | examples | what it gets | why |
|---|---|---|---|
| small (<7B, local) | LFM2.5-2.6B via llama.cpp | one-shot pipeline: code prefilter → curated context → one SQL → repair loop (≤2). No tool loop. | tool loops collapse below ~7B; the repair loop was the biggest lever (45%→67% with tolerant extraction) |
| mid | Haiku-class | full hybrid loop (§4); risk probes run but the UI states they may not change the answer | 23/23 SQL; ran probes yet kept the cohort bug |
| large | Sonnet-class and up | full hybrid; probes trusted; analysis-style answers | acted on probe evidence (fixed the cohort); the only tier that did |

The model registry (`providers/registry.ts`) carries `tier`, context window,
`parallelTools`, and `samplingParams` (Sonnet 5 rejects `temperature`; Haiku
accepts it). Unknown models default to `mid` and say so in the picker.

## 4. Pipeline (the hybrid, as measured)

Every step is either **code** (deterministic, milliseconds, zero tokens) or
**model** (a turn). The design goal is two model turns for most questions.

### 4.1 Prefilter (code)
From the cached `SchemaSnapshot`: IDF-weighted lexical match of question
tokens against table and column names (rare tokens weigh more; "user" matches
40 tables and weighs little), plus a small synonym map, plus the top-3 FK hub
tables, plus one-hop FK expansion of the top picks (bridge tables), minus any
table whose comment contains `LEGACY`. Target 15–25 candidates. Measured
recall 28/28 on staging. Recall is logged per question (EVAL.md).

### 4.2 Context (code)
User message = question + `CANDIDATE TABLES` block: one line per candidate
`table(col, col, …)  -- <table comment>` plus FK edges among candidates. The
system prompt (§6) is frozen text so providers can cache it. Tables whose
name differs from another only by a `_v\d+` suffix get the note
`-- possible legacy twin of <other>` when neither carries a comment.

### 4.3 Turn 1 (model, parallel tools)
The prompt instructs: call `describe_tables` for every table you will use
AND `peek_values` for every text/enum/status column you will filter on, in
this one turn. Code runs the calls concurrently, returns one result block.

### 4.4 Risk classifier (code)
Regex over the question for time-window / cohort / percentage / first-after
/ growth / retention / conversion shapes. Risky → the user message carries
the RISK CHECK block (§6). Measured: flipped Sonnet's cohort answer from
wrong to right; 7 of 28 bench questions trigger it.

### 4.5 Turn 2 (model)
`run_sql`, optionally preceded by `probe` for risky shapes. On SQL error the
error text goes back and the model retries (repair loop, max turns 12 total,
a cap hit is a failure with a Fix It affordance, never a silent stop).

### 4.6 Post (code + cheap model)
- Final SQL extracted from the answer (tolerant: fenced, tool-call syntax,
  stray special tokens; this tolerance alone was worth 22 points on a small
  model).
- Result rows go to the existing grid (no second grid species).
- **Assumption chips**: parsed from the model's mandated "Assumptions:" line
  plus code-detected filters not present in the question (`is_deleted`,
  `<> 0`, status filters). Each chip is a toggle that re-runs (AGENT-UX §3).
- **Sanity line**: values peeked, min/max probed, anomalies (AGENT-UX §4).
- **Follow-ups**: three next questions from the cheapest configured model.
- Turn, tool log, usage, SQL persist to appdb (`agent_turns`) for trace and
  history.

### 4.7 Small-tier path
Steps 4.1–4.2 then ONE model call producing SQL; execute; on error feed the
error back once or twice; no tools, no chips beyond code-detected filters.

## 5. Tools (contract)

Schemas defined once as JSON Schema in `tools.ts`; every provider adapter
renders them in its wire format. Names and behaviours are law:

| tool | args | returns | limits |
|---|---|---|---|
| `list_tables` | — | `name  (~rows)  -- comment` per table | all tables of the connection |
| `describe_tables` | `names: string[]` | DDL-shaped text: columns, types, PK, FK, `-- values:` for low-cardinality columns (from `pg_stats`, cap 20), column comments | unknown name → error text listing valid names |
| `peek_values` | `table, column, limit≤50` | distinct non-null values, `… (more exist)` marker | 5s statement timeout |
| `run_sql` | `sql` | header + rows (≤50 to the model; full result, ≤2000 rows, to the grid) + row count; errors as `ERROR: <first line>` | SELECT/WITH/EXPLAIN only (AST gate, §8); 10s timeout (setting) |
| `probe` | `sqls: string[]` | one block per query, same format as `run_sql` | ≤6 queries, each ≤5 rows, gated independently, run one after another on the thread's single session (§2.3); one failure never sinks the batch |

Never truncate `run_sql` rows below 50 to save tokens: the lean variant did
and looped to the turn cap re-querying what it could not see. Save tokens by
pruning history, never by blinding tools.

## 6. Prompt rules (frozen text lives in `prompt.ts`)

The system prompt states, verbatim in spirit:
1. Do not add filters the question did not ask for (`is_deleted`, `<> 0`,
   status). If one seems warranted, answer as asked and list it under
   `Assumptions:`. (Measured: this single rule took judgment injection from
   4/4 questions failing to 8/8 passing.)
2. Return exactly the columns the question asks for.
3. Tables marked LEGACY are never the answer.
4. Work plan: turn 1 describe + peek in one go; turn 2 run; then answer with
   the final SQL in a ```sql block and an `Assumptions:` line (may be "none").
5. RISK CHECK block (appended only when §4.4 fires): before trusting the
   final query, probe min()/max() of every timestamp you filter or compare on,
   check for rows outside the expected order (an event dated before its
   entity existed), apply lower AND upper bounds explicitly, state what the
   probes showed.

The prompt is versioned (`PROMPT_VERSION`); EVAL.md ties baselines to it.

## 7. Providers

```ts
interface Provider {
  id: string
  chat(req: { system: string; messages: Msg[]; tools: ToolSchema[];
              model: string; signal: AbortSignal }): AsyncIterable<Event>
}
type Event = { text: string } | { thinking: string }
           | { toolCall: { id; name; args: string } }
           | { toolResult: { id; name; result: string; isError? } }   // ownsLoop providers only
           | { usage: { input; output; cacheRead?; cacheWrite? } } | { done: StopReason }
           | { error: { kind: 'auth'|'rate'|'unreachable'|'provider'|'cancelled'; message; retryAfterMs? } }
```
`thinking` (OpenAI-compatible `reasoning_content`, Anthropic `thinking_delta`)
renders in the thinking strip and trace, never as answer text. `StopReason` is
`stop | toolCalls | maxTokens | turnCap | cancelled | error`: every truncation
(`max_tokens`, `model_context_window_exceeded`, `content_filter`, `length`)
maps to `maxTokens`, and an `ownsLoop` provider that exhausts its own turn
budget mid-loop (`claude -p` `error_max_turns`) reports `turnCap`, which the
loop turns into the turn-cap verdict, never an answer. A provider
with `ownsLoop: true` executes tools itself and yields `toolResult`; the
loop records those and never re-executes. Adapters reach the network only
through `Platform.httpStream` / `Platform.spawn` (§2.4).

v1 adapters, in build order:
1. **OpenAI-compatible** (`base_url` + key): covers OpenAI, OpenRouter,
   llama.cpp `llama-server`, vLLM, Ollama, LM Studio, Groq, Mistral, Together,
   Fireworks, DeepSeek, xAI and **Gemini** (its OpenAI-compatible endpoint;
   the native `functionCall` adapter is a research item, DECISIONS
   2026-09-05). One adapter; quirks are data in `presets.ts`.
2. **Anthropic**: native `tool_use` blocks, `cache_control` on the frozen
   prefix and the last tool, sampling params per model from the registry.
3. **Claude Code (`claude -p`)**: `ownsLoop`. Spawns the CLI with
   `--mcp-config` pointing at qwry's own streamable-HTTP MCP server
   (`agent_mcp.rs`, per-thread bearer token), `--strict-mcp-config`,
   `--tools ""`, `--allowedTools 'mcp__qwry__*'`, `--setting-sources ""`,
   `--output-format stream-json --verbose`, `--system-prompt`,
   `--session-id`/`--resume`; prompt on stdin. A not-`connected` MCP status
   in `system/init` fails the turn before the model runs. No key needed.

Provider-neutral rules: tool arguments are untrusted text → `JSON.parse` in a
try, schema-validate, error text back to the model on failure; unknown tool
name → error text listing valid tools; a turn cap ends every loop; tool
results are appended in the format the provider expects (all results of a
parallel turn in ONE message). Bedrock/Vertex/Foundry are a research item.

## 8. Safety

1. Read-only in v1, twice: server-side `default_transaction_read_only=on`
   on agent sessions AND an AST gate (`pg_query` crate in `agent.rs`)
   allowing only one `SELECT`/`WITH … SELECT`/`EXPLAIN` statement, with
   no data-modifying CTE, SELECT INTO, FOR UPDATE/SHARE (checked on every
   SelectStmt incl. SubLinks) or deny-listed function (pg_sleep,
   pg_terminate_backend, set_config, lo_*, pg_read_file, dblink…; read-only
   does not stop these). Both must pass. Policy table: DECISIONS 2026-09-05.
   Agent sessions are flagged at connect and the raw-SQL commands (`execute`,
   `execute_stream`) refuse them, so the gate has no side door.
2. `statement_timeout` from the existing setting (default 10s); row caps §5.
3. Secrets never enter prompts, logs, appdb, or the trace (redaction is not a
   fallback; the values are simply never read into TS).
4. Everything the model sends to a provider is visible in the trace panel
   (AGENT-UX §5). No hidden context.
5. No telemetry (ARCHITECTURE ideology 7). Agent history is local appdb.
6. Provenance: an answer carries its connection identity; the chrome speaks
   for the data's origin (LESSONS 4).

## 9. Data model (appdb, rusqlite)

```
agent_threads(id, profile_id, title, created_at)
agent_turns(id, thread_id, idx, role, content, tool_calls_json, tool_results_json,
            usage_json, model, provider, prompt_version, ms, created_at)
agent_answers(turn_id, sql, row_count, assumptions_json, sanity_json, status)
```
Provider/model choice and per-connection defaults live in `useSettings`
(persisted). Keys: Keychain only (§2.4).

## 10. Budgets

First streamed token < 2s after send on hosted providers; ≤5 model turns for
non-risky questions (measured 4.7–4.9); the UI never blocks on the loop; the
grid receives rows as the existing `QueryEvent` stream, so 50k rows behave as
they do for a query tab.

## 11. Open questions (decide during the workflow, record in DECISIONS.md)

- ~~MCP server for the `claude -p` provider~~: closed 2026-09-05, in-process
  streamable-HTTP server (`agent_mcp.rs`); see DECISIONS.
- Widen the gate to `SHOW <setting>`? Harmless and read-only, but §8.1 is
  spec-literal today.
- Legacy-twin detection beyond comments: `_v\d+` note (§4.2) is v1; a
  qwry-side hint store is the v2 Knowledge layer.
- Keyboard shortcut for the Ask panel (proposal in AGENT-UX §1).
