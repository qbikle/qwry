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

### 4.6 Post (code + cheap model): the conversational contract (E4, 2026-09-17)

A canvas thread's fourth question, informational and asking for no data,
was answered in prose with no tool call; the loop took that prose as
`run_sql`'s own argument anyway, ran it, hit the AST gate's `this is prose,
not SQL` refusal, fed the refusal back, and looped to the cap, because the
only thing this step used to do was extract SQL from whatever text the
model left behind and run it — the model's own choice not to call a tool
was never a question the code asked (the maintainer's thread; LESSONS.md
has the shape of it, the app's own turn log has the words). Two checks now
run, in order, before this step will call anything an answer:

**One nudge, evidence-gated.** Has this exchange, across every turn so far,
called `run_sql` — or, on a canvas-targeted exchange, `canvas_write` /
`canvas_replace` — even once? If not, and the question resolves to a table,
the loop sends ONE user turn. Three code facts, never a guess, are what
resolving to a table means: the question names a table (context.ts
`tablesNamed`: a word of the table's own name, its base name, or a synonym
the user mapped to it; a column-only hit, the FK hubs and the one-hop
expansion do not count, since those put tables under every question), §4.1;
or the question carries an `@table` / `@column` mention, §4.2; or the risk
classifier fired, §4.4. The turn is `nudgeMessage` (`prompt.ts`, beside
`repairMessage`, never in the cached `SYSTEM_PROMPT`): "You have run_sql.
Answer this with the data, then say what it shows," and the loop continues
exactly as a SQL-error repair does (§4.5), counting as a turn against that
section's cap. A question that resolves to no table — "what can you create
on canvas," "what did you just do," "thanks" — is conversational and gets
none. The prefilter's PICKED list is not this test and cannot be: on any
schema holding a foreign key it is never empty, because the top-3 FK hubs
and the one-hop expansion (§4.1) put tables under every question, the
maintainer's own included. At most one nudge per exchange; its text rides
its own trace step, `nudge` (AGENT-UX §5). The model's next stop, nudged or
not, is read by the rule below.

**The answer is what the model said.** Once the model stops for real (no
tool call, and the nudge above has already had its one chance), the exchange
ends `answered` and its last text block is the answer — never a statement
the loop invents on the model's behalf. `sql` is the closing ```sql fence
when the answer has one (a tool-call literal, `extractSql`'s `tool-call`
branch, counts as a fence too), else null: on this, the hybrid tier, plain
unfenced text is never SQL, so `extractSql`'s `raw` branch — measured worth
22 points on a small model — never fires here; it still fires on the small
tier, which has no tools and no fence to ask for (§4.7). `run` is the run
`sameSql` matches to the fence's own statement when the fence names one
already run this exchange, the exchange's last successful run when the
fence names none, else null. The loop never starts a run of its own to fill
either slot: no `final-N` trace step exists any more, the id (`final-${turns}`)
retired with it.

**A fence naming an unrun statement is run once; a fence the gate calls
prose is not run at all.** When the closing fence names a statement the
model has not yet run, the loop runs it once — the "state it, then say
done" pattern the tool loop already lets a model use mid-conversation — as
a trace step `closing-fence`, and a failure there feeds exactly ONE
`repairMessage`, the same message §4.5's mid-conversation repair loop
sends, capped here at one round because the model already said it was
finished: fail again and the exchange ends `failed` carrying that `sql`.
When the AST gate instead refuses the fence as prose (`isProseRefusal`,
`tools.ts` — the same check the W7 circuit breaker above counts refusals
with), the loop does not retry it: the exchange ends `answered` with the
prose text at once, `sql` and `run` both null, no repair, no failure block.
This is the W7 breaker's own principle carried one step further. That
breaker already refused to let the loop mistake the model's own
prose-fed `run_sql` call for progress toward an answer; this rule refuses
to let the loop mistake the model's prose ANSWER for a statement in the
first place, which is the half of the same bug the breaker's counter,
scoped to the model's own `run_sql` calls, could never see (it never ran a
tool at all, so nothing tripped it, LESSONS.md).

**Held across the bridge too (E5a, 2026-09-18).** `run` above already
reads as one rule for every provider — the fence's own match, else the
exchange's last successful run — but `held` (this section, and the loop's
own `heldFor`/`lastHeld`) only ever filled from the driven path: an
`ownsLoop` provider's child answers its own `run_sql` inside its own
process (§7), so the text-only `toolResult` this loop saw on that path
left `held` empty whatever the child ran. A closing fence still got its
rows, once, through `closing-fence`'s own re-run; a fence-less close did
not, and ended `answered` with `sql` and `run` both null even after a
real `run_sql` — the one gap this contract left standing on `claude -p`,
the app's default provider. The row bridge (§5) closes it structurally:
the loop subscribes to its own session's `agent-run-sql` before the
child starts (§7) and pushes each one into `held` (sql + `AgentRun`) in
arrival order, the identical shape `held` already took from the driven
path's own `run_sql` calls, so `heldFor`/`lastHeld` read one list, filled
the same way, on either path from here. Nothing above moves for it: a
closing fence naming a run the bridge already delivered is adopted with
no re-run; a fence-less close under a held run answers under that run's
own statement; `closing-fence` still fires, once, for a statement the
child stated and never ran, or a fence naming a statement neither path
ever held — the one honest re-run this section has ever allowed, and now
the only one left on any provider.

