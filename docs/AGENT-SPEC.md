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

The A3 canvas (ROADMAP › Next: Agent) is a second main-area surface, not a
mode of the Ask pane's one right-hand card: `Tab.kind` gains `"canvas"` and
`App` renders it the way it renders a query or table tab today, by
`Tab.kind` (one more dispatch arm; nothing about the Inspector/Ask pane's
own wiring moves). Its components live in `src/canvas/` (CanvasTab, CanvasResult wrapping
the W7 `ResultBlock` reused whole from `src/ask/`, NoteBlock), backed by
`src/stores/canvas.ts`. A canvas block's `Ask` action opens no second entry
point into the agent: it is the SAME Ask pane and the same
`askMessage(question: string)` seam as §1, with the block itself riding as
a fifth kind on the `@` mention ladder (`mentionsFor` / `resolveMentions`)
rather than a new argument threaded through the loop, so the system prompt,
the loop and `PROMPT_VERSION` are exactly as untouched by where a question
was typed from as they already are by a tag (§4.1, §4.2, W6).
`askedFrom: blockId` rides the resulting exchange in the store only, for
the session, so `Add to Canvas` on the reply can find the block it answers
(AGENT-UX §16d).

B3 (2026-09-09) adds the ladder's **seventh kind**, `canvas` (`MentionKind`,
6 → 7), promoted out of the `block` kind's `canvas?: boolean` flag B2 shipped
as a stopgap: `@"Canvas 4"` is the canonical bare quoted form and B2's
`@canvases/"Canvas 4"` canonicalizes to it before the ladder, the way
`@tables/` already does (§4.1). A whole canvas and a block of one are
different nouns, and only the canvas can be a TARGET (AGENT-UX §16l). Unlike
every other kind, a `canvas` tag contributes **no line** to `TAGGED BY THE
USER:` (§4.2): it resolves to `AskRequest.canvas` instead, and the `CANVAS:`
block (§5.1) is the one place the canvas is described, with its title and the
outline the model may edit against, so a second description would be one fact
in two slots (DESIGN rule 14). The question text still goes to the model with
its `@` tokens exactly as typed, and `PROMPT_VERSION` does not move.

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
ones (a loop test pins this). A category-prefixed tag (`@tables/order_v2`,
AGENT-UX §1a, B2) reaches this stage already canonicalized to the plain
token by `mentions.ts`, so must-include selection and the eval's
byte-identical claim read it exactly as they read any other tag.

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

### 5.1 The canvas family (B3, 2026-09-09)

Three more tools, offered only when the exchange carries a resolved canvas
target (`AskRequest.canvas`, AGENT-UX §16l): `canvas_write({ blocks: [1..6],
after? })` appends, `canvas_replace({ block_id, block })` replaces one block
in place, `canvas_read({})` returns the target's outline. No `canvas_create`
and no delete tool exist: the target is resolved by the store before the run
(§2, LESSONS 3) and is unrepresentable to the model — no tool takes a canvas
id or a title — so a canvas the user did not ask for is not merely
forbidden, it has no wire shape to ask for it in. Deleting a person's block
is the user's own act (`⌫` on a focused block, AGENT-UX §16b);
`canvas_replace` refuses to empty a block (an empty `note.text` is an error,
never a delete) so the model cannot delete by emptying either. Model-facing
tools: **5 → 8**.

The block the model may write is the SAME union AGENT-UX §16 already ships,
**two kinds, not three**: a `metric` variant was drafted in research and is
dropped — the figure row it would have carried is a `result` whose statement
returns one row, rendered on its **values** face (`ScalarResult`, unchanged),
never a kind of its own. Faces on a canvas result: `table | chart | values |
sql`. `face` defaults to `chart` when `chartOf` (AGENT-UX §16a) yields a
spec, else `values` for a one-row result, else `table`; an explicit `face`
that does not exist for the rows lands on the same fallback and the tool
result says so, never a refusal (DESIGN rule 11). This is one deliberate
asymmetry with `Add to Canvas` (AGENT-UX §16c), which keeps opening on
`table`: a person's press keeps the face they were looking at, a model's
write composes a reading.

```jsonc
// note: prose, rendered by AnswerText (AGENT-UX §16a item 2)
{ "kind": "note", "text": "**August, against the year:**\n- COD took 22% …" }

// result: one statement the tool runs read-only and keeps with its rows
{ "kind": "result",
  "title": "Revenue by month",   // optional: absent on an exchange's FIRST
                                  // block, which takes the exchange's own
                                  // question (AGENT-UX §16a item 1); every
                                  // block after it needs its own title
  "sql":   "SELECT …",
  "note":  "Paid orders carry the year.",   // optional, rides above the face
  "face":  "chart" }                        // optional, see the default above
```

