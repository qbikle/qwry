# qwry Roadmap

> Session protocol: pick the next open item, build it, verify it against the owning plan doc's gate, tick it there, then append a dated session note at the TOP of [`ROADMAP_log.md`](./ROADMAP_log.md) (what was done, what's half-done, gotchas). One wave ≈ one session; finishing early, pull the next item. `LESSONS.md` (bug classes), `DESIGN.md` (pixels), `WRITING.md` (strings) and `DECISIONS.md` (ADRs) are law and bind every change; cite them when pushing back, even on the maintainer.

Plan docs: [`ROADMAP_v0.5.md`](./ROADMAP_v0.5.md) (v0.3 → v0.5 push, complete) · [`ROADMAP_v0.9.md`](./ROADMAP_v0.9.md) (v0.7 → v0.9 launch push, complete) · [`GAPS.md`](./GAPS.md) (ranked gap census) · [`ROADMAP_log.md`](./ROADMAP_log.md) (archived session log, 2026-06-12 → 2026-08-23). Two invariants outrank all feature work: **never feels slow at any data scale**, **never lies about or corrupts data**. Current version: **0.9.7-alpha.4**.

## Shipped

- **v0.1** (2026-06-12, P0–P10, one session): Tauri 2 + React shell, PG simple-protocol streaming driver, virtualized 50k grid, schema-aware completion, edit-from-arbitrary-SQL, jsonb inspector, table browser, tabs/history/palette, EXPLAIN tree, danger guards.
- **v0.1.5** (06-13/14, P1.1–P1.7): batched row UPDATEs, ctid-fallback editing, insert/delete row, JsonTree search + tree editing, per-tab sessions and transactions, light theme, vibrancy + app icon, SSH tunnels.
- **v0.2** (06-14/15): floating-card shell on vibrancy gutters, seed-based theme engine (8 palettes, dual-mode custom themes), connection rail + home dashboard + DB switcher, per-tab results, inspector redesign, breadcrumb.
- **v0.2.5** (06-17): tables-as-tabs, type-icon column headers, inline add-row band, close-with-unsaved-edits guard, connect-error surfacing.
- **v0.3** (06-26 → 07-02): shared overlay primitive + nested ContextMenu, context menus across surfaces, ⌘F in editor and results, Copy URI + paste-DSN. Detail: `ROADMAP_v0.5.md`.
- **v0.35** (07-02, the Correctness Milestone): statement-at-a-time execution keystone, verify-then-commit, truncated-cell / NULL→`''` / JSON-reserialization corruption guards, never-lose-work sweep, display-honesty sweep. Detail: `ROADMAP_v0.5.md` + `GAPS.md` §1.
- **v0.4** (07-02/03): grid memoization and drag/scroll perf, header sort, column reorder + hide, quick-filter, selection stats, export to file, run-statement-under-cursor, table DDL view, persisted column widths.
- **v0.45** (07-02, one batch): staged-edit undo/redo, fill-down, paste-into-selection, full keyboard grammar, bool/enum editors, Set DEFAULT, FK forward + reverse navigation, row peek, filter-op power.
- **v0.5** (07-03): native macOS menu bar, Settings ⌘,, enforced prod read-only safe-mode, test-connection, history panel ⌘Y, window + active-tab persistence, format presets, NOTICE surfacing.
- **v0.6.0** (07-06): per-connection workspaces + cross-connection pins, the latency batch (2-RTT commits, cached edit mappings, schema hydrate, tunnel dedupe, spare sessions), three design loops, QOL loops, Liquid Glass gutters.
- **v0.7.0-bedrock** (07-18): `GAPS.md` §1 correctness-ledger burn + driver spine (driver-lexed tx state, SAVEPOINT edits, out-of-band cancel, appdb migrations, single instance). Detail: `ROADMAP_v0.9.md`.
- **v0.7.1-tempo** (07-18/19): `GAPS.md` §2 perf-register burn: true keyset pagination, incremental editor statement spans, inspector/tree/grid memoization, catalog cache. Proof harness kept at `scripts/keyset-proof.ts`.
- **v0.8.0-spelunk** (07-19): record view, row diff, FK picker, value histograms, multi-column sort + NULLS control, filter power, deep Structure tab, jump-to-row, sidebar depth (functions/sequences/enums/pins).
- **v0.8.1-timeline** (07-19): inverse-SQL undo after commit, buffer time-machine, history panel upgrade, `.sql` open/save/drop, ⌥↑/⌥↓ history stepping, CSV import wizard.
- **v0.9.0-flightcheck** (07-19): focus discipline + modal traps, Mac destructive-confirm grammar, empty-state CTAs, UI zoom, live window title, README, first dmg.
- **v0.9.1-firstlight → v0.9.2-lookingglass** (07-20): hidden-until-painted launch + code splitting (1.47MB → 590KB entry), draft-paste data-loss fixes; then the 4-lens UI audit sweep (49 findings) with copy cues, the grid z-ladder and `scrollPaddingEnd`.
- **v0.9.5-truename → v0.9.7-copyedit** (07-21): workspace identity honesty (origin provenance, prod ceremony bound to origin), draft-row value grammar, TSV round-trip parser, `WRITING.md` + `LESSONS.md` written, 790-string copy sweep, identifier register.
- **fix/orphaned-global-chords + PR #17 audit** (07-21): inputs swallow only the keys they own (LESSONS #10); chord fixes hardened.
- **v0.9.8-onerow → v0.9.9-onelook** (07-22): RowPeek absorbed into Record View, inspector narrow mode; then `DESIGN.md` born and the whole app migrated onto it (census 597 → 0) behind `scripts/design-lint.ts`.
- **v0.9.10-lifeline** (07-22): SSH control-lane cancel (second pre-spawned ssh child), hard client-side abort, instant Cancelling… feedback.
- **v0.9.11-truecolor → v0.9.13-lighthouse** (07-23/24): stable-chrome law, Match Connection theming, per-connection themes + Switch species, auto-update over GitHub Releases (inert until the repo is public).
- **Session 14** (08-20): ⌘Z in the JSON editor, tab scroll restore, selection-tinted headers, session self-heal across sleep/tunnel death, inline rebuilt-session consent + ⇧⌘R.
- **Session 15** (08-21/23, v0.9.7-alpha.4): record-view JSON scroll + pencil affordance, ⇧⌘R "the rebuild" choreography, principal-review fixes.

