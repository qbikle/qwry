# qwry — Roadmap

> Session protocol: pick the next unchecked item in the current phase. Build → verify per the phase gate → tick → append session note at bottom. One phase ≈ one session; finishing early, pull from the next phase.

## P0 — Scaffold ✅
- [x] rustup install (rustc 1.96.0)
- [x] create-tauri-app scaffold (React-TS, bun)
- [x] CLAUDE.md + docs/
- [x] git init + initial commit
- [x] Gate: `bun run tauri dev` opens window, hello IPC works

## P1 — Connect + run
- [x] `driver/mod.rs`: shared types (Profile, ColumnMeta, StatementResult, DriverError)
- [x] `driver/postgres/`: connect (tokio-postgres, rustls no-verify ≈ psql sslmode=require), session registry in AppState
- [x] `secrets.rs`: keyring save/load password per profile (service `app.qwry`)
- [x] `appdb.rs`: rusqlite init, `profiles` table (no passwords)
- [x] Connection profiles UI: list + create/edit modal (host/port/db/user/ssl, prod flag)
- [x] Execute v0 via **simple protocol** (universal wire-text values, multi-statement free) — `tests/staging_smoke.rs` passes live against staging
- [x] PG error display (message + code + position)
- [x] Gate: connect to staging PG in-app, query renders ✅ (verified by user: 10 rows from product_flatlay_generations, 69.7ms)

## P2 — Streaming + grid
- [x] Statement splitter lexer (strings, dollar-quotes, nested block comments) + 8 unit tests
- [x] `execute.rs`: QueryEvent stream via `simple_query_raw` (public, streams!), ≤500-row batches, per-statement timing/affected — live-tested (120k rows → 50k cap + full count)
- [x] CancelToken wiring + ⌘. shortcut — live-tested (pg_sleep(30) killed <5s)
- [x] `ipc/`: Channel-based QueryEvent decoder, resultsStore with rAF-batched row flushing
- [x] Grid: virtualized rows+columns (TanStack Virtual), sticky header + sticky rownum column, column resize
- [x] Cell selection (drag/shift/arrows/⌘A), ⌘C TSV, right-click copy menu (TSV/CSV/JSON/Markdown/INSERT)
- [x] Row cap 50k (status shows "50,000 of N (capped)"); >8KB cell truncation marker …⧉
- [x] Gate: `SELECT * FROM generate_series(1,1000000)` scrolls smooth, ⌘. cancels mid-stream ✅ user-verified
- [x] **CHECKPOINT passed: custom DOM grid is smooth in WKWebView at 50k rows — Glide fallback not needed**
- [x] Fixes from user testing: clipboard via tauri-plugin-clipboard-manager (navigator.clipboard dead on dev origin), copy-menu backdrop swallowed clicks, native text-selection during drag, row/col/select-all via rownum+header+corner

## P3 — Schema + basic completion
- [x] `introspect.rs`: 4 pg_catalog json_agg queries in one round trip → SchemaSnapshot (tables+columns+PKs, FKs, functions incl. pg_catalog, schemas) — live: 128 tables/3475 fns in 268ms (indexes deferred to P7 structure tab)
- [x] Schema fetch on connect + DDL sniff after runs + manual ⌘R
- [x] Sidebar: schema → tables/views tree under connected profile, fuzzy filter ⌘⇧F, double-click → SELECT LIMIT 100
- [x] CodeMirror SqlEditor: lang-sql PostgreSQL dialect, snapshot-fed schema completion (Compartment-swapped), dark theme, history/brackets/active-line
- [x] ⌘Enter runs selection-if-any else buffer; ⌘. cancel
- [ ] Gate: completion offers tables after FROM, columns after SELECT (user verify)

## P4 — Intellisense deep
- [x] `completion/context.ts`: token walk → clause + FROM/JOIN/UPDATE/INSERT tables + alias map + dot-qualifier
- [x] `completion/engine.ts`: clause-scoped sources — columns from in-scope tables (alias detail), `alias.` exact-table columns, `schema.` tables, aliases, functions w/ signatures, keywords; CM fuzzy + boost ranking
- [x] FK-aware suggestions: after JOIN → `table ON cond` one-shot; after ON → `a.col = b.col` pairs (in engine.ts joinOptions)
- [x] Usage ranking: accepted completions bump localStorage counts → log boost (appdb persistence later if needed)
- [x] Snippets: sel/ins/upd/cnt templates at statement start
- [x] PG error position → squiggle + lint gutter (when executed text == buffer)
- [x] Gate: column scoping + FK joins + function gating ✅ user-verified
- [x] User-feedback round: functions out of typed flow (settings toggle + ^Space), ⌘⇧U/right-click searchable function palette, editor context menu

