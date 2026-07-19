# GAPS — Density audit, 2026-07-02

> Census of everything qwry is missing or getting wrong, produced by a 13-agent audit:
> 9 code-surface auditors (every src/ + src-tauri/ surface, read in full) + 4 lenses
> (TablePlus census, Postico 2 + Beekeeper Studio, DataGrip + pgAdmin, first-principles
> daily-workflow enumeration). Raw per-agent reports with full detail live in
> `docs/audit-2026-07/*.json` — this file is the ranked synthesis.
>
> **This is the census; execution order lives in `docs/ROADMAP_v0.5.md`.** When an item
> ships, tick it here too. `[plan]` = was already in ROADMAP_v0.5.md before this audit.
>
> Mission context (2026-07-02): goal upgraded from "releasable v0.5" to **surpass
> TablePlus/Postico/Beekeeper/DataGrip/pgAdmin** — no finish line. Two invariants that
> must never regress: (1) never feels slow at any data scale; (2) never lies about or
> corrupts data. Feature count only grows.

---

## 1. The correctness ledger — invariant-2 violations (fix before anything shiny)

Every entry here makes qwry lie about data, corrupt data, or lose work. These outrank
all feature work.

### 1a. Data corruption / wrong writes

- [x] **Multi-statement run is one implicit transaction — UI reports early UPDATEs committed, then a later error rolls back everything** — FIXED 2026-07-02 (keystone): `execute_stream` now runs each split statement as its own `simple_query` (psql autocommit); explicit BEGIN/COMMIT still span; VACUUM works mid-buffer; error positions rebased to whole-buffer chars via `StmtSpan.char_offset`. Proven by `staging_statement_at_a_time` live test. Rode along: StatementStart now fires at true start (real ms for DDL/UPDATE), `affected` always passed through (RETURNING keeps its count).
- [x] **Editing a truncated (>8KB) cell stages the 8KB prefix — commit destroys everything past 8KB** — GUARDED 2026-07-02: every edit entry point (grid inline editor, inspector pencil/dblclick/editSeq, JSON tree/raw) now refuses until the full value is fetched (chip says so); grid dblclick on truncated routes to inspector and auto-enters edit when loaded. Still open: backend `fetch_cell` command to replace the hand-rolled fetch SQL (quoted/aliased idents, no `.catch`). — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Open editor on a NULL cell, click away → stages NULL→`''` silently** — FIXED 2026-07-02: `startedNull` tracked; empty close on a NULL cell stages nothing (empty string only via explicit Set EMPTY); editor shows a NULL placeholder.
- [x] **One leaf edit re-serializes the whole JSON doc** — FIXED 2026-07-02: raw mode now stages the typed text VERBATIM (parse = validation only) for json AND jsonb; `json` columns tree-edit disabled (raw only); docs containing bare ≥16-digit numbers get tree-edit + pretty-print disabled with a warning chip (raw text shown/copied instead of a rounded re-serialization). Remaining edge: big numbers inside PG *array* raw edits still round (jsToPgArray path).
- [x] **`structuredValue` treats any text starting `{`/`[` as JSON → text column corrupted** — FIXED 2026-07-02: strict type gate (json/jsonb → JSON.parse; array types → parsePgArray; anything else = plain text); Grid JSON routing now by column type only. Side effect: unmapped results (editability unavailable) show raw text instead of a tree — honest over pretty.
- [x] **`matched != 1` still COMMITs** — FIXED 2026-07-02: apply_edits/delete_rows now run verify-then-commit (per-statement RETURNING count, any mismatch → ROLLBACK all, `committed:false`); frontend keeps rolled-back edits staged + surfaces why. Proven by `staging_matched_rollback` live test.
- [x] **Mixed AND/OR filters compile to different logic than the UI shows** — FIXED 2026-07-02: WHERE folds left-associatively, matching the linear UI reading.
- [x] **`apply_edits` sends BEGIN…COMMIT on a session already inside the user's transaction → silently commits their open work** — `edit.rs:394`. Track tx state; use SAVEPOINT or refuse. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **ctid-located edits can write a different row after UPDATE/VACUUM row movement** — `edit.rs:169`. Add old-value WHERE predicates or `FOR UPDATE` verify inside the tx. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Edit casts break on mixed-case / schema-qualified / custom types** — `edit.rs:335,350,481` emit bare `::mystatus`. Quote + schema-qualify via `Type::schema()`. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Tree-generated SQL uses unquoted identifiers / Copy-as-INSERT `your_table`** — FIXED 2026-07-02: shared `lib/sqlIdent.ts` (`qi` quote-when-needed w/ reserved list, `qualify`); SchemaTree SELECT/copy refs quoted; copy-as-INSERT emits the real qualified table (single-source results), quoted column names, and drops ctid locator columns.
- [x] **GENERATED ALWAYS / identity-ALWAYS columns shown editable — fails only at commit** — `edit.rs:187-245` never reads `attgenerated`/`attidentity`. Mark read-only with reason. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Commit wipes pending edits for statements whose editability map was loading — silently dropped, never applied** — FIXED 2026-07-02: commit clears ONLY keys that actually committed; skipped/rolled-back edits stay staged with a status message.
- [x] **Draft-row double-commit inserts the row twice** — FIXED 2026-07-02: per-tab in-flight guard on commitDraft.
- [x] **Draft row can't express `''`** — `browser.ts:244` skips `text===''` → silently becomes DEFAULT. Track touched-ness; make DEFAULT/NULL/`''` all expressible. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Rename tab pushes the tab's unsaved SQL draft over the linked saved query** — FIXED 2026-07-02: rename updates the saved entry's name only, preserving its stored SQL.
- [x] **Literal quoting assumes `standard_conforming_strings=on`** — FIXED 2026-07-02: forced on via connect options.
- [x] **JSON key rename silently overwrites an existing key** — FIXED 2026-07-02: rename onto an existing key is a no-op.