Caps: `blocks` 1..6 per `canvas_write` call (`CANVAS_WRITE_MAX`), 8 blocks an
**exchange** may write across every call (`CANVAS_EXCHANGE_MAX`); 5 rows
echoed to the model per block (`CANVAS_ECHO_ROWS`, = `PROBE_ROW_CAP`, enough
to write truthfully, never a second `run_sql`); **200 rows kept on a canvas
result block (`CANVAS_BLOCK_ROWS`) — the ONE number for a canvas document,
both routes**: `Add to Canvas` (AGENT-UX §16c) is capped at the same 200,
down from its prior `UI_ROW_CAP` of 2,000, and a press or a write that
truncates says so in the status line, `200 of 1,842 rows` (AGENT-UX §16a item
4's register). Short block ids: 4 hex characters minted once, in TypeScript,
per block (`crypto.randomUUID()`'s own prefix); a call may name one by its
full id or any unique prefix of at least 4 characters, and an ambiguous
prefix is refused (`ERROR: '7' matches 3 blocks. Use at least 4 characters of
the id`) rather than guessing.

A `result` block's `sql` reaches PostgreSQL through the SAME door as
`run_sql`, `agent_run_readonly` on the thread's own session (§8 item 11): a
refused statement lands NO block, the refusal text returned to the model
verbatim, first line, exactly as a write sent to `run_sql` is refused.

**The gate is the tool array itself, one boolean, both provider paths**
(§7): `AskRequest` gains `canvas?: CanvasTools`, resolved before the
exchange's first await (LESSONS 3); `tools: toolsFor(!!req.canvas)` (`5` or
`5 + 3`, the five always first, in file order) is what an HTTP provider is
handed, so a no-target run is gated by construction, and the `claude -p`
path is gated the same way through the per-token MCP tool list (§7). The
unknown-tool error lists only the names actually offered, so a no-target
run's refusal text stays byte-identical to before this wave. One
implementation: `src/agent/canvas.tauri.ts` (new; the second `*.tauri.ts`
file under `src/agent/` besides `tools.tauri.ts` / `platform.tauri.ts`, so
rule 2's placement test still holds — it is the only file of its kind
allowed to import a store). The target's `canvasId` is captured once at
construction and never re-read from a store after an await (LESSONS 3): the
model cannot name a canvas, so "write outside the target" has no wire
representation at all. Block ids are minted here, once; the store never
mints an id for a model-written block, and Rust never mints one either (§7).

**The `$ref` question is resolved, no.** `tools.schema.json` carries no
`$ref` and no `$defs` anywhere. Every schema, canvas or not, is
self-contained on the wire, because each adapter puts `parameters` on the
wire ALONE (`openai.ts`'s `renderTools`, `anthropic.ts`'s `input_schema`,
`agent_mcp.rs`'s `parse_tools`, which reads `t.get("parameters")` off one
object and never looks for a sibling key) — a `$defs` sibling of `tools`
would never reach the model, and a pointer into it would not resolve. The
block union is written out in full inside BOTH `canvas_write` and
`canvas_replace`, and `tools.test.ts` pins the two copies equal, so the one
place they could drift (a cap or a field added to one and not the other) is
caught at the schema level rather than trusted to eyes.

**The `CANVAS:` block** rides the user message last, after `RISK CHECK` and
after `WRITES:` when either fires (§6, §8 item 7's own pattern: it governs
the FINAL shape of the answer, the outermost instruction), appended only
when `req.canvas` is set and to nothing else, so `SYSTEM_PROMPT` and
`PROMPT_VERSION` do not move (EVAL §3, §4). Quoted whole, as shipped by the
tools builder (`canvasMessage(title, outline)`, `prompt.ts`; if the shipped bytes
differ from this paragraph, this document is amended to match, never the
reverse):

> CANVAS: the user is reading a canvas called "Canvas 4" and your
> answer goes INTO it through canvas_write, canvas_replace and
> canvas_read, not into this reply. A result block carries one
> read-only SELECT; the canvas runs it, keeps its rows and prints its
> own status line under them. It stands on its chart when the rows
> have one label column and one to three numeric columns, on its
> values when it returns one row, and on its table otherwise, so name
> a face only to override that. Every result after the first carries a
> title of at most six words naming what it shows; the first wears the
> question. A note block carries markdown: at most one bold lead-in
> ending in a colon and two to four bullets, each ONE finding with its
> own figure, a comparison the blocks above cannot make for
> themselves, never a figure a result on this canvas already prints
> and never a markdown table. An insight question gets two to five
> blocks, the results first and one note last; a direct question gets
> one result and no note. Write the results first and read their
> shapes back before you write the note. Call canvas_read before
> writing into a canvas that already holds blocks, and replace a block
> you wrote yourself when new work supersedes it rather than writing a
> second one beside it. A question that asks to change data is
> answered in this reply exactly as before, never as a block. When the
> blocks are written, finish HERE with one sentence naming what you
> wrote and no ```sql block: each result's assumptions ride that
> block, so no Assumptions line is needed here.

A canvas that already holds blocks appends its OUTLINE under the paragraph,
one line per block, rendered by the tool layer's own `outlineLine` so this
block and `canvas_read` can never describe the document differently
(LESSONS 13). It is ABSENT on an empty canvas, never `(0 blocks)`
(DESIGN rule 11):

> OUTLINE OF "Canvas 4" (1 block):
> b3f2  result  what stood out in orders last month · 1 row: orders, collected · values face

Every sentence earns itself against a rule already in this file or in
AGENT-UX §16, in the order shipped: 1 names the tools and the target and
overrides the system prompt's own "finish with the final SQL in a fenced sql
block" the same way `WRITES:` overrides `run_sql`'s instinct (§8 item 7); 2
and 3 are what a result block IS and the face default, stated once so a
prompt sentence, not this spec alone, is what the model reads; 4 is the
title rule (AGENT-UX §16i, the question once); 5 is the note's shape
(prompt v3's own rule) with rule 14 restated across blocks; 6 is the
block-count budget; 7 is the results-before-the-note order, which is what
makes a note describe rows that actually came back rather than rows the
model imagined; 8 is read-before-repeating and the consent rule
(AGENT-UX §16i), the same pair `canvas_read`'s own description states; 9 is
the safety rule §8 item 11 already enforces structurally, restated where
the model reads it; 10 keeps the pane's summary exchange to one line
(AGENT-UX §16k) and needs no separate `Assumptions:` line, since the
assumption rule below patches the labels onto the block after the verdict
regardless of what the closing sentence says. Amended 2026-09-09 against the
shipped bytes (the paragraph above was a pre-build draft; its own rule is
that the shipped text wins).

**Assumptions on a model-written result block.** The loop does not parse the
model's `Assumptions:` line until after the verdict (§4.6), so after it, the
store patches the exchange's active assumption labels onto the FIRST result
block the exchange wrote — never onto every block, never onto the note: an
assumption belongs to the exchange, and the same label under four blocks is
one fact in four slots (DESIGN rule 14). An `assumptions` field on the block
itself was considered and refused: one more thing the model can get wrong,
for a fact the loop already extracts once.

`run_sql` and the five measured tools do not move: their schemas, their
caps, their refusals are byte-frozen, unchanged by this section.

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

**The canvas bridge (B3, 2026-09-09).** `agent_mcp_serve` gains a fourth,
optional argument, `tools: Option<Vec<String>>`: the list of tool NAMES this
token's MCP server actually serves, `None` reading as today's five in file
order (§5.1's gate, the other half of it). Every `claude -p` spawn already
calls `mcpServer` once per exchange and revokes the token in the adapter's
own `finally` (item 3 above), so a per-token list is per-exchange with no
new lifetime to manage: `platform.tauri.ts`'s `mcpServer` passes
`req.tools.map(t => t.name)` — the same array `toolsFor(!!req.canvas)`
already computed for the HTTP path (§5.1) — straight through, so the token
this exchange holds can never serve a superset of what the HTTP providers
were handed. `agent_mcp.rs` parses `tools.schema.json`'s new `canvasTools`
sibling key beside its existing `tools` (`tools_for(names)`, `None` =>
`tools().clone()`, the unchanged five in file order), and `QwryMcp.tools` —
one field on the struct — is the `Vec` `list_tools` answers from, never the
file-wide global.

**Rust holds zero canvas semantics.** The three canvas tool names are
dispatched through one new trait method, `McpToolBackend::canvas_call(name,
args_json) -> ToolText`, and `SessionBackend`'s implementation is a BRIDGE,
not a mirror: today's five tools are already mirrored line-for-line in Rust
(item 3's own ~470-line debt, "change one, change both"), and mirroring
three more — block-id minting, chart availability, the canvas document's own
rules — would double it and hand the two copies a fresh way to drift on the
next cap change. Instead: `canvas_call` mints a `call_id`, parks a
`tokio::sync::oneshot::Sender<ToolText>` in a process-wide pending map,
emits `canvas-tool-call { call_id, session_id, name, args_json }` on the
app's existing event bus (the shape `commands.rs` already uses), and awaits
the oneshot under a 20 s timeout (`CANVAS_BRIDGE_TIMEOUT_MS`, mirrored as a
Rust constant, the only canvas number that lives in both languages because
it is a timeout, not a rule). TS answers through one new command,
`agent_canvas_result(call_id, text, is_error)`, from a listener
`createCanvasTools` (§5.1) registers keyed on session id, last write wins, no
dispose — a stale entry is unreachable the instant its exchange's own MCP
token is revoked (item 3), which is a clean error already (§8). An event for
a session with no registered listener answers
`ERROR: the canvas is not open for this thread` rather than dropping it,
which would spend the child's whole 20 s for nothing; on elapse the pending
entry is dropped and the call answers
`ERROR: the canvas did not answer. Say your findings here instead` — the
model's own way out, never a hung turn. Cost: +1 IPC round trip per canvas
tool call, sub-millisecond beside a run allowed 10 s; benefit: one
implementation instead of two that could disagree, DESIGN rule 14 applied to
code rather than chrome.

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
   §4.5, applied to a new case). The `WRITES:` block itself (`writesMessage()`,
   prompt.ts) tells the model what the app actually does with that fence, not
   where to send it: the statement is rendered as a preview with the affected
   rows and a Run button the user presses inside qwry, so the block carries no
   instruction to run it elsewhere, no sentence announcing that a statement
   follows, and no filler, one sentence of what will change and why
   immediately before the fence (maintainer finding, 2026-09-08, replacing a
   draft that told the model to say things like "Copy and run this statement
   in your PostgreSQL client"; `PROMPT_VERSION` stays `v4`, `SYSTEM_PROMPT`
   byte-equal, since the block rides the USER message alone). The only path a
   write can take is the model's final answer: when it parses as a write, `agent_gate(sql, mode)`
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
10. **Compare (A3, canvas only, AGENT-UX §16e)** runs a result block's own
    stored SQL against a sibling connection through the same `agent_connect`
    + `agent_run_readonly` path as any other agent read, never a second code
    path: the AST gate (§8.1, above) is what allows a PROD sibling to be
    picked at all, since nothing the gate would refuse can pass it on either
    connection. The comparison session is opened for the one run and
    dropped, never left resident.
11. **The canvas tools (B3, 2026-09-09)** reach PostgreSQL through exactly
    one door, and it is the door that already exists. A `result` block's
    `sql`, from `canvas_write` or `canvas_replace` alike, goes to
    `agent_run_readonly` on the thread's own session — the same call
    `run_sql` makes — so both halves of item 1 apply unchanged: server-side
    `default_transaction_read_only=on` AND the AST gate (one
    `SELECT`/`WITH … SELECT`/`EXPLAIN`, no data-modifying CTE, no `SELECT
    INTO`, no `FOR UPDATE`/`SHARE`, no deny-listed function). A write sent
    to a canvas block is refused in the gate's own words, first line,
    exactly as a write sent to `run_sql` is, and the refused statement
    lands NO block (LESSONS 9: the refusal names the way out, never a block
    standing in for one). `run_sql` itself does not move: its schema,
    description, caps and refusals are byte-frozen (§5). The canvas tools
    write appdb only, through the SAME debounced `canvas_upsert` a person's
    own edit already takes (§9); Rust gains a bridge (§7) and no
    `rusqlite` call for a canvas tool — no database path is added on the
    Rust side by this wave. Production is allowed, for reads, on item 10's
    own reasoning: the AST gate is what makes a prod target legal at all,
    and a canvas result block reads the connection the thread is already
    on, its provenance structural (the canvas belongs to a profile, §9) and
    the chrome speaking for the data's origin (LESSONS 4). The model cannot
    address a canvas: no tool takes a canvas id (captured once, at
    `createCanvasTools`'s construction, from the target resolved before the
    exchange's first await, LESSONS 3, §5.1), no tool creates or deletes
    one (§5.1), and with no target no canvas tool exists at all — the array
    a provider is handed IS the gate (§5.1, §7). Row caps: 5 rows echoed to
    the model per block, 200 kept on the document (§5.1, the one number
    both `Add to Canvas` and a model write now share), 6 blocks a call, 8
    an exchange; the statement timeout is the thread's own (item 2).

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

**Knowledge and saved checks (A2; appdb v8 — the merge left the number where
the wave wrote it, A4 having added no migration, so the arm reads
`8 => knowledge_v8(&tx)?` and no test names the literal version).**

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

A3 (canvas, AGENT-UX §16) adds one appdb table, migration v9 (written as
v8 in the A3 worktree and renumbered on merge, A2's `knowledge_v8` having
taken v8; it is its own match arm, `9 => canvases_v9(&tx)?`, and the number
lives nowhere else inline, so a later merge only has to move the arm and
never edit its body):
```
canvases(id, profile_id, title, doc_json, created_at, updated_at)
```
A canvas tab surviving a restart is the smaller of the two shapes the wave
allowed: not a second persisted `kind` of its own, but one nullable
`tabs.canvas_id` (`add_column_if_missing`) that IS the tab's kind on disk —
a restored row carrying one is a canvas tab, every other row a query tab,
the same non-NULL-is-the-kind trick the table tabs' own session-only kind
never needed a column for. `doc_json` is the ordered block list
`src/stores/canvas.ts` owns end to end, written back debounced on every
change rather than field by field; `canvas_list(profile_id)`,
`canvas_upsert(row)` and `canvas_delete(id)` are its three commands
(`lib.rs`). A block never earns its own row: the whole document is one
write, so a reorder, a face flip that persists (AGENT-UX §16a) and a note's
edited text all move together or not at all.

**Provenance of a model-written block (B3, 2026-09-09).** A block a canvas
tool writes carries one more field inside `doc_json`, `wroteBy: exchangeId`,
set once at write time and never touched again: the block's own record of
whose turn wrote it, which is what `canvas_replace`'s consent rule reads (a
model may replace a block it wrote IN THIS THREAD, or one the user named
with `@`; a user's own note, or a block another thread or `Add to Canvas`
put there, is never replaced unnamed, AGENT-UX §16i) and what a cut or a
re-run reads to find what to remove, below. It does not become a fifth
appdb column: `doc_json` stays opaque to appdb (above), a block's shape is
the canvas store's, not the schema's, and `wroteBy` rides inside the block
exactly as `askedFrom` already rides the OTHER direction (§2's
`askedFrom: blockId` on the exchange).

The exchange carries the matching half, `Exchange.canvasWrites?: {
canvasId: string; blockIds: string[] }` (`src/stores/agent.ts`), in write
order, session-lived like `askedFrom` — never persisted, since a reload's
`doc_json` already knows which blocks exist and each one's own `wroteBy`
already knows which exchange wrote it; `canvasWrites` exists only so a CUT
and a RE-RUN, which act on the THREAD's own rows, know which document rows
to remove without scanning every block of every canvas for a matching
`wroteBy`. Three rules, no fourth, extending the cut semantics above:

1. A cut deletes the blocks of every exchange it removes: in
   `truncateThread`, beside `rowsOf(e)`, one `removeMany(e.canvasWrites)`
   per canvas, not per block.
2. The FIRST canvas write of a re-run clears what the previous attempt of
   THAT exchange wrote. One rule covers Restart, Retry, Fix It and an
   assumption-chip toggle — every path that re-enters `runInto` on an
   existing `exchangeId` — and it fires on the first write, not the run's
   start, so a re-run that fails, is refused, or is cancelled BEFORE
   writing leaves the standing blocks alone.
3. A cancelled run keeps the blocks it already wrote, and `canvasWrites`
   names exactly the blocks now standing. `PriorAnswer` is not extended for
   this: a Stop restores the pane's own answer, and a document is not
   un-written by a Stop any more than a note a person typed by hand is.

A block the user deleted meanwhile is a no-op on all three (`remove`
already resolves nothing for an id no document holds, above). An older
Restart's confirm counts the canvas blocks beside the questions it deletes:
`Restart from Here?` · `The 2 questions after this one, their answers and 7
canvas blocks will be deleted.` · `Delete 2 Questions` (AGENT-UX §16i).

One new `AskEvent`, kinds 9 → 10 (`loop.ts`):
`{ type: "canvasWrite"; canvasId: string; blockIds: string[] }`, emitted
right after a canvas tool call returns and recorded by `runInto`'s
`onEvent`. The ids are never parsed out of the model-facing result text —
deriving one record from another rendering is the exact bug the tool
result's own tolerant-parsing comment (§4.6) warns against — so this event
is the only place `canvasWrites` is ever written.

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