## P5 — Editable results
- [x] `edit.rs`: editability via `prepare()` (no re-execution) — table_oid/column_id → PK presence; reasons for read-only (computed / no PK / PK not selected). ctid fallback NOT implemented (deferred; reasons are actionable instead)
- [x] `editability`/`edits_preview`/`edits_apply` commands; UPDATE gen with `'val'::type` casts, one transaction, RETURNING ::text refresh; rows-matched≠1 reported per edit — live-tested on staging scratch table incl. JOIN base-col edit + SET NULL
- [x] Grid editing: double-click or Enter on focused cell, input overlay, Esc revert, ∅ button / ⌘⇧⌫ sets NULL, editing-back-to-original clears the edit
- [x] editsStore: pending keyed (stmt,row,col), dirty ✎ amber cells, PK values always taken from ORIGINAL row data, discard all
- [x] ⌘S (or status-bar Commit) → SQL preview modal → apply → RETURNING patches grid in place
- [x] Gate: edit base-table cell from a JOIN query in-app, persists; computed col shows reason tooltip ✅ user-verified
- [x] Keyboard flow polish: Enter commits in preview modal, esc cancels, ⌘⇧D discard all

## P6 — Inspector + jsonb
- [x] Inspector panel (right, ⌘I toggle): focused cell full view, auto JSON detection, raw/tree modes, Copy + Copy-pretty, type + read-only reason display
- [x] Truncated cells: full value auto-fetched by PK when editability map allows
- [x] JsonTree: collapsible (depth-2 default), click value copies, ⌥-click copies json path
- [x] jsonb edit: pretty textarea with live validation → staged into pending edits (⌘S commits like any cell)
- [ ] JsonTree search (deferred — palette/⌘F later)
- [x] User-feedback round: ⌘I intercepted in editor (CM binds Mod-i to selectParentSyntax) + defaultPrevented guard on the window keymap (double-fire = no-op toggle), resizable inspector (drag left edge, persisted), Raw→Tree dead-end fixed, hide button + right-edge reopen tab
- [x] Gate: inspector flows ✅ user-verified

## P7 — Table browser
- [x] Sidebar single-click → browser (double-click → SELECT in editor); Data/Structure tabs, close ✕ back to editor, refresh
- [x] Filter builder: col + op (=,!=,<,>,<=,>=,LIKE,ILIKE,IN,IS [NOT] NULL) + value, enable checkboxes, AND-joined; sort dropdown; generated SQL runs through normal pipeline → grid stays editable (P5 reuse for free)
- [x] Infinite scroll: LIMIT grows by 1000 near grid bottom (nearEndHook in Grid)
- [x] Structure tab: columns (type/nullable/default/PK badge), FKs both directions, indexes (added to introspection — 5th json_agg query)
- [ ] Insert row / delete row (deferred — needs guarded UX, do with P10 safety work)
- [x] Feedback rounds: AND/OR filter connectors (parenthesized, left-to-right), cell-editor Enter-bubble bug (reopened editor — stopPropagation), blur=save/Esc=discard semantics, Set NULL/EMPTY in grid context menu for selections, inspector plain-text Edit, JSON cells double-click → inspector edit mode (never inline), sort = searchable popover (PK & time group first, click flips direction, Clear sort row)
- [x] Gate: browse + filter + edit without writing SQL ✅ user-verified

## P8 — Tabs, history, palette
- [x] Tabs: bar above editor, ⌘T new / ⌘W close (last tab resets, never zero), double-click rename, active tab mirrors editor buffer, debounced replace-all persistence in appdb `tabs`, restore on launch
- [x] History: every run logged to appdb `history` (profile, sql, total ms, total rows); LIKE search command
- [x] ⌘K palette (cmdk): Actions (run/new tab/inspector/refresh schema), Tables (→ browser), Connections (→ connect, PROD badge), History (live-searched, → new tab)
- [x] Feedback round: ⌃Tab cycle, ⌘1-9/0 jump, ⌘⇧T restore-closed (20-deep stack), ⌘W context-aware (table view first), saved-queries section pinned to sidebar bottom, tab↔saved linking via tabs.saved_id (⌘S upserts same entry, two-way rename sync, click focuses existing tab), history clear actions in palette
- [x] **GOTCHA: `window.confirm()` is a silent no-op stub in Tauri WKWebView** — never gate actions on it; use two-click arm pattern (see SavedQueries/ProfileList delete)
- [x] Gate: tabs/saved/shortcuts ✅ user-verified (restart-restore trusted, retest later)