## Open

Deduplicated across this file, `ROADMAP_v0.5.md`, `ROADMAP_v0.9.md` and `GAPS.md`. `[G]` = carried from `GAPS.md`; `[5]` = from `ROADMAP_v0.5.md`; `[9]` = from `ROADMAP_v0.9.md`.

- **Correctness / data**
  - Capped SELECTs inside an open transaction drain fully; auto-cancel is disabled there on purpose `[G §1d/§2.11]`
  - ctid-keyset pages can dup or vanish rows under concurrent writers; PK tables unaffected; candidate = a banner on PK-less browses `[G]`
  - Inspector JSON/scalar drafts die on Esc or cell-switch with no confirm `[G §1b]`
  - Restore-closed-tab stack does not survive restart (needs an appdb surface) `[G §1b]`
  - JSON copy/export emits every value as a string (needs type-aware coercion); cmdk still re-filters palette history on the 80-char value prefix `[G §1c]`
  - Error positions: UTF-16-vs-char drift on non-ASCII, and selection runs get no squiggle at all `[G §1c]`
  - ssh stderr is never drained after startup; a chatty bastion can wedge a days-old tunnel via pipe backpressure `[G §1d]`
  - `ql()` assumes `standard_conforming_strings` stays on for the session's life; `execute_simple`'s multi-statement error classifier is position-blind `[G §1d]`
  - Undo residuals: inverse SQL re-fires row triggers, identity-ALWAYS re-inserts mint new ids, only the newest commit is ever offered `[G §1d]`
  - Import cancel is a silent no-op between batches; `.sql` file links are session-only; `session_profiles` leaks a String pair per hard session death `[G §1d]`
  - Race ledger: FK-nav dotted-name split, missed ConnToast death toast, DbSwitcher/saveProfile skip the open-tx confirm, delete-vs-connect resurrection, force-disconnect logged `error` not `cancelled`, stale `txTabs` after primary death, history stats race on the error path `[G §1d]`
  - Semantically no-op JSON/array edits never clear dirty → phantom UPDATE `[5]`
  - A user column literally named `ctid` (type `tid`) is still taken as a row locator; array cells edit as scalars until the editability map loads; stale schema snapshots survive disconnect/profile-delete; `openRecent` is unguarded for a deleted profile `[5]`