**Failures are the tool's.** A `failed` verdict carries `sql` only when a
statement — a closing fence or a call the model actually made — failed on
the wire; `errorKind: "sql"` and `Fix It` (AGENT-UX §7) appear only then. A
prose answer can never produce a failure block, whatever it says.
`repairMessage` is never sent for a call the loop made and the model did
not.

What §4.6 has always done next is unchanged by any of the above:
- Result rows go to the existing grid (no second grid species).
- **Assumption chips**: parsed from the model's mandated "Assumptions:" line
  plus code-detected filters not present in the question (`is_deleted`,
  `<> 0`, status filters). Each chip is a toggle that re-runs (AGENT-UX §3).
- **Sanity line**: values peeked, min/max probed, anomalies (AGENT-UX §4).
- **Follow-ups**: three next questions from the cheapest configured model.
- Turn, tool log, usage, SQL persist to appdb (`agent_turns`) for trace and
  history. `tool_calls_json` / `tool_results_json` hold the calls the MODEL
  made and nothing else (R5): the `nudge` is not a tool step at all, and the
  loop's own `closing-fence` fetch, truthful as its live row is, is filtered
  out on the way to the column (`persist`, `stores/agent.ts`), so a reopened
  thread shows the model's own calls alone rather than a second `run_sql`
  row beside the one the model wrote. What that reload drops is a fetch, not
  a fact: the statement and its row count are the answer row's own columns
  (§9). `final-N` is among none of it, and never again.

### 4.7 Small-tier path
Steps 4.1–4.2 then ONE model call producing SQL; execute; on error feed the
error back once or twice; no tools, no chips beyond code-detected filters.
This tier has no tool call to distinguish an answer from a statement with,
so it is the one place `extractSql`'s `raw` branch still runs (§4.6): the
whole of the model's reply is read as the SQL, fenced or not, because that
tolerance is what the 22 points were measured on and nothing here has a
fence to require instead. No nudge, no closing-fence step, no `final-N`
retirement: none of §4.6's contract changes this tier's one call.

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