### 1b. Never lose work

- [x] **Any re-run wipes staged edits with zero warning — including scroll-triggered loadMore** — FIXED 2026-07-02: explicit re-runs (⌘↵, filter/sort, refresh) prompt "Discard N staged edits?" first; scroll-triggered loadMore parks itself while edits are staged (no hostile modal on scroll). Long-term PK-keyed edits still a beyond-item.
- [x] **⌘Q loses the last ≤600ms of typing AND skips the close guard entirely** — FULLY FIXED 2026-07-02/03: native menu owns Quit → routes through requestQuit (flush + confirm). Earlier partial: persist flushes on window blur/visibility-hidden AND in `onCloseRequested` (awaited before close proceeds); window close with uncommitted edits/draft row prompts a quit confirm. Remaining: ⌘Q via the DEFAULT app menu bypasses onCloseRequested — fully closed when the native menu bar (v0.5 P0) owns Quit.
- [x] **Failed `tabs_list` at startup → next persist WIPES all saved tabs** — FIXED 2026-07-02: persist gated on `loaded`; load catches, retries every 1.5s, gives a scratch tab meanwhile and MERGES any scratch typing into the restored set; `PRAGMA busy_timeout=2000`.
- [x] **`tabs_save` failures silently swallowed forever** — FIXED 2026-07-02: catch → auto-retry (3s) + persistent "⚠ not saving" badge in the tab strip until a save succeeds.
- [x] **Cross-tab undo corrupts another tab's SQL** — FIXED 2026-07-02: one EditorState per tab, swapped via `view.setState()` on tab switch — undo history, selection AND cursor are now per-tab (free ride-along: cursor position survives tab switches in-session). Cache dies on theme remount (Compartment fix still separate).
- [x] **Bulk close (Others/Right/All) bypasses the close guard / close guard ignores the draft row** — FIXED 2026-07-02: bulk closes show ONE aggregate confirm when any closing tab holds staged edits; per-tab close guard now also counts a half-typed inline add-row.
- [x] **⌘⇧D discard-all-edits: no confirm, no undo** — FIXED 2026-07-02: DangerModal confirm with edit count (undo still a v0.45 item).
- [x] **Disconnect / Reconnect / connection-save / recent-strip click silently roll back open transactions** — `connectionMenu.ts:23`, `connections.ts:87`, `Dashboard.tsx:49` (recent-click reconnects even when already connected, killing all tab sessions). Scan `txTabs`, confirm first. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [~] **Connection editor Esc discards a dirty 8-field form instantly** — FIXED 2026-07-02 for the connection editor (dirty check → "Discard connection changes?" on Esc/Cancel). Still open: inspector JSON/scalar drafts die on Esc/cell-switch with no confirm (`Inspector.tsx`).
- [x] **A late global error wipes 30k streamed rows off the screen** — FIXED 2026-07-02: error renders as a banner above the grid when statements exist; rows stay browsable.
- [~] **Restore-closed-tab drops table tabs and `saved_id` links; stack dies on restart** — MOSTLY FIXED 2026-07-02: closed-stack entries now carry kind/table/saved_id — ⌘⇧T reopens table tabs (re-browses) and restores the saved-query link. Stack persistence across restarts still open (needs appdb surface).
- [x] **Two app instances silently clobber each other's tabs** — busy_timeout added 2026-07-02 (no more instant lock errors); single-instance plugin still open. — FIXED 2026-07-18 (v0.7.0-bedrock).

### 1c. UI lies (read path)

