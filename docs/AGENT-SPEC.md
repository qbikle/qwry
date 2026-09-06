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
src/stores/ask.ts     zustand: the Ask card's UI state (open, width, trace, picker, draft)
src/ask/              React components (AGENT-UX): AskPanel, AnswerBlock, ThinkingStrip,
                      ResultBlock, AnswerActions, AssumptionChips, SanityLine, FollowUps,
                      FailureBlock, TraceDrawer, ModelPicker, ModelsSettings, SetupCard,
                      starters.ts, ask.css
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

Must-include candidates (W6, 2026-09-06): the tables the user tagged with `@`
in the question (a tagged column's table too), resolved by the caller against
the connection's snapshot (`src/agent/mentions.ts`; never fetched here), lead
the list in the order they were typed, and the lexical picks fill the rest to
the same k, so k names reach the model either way and the one-hop expansion
hops out of what the user pointed at. A tagged table is included LEGACY or
not: the prefilter guesses and the user does not, and §6 rule 3 still
travels. A tag the snapshot no longer resolves yields nothing (LESSONS 5).
The eval sends no tags, so its messages are byte-identical to the measured
ones (a loop test pins this).

Synonyms (A2, 2026-09-06): the connection's own synonyms — `agent_knowledge`
rows of kind `synonym`, §9 — merge over the static `SYN` map at call time.
`candidates(question, meta, k, mustInclude, synonyms)` takes them as a
fourth argument and never mutates the static map; a synonym whose target is
a column pulls in the column's table exactly as a lexical hit would. This is
the `t4-02` class of miss (EVAL §4: the prefilter's candidate set misses a
table the gold SQL uses while the model still answers it right anyway) — a
user's own word for a table the static map does not carry, one query away
from the schema's real name. Synonyms are the only knowledge kind that
touches candidate selection: a hint or a definition never changes which
tables the prefilter picks, only what the model reads once they are picked
(§4.2). Unmeasured this wave: no eval run moves a prompt byte or a bench
number (EVAL §3).

### 4.2 Context (code)
User message = question + `CANDIDATE TABLES` block: one line per candidate
`table(col, col, …)  -- <table comment>` plus FK edges among candidates. The
system prompt (§6) is frozen text so providers can cache it. Tables whose
name differs from another only by a `_v\d+` suffix get the note
`-- possible legacy twin of <other>` when neither carries a comment.

When the question carries `@` tags (W6), a `TAGGED BY THE USER:` block
follows the candidate block and precedes the RISK CHECK block (which stays
last, with one exception: it is the instruction for the next turn, while A4's
`WRITES:` block, present only when the connection's edits are on, follows it
because it instructs the FINAL fence rather than the next turn), one line per
tag in the order
typed, the same thing tagged twice one line: `table public.users`, `column
users.email` (the owner qualified only outside `public`), `saved query
"Monthly revenue":` followed by the query's SQL verbatim, `thread "<title>":`
followed by a compact replay of that thread (Q / SQL / A per exchange, the
store's own replay helper, oldest dropped first). SQL and replay are each
capped at 1,500 characters and a cut says `… (truncated)` (LESSONS 9). The
question text itself is sent with its `@` tokens exactly as typed;
`SYSTEM_PROMPT` and `PROMPT_VERSION` do not move. Record View's `Ask to Edit`
(A4 item 7, AGENT-UX §13.8) writes into this same block, under the tags: a
line naming the table and the row's primary key, then the row's own
`column = value` lines. One block, because both are the same fact, that the
user pointed at this. The trace's context step
carries the tags as `{ kind, token }` beside the exact text.

**Knowledge and history (A2, 2026-09-06).** Two more blocks ride the same
user message, each absent, whole, when it has nothing to say — no header,
no block, the same tell as `TAGGED BY THE USER:` above. `knowledgeMessage`
in `prompt.ts` renders `KNOWLEDGE:` then one line per fact, in this order: a
hint on a candidate table (`<table>  -- <hint text>`) or one of its columns
(`<table.column>  -- <hint text>`); a synonym that fired, one line per name
(`<name> -> <target>`), only for a target already among the candidates; a
definition whose term's every token appears among the question's own tokens
(`<term>: <meaning>`, the prefilter's own tokenizer, §4.1). Capped at 1200
characters; over the cap, the oldest-updated fact drops first, whole lines
only, never a fact cut mid-line (a half a hint is a wrong hint).
`historyMessage` renders `EARLIER ANSWERS ON THIS DATABASE:` then up to
three `Q:` / `SQL:` pairs drawn from `agent_history_pairs` (§4.8), scored by
the same lexical overlap the prefilter scores table names with, highest
first; capped at 1500 characters, the lowest-scoring pair dropping first
when the three do not fit, oldest first on a tie. Both blocks sit after
`CANDIDATE TABLES` and its FK edges and before `TAGGED BY THE USER:` (when
tags exist) and `RISK CHECK:` (when the question is risky), which still
stays last: `KNOWLEDGE:` then a blank line then `EARLIER ANSWERS ON THIS
DATABASE:` when both fire, either alone with no blank line to spare, neither
at all leaving the message exactly as it would read without this wave. Like
`TAGGED BY THE USER:`, neither rides the small-tier message (§4.7): a
tagged table and a fired synonym both still reach it as must-include
candidates, but the text explaining either is hybrid-only. Both blocks are
USER message only and both are absent from the eval's no-profile call, so
`SYSTEM_PROMPT` and `PROMPT_VERSION` stay v4 byte-equal and `loop.test`'s
no-profile pin is extended to assert their absence (EVAL §3, §4). The trace
gains a step, `{ step: 'knowledge', ms, counts: { hints?, definitions?,
synonyms?, history? }, text }` (`TraceStep`, `src/agent/types.ts`): `text`
is exactly the bytes above, whichever block fired or both, and `counts` is
read off the same data that built `text`, never recomputed for the label
(LESSONS 13), so the drawer's `2 hints · 1 definition · 1 synonym · 2
earlier answers` (AGENT-UX §14) can never disagree with the block under it;
a zero-valued kind is omitted from `counts` entirely, never shown as `0
definitions` (rule 11). A question that used neither carries no `knowledge`
step at all, the same absence rule `mentions` already has on `context`
(AGENT-UX §5).

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
error text goes back and the model retries (repair loop). The `claude -p`
invocation's own turn cap is 24 (was 12, W7): a wide question spent the old
12 describing and peeking before it ever reached `run_sql`, and the failure
copy `stopped after 1 turns` was qwry's own per-invocation counter, not the
child's (LESSONS 13); the wall clock, not the turn count, is the real guard
against a runaway loop now. A cap hit reads the child's own `num_turns` off
its result line for the failure copy (`stopped after 12 turns`, singular
when the number is 1) and is a failure with a `Continue` affordance beside
`Fix It` (AGENT-UX §7): `Continue` resumes the SAME session with a fresh
budget and no re-inspection, never a silent stop.

**Circuit breaker (W7).** A model that answers a write request in prose,
then calls `run_sql` with that prose anyway, is refused by the AST gate
(§8); the refusal names the way out (`this is prose, not SQL. To answer
without running a query, reply in text and call no tool`), returned verbatim
through the MCP/tool layer. Two CONSECUTIVE `run_sql` refusals of the same
class (the gate's own error class, never a string match) end the exchange
as `answered` with the model's last prose, `sql` and `run` both null, rather
than feeding the refusal back for an eleventh restatement. `PROMPT_VERSION`
does not move for this fix: the loop and the claude-code adapter carry the
breaker, not the prompt. Tested on both paths (`loop.test`, the claude-code
adapter's own test).

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

### 4.8 History few-shot (A2, 2026-09-06)
`agent_history_pairs(profile_id, limit)` (§9) returns up to `limit` rows of
`{ question, sql, created_at }` from `agent_turns` × `agent_answers` where
`status = 'answered'` and `sql is not null`, newest first, pooled across
every thread of the connection — a few-shot pool, not one thread's replay:
replay (§9) is a THREAD's own memory carried forward through a cut; history
is the CONNECTION's, carried into a thread that has never asked the
question before. `historyMessage` (§4.2) scores each of the `limit` pairs
the loop fetches by the same lexical overlap `candidates` (§4.1) scores
table names with, keeps the top three, and orders the kept set oldest first
so the most relevant-and-recent earlier answer reads last, immediately
before the question it is context for. A connection with no answered turn,
or none whose SQL survived a later cut (`sql is not null` already excludes a
turn a Restart deleted, §9), sends no block. Small-tier questions get none
either, the same treatment `KNOWLEDGE:` gets (§4.2): the tier's one call
stays the minimal message it always was.

## 5. Tools (contract)

Schemas defined once as JSON Schema in `tools.ts`; every provider adapter
renders them in its wire format. Names and behaviours are law:

| tool | args | returns | limits |
|---|---|---|---|
| `list_tables` | — | `name  (~rows)  -- comment` per table | all tables of the connection |
| `describe_tables` | `names: string[]` | DDL-shaped text: columns, types, PK, FK, `-- values:` for low-cardinality columns (from `pg_stats`, cap 20), column comments | unknown name → error text listing valid names |
| `peek_values` | `table, column, limit≤50` | distinct non-null values, `… (more exist)` marker; `(sampled …)` when the exact scan timed out | exact DISTINCT under 2s, then a ≤20k-row `TABLESAMPLE SYSTEM (0.5)` sample under 5s |
| `run_sql` | `sql` | header + rows (≤50 to the model; full result, ≤2000 rows, to the grid) + row count; errors as `ERROR: <first line>` | SELECT/WITH/EXPLAIN only (AST gate, §8); 10s timeout (setting) |
| `probe` | `sqls: string[]` | one block per query, same format as `run_sql` | ≤6 queries, each ≤5 rows, gated independently, run one after another on the thread's single session (§2.3); one failure never sinks the batch |

Never truncate `run_sql` rows below 50 to save tokens: the lean variant did
and looped to the turn cap re-querying what it could not see. Save tokens by
pruning history, never by blinding tools.

`run_sql` never writes, on a write-enabled connection or off one (A4,
2026-09-06): its schema takes no `mode` argument, and the AST gate behind it
(§8.1) still allows only `SELECT`/`WITH … SELECT`/`EXPLAIN`, so an
`INSERT`/`UPDATE`/`DELETE` can reach the database only through the model's
final answer, gated by `agent_gate(sql, "write")` (§8.7), never through a
tool call (§8.9).

## 6. Prompt rules (frozen text lives in `prompt.ts`)

The system prompt states, verbatim in spirit:
1. Do not add filters the question did not ask for (`is_deleted`, `<> 0`,
   status). If one seems warranted, answer as asked and list it under
   `Assumptions:`. (Measured: this single rule took judgment injection from
   4/4 questions failing to 8/8 passing.)
2. Return exactly the columns the question asks for.
3. Tables marked LEGACY are never the answer.
4. Work plan: turn 1 describe + peek in one go; turn 2 run; then answer in
   the shape of rule 6 with the final SQL in a ```sql block and an
   `Assumptions:` line (may be "none").
5. RISK CHECK block (appended only when §4.4 fires): before trusting the
   final query, probe min()/max() of every timestamp you filter or compare on,
   check for rows outside the expected order (an event dated before its
   entity existed), apply lower AND upper bounds explicitly, state what the
   probes showed.
6. Answer shape (v3, 2026-09-06): a direct question gets ONE sentence of
   interpretation; an insight question (insights, patterns, what stands out,
   anomalies, a summary or overview of a table or a period) gets an optional
   one-line bold lead-in ending in a colon and two to four bullets, each ONE
   finding carrying its own figure, a comparison the grid cannot make for
   itself, none a row of the result read back, none over 25 words; never a
   heading, never a markdown table of the result, the SQL only in its fence.
   One GOOD and one BAD example, set over an orders question so a bench answer
   cannot be copied from them (`prompt.test.ts` asserts the prompt names no
   Pagila noun). What renders is AGENT-UX §2 item 3; what scores it is EVAL
   §3.x.

The prompt is versioned (`PROMPT_VERSION`, now `v4`); EVAL.md ties baselines
to it. v3 changed the finish line of the base prompt and step 3 of the work
plan and nothing else: rule 1, the column rule, LEGACY, the two-turn work
plan, the Assumptions line and both fence phrasings are byte-equal across v1,
v2 and v3, and `src/agent/__tests__/prompt.test.ts` pins each as a literal so
the measured rules cannot drift under a formatting edit. v4 (W3b, 2026-09-06)
adds three sentences to `HYBRID_RULES`'s "Rules that override your instincts"
list, beside the existing column rule, and changes nothing else: columns (the
final SQL names exactly the columns the question asks for and no other, not
the column it orders by, not the count it ranked with, not an id; a figure
the prose wants that the result will not carry comes from a query already run
or one more `run_sql`, never a column added to the final SQL), joins (two
one-to-many relations joined to the same parent in one pass multiply each
other's rows and inflate every SUM and COUNT, so aggregate each in its own
CTE first and join the aggregates), and rows and numbers (return the rows the
data has, never padded with periods that have no rows, and cast integer
counts to numeric before dividing). Every rule measured through v3 stays
byte-equal into v4, and `prompt.test.ts` pins the three new sentences beside
them. The re-baseline the v3 bump owed was W3's (`d30e28a`); it recorded two
losses (claude-sonnet-5 `pagila.json` 32/33 → 28/33, claude-haiku-4-5
`pagila-hard.json` 5/5 → 3/5) that v4's three rules were written to close, and
the v4 re-baseline (`c6494b6`, the same day) shows both recovered with no cost
to the other model. It also shows one row EVAL §4's gate does not meet:
`pagila-insight.json` + claude-haiku-4-5's presentation mean moved down,
0.850 → 0.714, past the gate's 0.05 slack (EVAL §4, ROADMAP_log's W3b note).
A cut thread's replay (§9) is a prefix of the user
message, not prompt text: it never moves `PROMPT_VERSION`. Neither does the
`TAGGED BY THE USER:` block of §4.2 (W6, 2026-09-06): the header is a string
`askMessage` appends to the user message only when a tag exists, the eval
sends none, and a loop test pins the untagged message byte for byte, so every
version's rows measure the same bytes before and after W6.

## 7. Providers

```ts
interface Provider {
  id: string
  chat(req: { system: string; messages: Msg[]; tools: ToolSchema[];
              model: string; signal: AbortSignal }): AsyncIterable<Event>
  sideChat?(req: { system; user; model; signal }): Promise<{ text; usage? }>  // ownsLoop providers only
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

Side calls (the follow-up prompt of §4.6 and the starter pool of AGENT-UX §1)
are one tool-less text turn with no thread: a hosted adapter takes them
through `chat` with an empty tools list, an `ownsLoop` adapter implements the
optional `sideChat` (claude -p: a fresh spawn with `--tools ""`,
`--strict-mcp-config` and no `--mcp-config`, `--max-turns 1`, no session
flags, the prompt on stdin, an init gate that requires no MCP server and
refuses any listed tool), and `providers/side.ts` `sideText` picks the door,
refusing an `ownsLoop` adapter that has neither.

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
   This item is the TOOL path, and A4 leaves every byte of it standing: no
   tool gained a write, the §5 table did not move, and a write sent to
   `run_sql` is refused exactly as it was. What A4 adds is a SECOND entry
   point beside it, reachable only from an answer's final `sql` fence and
   never from a tool call (items 7-9): its own gate (`gate_write`), its own
   dry run on an ephemeral session inside a transaction that always rolls
   back, and its own refusal on production, taken before any connection is
   opened. Every statement that runs still ran because a person pressed
   something.
2. `statement_timeout` from the existing setting (default 10s). The setting's
   0 means "no timeout" for a SESSION only (`agent_connect` passes it through
   and Postgres reads 0 as disabled); a tool call has no such shape, so 0 falls
   through to the §5 default (`RUN_SQL_TIMEOUT_MS`, 10s, the one number in
   `tools.ts` and `agent_mcp.rs`, read by `tools.tauri.ts` and
   `platform.tauri.ts`) rather than down to `run_readonly`'s one-second
   floor. Row caps §5.
3. Secrets never enter prompts, logs, appdb, or the trace (redaction is not a
   fallback; the values are simply never read into TS).
4. Everything the model sends to a provider is visible in the trace panel
   (AGENT-UX §5). No hidden context.
5. No telemetry (ARCHITECTURE ideology 7). Agent history is local appdb.
6. Provenance: an answer carries its connection identity; the chrome speaks
   for the data's origin (LESSONS 4).
7. Write mode (A4, 2026-09-06). Edits are OFF by default per connection
   (`useSettings.agentWrites: Record<profileId, boolean>`, AGENT-UX §13.1)
   and, even on, never reach the database through a tool: item 1's gate is
   unchanged, so a write attempted through `run_sql` is refused exactly as
   before, and the refusal names the way out, "this is prose, not SQL" for a
   non-statement and, for a real write, a sentence pointing at the final
   `sql` fence instead (the same redirect shape as the prose-loop breaker,
   §4.5, applied to a new case). The only path a write can take is the
   model's final answer: when it parses as a write, `agent_gate(sql, mode)`
   grows a `"write"` mode beside `"read"`, and `gate_write(sql)` (`agent.rs`)
   is the check it runs, through the same `pg_query` crate as the read gate,
   accepting exactly ONE `INSERT`/`UPDATE`/`DELETE` statement: no second
   statement, no DDL, no `TRUNCATE`, no data-modifying CTE, no `SELECT INTO`,
   no deny-listed function (item 1's own list). A pass returns
   `{ verb, table (qualified), has_where, has_returning }`, the shape both
   the dry run (item 8) and the UI (AGENT-UX §13) read. Unit tests cover
   every refusal: no statement kind slips past the AST walk uncaught.
8. The dry run (A4, 2026-09-06). `agent_write_preview(profile_id, sql,
   timeout_ms)` (new `agent_write.rs`) returns `WritePreview { verb, table,
   has_where, exact_rows, before: { columns, rows ≤ 6 },
   after: { columns, rows ≤ 6 }, warnings: string[] }` (six, one constant
   `WRITE_SAMPLE_ROWS`: the block's grid window is a header and six rows, and
   a sample one row shorter than its own frame would read as the whole
   result) from a SHORT-LIVED
   session on the profile (the connection editor's ephemeral-connect
   precedent, never the thread's own agent session): `BEGIN`, `SET LOCAL
   statement_timeout`, a before-sample `SELECT` derived by `pg_query` from
   the write's own target and its WHERE (none for `INSERT`), the statement
   itself with `RETURNING *` appended when it carries none (so `exact_rows`
   is the true affected-row count and the returned rows are the
   after-sample), then `ROLLBACK` unconditionally in a `finally` — a failure
   anywhere is reported and still rolls back, so a dry run can never leave a
   transaction open on the profile's connection. Refused before any
   connection is opened when the profile is `is_prod` (its own error kind;
   the copy names production, AGENT-UX §13.7). Warnings are code facts, one
   token each: `missing_where` (an `UPDATE`/`DELETE` with no WHERE) and
   `many_rows` (`exact_rows` > 1000). The exact count comes from the dry run
   itself, never an `EXPLAIN` estimate (LESSONS 13: a status reports the
   number the user saw work, and the only number this preview ever saw is
   the one the rollback-wrapped statement actually touched).
9. The three refusals (A4, 2026-09-06). Three distinct places refuse a
   write, each with its own copy and none of them a dead end (AGENT-UX
   §13.7): the AST gate refuses a write attempted through any tool, in read
   mode or write, always (item 7); `agent_write_preview` refuses before
   opening any connection when the profile is prod (item 8); and the loop
   refuses to EXECUTE a write it did extract when the connection's
   `agentWrites` flag is off, ending the exchange as a failure with `sql`
   set and `run` null rather than silently downgrading to a proposal the
   user never asked to see disabled. None of the three is a dead end: the
   tool refusal redirects to the fence, the prod refusal is a fixed fact
   with no settings row to offer, and the writes-off refusal offers
   `Settings` (opens Settings › Models) beside `Ask Differently`.

## 9. Data model (appdb, rusqlite)

```
agent_threads(id, profile_id, title, created_at, session_key)
agent_turns(id, thread_id, idx, role, content, tool_calls_json, tool_results_json,
            usage_json, model, provider, prompt_version, ms, created_at)
agent_answers(turn_id, sql, row_count, assumptions_json, sanity_json, status)
```
`session_key` (v7) is the provider session the thread resumes; NULL reads as
the thread id (both selects `COALESCE(session_key, id)`, no backfill). A cut
(W4: a send from edit mode; W7: Restart on ANY exchange, not only an older
one) deletes turns, and `claude -p` resumes a session that remembers them
and cannot rewind, so the cut writes a fresh uuid here and the adapter
resumes THAT (`ThreadRef.session`) while `id` still names the thread's MCP
session and its rows. Before W7, Restart on the NEWEST exchange skipped the
cut and resumed the same session unmodified, so the model answered from its
own remembered tool results in a few seconds with no new tool call, chips
included; W7 closes that hole by giving every Restart the cut, exclusive of
the exchange restarted (that exchange's own turns and answer are deleted,
everything before it kept), so the re-minted session replays the kept
exchanges (as below) and the model re-inspects the live database before it
answers again, on the newest exchange exactly as on an older one. The cut,
`agent_thread_truncate(thread_id, turn_ids)`, deletes the NAMED turns and
their answers in one transaction, answers first: the store names each
exchange's two rows (`userTurnId`, `turnId`) because neither `idx` nor write
order is a boundary (an exchange that failed before persisting owns no rows;
a Retry on it writes its pair after its successors'). `idx` is thread order —
the question's slot and its answer's one above it, allocated between the
pair's NEIGHBOURS (`prev.idx + 2`, or 0) and never from the exchange's
position, which a reload compacts over a gap while the rows keep their idx;
when the next exchange leaves no room, `agent_turns_shift(thread_id, from_idx,
by)` moves the tail up first, a separate call from the insert so a failure
leaves a gap and never a collision. A reload reads `ORDER BY idx, id`. A
re-run that does not cut (Fix It, a chip toggle) rewrites its assistant turn
in place (`agent_turn_update`) so a reload never pairs old prose with a new
answer; Restart (W7) goes through the cut above instead, exclusive of the
exchange restarted, so its old answer is deleted rather than overwritten and
the re-minted session is what forces the fresh answer, not a rewritten row.
The first run after a cut carries a compact replay
of the KEPT exchanges as a prefix of the USER message, never the system
prompt: `Earlier in this thread:` then one `Q:` / `SQL: <final sql or none>`
/ `A: <first sentence>` block per exchange, capped at 2000 characters with
the oldest dropped first (`replayOf` in the store, `withReplay` in loop.ts on
both the hybrid and the small path, so a stateless provider gets the same one
behaviour per cut); it is carried once and kept for the next attempt when the
run fails or is cancelled. The eval passes no thread, so its prompt bytes and
`PROMPT_VERSION` do not move (loop.test pins the no-thread and no-replay
messages byte-identical). Provider/model choice and per-connection defaults
live in `useSettings` (persisted). Keys: Keychain only (§2.4).

`agent_answers.status` gains two values this wave (A4, 2026-09-06):
`proposed`, once the final SQL is a write that clears `gate_write` (§8.7)
and ends the exchange without executing it (`sql` set, `run` null); and
`ran`, once Run (AGENT-UX §13.6) has executed that statement in the active
query tab. `row_count` on a `ran` row is the rows affected the TAB reported,
never the dry run's `exact_rows` (§8.8): the two can differ (a concurrent
writer between preview and Run), and only the tab's own number is what the
user watched happen (LESSONS 13). No new table and no migration exist to
track commit state itself this wave: the tab's own transaction is the only
record of whether a `ran` row is committed, rolled back or still open
(AGENT-UX §13.6's `uncommitted`), so a reload mid-transaction reads `ran`
with no way to ask the tab what it later decided.

**Knowledge and saved checks (A2; appdb v8 in this worktree — the merge
renumbers it, so the migration arm is written `8 => knowledge_v8(&tx)?` and
no test names the literal version).**

```
agent_knowledge(id, profile_id, kind CHECK IN ('hint','definition','synonym'),
                target TEXT NULL, text TEXT NOT NULL, created_at, updated_at)
```

`target` is `table` or `table.column` for a `hint` or a `synonym`, `NULL`
for a `definition`. A `hint` row's `text` is the line's own words with any
trailing `aka` clause already stripped (AGENT-UX §14); a `synonym` row's
`text` is one bare name from that clause, one row per name, sharing the
hint's `target` — a target with no hint row can still carry synonym rows (a
user who writes only `aka orders, purchases` with no prose), because the two
kinds are edited as one line by the UI, never joined by the schema. A
`definition` row's `text` is the palette's own `term = meaning` line
verbatim: no separate `term` column exists, so the term is always the
substring before the first ` = ` (parse and write share one function,
LESSONS 1), used both to match a question's tokens (§4.2) and to fill the
palette row's two slots on render and its input again on re-edit.
`saved_queries` gains three columns through `add_column_if_missing`:
`question TEXT NULL` (a quick-ask's own text, AGENT-UX §15), `expect_json
TEXT NULL` (a check's expectation — `{ kind: 'rows', op: 'eq'|'gte'|'lte',
n }`, `{ kind: 'scalar', eq: string }`, or `{ kind: 'nonempty' }`), and
`last_check_json TEXT NULL` (`{ ok: boolean, rows: number, scalar?: string |
null, at: string, error?: string }`, the last `Run Checks` verdict for that
row, read straight onto the palette's dot and its failed-row detail,
AGENT-UX §15). The verdict carries the row count whatever the expectation's
kind, because a scalar check whose result stopped being one cell has to say
so (`2 rows · expected 7`); `scalar` is absent when the result was not one
cell and `null` when that cell held SQL NULL; `error` is the first line of a
run that could not run at all, which is a failed check and never a silent
pass (LESSONS 9).

Commands (`lib.rs`, appended): `agent_knowledge_list(profile_id)`;
`agent_knowledge_upsert(row)` (upsert by `id`, which TS mints as saved
queries do: an edit rewrites the row and keeps its `created_at`, so a hint
edited in place stays where a cap would drop it from);
`agent_knowledge_delete(id)`; `agent_history_pairs
(profile_id, limit)` (§4.8). None of the four touch a connection's live
session: knowledge is appdb-local like a saved query, read once alongside
the connection's other rows, never fetched mid-turn. Saving an edited hint
line is the store's own read-modify-write, not a single command:
`src/stores/knowledge.ts` diffs the parsed line against what it already
holds for that target and calls `agent_knowledge_upsert` / `_delete` per row
that changed (the hint row, each added or removed synonym name), so the
four commands stay plain CRUD and the parse/write pairing (LESSONS 1) lives
once, in TS. `src/stores/knowledge.ts` holds a connection's knowledge rows
(hints, definitions, synonyms), loaded alongside the schema snapshot;
`src/stores/saved.ts`'s `SavedQuery` gains `question?`, `expect_json?`,
`last_check_json?`, snake_case like the row's other wire fields, and its
`upsert` merges over the row it already holds so a rename cannot drop the
question a quick-ask kept or the check on it. Reading either blob is
`src/stores/checks.ts`'s `checkOf` / `lastCheckOf`, paired with
`writeExpect` / `writeResult` (LESSONS 1); a blob this build cannot read
leaves an ordinary bookmark rather than a check nobody can explain.

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