**The row bridge (E5a, 2026-09-18).** `claude -p` owns its loop (§7): its
child answers its own `run_sql` calls against the MCP server inside Rust,
and until this wave only the model's TEXT crossed back into TypeScript,
so this loop's `held` (§4.6) stayed empty on that path whatever the child
ran, and a closing fence had to be fetched a SECOND time, through the
app's own driven `run_sql`, before the grid showed anything at all — the
one path where a fence-less prose close after a real run left no grid to
show, since nothing this loop held could fill one either. `run_sql`'s own
Rust implementation, `SessionBackend::run_sql` in `agent_mcp.rs`, now
fires one Tauri event alongside the model's own tool result, no oneshot
to wait on since nothing here answers a call the model is still owed:
`RUN_SQL_EVENT` (`"agent-run-sql"`, declared beside `MODEL_ROW_CAP` — the
bridge's other named event is `canvas-tool-call`, §7), payload `SqlRun {
call_id, token, session_id, sql, columns, rows, row_count, capped, ms }`,
mirrored by hand in `src/ipc/types.ts`. `MODEL_ROW_CAP` does not move: it
still caps `run_text`'s own count to the model at 50, and nothing about
that changes. The event carries the WHOLE run instead, the same
`AgentRun` `run_sql` already built to answer the model, up to
`UI_ROW_CAP`'s 2,000 rows with its own `row_count`/`capped` — the app's
grid is a query tab's grid, not the model's transcript, and has shown
that many rows for a `run_sql` call on the driven path since before this
wave; the model's cap governs what the model reads, never what the grid
does with a statement that already ran (§4.6, LESSONS 13: the grid says
how many rows RAN). One event per `run_sql` call the gate let run; a
refusal is already whole in the model's own text and earns none, and
`probe`'s rows, five at a time and built for verification rather than an
answer, earn none either.

### 5.1 The canvas family (B3, 2026-09-09)

Three more tools, offered only when the exchange carries a resolved canvas
target (`AskRequest.canvas`, AGENT-UX §16l): `canvas_write({ blocks: [1..6],
after? })` appends, `canvas_replace({ block_id, block })` replaces one block
in place, `canvas_read({})` returns the target's outline. The target is
resolved by the store before the run (§2, LESSONS 3) and is unrepresentable
to the model on these three — no tool takes a canvas id — so a canvas the
model wants to WRITE INTO is never one it names, only one the user, or its
own `canvas_create` below, already opened.

**A fourth tool, `canvas_create({ title })` (D1, 2026-09-14, AGENT-UX
§16l), closes the one door that stayed shut: making a canvas at all.**
Offered wider than the three above, on ONE more condition than a target:
the exchange carries a resolved target, OR the question contains the whole
word "canvas" (any case) — the SAME test AGENT-UX §16l item 4 already runs
at the app layer, run again here because that app-side route only ever
opens a connection's FIRST canvas (item 4's own rule: it never re-targets
one that already exists), so a question naming "canvas" on a connection
that already holds one used to reach the model with no target and no way
to make a new one, answered inline instead of on a canvas (the
maintainer's own screenshot). `canvas_create` takes no id, only a title
(capped at `CANVAS_NAME_CAP`, 80, the same number a thread's own title
already takes, `tools.ts`: both wear a tab, one number for the two — never
`CANVAS_TITLE_CAP`, the SEPARATE, longer cap a result block's own title
inside a canvas takes, a different line in a different place, §5.1's own
title rule below): it creates a NEW canvas through the store
exactly as the app's own word-route does (`create(profileId, title)`),
opens its tab beside the exchange's own current tab WITHOUT switching the
pane's focus off Ask (the SAME no-steal rule), and returns the outline
`canvas_read` would for it, empty (§5.1, below).

**It is the one canvas tool allowed to change what the OTHER three act on
for the rest of this exchange, and it is the only one.** LESSONS 3's rule —
the target is captured once at construction and never re-read from a STORE
after an await — is unmoved and is not what this describes: a successful
`canvas_create` call writes its own new canvas id into the exchange's own
`canvasId` binding at the moment the call returns, the tool's OWN result,
never a second read of external state, and `toolsFor` (below) evaluates
that binding fresh on every turn from here, the same way it already
evaluates `req.canvas` fresh at construction. On a HOSTED provider,
`canvas_write`, `canvas_replace` and `canvas_read` join the array from the
NEXT turn onward once there is something for them to act on, since the
array a turn is offered is computed fresh each turn (§7). **`claude -p` is
the one exception, because its MCP tool list is minted ONCE for the whole
exchange (§7): the three that write are pre-offered beside `canvas_create`
from turn one whenever this run may create at all, and refuse in one
sentence, `CANVAS_NOT_MADE` (`ERROR: there is no canvas for this answer.
Call canvas_create to make one`), until a create actually lands — never a
silent no-op, LESSONS 9's own way-out rule.** Either path, no canvas tool
succeeds on the SAME call that made its target: a hosted turn does not yet
offer the writers, and a `claude -p` call that tries one before creating
reads the refusal above. **A SECOND `canvas_create` call in the same
exchange opens a SECOND canvas and re-targets the run to it: this answer
writes into the last canvas it made from then on** (the tool's own schema
description states this to the model directly, and the CANVAS block's
sentence 11, below, names it for a run that already has a target). It is
the case AGENT-UX §16l's own finding is about: a connection that already
holds a canvas and a question that asks for a NEW one, where a refusal
would answer the user's own words with "this answer already has a canvas."
A refusal was built first, on the ground that a loop which can open tabs is
a loop that can bury a user in them; what bounds it instead is the turn cap
and the offer itself, since only a run whose question names a canvas, or
which already has one, is shown the tool at all. No `canvas_create`
call outlives its own exchange: the NEXT exchange's tools are computed
fresh from the connection's own state, never from what a prior exchange
happened to leave standing.

No delete tool exists, for any of the four: deleting a canvas is not this
wave's question, only creating one where none was addressable was.
Deleting a person's block is the user's own act (`⌫` on a focused block,
AGENT-UX §16b); `canvas_replace` refuses to empty a block (an empty
`note.text` is an error, never a delete) so the model cannot delete by
emptying either. Model-facing tools: **5** (no target, question names no
"canvas") **→ 6** (no target, question names "canvas": the base five plus
`canvas_create` alone) **→ 9** (a target already stands: the base five, the
three the target always offered, and `canvas_create` last — the array's
file order, `toolsFor`, so the eight-tool prefix B3 measured never moves). **The 6 is the
one count a provider can widen: a provider that OWNS its loop is handed one
array for the whole exchange (`claude -p` mints its MCP token once, above),
so a run that may create carries the three that write from the start there
— 9 from turn one, refusing in `CANVAS_NOT_MADE`'s words until a create
lands; every other provider is offered 5, 6 or 9 exactly as counted.** The FIRST of
those three is the eval's own case (EVAL §4): its bench questions carry no
canvas target and name no "canvas," so neither of `canvas_create`'s two
conditions is ever true for it, and its tools array — length 5, same order
— and its message both stay byte-identical to before this section, the
same pin B3 made and this section does not reopen.

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

**The gate is the tool array itself, both provider paths** (§7): `AskRequest`
gains `canvas?: CanvasTools`, resolved before the exchange's first await
(LESSONS 3); `tools: toolsFor(!!canvas || (canMake && req.provider.ownsLoop),
canMake)`, where `canMake = !!req.canvasNew && (!!canvas ||
saysCanvas(req.question))` — the question's own word AND the platform's own
door, since a platform with no canvas hands over no `canvasNew` and its runs
can never be offered the maker at all (EVAL §4's pin made structural, not
left to depend on what a bench question happens to say). The predicate is
`saysCanvas`, not `mentionsCanvas`: in this codebase a *mention* is the `@`
ladder, and a canvas MENTION is AGENT-UX §16l's route 1, the opposite of
this word route; one regex, one home (`tools.ts`), imported by
`stores/agent.ts` so the app's door and the model's door read the same test.
The result (`5`, `6` or `9`, the five always first, in file order,
`canvas_create` last of the canvas family when it is offered at all — which
keeps B3's measured 8-tool prefix and Rust's own "five first, then
`canvasTools` in file order" pin intact) is what an
HTTP provider is handed, so a no-target, no-word run is gated by
construction exactly as a no-target run always was, and the `claude -p`
path is gated the same way through the per-token MCP tool list (§7). **D1
widens the gate from one boolean to two, `hasTarget` and `saysCanvas`,
ORed for `canvas_create` alone**: the other three still gate on `hasTarget`
by itself, unmoved. The unknown-tool error lists only the names actually
offered, so a no-target, no-word run's refusal text stays byte-identical to
before this wave. One implementation: `src/agent/canvas.tauri.ts` (new; the
second `*.tauri.ts` file under `src/agent/` besides `tools.tauri.ts` /
`platform.tauri.ts`, so rule 2's placement test still holds — it is the
only file of its kind allowed to import a store). The target's `canvasId`
is captured once at construction and never re-read from a STORE after an
await (LESSONS 3): the model cannot name an EXISTING canvas by id, so
"write outside the target" still has no wire representation at all;
`canvas_create`'s own carve-out (above) is a write to that SAME binding
from the tool call's own result, not a store read, and is the one stated
exception LESSONS 3 always allowed for state a call itself just produced.
Block ids are minted here, once; the store never mints an id for a
model-written block, and Rust never mints one either (§7).

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
> block, so no Assumptions line is needed here. A further canvas_create
> opens a second canvas, when the question asks for one rather than for
> this one.

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
that the shipped text wins). **Sentence 11, appended D1 (2026-09-14, not in
the ten the accounting above describes, since it postdates the shipped v4
bytes those numbers were written against): names `canvas_create` in the ONE
sentence AGENT-UX §16l's own finding asks for, so a model already targeting
one canvas is never left to guess it may open another when the question
asks for one.**

**The create-only message, no target (D1, 2026-09-14).** When
`canvas_create` is offered WITHOUT the other three — no target, the
question names "canvas" — there is no existing canvas to describe, so
`canvasMessage`'s own paragraph does not apply and a second, shorter frozen
text takes its place, `canvasCreateMessage()` (`prompt.ts`), riding the
user message the same way, last, quoted whole:

> CANVAS: the question names one, so call canvas_create with a short
> title to open it, then canvas_write your findings into it once it
> exists.

One sentence, naming the one tool offered and the one thing to do with it
next; no outline follows it, there being nothing yet to outline. The
moment `canvas_create` succeeds, the NEXT turn is offered the full nine
(above), but the USER MESSAGE does not move: it is built once, before the
run's first await, and the same bytes go to the model and to the trace
(§8.4), so the create-only sentence stands for the rest of the exchange and
`canvasMessage`'s paragraph is never sent on a run that began without a
target. What the model then reads about the canvas it just made is the
create's own reply, the outline `canvas_read` would return; the block
grammar it writes against is `canvas_write`'s own schema. A mid-run swap
was considered and refused: a provider that OWNS its loop takes no message
from this loop at all (§7, `claude -p`, the app's default), so the swap
would be a rule that held on the HTTP path and nowhere else.

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

### 5.2 Placement: `at`, `span` and clamping (C2, 2026-09-11)

`canvas_write`'s block schema and `canvas_replace`'s block both gain two
more optional objects, on every kind the union carries today and on
`drawing` the day it joins (AGENT-UX §16p):

```json
"at":   { "type": "object", "properties": { "x": {"type":"integer","minimum":0},
                                             "y": {"type":"integer","minimum":0} },
          "required": ["x","y"], "additionalProperties": false,
          "description": "Where to put it, in grid cells, as canvas_read printed the columns. Omit it and the canvas finds the first free place in reading order." }