## P9 — EXPLAIN viz
- [x] ⌘E / Explain button → EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), selection-aware
- [x] Plan tree: per-node self-time bars (hot ≥20% red / warm ≥5% amber), actual-vs-est rows with 100× misestimate badge, ×loops, relation/index names, execution+planning summary, esc closes
- [x] Gate: readable tree for join query ✅ user-verified
- [ ] NOTE: ⌘E on UPDATE/DELETE executes it (ANALYZE) — P10 adds the guard

## P10 — Polish
- [ ] Springs per `design/springs.ts` spec: palette, panel resize, tab reorder, edit pulse, commit flash
- [ ] Vibrancy sidebar, traffic-light inset, native menus + context menus
- [ ] Dark/light themes via tokens
- [ ] Safety: prod-flag styling, UPDATE/DELETE-without-WHERE confirm
- [ ] App icon, `tauri build` dmg (ad-hoc sign)
- [ ] Gate: full keyboard map works; dangerous-SQL guard fires

---

## Session log

### 2026-06-12 — P5 (session 1, continued)
P5 complete, user-verified. THE differentiator feature works: edit any base-table cell from arbitrary SQL (incl. JOINs). Design notes: editability via `prepare()` of the same SQL (RowDescription table_oid/column_id — zero re-execution); `'value'::typename` casts give psql-typing semantics; PK WHERE values always from original row data; whole commit keyboard-driven (Enter in grid → ⌘S → Enter). Deferred: ctid fallback for PK-less tables (read-only reason is actionable instead), batched multi-cell row updates (one UPDATE per cell currently). Next: P6 inspector + jsonb.

### 2026-06-12 — P4 (session 1, continued)
P4 intellisense built + 3 user-feedback rounds. CRITICAL GOTCHA: the CodeMirror EditorView is created in a `useEffect([], )` — it captures completion-engine closures at mount. Vite HMR swaps modules but the live view keeps OLD references → engine edits silently don't apply. ALWAYS restart `tauri dev` (not just HMR) when testing editor-internal changes. Engine reads stores dynamically per keystroke (no Compartment reconfig — also HMR-fragile). Functions gated: typed flow excludes 3.5k pg functions unless settings.fnInComplete; ^Space always includes; ⌘⇧U / right-click → searchable function palette. context.ts parses FULL statement for tables (cursor-bounded only for clause) — `SELECT col| FROM t` needs tables after cursor.

### 2026-06-12 — P2 (session 1, continued)
P2 complete, all gates user-verified incl. 1M-row stream (50k cap), instant ⌘. cancel, statement chips, row/col/all selection, 5-format copy. Key learnings: (1) `simple_query_raw` is public in tokio-postgres — true streaming, no materialization. (2) `navigator.clipboard` is unavailable in dev (http://localhost = insecure context in WKWebView) — always use tauri-plugin-clipboard-manager. (3) Backdrop-close patterns must check `e.target === e.currentTarget` or inner button clicks die. (4) rAF-batched row flushing into zustand keeps stream renders at 60/s. Next: P3 (introspection + sidebar tree + lang-sql completion).

### 2026-06-12 — P1 (session 1, continued)
P1 complete. Rust core: driver/postgres (simple-protocol exec, TLS prefer/require/disable, cancel), secrets (keyring v3), appdb (rusqlite profiles), commands wired. Frontend: zustand connections store, profile list+form modal, query box (⌘Enter/⌘.), plain results table w/ per-statement blocks + error pane. Live staging smoke test in `src-tauri/tests/staging_smoke.rs` (run with --ignored + env creds). Gotchas: (1) Keychain items seeded via `security` CLI trigger an auth prompt asking for the *Mac login password* — app-saved passwords avoid it; dev rebuilds are ad-hoc-signed so prompts can recur until P10 signing. (2) keyring v4 is a breaking meta-crate — stay on v3. Next: P2 from top (splitter lexer first).

### 2026-06-12 — P0 (session 1)
Scaffolded. rustc 1.96.0, tauri 2.11.2 (React 19.2.7, Vite, bun). Docs written. Gotcha: `time` 0.3.48 breaks tauri-utils 2.9.2 (E0119) — pinned 0.3.47 in Cargo.lock, see DECISIONS.md. Beware: `cargo build | tail` masks exit code — check PIPESTATUS or drop the pipe. Next: P1 from top.