- [x] **NULL vs `''` vs literal `'NULL'` render identically** — FIXED 2026-07-02: real NULL = dim chip element, `''` = "∅ empty" marker, literal text renders plain; numeric columns right-align with tabular-nums (type from the editability map).
- [x] **Browse status bar presents the loaded page as the whole table** — FIXED 2026-07-02: full page reads "first 1,000 rows — scroll for more", short page "all N rows"; reltuples estimate arrives with v0.4 introspection adds.
- [x] **Infinite scroll dups/drops rows without a unique sort** — FIXED 2026-07-18 (tempo, keyset w/ PK/ctid tiebreaker; proof: 8/8 incl. dup values + double NULL partitions). — `browser.ts:196` re-runs from row 0, no PK tiebreaker.
- [~] **Palette caps tables at first 400 BEFORE filtering** — FIXED 2026-07-02: own ranked fuzzy (exact>prefix>substring>subsequence) over the WHOLE catalog, top 50 rendered with forceMount so cmdk can't re-hide them. Still open: cmdk re-filters history on the 80-char value prefix.
- [x] **DbSwitcher renders query failure as "No databases"** — FIXED 2026-07-02: error state with the real message.
- [x] **Introspection failure = silent empty sidebar forever; every refresh blanks the whole tree** — FIXED 2026-07-02: per-profile error state rendered with message + Retry button; refresh keeps showing the old snapshot (stale-while-revalidate) instead of unmounting the tree.
- [x] **History lies about timing: ms=0 / undercounted rows race** — FIXED 2026-07-02: history_add now fires from the `finished` event with event-carried ms + summed row counts.
- [x] **history_search LIKE escaping broken** — FIXED 2026-07-02: `\`, `%`, `_` escaped + `ESCAPE '\\'` clause.
- [~] **TSV copy mutates data / CSV misses `\r` / JSON collides duplicate columns** — FIXED 2026-07-02: Excel-convention TSV quoting (data never mutated), CSV escapes `\r`, markdown cells `\n`→`<br>`, JSON dedupes duplicate keys (`id`, `id_2`). Still open: JSON values all strings (needs type-aware coercion).
- [x] **sslmode=prefer can silently downgrade to plaintext — outcome never surfaced** — `mod.rs:100-119`. Lock indicator + downgrade warning. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **One dead tab session flips the whole profile to "disconnected" AND leaks live backend sessions** — `App.tsx:97` ignores `session_id`; `markDisconnected` (`connections.ts:196`) drops map entries without `ipc.disconnect`. Also: deleting a connected profile leaks primary session + ssh tunnel (`connections.ts:94`). — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Keychain failure silently becomes empty password → "password authentication failed" points at the wrong problem** — `commands.rs:94` `unwrap_or_default()`. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [~] **Error position semantics** — PARTIAL FIX 2026-07-02: driver now rebases per-statement PG positions onto whole-buffer chars (squiggles correct for statement index > 0). Still open: UTF-16 vs chars drift on non-ASCII in the frontend anchor (`SqlEditor.tsx:166`), and selection runs get no squiggle at all (`SqlEditor.tsx:162`).
- [x] **PG DETAIL/HINT dropped from every error** — FIXED 2026-07-02: DriverError::Db + QueryEvent::Error carry detail/hint end-to-end; rendered in the results error pane and in the editor squiggle tooltip.
- [x] **Stale selection survives re-run/filter → ⌘C crashes; Set-NULL/delete target phantom rows** — `Grid.tsx:161,251,322,363`. Reset/clamp selection on statement change. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Right-click doesn't retarget selection — menu acts on previously selected cells (wrong data); no menu without selection** — `Grid.tsx:429`. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **`parsePgArray` failure renders as empty `[]`** — FIXED 2026-07-02: returns undefined on malformed/trailing-garbage input → raw text shown.
- [x] **Danger no-WHERE scan naive-splits on `;` — dollar-quoted bodies false-positive, string `;` can MASK a real missing WHERE, CTE-wrapped DML never flagged** — `stores/danger.ts:26`. Port the Rust splitter. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Splitter mis-lexes `E'…'` escape strings** — FIXED 2026-07-02: E/e-prefixed strings honor backslash escapes (identifier-tail guarded); unit-tested.
- [x] **"Clear history (all)" clears only the active profile** — FIXED 2026-07-02: relabeled "Clear history (this connection)" — the label no longer lies; a true global clear can come with the history panel.
- [x] **StatementStart for non-SELECT fires at completion; ms reported ~0 for DDL/UPDATE** — FIXED 2026-07-02 with statement-at-a-time execution.
- [x] **Failed/cancelled queries never enter history** `[plan v0.35]` — `results.ts:277` success-path only. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Save&Connect strands the user on a blank New Connection form; connect failure loses the profile from view** — `connections.ts:89` + `Home.tsx:12`. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **matview/complex-view read-only reason says "add ctid to edit" — a dead end** — `edit.rs:213`. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Editability 'unavailable' → no reason shown anywhere, double-click silently no-ops** — `Grid.tsx:590`. — FIXED 2026-07-18 (v0.7.0-bedrock).

### 1d. Robustness (panic/hang class)

- [x] **Dotted schema/table names split at the wrong dot in edit/delete SQL** *(found 2026-07-02 self-audit)* — `edit.rs:88-93,125`: table identity round-trips as `nspname || '.' || relname` then `split_once('.')` — a schema/table containing a literal dot reassembles as the wrong relation. Fix: carry schema+name as separate fields through EditabilityMap (touches frontend consumers of `tables`). — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Default-menu accelerator watch item** — RESOLVED 2026-07-03: app owns the native menu; Edit uses predefined items (native clipboard), customs emit app events; default File▸Close Window ⌘W gone. Original note: *(2026-07-02)* — agent analysis says Tauri's default menu owns ⌘C/⌘A/⌘Z/⌘W/⌘V key equivalents; EMPIRICALLY ⌘C/⌘A/⌘Z/⌘W reach the webview on this setup and only ⌘V misbehaved (menu-item validation). Grid now has BOTH paths for paste (keydown fallback + paste event). Resolve the whole class when the native menu bar lands (v0.5 P0) — own the menu, rebind Edit items to app events.


- [~] **ROW_CAP hit: driver drains the ENTIRE result over the wire** — FIXED 2026-07-02 for autocommit: the driver cancels its own query at cap+1 and swallows the 57014 as a capped completion; cancel races handled. RE-OPENED for in-tx 2026-07-18: auto-cancel is deliberately disabled inside an open transaction (our 57014 would abort the user's tx) → capped in-tx SELECTs drain fully, bounded only by statement_timeout. Candidate: surface "draining remainder — Cancel aborts the transaction" in the UI.
- [x] **Dead tunnel mid-query = hung query AND hung cancel** — FIXED 2026-07-02: TCP keepalives 30s/10s×3 (dead peer detected ~1min, not 2h); `statement_timeout=5min` + `idle_in_transaction_session_timeout=10min` at connect (Settings will tune; see DECISIONS); cancel wrapped in a 3s deadline with a clear force-disconnect message; disconnect best-effort cancels the in-flight query.
- [x] **Indexing/unwrap panics on the edit path** — FIXED 2026-07-02: `.first()` + graceful defaults / `ok_or(Internal)` at all three sites.
- [x] **One corrupt profile row hides ALL connections** — `appdb.rs:97` aborts on first bad row; `App.tsx:91` no catch. Skip-and-log. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **connect() re-entrant — double-click spawns duplicate primaries (loser leaks)** — `connections.ts:111`; same class: `ensureTabSession` race (`connections.ts:157`). — FIXED 2026-07-18 (v0.7.0-bedrock).
- [ ] *(2026-07-18 tempo residuals)* ctid-keyset pages under CONCURRENT writers: any UPDATE moves a row's ctid between page fetches (READ COMMITTED = fresh snapshot per page) → moved rows can dup/vanish across page boundaries — inherent to ctid pagination, PK tables unaffected; candidate: banner on PK-less browses ("physical order — concurrent writes can shift rows"). Editor: completion caps degrade silently >200KB statements (comment-only honesty); GAPS 1c error-position line anchors (SqlEditor.tsx:162/166) stale after tempo. Grid: context-menu copy-as JSON/CSV of 50k rows still synchronous (only TSV chunked).
- [ ] *(2026-07-19 timeline residuals, deliberate deferrals)* Inverse-undo re-fires row triggers and cannot revert their side effects (inherent to inverse SQL — doc line, not a bug); undone deletes on identity-ALWAYS tables mint fresh ids (OVERRIDING SYSTEM VALUE deliberately unused); undo offers only the NEWEST commit (older rows exist but are never surfaced while newer live). Import cancel is a silent no-op between batches/during cast-fetch (inherent PG-cancel raciness; button gives no landed/not-landed feedback). .sql file links are session-only (persisting needs a tabs schema column). session_profiles map leaks one String pair per non-graceful session death (UUID ids — no recycling risk).
- [ ] *(2026-07-19 flightcheck residuals)* Cascading overlay close (parent+child in one gesture) restores focus to the editor fallback, not the true opener (never body, never a hidden layer — cosmetic); zoom chords need a one-time device test (menu accelerator + DOM fallback both bound — expect single-fire, verify one press steps 10 not 20); `--zoom` CSS factor emitted but consumer-less (opt-in hook); cold start + 60fps budgets need in-app eyes (autonomous window probe blocked by Accessibility permission); screenshots pending (README refs commented); license TBD; typed-confirm tier for TRUNCATE/DROP still open.
- [ ] *(2026-07-18 audit residuals, deliberate deferrals)* `ql()` literal escaping assumes standard_conforming_strings stays on for the session's life (a user SET …=off desyncs guard literals — syntax-error-bounded, but ledger it); `execute_simple`'s multi-statement error classifier is position-blind (documented; only edit batches flow through it today); history stats on the error path race the event channel (client-measured ms, undercounted rows — cosmetic); primary-death leaves stale txTabs until per-session close events land (false-positive tx confirm on reconnect — conservative direction, kept).
- [ ] *(2026-07-18 residuals)* Grid FK-nav still splits `map.tables` dotted display strings (nav-only misparse); ConnToast can miss a tab-session death toast (listener-order race vs markDisconnected); DbSwitcher connect-to-clone + saveProfile-invalidate lack the open-tx confirm; delete-profile racing an in-flight connect can resurrect `connected`; force-disconnect cancel records history `error` not `cancelled`.
- [ ] **ssh stderr never drained after startup — chatty ssh can wedge a days-old tunnel via pipe backpressure** — `tunnel.rs:101`.
- [x] **Corrupt stored custom theme bricks the whole UI at startup (NaN → every CSS var invalid)** — `theme.ts` + `settings.ts:101`. Validate on rehydrate. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **No appdb schema versioning; migrations are `let _ = ALTER` that swallow ALL errors** — `appdb.rs:80`. `PRAGMA user_version` + numbered migrations. (Prereq for: history error-flag, tab meta, widths.) — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Two synthesis-blocking overlay bugs**: global shortcuts fire behind modals (⌘W while CloseGuard open silently drops the pending close — `App.tsx:104` no depth check); palette opens UNDER DangerModal but steals its keys (z-40 vs z-50) — assign z from stack position. — FIXED 2026-07-18 (v0.7.0-bedrock).
- [x] **Esc during IME composition closes the overlay** — `escStack.ts:18` no `isComposing` check. — FIXED 2026-07-18 (v0.7.0-bedrock).

---

## 2. Perf register — invariant-1 threats, ranked by daily pain

Budgets: cold start <500ms · keystroke <16ms · scroll/drag 60fps.

1. ~~**Grid cells unmemoized**~~ — FIXED 2026-07-02: `Cell` memo on primitive props + mouse events DELEGATED to the container via data-r/data-c (cells carry zero closures); arrow/drag/flush repaints only changed cells.
2. ~~**App.tsx re-renders the ENTIRE shell tree on every editor keystroke**~~ — FIXED 2026-07-02: scalar tab selectors (kind/name/table-ref); inspector drag writes a CSS var per mousemove, ONE store/localStorage write on release.
3. ~~**O(doc) per keystroke ×3 in the editor**~~ — FIXED 2026-07-18 (tempo): incremental stmt spans (20.2→0.42ms), 200KB-capped context window (byte-identical under cap, 2,664-position proof), rope chunk compares; 2.95MB worst-case keystroke ~24→4.2ms. Was: — updateListener `toString()` + connections.subscribe compare + tabs compare + whole-statement re-tokenize (`SqlEditor.tsx:133,152`, `context.ts:74`); 2MB paste = lag per key.
4. ~~**Drag-select: store write per cell crossed**~~ — FIXED 2026-07-02: rAF-coalesced dragOver + window-mouseup + EDGE AUTOSCROLL (dragging past the viewport scrolls and keeps extending the selection).
5. ~~**Filter input fires a full streaming SELECT per keystroke**~~ — FIXED 2026-07-02: value applies on Enter/blur (locally buffered); setFilters only re-runs when the compiled SQL actually changed (col/op churn on an empty value = zero queries). Still open: browse SQL floods history.
6. ~~**Infinite scroll O(n²)**~~ — FIXED 2026-07-18 (tempo): true keyset pagination (PK/ctid tiebreaker, NULL-partition OR-ladder, typed seek casts; offset fallback only for non-keysettable relations); 8.1M-row page-5000 >300s→~2ms; loadMore appends one page. Was: — re-streams from row 0 every page `[plan keyset]`; unbounded LIMIT growth vs 50k cap = expensive no-op loop at bottom — `browser.ts:196-204`.
7. ~~FIXED 2026-07-18 (tempo): bounded parse LRU + per-cell subscriptions + 150ms raw-mode debounce.~~ **Inspector: unmemoized `JSON.parse` + pretty-stringify of the full cell on EVERY render; subscribes to whole statements/pending → re-parses per streamed batch** — `Inspector.tsx:49,146`. 8MB jsonb = 100s of ms per repaint. Raw-mode: full parse per keystroke (`Inspector.tsx:287`).
8. ~~FIXED 2026-07-18 (tempo): 200-child cap w/ explicit expanders, dep array, 120ms search debounce + 50k-node cap (visible note).~~ **JsonTree: no virtualization/child cap (50k-array = 50k components); registerRef effect missing dep array; search walks all nodes per keystroke** — `JsonTree.tsx:317,333,90`.
9. ~~FIXED 2026-07-18 (tempo): tanstack-virtualized, memoized rows, 80ms filter debounce, hoisted icons.~~ **SchemaTree not virtualized; re-renders every row per filter keystroke; 2 SVGs + tooltip string per row** — `SchemaTree.tsx:93`.
10. ~~**Commit of N row-edits = N sequential `pg_attribute` round trips**~~ — FIXED 2026-07-06 (perf batch A/B): commit is ONE `BEGIN;U₁;…;Uₙ` batch + COMMIT (2 RTTs total regardless of N, verified per-row from the result stream); planning runs on the frontend-fed cached mapping (zero catalog trips), and even the hint-less fallback fetches all attnames in ONE bulk query.
11. **ROW_CAP full-drain** (see 1d) — the "app feels hung" perf lie.
12. ~~**Dynamic `import()` in hot paths**~~ — FIXED 2026-07-02: completion engine + editor keymap (⌘E/⌘I) + grid focus/edit paths use static store imports; focus→inspector target write debounced 60ms (held-arrow nav no longer re-parses the inspector per step).
13. ~~FIXED 2026-07-18 (tempo): pg_catalog fns cached in appdb by server_version (in-batch drift probe, still 1 RTT; 25.8→2.0ms + 338KB less transfer); DDL-sniff head-anchoring was already fixed in bedrock.~~ **FUNCS introspection pulls ~3k pg_catalog fns per connect/⌘R/DDL-sniff** `[plan]`; DDL-sniff regex false-positives re-introspect after ordinary queries (`schema.ts:80` `im` flags).
14. ~~FIXED 2026-07-18 (tempo): rAF-sliced build w/ progress, byte-identical serialization.~~ **⌘A+⌘C on 50k rows builds a >100MB string synchronously** — `Grid.tsx:245`.
15. ~~FIXED 2026-07-18 (tempo): tag-gated + .vgrid subtree skip.~~ **noAutocorrect MutationObserver runs selector work over every virtualized row mount during 60fps scroll** — `noAutocorrect.ts:29`.
16. ~~history LIKE full-scan~~ FIXED 2026-07-18 (tempo): bounded to newest-5k window (constant cost). Single Mutex serializing appdb remains (unmeasured pain, keep). — `appdb.rs:192,41`.
17. Smaller: ~~setSelectionValue O(N²)~~ (was ALREADY batched pre-tempo — stale entry); ~~column-resize measure per mousemove~~ (rAF-coalesced 2026-07-18); per-cell closures; smooth scrollIntoView `[plan]`; theme 40 setProperty `[plan]`; editor remount on theme change `[plan]`; ~~springs no reduced-motion~~ (live media-query collapse 2026-07-18; replay audit → flightcheck); ~~tunnel 200ms poll quanta~~ (fixed 2026-07-06: 25ms→×2 backoff→200ms) + double 10s TLS retry stack (~30s worst 'connecting' with no abort).

---

## 3. Per-surface gap highlights (P0/P1 features beyond the ledger)

Full lists incl. P2s: `docs/audit-2026-07/*.json`.

### Editor
- Find/replace (⌘F) + `highlightSelectionMatches` + goto-line `[plan v0.3 — next step]`.
- **Run statement under cursor — PROMOTED to P0 now** (was v0.5 P2). `statementRange()` exists. ⌘↵ = statement at caret w/ visible range highlight, ⌘⇧↵ = run all. Every auditor + every lens flagged this as top-3 daily.
- Completion blind to CTEs/derived tables/subquery scope (`context.ts:130`) — daily bread for serious SQL; quoted mixed-case idents break completion end-to-end (`engine.ts:66`); no popup after `FROM `; completion inside strings/comments; usage-ranking frozen+global (`usage.ts`).
- Editor right-click has no Cut/Copy/Paste/Select-All (WKWebView native menu suppressed) — mouse users can't paste.
- No format (sql-formatter, ⌘⇧F conflict: currently schema-filter — resolve now) `[plan v0.5, promote to v0.4]`; no multi-cursor/Tab-indent/line-wrap (one-line CM wirings); Tab moves focus OUT of editor mid-query.
- EXPLAIN: always ANALYZE (executes!) — need plain-EXPLAIN variant; breaks on multi-statement selections (`explain.ts:88`).
- No in-editor history stepping (⌥↑/⌥↓ psql muscle memory); no .sql file open/save/drop.

### Grid / results
- Find-in-results ✓; ~~client sort on header click~~ ✓ 2026-07-02; export to file `[plan v0.4]`; client quick-filter `[plan v0.4]`.
- **Selection stats in status bar (n · sum · avg · min · max · nulls) — promote to v0.4 P0.** Excel-reflex, TablePlus doesn't have it. O(selection) over loaded rows.
- Keyboard nav: PageUp/Down, Home/End, Tab-advance, type-to-edit, Delete-stages-NULL, F2 `[plan v0.45, pull earlier]`; first ArrowDown skips row 0 (`useSelection.ts:80`).
- Copy: with-headers variant, single-cell raw, column name(s), IN-list `[plan]`; **copy-fidelity contract**: one shared value-serialization fn for copy/export/INSERT — raw ISO timestamps, no locale separators, NULL ≠ `'NULL'`, exact server jsonb text.
- Multiline cell editor (current `<input>` can't show/type `\n`); editor at (0,0) when cell scrolled out `[plan]`.
- No paste into grid / fill-down / type-once-fill-selection `[plan v0.45]`; paste external TSV/CSV as staged edits (DataGrip parity, staged = safer).
- No undo/redo of staged edits `[plan v0.45]`; no per-cell revert (store has `clearEdit`, unwired).
- FK follow `[plan v0.45]` + **reverse-FK "what references this row?" with count badges** (killer spelunking feature, no client has it) + FK peek popover.
- Row record view (transposed single-row inspector w/ prev/next) — Postico's most-loved; row diff (select 2 rows → highlight differing columns).
- Column hide/pin `[plan]` (~~reorder~~ done 2026-07-02 via drag-header, session-only view order); column picker overlay; hidden-columns copy contract.
- Zero-row result = blank void; no cancel button while running; statement chips overflow unmanaged.
- Browser-mode injected ctid column shown/copied as data (`browser.ts:121`).

### Table browser
- Filter ops thin: no NOT IN/NOT LIKE/BETWEEN/regex/contains/IS TRUE/jsonb `@>`; type-blind (ILIKE offered on ints, no bool/enum/date editors); raw-WHERE escape hatch + "show the SQL I built" (trust!); filter column picker is a raw 300-option `<select>`.
- ~~No header-click sort / sort indicator~~ — FIXED 2026-07-02 (click tri-states, ▲/▼ glyph; server ORDER BY in browser, client view-order in editor results). Still open: multi-column sort (shift-click tiebreakers).
- No cancel from a table tab (⌘. lives only in the editor keymap) — stuck until server finishes.
- Zero keyboard shortcuts on the whole surface (refresh/toggle/add-row/add-filter).
- Structure tab ~20% depth: no constraints/triggers/partitions/comments/DDL/sizes/RLS; refresh button on Structure reruns the data query (dead).
- Stale TableInfo after DDL (filters/sort/draft use tab-open-time columns); table tab silently re-runs against a different profile after rail switch (stamp profileId).
- No jump-to-row/go-to-end; exact-count-on-demand footer (estimate → click → real count).
- Partitioned parents (`kind='p'`) can't insert; should allow r+p(+f).

### Sidebar / schema
- No keyboard nav from filter into tree (⌘⇧F is a dead end) — arrows/Enter/Esc.
- Functions/sequences/enums/extensions invisible; matview/foreign/partitioned lack distinct glyphs; partitions flood the tree (nest under parent).
- No table metadata: row estimates + sizes `[plan]` + **comments (pg_description) — surface in tree tooltips, completion, headers, structure**.
- No pinned/favorite tables; no active-table highlight; no refresh affordance/staleness hint; no schema-header menu (collapse-all, copy name); tables can't expand to columns inline.
- Filter matches table name only (no schema-qualified 'auth.users'), no ranking; state leaks across profile switches (key by profileId).
- Saved queries: no search/folders `[plan]`, no connection affinity (open runs against the wrong DB with no warning!), rename discards on blur.
- Sidebar fixed 248px, not resizable.

### Connections
- Copy URI (redacted default) + paste-DSN-to-create `[plan v0.3 — queued]`; also accept `psql` flag strings and `.env` lines; auto-detect DSN on clipboard.
- Test-connection button `[plan v0.5, promote]` — validate unsaved form, report latency/version/TLS.
- ✅ **Enforced read-only prod safe-mode** — SHIPPED 2026-07-03: server-side `default_transaction_read_only=on` on every is_prod session + titlebar lock chip with per-tab confirm-unlock/one-click-relock. Remaining polish: broader ambient chrome (tint tab strip/grid), timed auto-relock.
- connState has no 'error' state (failed card = gray dot like never-tried); 8s auto-dismiss toast unreadable for ssh multi-line errors; connection death is silent (dot flips, nobody told).
- Password affordances: reveal toggle, forget/clear stored password (impossible today without deleting profile).
- DbSwitcher clones pollute the rail permanently (40-db server = rail soup); group under parent or don't persist.
- No keyboard path anywhere: dashboard arrows/Enter, ⌘N new connection, palette connect verbs.
- Host-key rotation = raw wall of text; .pgpass/pg_service.conf/preconnect-script support (Postico parity).
- Per-connection init SQL (SET ROLE/search_path/statement_timeout) + session count visibility.

### Inspector / JSON
- bytea: byte count, hex+ASCII dump, image sniff preview, save-to-file (currently hex soup).
- No find in plain-text values or raw JSON mode (⌘F only in JsonTree — and that listener hijacks ⌘F globally while mounted, `JsonTree.tsx:417`).
- ~~Pending edit hidden by full-value fetch~~ *(fixed 2026-07-02 — staged edit now always wins)*; no diff pending-vs-original; no revert from inspector.
- No context menu anywhere (node: copy path/value/subtree, pg path expr `col->'a'->>0`); no expand-all/collapse-subtree; leaf type locked (null→number impossible, `coerce` `JsonTree.tsx:66`); strings render unquoted w/ collapsed whitespace (lies).
- No value metadata (chars/bytes/lines, "showing 8KB of 3.2MB"); no Set-NULL on non-null cells; copy has zero feedback and editable leaves have NO copy path (click enters edit).

### Shell / keyboard / palette
- ✅ Native macOS menu bar — SHIPPED 2026-07-02 (menus also carry accelerators for non-Latin layouts).
- ✅ Settings ⌘, — SHIPPED 2026-07-03 (mode/theme/font/wrap/timeout/fn-complete).
- ⌘↵ run + ⌘. cancel must work from ANYWHERE (grid/sidebar/body) — currently editor-only; focus not restored on overlay close (lands on `<body>`).
- Palette: switch-to-open-tab (table stakes), cancel-query, commit/discard, connect-to, disconnect; items not state-aware; "Run query" ignores editor selection (runs EVERYTHING — safety divergence, `Palette.tsx:99`).
- Missing macOS tab chords (⌘⇧[/], ⌘⌥←/→); ⌘0 convention; middle-click close; drag-to-reorder tabs; tab dirty-vs-saved dot.
- No ⌘/ shortcut cheat-sheet; no UI zoom (⌘+/-); window title never shows connection/db; breadcrumb not clickable. ~~SHIPPED 2026-07-19 flightcheck~~ (zoom 70–150% + live window title; ⌘? existed since v0.5; breadcrumb-click still open).
- Modal a11y: no focus trap (Tab reaches hidden background buttons), no role=dialog, no focus restore. ~~SHIPPED 2026-07-19 flightcheck~~ (trap + role=dialog + opener-restore across 13 modals).
- ContextMenu: no max-height scroll, no type-ahead, no checkbox items, second right-click doesn't re-open at new point.
- CloseGuard: plain Enter = destructive discard (inverts Mac convention — Postico requires ⌘⌫); DangerModal: no keyboard confirm, no typed-confirm tier for TRUNCATE/DROP. ~~SHIPPED 2026-07-19 flightcheck~~ (Enter=safe, ⌘⌫=destructive; typed-confirm tier still open).
- Empty states are dead ends (no CTA, no ⌘K hint). ~~SHIPPED 2026-07-19 flightcheck~~ (CTAs on results/dashboard/sidebar/history).

### Persistence / history
- History: failed queries `[plan]`, timestamps shown nowhere, no dedupe/grouping (one hot query drowns the list), unbounded growth `[plan]` + unbounded per-row SQL size (8MB INSERT stored verbatim per run), no dedicated panel `[plan v0.5]`, blind to database, orphaned by profile deletion.
- Active tab not persisted `[plan]`; table tabs vanish (persist as LAZY placeholders — zero cold-start cost, revisit locked decision #5); cursor/scroll/undo not restored; column widths `[plan]`.
- appdb needs: `user_version` migrations, `meta TEXT` JSON column on tabs, busy_timeout, single-instance plugin.
- IPC type drift: hand-synced types.ts already diverged (HistoryRow re-declared, TabRow unmirrored, QueryEvent missing Notice) — adopt ts-rs/specta.

### Driver
- Notices (RAISE NOTICE) dropped entirely `[plan v0.5, promote]` — bulk-fix scripts run blind; stream live, not after.
- Transaction-state tracking (idle/in-tx/failed-tx chip + one-key ROLLBACK; "current transaction is aborted" is undiagnosable today).
- **Out-of-band cancel**: dedicated control connection issuing `pg_cancel_backend`, escalating to terminate — cancel must never share the busy session's fate (TablePlus's most chronic complaint, a decade of issues).
- type_oid=0 on streaming path (`execute.rs:83`) — grid has no type info until editability's second round trip `[plan v0.5]`.
- get_ddl backend `[plan v0.4]`; COPY detection (clean error now, copy_in/out later — feeds export); ~~UPDATE…RETURNING loses affected count~~ *(fixed 2026-07-02 w/ keystone)*; session-closed event carries no reason.

---

## 4. Lens highlights — the surpass list

What the competition teaches, distilled. Full censuses in `docs/audit-2026-07/{06,10,11,12}-*.json`.

**Beat TablePlus at its own game** (user's favorite; its known weaknesses = qwry's wedge):
- Its cancel is chronically broken (decade of issues) → out-of-band cancel that ALWAYS works.
- Fixed 300-row pagination with page boundaries → seamless keyset-virtualized scroll.
- Grid-export silently exports only the current page → export always states scope, never truncates silently.
- No visual EXPLAIN → qwry already has the plan tree; extend (heat nodes, est-vs-actual badges, plan history diff).
- Connection loss closes windows/loses state → tabs grey out, auto-reconnect, restore everything.
- No selection stats; weak history; safe-mode is cosmetic-ish → all covered above.
- Its signature strengths to match: stage-then-commit ⌘S (qwry has), Code Review of pending SQL (qwry has EditPreview — add old→new diff + per-statement selective commit), safe-mode levels, Open Anything ⌘P, dense copy menus, connection colors/env tags, import-from-URL.

**Steal from Postico** (mac-native polish): FK-cell picker (searchable referenced-row picker), record view, staged-deletes visible+undoable, multi-col sort via ⌥-click + NULLS control, ⌘P Open Quickly, nav back/forward through browse history (⌥⌘←/→), in-editor history scrubbing (^⌘←/→), pgFormatter respecting `~/.pg_format`, `.pgpass`/preconnect scripts, whitespace-trimming pasted hosts, ⌘⌫-only destructive confirms, statement-under-cursor highlight, ⌘F in every text surface without exception.

**Steal from Beekeeper**: pending-changes color states + Apply/Reset bar, "Copy To SQL" (staged edits → editable SQL tab), row-as-JSON view with FK expansion, IN-clause from selection, pinned tables, honest 50k truncation banner, privacy/screen-share blur mode, `:param` prompts (as real extended-protocol params — correctness win), Query-Magics intent via header "Display as ▸" menu (no alias hacks).

**Steal from DataGrip**: run-under-caret with permanent statement-boundary gutter, schema-aware lint (unresolved column/table squiggles + did-you-mean — qwry has all ingredients in-memory), selection aggregates, local history with diff/restore, tx-state awareness, unsafe-query guard with row estimate, ⌘E recent-locations, syntax-aware expand-selection (⌥↑), postfix completion (`orders.afrom`), result-set diff incl. cross-connection (staging vs prod!), quick table peek (Ctrl+Alt+F8 → qwry overlay + LIMIT 20 mini-grid), alias/CTE rename (F2), column list popup ⌘F12.

**Steal from pgAdmin (grid-native versions only)**: per-table stats (dead tuples, last vacuum, seq vs idx scans, never-used-index badges) in Structure tab; query macros with `$SELECTION$`/`$TABLE$`/`$CELL$` placeholders + built-in PG toolbox (blockers/sizes/activity/dead indexes) as palette verbs; maintenance menu items that GENERATE statements (never auto-run); "who is blocking me" one-key via `pg_blocking_pids`; pg_settings as a plain grid macro. Skip: ERD canvas, live dashboards, schema-diff-with-DDL-gen (client-side snapshot diff is the cheap variant).

**qwry-original leapfrogs (no client has these)**:
1. **Run-CTE-as-standalone** — caret in a CTE → run `SELECT * FROM <cte> LIMIT 500` with the chain above it. Pure text transform; makes CTE debugging categorically better than DataGrip.
2. **Reverse-FK "referenced by ▸" with live count badges** — relational spelunking backwards.
3. **Inverse-SQL undo after commit** — capture OLD via CTE, persist revert script, toast offers Undo. Never-lose-work applied to *data*.
4. **Pre-execution impact estimate** — silent EXPLAIN before UPDATE/DELETE: "matches ~48,201 rows — run?".
5. **Latency breakdown in status bar** (server/wire/render) — the identity, made visible.
6. **Distinct-value histogram with counts/percentages** in header menu ("paid 78% · pending 12%").
7. **Plan history + regression diff** ("plan changed: Seq Scan → Index Scan") — local-first enables it.
8. **Smart paste transforms** — spreadsheet column → IN-list/ARRAY/VALUES.
9. **Copy-for-Slack** — SQL + aligned result + meta in one Markdown snippet.
10. **Row diff** — select 2 rows, highlight differing columns.
11. **Buffer time-machine** — step the editor back through executed versions of THIS tab.
12. **qwry as MCP server** — user's own agent drives qwry; AI without telemetry betrayal.
13. **Editing PK-less tables safely via guarded ctid** (verify-old-values-in-tx) — every mainstream client refuses these tables.
14. **Filter bar with real schema-aware completion** (the intellisense engine pointed at the browse WHERE).

---

## 5. Sequencing verdict (feeds ROADMAP_v0.5.md)

1. **Finish v0.3's explicit asks** — ⌘F editor+results, Copy URI/paste-DSN, remaining menus. (In flight.)
2. **v0.35 becomes the Correctness Milestone** — the ledger (§1) is bigger and scarier than the old bug list; burn P0s of §1a/1b first, then 1c. Statement-at-a-time execution (driver) is the keystone — it unlocks matched≠1 rollback, per-statement errors, tx tracking, and honest multi-statement UI.
3. **v0.4 perf pass** absorbs §2 items 1-12 (add App.tsx shell re-render + inspector parse + ROW_CAP drain to the old list) + promoted features: run-under-cursor, selection stats, export, sort/filter.
4. **v0.45/v0.5** as planned + promoted items marked above.
5. **Beyond v0.5**: the surpass list (§4) — leapfrogs first, parity-polish second. No finish line.

- [x] **edits_preview re-prepares the query per ⌘S** (2026-07-06) — FIXED 2026-07-06 (perf batch B): preview/apply/delete accept the cached mapping (EditabilityMap + snapshot names) — with a warm map the preview touches the server ZERO times and stays server-generated (same Rust generator as commit, same inputs stashed preview→commit for byte-for-byte). Stale mapping → rollback + auto-repair (silent retry for preview; regenerated-preview-with-notice for apply — never auto-retry a write).