"span": { "type": "object", "properties": { "w": {"type":"integer","minimum":1},
                                             "h": {"type":"integer","minimum":1} },
          "required": ["w","h"], "additionalProperties": false,
          "description": "How many cells wide and tall. Omit it and the canvas gives this kind its own default size." }
```

**Absent equals `place()`**, the same first-fit-in-reading-order the
model's writes have always landed on. **Present and impossible is clamped,
never refused**, in the tool result's existing voice (the shape `faceFor`'s
own fallback already uses, §5.1: "never a refusal and never an empty face,
the statement was good, only the guess was wrong", DESIGN rule 11):

```
asked for 6 wide, the canvas is 5 columns, placed 5 wide
asked for column 7, the canvas is 5 columns, placed at 0,3
```

Order within one `canvas_write` call: blocks carrying `at` place first, in
array order, each pushing down whatever it now overlaps exactly as a
person's drag does (AGENT-UX §16q); the rest place through `place()` into
what is left, so a call mixing placed and unplaced blocks never lands the
unplaced ones on a cell an `at` block asked for. `canvas_replace`'s `at`
means "and move it": omitted, the replaced block keeps the place it
already had.

**The model must be told the column count, or `at` is a guess.**
`canvas_read`'s outline gains the count once, in its own opening line, and
every entry after it its own cell:

```
Canvas "Q3 revenue", 4 blocks, 10 columns wide.
a3f1  result  Monthly revenue by channel . 12 rows: month, channel, revenue . chart face . at 0,0 6x4
7c02  note    Revenue concentrated in two channels: . at 6,0 4x4
```

`outlineLine` (§5.1) gains this one fragment, so `canvas_read` and the
`CANVAS:` block's own outline (§5.1) describe a block's place identically
(LESSONS 13), never two renderers disagreeing about where something sits.
The column count is read off the live surface at the moment of the call,
falling back to the document's own advisory `lastColumns` (§9) and then to
`COLUMNS_FALLBACK`, 7 (the 960 card's own count under the cell law of §16o,
not the 8 this section first drafted before that arithmetic landed), when
neither exists; advisory, never a refusal
(LESSONS 5): nothing reads the column count to decide whether a write is
LEGAL, only to word `at`'s reply honestly.

**A no-target run's tools and message stay byte-identical.** `at` and
`span` are two more properties on a schema only a canvas-targeted run is
ever handed (§5.1's own gate, unmoved): the array a provider receives IS
the gate, so the five tools a no-target run is offered do not grow these
fields, and neither `PROMPT_VERSION` nor the no-canvas eval baseline moves
(the B3 pin this section inherits, §5.1).

### 5.3 `canvas_read(block_id)`: the drawing's image (C2b, 2026-09-11)

`canvas_read`'s schema (§5.1) gains one optional string, `block_id`,
addressed the SAME way `canvas_replace`'s own block id already is (§5.1: a
full id or any unique prefix of at least 4 characters; an ambiguous prefix
refused by name, never guessed). **Called with no `block_id`, the reply is
today's outline, byte for byte** (a pinned regression, the same habit
§5.2's own "byte-identical" claims keep): naming one block never was and
still is not required to read a canvas. **Called with one naming any
block**, the reply narrows to that block's own outline line alone
(`outlineLine`, §5.1, §5.2); **naming a drawing**, the reply carries that
line PLUS the drawing's own PNG as an image alongside the text, rendered
offscreen at 2x and clamped to a 1568px long edge (AGENT-UX §16w, §7's own
budget). No new tool: `canvas_read` was already the door the model is told
to open before writing into a non-empty canvas (§5.1's own prompt
paragraph), so a drawing's image rides the door a text outline already
used, rule 15's first question answered yes.

**Two wires, one call, because only one of them has anywhere else to put
an image.** A hosted provider (the Anthropic adapter, the OpenAI-compatible
adapter) already receives a drawing's image the moment a person presses
`Ask` on it (§7, `Msg.images`): the image rides the NEXT user turn, not a
tool result, because both of those adapters carry a structured message body
with room for one. `claude -p` has no such room: its whole turn reaches the
child as one string on stdin (`claudecode.ts`), so an `Ask` on a drawing
under that provider cannot attach an image to anything the child reads
directly, and the model must ask FOR it, mid-turn, through this very tool.
So `canvas_read(block_id)`'s image half is a `claude -p` mechanism in
practice, even though its schema is offered to every canvas-targeted run
alike: the bridge's `ToolReply` (`agent_mcp.rs`) carries `{ text, image:
Option<ToolImage { b64, mime }> }`, and the reply builder appends `rmcp`'s
own `ContentBlock::image(b64, mime)` beside the text block exactly when one
is present (the shape both Claude Code's own MCP docs and `rmcp`'s source
state, both ends verified rather than guessed). A hosted provider's own
tool-result wire is UNCHANGED by this wave (`ToolResult` in
`providers/types.ts` carries no image field): calling `canvas_read(block_id)`
on a drawing through the Anthropic or an OpenAI-compatible adapter answers
with the text line alone, which costs that path nothing it did not already
have, since the person's own `Ask` press already put the picture where that
adapter reads pictures from.

Refusals: an unknown or ambiguous `block_id` answers exactly as an unknown
tool argument does everywhere else (§7's provider-neutral rules), first
line, never a partial reply. Images travel under §8 item 12's one rule,
unchanged by where they are requested from.

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

**A v5 was written, measured and REVERTED (D2, 2026-09-14, Q6d, EVAL §4).**
It added ONE sentence to the same list v4 added its three to, directly under
the column rule it belongs beside: "When the answer is a list of more than a
few identifiers, return them as the result of a query, never as a list in
prose." The maintainer's own screenshot was the reason: seventy ERP table
names, numbered down the answer slot, where AGENT-UX §2 item 4's own grid was
built to hold exactly that (DESIGN rule 14, one fact in one slot). The gate
did not hold. Accuracy held everywhere (`pagila.json` 33/33 and
`pagila-hard.json` 5/5 on both `claude-code` models), but
`pagila-insight.json` + claude-haiku-4-5's presentation read 0.771 and, on
its one re-sample, 0.750 against a row of 0.850, where the slack is 0.05;
a v4 control run the same hour on the same machine read 0.857, so the loss
was the sentence and not the weather. The check that moved is
`no_grid_restatement`: a sentence telling the model to put identifiers in the
result made it read MORE of the result back in prose. The sentence and the
`v4` → `v5` bump were reverted together, `PROMPT_VERSION` stays `v4`,
`src/agent/prompt.ts` is byte-equal to what it was before the wave but for
nine comment lines recording the experiment, and `eval/baseline.json` does
not move. D2 item 6 therefore ships as the FOLD alone: AGENT-UX §2b's answer
slot folds a list past twelve items behind one `Show All N` line, whatever
the model writes. The numbers, the control and the wording a future attempt
should start from are EVAL §4's, not this file's.

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
`req.tools.map(t => t.name)` — the same array `toolsFor` (D1, 2026-09-14:
two arguments now, §5.1, and `claude -p` is the one provider whose first
argument may be true on a run that has no target YET) already computed for
this run — straight through, so the token
this exchange holds can never serve a superset of what the HTTP providers
were handed. `agent_mcp.rs` parses `tools.schema.json`'s new `canvasTools`
sibling key beside its existing `tools` (`tools_for(names)`, `None` =>
`tools().clone()`, the unchanged five in file order), and `QwryMcp.tools` —
one field on the struct — is the `Vec` `list_tools` answers from, never the
file-wide global.

**Rust holds zero canvas semantics.** The canvas tool names — three, now
FOUR with `canvas_create` (D1, 2026-09-14) — are dispatched through one new
trait method, `McpToolBackend::canvas_call(name, args_json) -> ToolText`,
and `SessionBackend`'s implementation is a BRIDGE, not a mirror: today's
five tools are already mirrored line-for-line in Rust (item 3's own
~470-line debt, "change one, change both"), and mirroring the canvas ones
too — block-id minting, chart availability, the canvas document's own
rules, now canvas creation itself — would double it and hand the two
copies a fresh way to drift on the next cap change. Routing is by name, not
by semantics, and generic across all four: `agent_canvas.rs`'s own
`CANVAS_TOOL_NAMES` constant (`agent_mcp.rs`'s `dispatch` checks
`CANVAS_TOOL_NAMES.contains(&canvas) && self.serves(canvas)` before it ever
reaches `canvas_call`) is a plain array of tool names — three today — and
`canvas_create` joining it is the WHOLE Rust-side change this section asks
for: no new match arm, no new semantics, the same generic bridge routing a
fourth name exactly as it already routes the first three. Instead: `canvas_call` mints a `call_id`, parks a
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

**Image context: two facts, never one (C2b, 2026-09-11).** This document's
own law already splits a per-model fact from a per-provider one (the cache
minimum, above: "it belongs to the model, not the provider"); vision is the
same shape and splits the same way. `ImageWire` (`"none" | "image_url" |
"anthropic-blocks" | "mcp-image"`) is a field on `ProviderPreset`: what the
WIRE can carry, true of every model behind it alike, since one adapter
serves every OpenAI-compatible preset by this document's own law (one
adapter per wire protocol, never one per vendor). `Vision` (`true | false |
"unknown"`) is a field on `ModelInfo`: whether THIS model reads what its
wire can carry. `"unknown"` is a third state on purpose, not a lazier
`false`: a model nothing has confirmed either way is a NO at every gate
that reads it (AGENT-UX §16y), because a wrong guess of `true` spends a
person's turn learning from the provider's own 400 what a flag should
already have known, and a wrong guess of `false` hides a capability a model
actually has. `imageWireFor(providerId)` and its convenience
`carriesImages(providerId)` (`presets.ts`) answer the WIRE half of this
question alone; neither gates `Ask` (that is `vision`, below, AGENT-UX
§16y). They exist only so the wire layer can state what it measured
without waiting for a gate to need the answer. The shipped registry's own
accounting (`registry.ts`'s own header comment): 7 `true` (the three
Claude ids, because the vision guide's own examples run on `claude-opus-5`
and the family's own documentation states the capability reaching Haiku
too; **both GPT-5.6 rows and both Gemini rows, D2, 2026-09-14, Q9b, below**),
2 `false` (the two local ggufs, no vision tower to speak of), 8 `unknown`
(DeepSeek's two rows, Mistral's three, Groq's two and xAI's one, every id
whose own provider's docs nothing here has read yet, the honest remainder
and not a gap to feel bad about); the way out of `"unknown"` for one of
THESE rows is still a documented lookup per row, the same discipline
`verified` already keeps for a model's existence, or the one person-facing
override below.

**Amended (D2, 2026-09-14, Q9b): OpenAI's rows and Gemini's rows move from
`unknown` to `true` as a FAMILY default, not a per-model verification.**
Eleven non-Claude rows read `vision: "unknown"` before this wave (the
question the maintainer's own finding named: OpenAI, Gemini, DeepSeek,
Mistral, Groq and xAI presets all absent `Ask` on a drawing unless the
per-model Settings switch, §16y, was hand-flipped). The maintainer's own
call narrows that to two families whose public documentation already
states the capability for every model they ship, not one model each:
`gpt-5.6-terra` and `gpt-5.6-sol` read `true` because OpenAI's own images
guide documents vision input for the family (`images.test.ts` pins the
same citation `registry.ts`'s header comment carries); `gemini-3.8-flash`
and `gemini-3.1-pro` read `true` because Google's own OpenAI-compatibility
page documents image input for the family at the same base URL
`presets.ts` already holds, `gemini-3.8-flash` remaining the one model its
own example runs on. DeepSeek, Mistral, Groq and xAI rows stay `unknown`:
nobody has read those four families' own docs yet, and a family default
is only as good as the documentation it is read off: a row this section
cannot cite stays the honest `"unknown"` rather than a guess in either
direction. The mechanism this changes NOTHING about: `visionOf`,
`imageRouteFor`, the gate at §16y and the Settings override below all read
the same `vision` field exactly as they did before this wave; a row that
newly reads `true` is a row that now needs no switch at all (§16y's own
row-is-absent rule for a `true`/`false` row, unmoved), and a row that
stays `unknown` keeps needing one. `images.test.ts` pins the new count.

**The install override.** A model whose row reads `"unknown"` gains one
path around it that touches no registry file: `useSettings.visionOverride:
Record<modelId, true>` (persisted, never a `false` entry: turning the
switch back OFF deletes the row rather than writing one, so a later release
that ships a verified `true` for that id is never shadowed by a stale
explicit `false` a person forgot they had set, LESSONS 5). The resolved
flag a gate reads is `override[id] ?? registryRow.vision`, so an override
can only ever turn a gate ON, never off a row the registry already states
`true` for. Where this lives on screen is AGENT-UX §16y's own switch, `Can
see images`, shown only on the row of the model currently chosen and only
while that row reads `"unknown"`.

**`Msg` gains one field, never a new variant.** `images?: ImagePart[]` on
the user variant alone (`ImagePart { mime: "image/png"; b64: string }`, the
base64 payload with no `data:` prefix, each adapter wrapping it in the
shape its own wire documents): a fourth `Msg` variant would force every
adapter to branch on it, and the one that forgot would drop a picture in
silence, exactly the failure LESSONS 9 names. A message with no image is
byte-identical to what it always sent (a pinned test, not an intention).
PNG only: the drawing's own export is the only producer, and the export is
where the size is held (§5.3's own clamp, a 1568px long edge at 2x, which
is what keeps a picture inside Anthropic's 10MB per-image ceiling and well
inside its 32MB request cap). The message path itself carries NO cap, and
that is the call rather than an omission: a second ceiling here would be a
number that could disagree with the first, and the only door that fills
this field is the renderer the first one binds (`types.ts` says so beside
the field).

**The two message-carrying wires.** The Anthropic adapter, when `images` is
present, pushes an `image` content block (`{ type: "image", source: {
type: "base64", media_type, data } }`) for each one BEFORE the text block
(the vision docs' own ordering advice, verified this wave): an empty
caption beside a picture sends no text block at all, since an empty string
is a 400 the picture does not need to risk. The OpenAI-compatible adapter,
same trigger, widens the user message's `content` from a bare string to a
`Part[]` array carrying one `{ type: "image_url", image_url: { url:
"data:image/png;base64,…" } }` per image (Gemini's OpenAI-compatible
endpoint takes the identical shape at the same base URL `presets.ts` already
holds, so the one adapter serves it too, no branch added); `detail` is left
unset (`auto`). Every request that carries no image is unchanged on both
adapters, which is the test that matters more than the feature.

**`claude -p` has no message-carrying wire for an image, and gets one
through the canvas bridge instead** (§5.3): its whole turn is one string on
stdin, so an image cannot ride a `Msg` the way it does on the two adapters
above, and the temp-file alternative is dead on arrival, because the child
runs with `--tools ""` and has no `Read` of its own to point at a file (the
same restriction that keeps 26 unrelated built-ins out of an app that
promises read-only SQL); reopening that door to carry a picture would trade
the guarantee for the picture. The image travels as an MCP tool result
instead, `canvas_read(block_id)`'s own mechanism (§5.3).

**An adapter that cannot carry an image drops nothing silently.** Two facts
answer this and the wire is only the first of them, because `"mcp-image"`
is not a property of the connection alone: it reaches the model through
`canvas_read`, and the canvas family is offered only to a run with a canvas
TARGET (§5.1's own gate, the tools array a provider is handed IS the
offer). So the same connection carries a picture on one question and none
on the next, and one function answers for both — `imageRouteFor(providerId,
hasCanvasTarget)` (`presets.ts`), returning `"message"` (the two wires
above), `"tool"` (`claude -p` with a target) or `"none"`.

Three things read that one answer and can therefore never disagree: the
TAGGED line the model is sent (`a drawing, attached as an image` on a
message wire, `a drawing: call canvas_read with block_id <handle> to see
it` on the tool route, `a drawing; its picture cannot travel on this
connection` where there is no route at all), the message the adapter is
handed (`Msg.images` is populated on the `"message"` route and on no
other), and the trace's context row, which prints `1 image · image_url`,
`1 image · canvas_read` or `1 image · not carried`. A picture the caller
could not render is the same `"none"`: the line never promises an
attachment the message does not carry. AGENT-UX §16y's `vision === true`
gate still stands in front of all of it (a `false` or `unknown` row makes
`Ask` absent before any of this runs, never a disabled button), and §8 item
4 stands behind it: everything sent to a provider is visible in the trace
panel, an image included.

A drawing's own pill is what supplies the target on the tool route
(AGENT-UX §16l's fifth route, built this wave): a question that names a
sheet of ink has already named the canvas it stands on. Where that canvas
has no tab to name it, there is no target, and the route is honestly
`"none"` rather than a door the model would knock on in vain.

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
    ADDRESS a canvas: no tool takes an EXISTING canvas's id (captured once,
    at `createCanvasTools`'s construction, from the target resolved before
    the exchange's first await, LESSONS 3, §5.1), and no tool deletes one.
    It can CREATE one, narrowly (`canvas_create`, D1, 2026-09-14, §5.1), and
    that tool's own row-write is the SAME `canvas_upsert` a person's `New
    Canvas` already takes — no new Rust path for creation either, the
    bridge routes it by name exactly as the other three (§7). With neither
    a target nor the word "canvas" in the question, no canvas tool of any
    of the four exists at all — the array a provider is handed IS the gate
    (§5.1, §7). Row caps: 5 rows echoed to
    the model per block, 200 kept on the document (§5.1, the one number
    both `Add to Canvas` and a model write now share), 6 blocks a call, 8
    an exchange; the statement timeout is the thread's own (item 2).
12. **Images carry only the element's own render (C2b, 2026-09-11).** The
    only image content that ever reaches a provider is one drawing block's
    own PNG, produced by the SAME `toPng` export `Copy` already uses
    (AGENT-UX §16w), rendered from that block's own `strokes` array alone,
    at 2x and clamped to a 1568px long edge (§7). No path renders the app's
    chrome, another block, a file from disk or the clipboard into that PNG;
    no tool and no mention TAKES an image as input, only ever produces one
    FROM a drawing already standing on the canvas. The two doors an image
    can leave through, `Msg.images` on a person's own `Ask` (§7) and
    `canvas_read(block_id)`'s reply on the model's own call (§5.3), both
    read the same render function; neither is a place a byte the user did
    not draw could enter.

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
user watched happen (LESSONS 13). **`status` gains two MORE values once a
`ran` row's own transaction closes (D1, 2026-09-14, closing the gap this
paragraph once accepted): `committed` or `rolled_back`, written the instant
the `useConnections` subscriber that stamps `Exchange.ranTx` in memory
(AGENT-UX §13.6) sees `txTabs[key]` flip false, through the SAME full-row
upsert `ran` already used (`agent_answer_put`) — no new command, no new
column, no migration, since the column was always a bare TEXT and
`proposed`/`ran` were prose convention, never a database CHECK. The
persisted spelling (`rolled_back`) is not `ranTx`'s own in-memory spelling
(`rolledback`): one shape in memory, a different one on disk, and exactly
ONE map between them (`TX_STATUS` / `txFromStatus`, `stores/agent.ts`), so
the two can never drift apart through a second, uncoordinated conversion
(LESSONS 11).** A CHANGE's status is therefore one of four, in the order it
moves through them: `proposed | ran | committed | rolled_back`; the other
four spellings this column carries (`answered`, `failed`, `turn_cap`,
`cancelled`) belong to a read and never meet a transaction. A transaction still open when the app
closes, or one closed some route this pair does not track, leaves `status =
'ran'` with nothing to distinguish, and a reload mid-transaction still
reads `ran` with no way to ask the tab what it later decided — that half of
the gap was never the finding, and it stays open on purpose (nothing closed
the transaction for the app to have learned from).

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
Restart's confirm counts the canvas widgets beside the questions it deletes:
`Restart from Here?` · `The 2 questions after this one, their answers and 7
canvas widgets will be deleted.` · `Delete 2 Questions` (AGENT-UX §16i, and
§16gg for the word: a grid element is a WIDGET in every string a reader sees,
D2 item 8).

**Open (D1, 2026-09-14): a cut does not delete a canvas `canvas_create`
made, only the blocks a `canvasWrites` entry names.** An exchange that
CREATED a canvas (§5.1) and is later cut by a Restart leaves that canvas
standing, empty or not, an orphan tab with no exchange left that made it;
`canvasWrites` tracks blocks written into a canvas, never the fact that an
exchange minted the canvas itself, and closing that gap (a `canvasCreated:
canvasId` field beside `canvasWrites`, and a fourth rule for the three
above) is carried forward rather than guessed at here.

One new `AskEvent`, kinds 9 → 10 (`loop.ts`):
`{ type: "canvasWrite"; canvasId: string; blockIds: string[] }`, emitted
right after a canvas tool call returns and recorded by `runInto`'s
`onEvent`. The ids are never parsed out of the model-facing result text —
deriving one record from another rendering is the exact bug the tool
result's own tolerant-parsing comment (§4.6) warns against — so this event
is the only place `canvasWrites` is ever written.


**The document becomes a grid, `v: 2` (C2, 2026-09-11).** `doc_json` stays
the one opaque blob it always was (above: no new appdb column, no new
migration); its SHAPE gains a version marker and, on every block, a cell:

```ts
interface BlockBase { id; askedFrom?; wroteBy?;
                       cell: { x: number; y: number; w: number; h: number };
                       autoH?: boolean }