- **Perf**
  - Cold start <500ms and 60fps budgets have never been measured in-app (autonomous window probe blocked by Accessibility) `[9]`
  - `applyTheme` still writes ~40 `setProperty` calls; the editor still remounts on theme change (Compartment fix) `[G §2.17, 5]`
  - Copy-as JSON/CSV of 50k rows is still synchronous (only TSV is chunked); completion caps degrade silently past 200KB statements `[G]`
  - String-per-cell allocation on large decodes (`execute.rs`, borrow / columnar wire path is the stretch fix) `[5]`; one Mutex serializes all of appdb; the double 10s TLS retry stack means ~30s of "connecting" with no abort `[G §2.16/§2.17]`
- **Editor**
  - Completion is blind to CTEs/derived tables/subquery scope, breaks on quoted mixed-case identifiers, never pops after a bare `FROM `, fires inside strings/comments; usage ranking is frozen and global `[G]`
  - ⌘E is always EXPLAIN ANALYZE (it executes); no plain-EXPLAIN variant, and it breaks on multi-statement selections `[G]`
  - Editor right-click has no Cut/Copy/Paste/Select All (WKWebView's native menu is suppressed) `[G]`
  - ⌘F has no affordance in scalar/raw inspector values or DDL views `[G, 5]`
- **Grid / results**
  - Column pin/freeze, date-picker editors, JSON array element add/remove (v0.45 deliberate deferrals) `[5]`
  - "Fetch next" past the 50k cap for arbitrary SELECTs `[5]`
  - Statement chips overflow unmanaged; the browse-injected `ctid` column still shows and copies as data `[G]`; menu track unfinished: gutter/rownum menu, structure-row menu, cell Filter-by-value / Hide-rows-with-this-value, header Copy as IN-list `[5]`
- **Table browser**
  - Truncate / Drop table actions never shipped; the typed-confirm tier for TRUNCATE/DROP is still open `[5, G]`
  - Filter column picker is still a raw 300-option `<select>` (searchable picker deferred to filter-bar completion) `[G, 5]`
  - Stale `TableInfo` after DDL: filters/sort/draft still use tab-open-time columns `[G]`
  - Partitioned parents (relkind `p`) can't insert; no keyboard shortcuts on the whole browse surface `[G]`
- **Sidebar / saved queries**
  - No keyboard path from the filter into the tree; filter is name-only, unranked, and leaks state across profile switches; no active-table highlight, staleness hint, or schema-header menu `[G]`
  - Saved queries have no search box or folders; rename discards on blur `[G, 5]`
- **Connections**
  - Password reveal toggle and forget-stored-password; per-connection init SQL (SET ROLE/search_path); session-count visibility `[G]`
  - DbSwitcher clones pollute the rail permanently (a 40-db server is rail soup) `[G]`
  - Accept psql flag strings and `.env` lines; auto-detect a DSN on the clipboard `[G]`
  - `.pgpass` / `pg_service.conf` / preconnect script; host-key rotation renders as a raw wall of text `[G]`
  - Prod safe-mode polish: ambient chrome beyond the chip, timed auto-relock `[G]`
  - Connect-error toast auto-dismisses at 8s, unreadable for multi-line ssh errors `[G]`
- **Shell / palette / persistence**
  - ⌘↵ and ⌘. work only from the editor; palette "Run query" ignores the editor selection (a safety divergence) `[G]`
  - Missing macOS tab chords (⌘⇧[ / ⌘⇧], ⌘⌥←/→); breadcrumb not clickable; ContextMenu lacks checkbox items and re-open-at-new-point `[G]`
  - Cascading overlay close restores focus to the editor fallback, not the true opener; zoom chords need a one-time device test; the `--zoom` CSS factor has no consumer `[G]`
  - Table tabs are still session-only across restart (locked decision #5, flagged to revisit); cursor/undo not restored; tabs need a `meta` JSON column `[G, 5]`
  - History is blind to database and orphaned by profile deletion; no true cross-connection clear `[G, 5]`
  - IPC types are still hand-mirrored Rust→TS; adopt ts-rs/specta `[G]`
- **Driver**
  - `type_oid=0` on the streaming path: the grid has no types until editability's second round trip `[G, 5]`; COPY is detected only as a clean error, `copy_in`/`copy_out` later (feeds export) `[G]`
- **Release**: README screenshots still commented out; LICENSE TBD; the auto-update endpoint 404s until the repo is public; timestamptz UTC ↔ local display toggle `[5]`
- **Deferred by charter** `[5]` (AI NL-to-SQL left this list for Next: Agent): other engines (MySQL/SQLite), JSON import, visual ALTER/DDL editor, ER diagrams / charts / geo viewer, SSL verify-ca/verify-full + client certs, connection folders, optimistic stale-row detection, parameterized queries, code folding, notebook panes, snippet-management UI, pg_dump / schema diff / roles / activity monitor, plugin system, multi-window + split panes, screen-reader a11y, connection and saved-query import/export, LISTEN/NOTIFY.
- **Surpass backlog** `[G §4]`
  - Leapfrogs left: latency breakdown in the status bar, plan history + regression diff, copy-for-Slack, qwry as an MCP server, schema-aware completion in the filter bar
  - Parity steals left: schema-aware lint with did-you-mean, permanent statement-boundary gutter, result-set diff (incl. cross-connection), PG toolbox macros (`$SELECTION$`, blockers, pg_settings), `:param` prompts as real extended-protocol params, browse back/forward history, privacy blur mode, FK peek popover, row-as-JSON with FK expansion

## Next: Agent

Law: [`AGENT-SPEC.md`](./AGENT-SPEC.md) (architecture, pipeline, tools, providers, safety, tiers) · [`AGENT-UX.md`](./AGENT-UX.md) (surfaces) · [`EVAL.md`](./EVAL.md) (benches + gates). Research basis: `~/projects/qwry-agent-lab` (measured 2026-09-01 → 09-05; hybrid pipeline 23/23 Haiku, 22/23 Sonnet on the 202-table staging schema). One phase ≈ one workflow; every UI phase ends with a running dev build and a maintainer taste stop.

- **A1 · Ask (v1)** — read-only question → SQL → answer panel. Gate: `EVAL.md` PR gate green; staging hybrid ≥ 22/23 on mid and large tiers.
  - ✓ (W1, 09-05) Rust `agent.rs`: `agent_connect` (gated read-only session), `agent_describe`, `agent_peek_values`, `agent_run_readonly` (`pg_query` AST gate + function deny-list), `agent_probe`; Keychain keys; `agent_http.rs` relay, `agent_claude.rs`, `agent_mcp.rs` (streamable-HTTP MCP)
  - ✓ (W1, 09-05) TS `src/agent/`: loop, prefilter (IDF + FK hubs + 1-hop; Pagila recall 31/33, the two misses are two-hop joins), risk classifier, prompt v1, tolerant extraction, `src/stores/agent.ts` + appdb persistence
  - ✓ (W1, 09-05) Providers: OpenAI-compatible (13 presets incl. Gemini) → Anthropic → `claude -p` via the in-process MCP server; registry with tiers; all HTTP through the Rust relay. Unverified live: every hosted preset (no keys on the build machine)
  - ✓ (W1, 09-05) Small tier: one-shot pipeline + ≤2 repairs (no tool loop); unmeasured against a live local model in-app
  - ✓ (W1, 09-05) Eval: `eval/` benches (Pagila 33 + hard 5 new, staging 23 + 5), `scripts/agent-eval.ts` on the same loop, `eval/baseline.json` (claude-code rows), CI job on Pagila (hosted row still to record)
  - ✓ (W2c + W2d, 09-05/06) Taste rounds 2–3: pending assumption chips + `Retry Without Assumption` pill, cancel restores the prior answer, scrolling strip with `qwrying…` sweep, Threads sheet, animated Ask ↔ Inspector swap, one-row values, tinted question bubble with the lift on send, rotating generated starters, `claude -p` side calls for follow-ups and starters, footer dot, finished SQL with `;`, last-prose answer rule; frames in `qwry-agent-lab/docs/research/w2c-frames/` and the scratchpad `w2d-frames/`
  - ✓ (W2 + W2b, 09-05) UI: Ask as a mode of the one right pane, header `Ask · Threads · New Thread`, two-row composer with the model picker in its control row, answer anatomy (text once, grid, SQL row, assumption chips, sanity line, follow-ups, footer, trace drawer), Fix It, Settings › Models; taste pass landed under DESIGN rules 11–14 and `.claude/skills/taste-gate`, frames in `qwry-agent-lab/docs/research/w2b-frames/`; open after the gate: the `Fix It ⌘↩` face vs AGENT-UX §11 (S2), the bare `probe` chip, the EVAL v2 re-baseline
- **A1.5 · Ask → agent (next; one workflow per wave, each ends in a dev build + taste stop; frames via `scripts/ask-frames.ts`, gate via `.claude/skills/taste-gate`)**
  - ✓ (W4, 09-06) **Message actions + edit** — hover actions on every question bubble (`Copy`, `Restart`, `Jump Back`), revealed with the strip's motion language, keyboard-reachable; clicking an older bubble jumps the thread back to it with the composer prefilled for editing (the bubble's text travels back into the composer, the later exchanges fold away; `Restart` re-asks as-is, `Jump Back` truncates the thread from there after a confirm when answers would be lost); all transitions on `springs.ts` presets. Store: thread truncation persisted (appdb turns after the cut are deleted), `prior`-style restore on cancel. Frames: hover, edit-ready, folded. Landed: `Copy` · `Restart` · `Jump Back` left of every bubble (the cap `calc(100% - 76px)` makes their room), edit mode with the fold (variant B: the edited bubble leaves with its words, the later ones stand as a dimmed stack; no dialog on send, the danger confirm on an older Restart only), appdb v7 `session_key` + `agent_thread_truncate` by named rows + `agent_turn_update`, the post-cut replay prefix on the user message, six harness states (`actions` · `actions-latest` · `actions-busy` · `edit` · `edit-latest` · `edit-stack`), frames in the scratchpad `w4-frames/`
  - ✓ (W5, 09-06) **Rich answer text, and rewarding it** — three halves, measured together. Landed: `parseBlocks` + `AnswerText` (lead-in · bullets · quote · code · link · the model's table only without a run; figures tabular at 600; no clamp), prompt v3 (`PROMPT_VERSION` v3, the measured rules byte-equal, one GOOD and one BAD example), `eval/presentation.ts` + `eval/bench/pagila-insight.json` + the `--baseline` presentation rule; measured on Haiku 4.5 via claude-code: insight bench **0.514 over 7 (v2) → 0.850 over 8 (v3 as shipped)**, `pagila.json` **32/33** at v3 against the v1 row's 33/33; the carried finding is `no_grid_restatement` 4/8 (four answers still name two cells of one row inside a comparison: the next prompt iteration's line). Five harness states (`insight` · `insight-prose` · `insight-steps` · `insight-code` · `insight-stream`), frames in the scratchpad `w5-frames/`, the streaming probe in `w5-stream-probe.log`.
    - ✓ *Support*: the answer slot renders a markdown subset (headings as lead-ins in the trace-kind register, bold/italic, inline code, ordered and unordered lists, blockquotes, links opening in the browser, non-SQL code blocks in the editor register, simple tables as a readOnly grid) while the SQL fence, the `Assumptions:` line and result tables still go to their slots (DESIGN rule 14); `display.ts` grows into a small block parser with property tests; the trace keeps the raw text. Design first, in the sketch: an "insight" answer at 320/392/560 next to today's wall of prose (the order_v2 example: good data the eye slides off toward the grid). Figures (numbers, currency, percentages) set in tabular numerals at tier 1 whether or not the model bolded them; bullets for multi-part insights with a two-line cap each; a lead-in per group, never a heading hierarchy.
    - ✓ *Tell*: prompt v3 says what formatting exists and WHEN to use it (a direct question = one sentence; an insight question = two to four bullets, each one finding with its figure, optional one-line lead-in; never repeat the grid), with one good and one bad example.
    - ✓ *Reward* (the heuristics; the judge-model rubric is unbuilt and stays as written, EVAL.md section 3.x says so in the same words): EVAL.md gains a presentation score beside execution accuracy on the insight-style bench questions: code heuristics first (bullet count in range, sentence length, figures present, no grid restatement, no headings deeper than a lead-in), a judge-model rubric only if the heuristics disagree with the maintainer's eye on a 20-answer sample. Baseline per model, then prompt/few-shot iterations that move the score without touching accuracy; the re-baseline after the prompt bump covers both scores.
  - ✓ (W6, 2026-09-06) **@ context tags** — `@table`, `@column`, `@saved-query`, `@thread` completions in the composer (cmdk-style popover, schema-aware), rendered as chips inside the draft and sent as explicit context (the prefilter takes them as must-include candidates; the trace shows them); the answer echo keeps the chips. Landed: `src/agent/mentions.ts` (the grammar, the resolve ladder, `canonicalToken` and the `TAGGED BY THE USER:` lines, pure and store-free), `AskRequest.mentions?` + `candidates(…, mustInclude)` + `askMessage({ context })` (`PROMPT_VERSION` untouched, the eval's bytes pinned), `MentionPopover` (the picker's box as the composer's own completion, off the overlay stack, focusless) over `mentionRows.ts`, the `.mention` pill in the draft's backdrop, the lift ghost and the bubble, the trace's `tagged` line; four harness states (`mention-popover` · `mention-draft` · `mention-echo` · `mention-trace`), frames in the scratchpad `w6-frames/`, behaviour probes in `w6-probe.log` and `w6-fix-probe-run.log`.
  - **W3 · Close** — two-lens principal review of the whole branch, `PROMPT_VERSION` re-baseline on Pagila (both claude-code rows) and the staging benches (auth_new via `STAGING_*` in `~/.claude/.env.claude`, claude-code provider), numbers into `ROADMAP_log` + release notes, then the PR to main. Runs after W4–W6 unless the branch needs merging sooner.
  - Carried opens: follow-ups and generated starters land 10–25 s after the answer on claude -p (a lower-effort side call, or Haiku for side calls regardless of the answer model); `Retry with Changes` label; kv values over ~20 mono chars wrap at 560; `probeNoun` blind spots; the sketch v2 trace frame lags the build.
- **A2 · Knowledge + Quiz** — table hints and legacy tags (optional write-back as `COMMENT ON`), business definitions, synonyms; query-history few-shot memory; Explain/audit any SQL; Quiz: guided Q&A flow, saved quick-asks in the palette, data-check quizzes (saved assertions, pass/fail)
- **A3 · Collaborate** — canvas of blocks (query, table, chart, note, assumption) with inline comments read as agent turns; two-connection diff (same question on staging vs prod, now vs then); multi-DB analysis through an in-app join layer (aggregates only, never raw millions)
- **A4 · Act** — writes with preview (affected-row count, before/after sample, missing-WHERE / no-LIMIT warnings, rollback plan, explicit Run; never auto-run); natural-language edits from Record View; watchers (query + threshold + schedule → notification); Modelling and Optimization modes (large tier only)
- **Research items** — provider presets beyond v1 (Bedrock/Vertex/Foundry, Together, Fireworks, DeepSeek, xAI); legacy-twin detection beyond comments; history pruning for long threads (needs a session bench); local-model TPS floor for the small-tier path; MCP sidecar vs in-process

## Distilled from the session log

Concrete findings from `ROADMAP_log.md` that are not already law in `LESSONS.md` / `DESIGN.md` / `WRITING.md` / `DECISIONS.md`.

- Clamp overlays by `offsetWidth`/`offsetHeight`, never `getBoundingClientRect`: a motion entrance scale returns the transformed box and the clamp undersizes (2026-06-26).
- Attached submenus SLIDE to fit; only point-anchored menus flip. Flipping a submenu detaches it from its parent item (2026-07-02).
- React portals bubble keys through the React tree, not the DOM: a portaled input over the grid seeds cell edits unless it claims the keys it owns (2026-07-02).
- cmdk routes Enter by `value`: duplicate labels (two tabs named `new qwry`, two connections named `prod`) can connect you to the wrong database; put the id in the value (2026-07-02/04).
- The header gesture map that finally read right: click = select column, drag = reorder, arrow = sort, no modifiers; the sorted column earns a gradient baseline so sort state reads from across the grid (2026-07-02).
- Never centre an animated overlay with `transform`; the spring's transform overwrites it. Flex-centre the backdrop instead (2026-06-12).
- WKWebView `<button>`s don't take focus on click, so click-then-⌘S never bubbles; surface-level shortcuts need a capture-phase window listener (2026-06-14).
- WebKit reports the UNSHIFTED key under ⌘: ⌘? arrives as `/` plus shift (2026-07-06).
- `visibility: hidden` drops a control out of the tab order, so its `:focus-visible` reveal can never fire; reveal with opacity (2026-08-23).
- Native `title` tooltips are slow and unreliable in WKWebView and read as "this control does nothing"; anything load-bearing needs a real styled bubble (2026-07-24).
- Keep the ⓘ outside the `<label>`: inside one, reading the tooltip flips the setting (2026-07-24).
- Empty-state read hierarchy: the shortcut keycap leads, the sentence follows (2026-07-23).
- StrictMode's throwaway first mount eats one-shot signals: consume on CONFIRMED success, never on attempt; and when a bug survives two fixes, stop reasoning and instrument (2026-07-06).
- Any mousedown-initiated loop with side effects needs a movement threshold, even when the click gesture looks compatible (edge-autoscroll armed on a plain click) (2026-07-06).
- A DML `EXPLAIN` plan roots at a `ModifyTable` node whose own Plan Rows is 0; the blast-radius estimate is the child scan node (2026-07-03).