interface DrawingBlock extends BlockBase { kind: "drawing" }   // the type only this wave; C2b gives it strokes and a surface (AGENT-UX §16p)
type Block = ResultBlock | NoteBlock | DrawingBlock
interface CanvasDoc { v?: 2; blocks: Block[]; lastColumns?: number }
```

`v` absent is a pre-C2 document (`{ blocks: Block[] }`, no block carrying
`cell`) and is migrated on load, once, inside `parseDoc`'s success path:
every block keeps its stored order exactly (`x = 0`, `y` the running total
of what came before it), takes `w = min(columns, 6)` (full width at the
5-column floor, 6 cells, 732px, anywhere wider, which is just past the
note's own 680 measure cap so nothing a user already reads gets any wider
than the law already allowed), and `h` from its kind's own content formula
(AGENT-UX §16p). A migrated document does **not** persist on that load —
this section first specified a `persist(canvasId, { touch: false })` write
to carry it, but `persist` takes no such flag and `load` schedules none:
`readDoc` migrates in memory, `docs[id]` in the store holds the result from
that load forward, and the row in appdb keeps A3's own v1 bytes until the
user's first real change (a move, a resize, a new block) calls `persist`
for real. Stronger than the write this section first asked for: opening an
old canvas cannot reorder the `@` completion's `Recent` rung (LESSONS 5's
own rule that a read must not look like an edit) because nothing is
written at all, and there is no touch-suppressing flag to keep in sync
with `persist`'s other callers. Nor does the layout re-derive on every
open: the same in-memory `CanvasDoc`, cells included, is what `docs[id]`
answers with on every read until that first real edit, so `outline()`'s
own `at x,y` names the same thing every time the model asks. A document
that did not parse is still never written over (unchanged); the migration
runs only inside that success path, never near the guard that refuses to
write over a broken one.

`autoH: true` marks a note whose height still follows AGENT-UX §16p's
formula; the first hand resize clears it, exactly as a drawing's own
autofit will (C2b). `lastColumns` is ADVISORY, never an invariant (LESSONS
5): it is the column count the document was last laid out at, so
`outline()` (§5.2) can word `at` honestly when no tab is open to measure,
and nothing reads it to decide whether an operation is legal.

**Serialize and deserialize are born as a pair (LESSONS 1).** `writeDoc(doc):
string` and `parseDoc(json): CanvasDoc | null` replace today's bare
`JSON.stringify` / `JSON.parse` plus one `Array.isArray` guard with named
functions and one property test, `parseDoc(writeDoc(d))` deep-equals `d`
for random v2 documents; `parseDoc` returns `null` only for unparseable
JSON or a missing `blocks` array, the same two conditions as today. A v1
document is not one of them, it parses and migrates, so a migration is
never mistaken for the break that would freeze a canvas forever.

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
