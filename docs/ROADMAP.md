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
- [ ] `introspect.rs`: pg_catalog queries → SchemaSnapshot (tables, columns, PKs, FKs, indexes, functions, enums)
- [ ] Schema cache + push event; refresh on connect / DDL / manual ⌘R
- [ ] Sidebar: connection → schema → tables/views tree, fuzzy filter ⌘⇧F
- [ ] CodeMirror SqlEditor with @codemirror/lang-sql (PostgreSQL dialect), schema wired from snapshot
- [ ] ⌘Enter run, run-selection-if-any
- [ ] Gate: completion offers tables after FROM, columns after SELECT

## P4 — Intellisense deep
- [ ] `completion/context.ts`: lezer tree walk → clause + FROM/JOIN tables + alias map
- [ ] `completion/sources.ts`: column source scoped to in-scope tables; qualified `alias.` completion
- [ ] `completion/joins.ts`: FK-aware JOIN … ON suggestions
- [ ] `completion/rank.ts`: fuzzy × usage frequency × context boost; usage persisted in appdb
- [ ] Function signatures + snippets (sel, ins, upd templates)
- [ ] `lint.ts`: squiggle from PG error position
- [ ] Gate: `SELECT u.|` with `users u` in FROM → only users columns; <16ms popup

## P5 — Editable results
- [ ] `edit.rs`: editability map from table_oid/attnum + PK presence (ctid fallback w/ warning)
- [ ] ColumnMeta carries editability + read-only reason
- [ ] Grid editing: double-click/Enter to edit, type-aware inputs, NULL toggle, Esc revert
- [ ] editsStore: pending edits, dirty ✎ badges, discard all
- [ ] ⌘S → SQL preview modal → `apply_edits` one transaction → RETURNING refresh
- [ ] Gate: edit base-table cell from a JOIN query, persists; computed col shows reason

## P6 — Inspector + jsonb
- [ ] Inspector panel: full cell value (on-demand fetch for truncated), text/json/bytea modes
- [ ] JsonTree: collapsible, search, path copy, value copy
- [ ] jsonb in-place edit with validation → pending edit
- [ ] Gate: edit nested jsonb key, persists

## P7 — Table browser
- [ ] Table tab: data view (no SQL), filter row builder (col op value, AND), sort, infinite scroll
- [ ] Structure tab: columns/indexes/FKs/constraints
- [ ] Inline edit reusing P5 machinery; insert row; delete row (guarded)
- [ ] Gate: browse + filter + edit without writing SQL

## P8 — Tabs, history, palette
- [ ] Tab persistence (editor text, connection, name) in appdb; restore on launch
- [ ] Query history: every run logged (sql, conn, ms, rows); searchable UI
- [ ] ⌘K palette (cmdk): tables, connections, actions, history
- [ ] Gate: relaunch restores everything

## P9 — EXPLAIN viz
- [ ] Run EXPLAIN (ANALYZE, FORMAT JSON) action
- [ ] Plan tree view: nodes, timing bars, rows est-vs-actual, hot-node highlight
- [ ] Gate: readable tree for a 3-join query

## P10 — Polish
- [ ] Springs per `design/springs.ts` spec: palette, panel resize, tab reorder, edit pulse, commit flash
- [ ] Vibrancy sidebar, traffic-light inset, native menus + context menus
- [ ] Dark/light themes via tokens
- [ ] Safety: prod-flag styling, UPDATE/DELETE-without-WHERE confirm
- [ ] App icon, `tauri build` dmg (ad-hoc sign)
- [ ] Gate: full keyboard map works; dangerous-SQL guard fires

---

## Session log

### 2026-06-12 — P2 (session 1, continued)
P2 complete, all gates user-verified incl. 1M-row stream (50k cap), instant ⌘. cancel, statement chips, row/col/all selection, 5-format copy. Key learnings: (1) `simple_query_raw` is public in tokio-postgres — true streaming, no materialization. (2) `navigator.clipboard` is unavailable in dev (http://localhost = insecure context in WKWebView) — always use tauri-plugin-clipboard-manager. (3) Backdrop-close patterns must check `e.target === e.currentTarget` or inner button clicks die. (4) rAF-batched row flushing into zustand keeps stream renders at 60/s. Next: P3 (introspection + sidebar tree + lang-sql completion).

### 2026-06-12 — P1 (session 1, continued)
P1 complete. Rust core: driver/postgres (simple-protocol exec, TLS prefer/require/disable, cancel), secrets (keyring v3), appdb (rusqlite profiles), commands wired. Frontend: zustand connections store, profile list+form modal, query box (⌘Enter/⌘.), plain results table w/ per-statement blocks + error pane. Live staging smoke test in `src-tauri/tests/staging_smoke.rs` (run with --ignored + env creds). Gotchas: (1) Keychain items seeded via `security` CLI trigger an auth prompt asking for the *Mac login password* — app-saved passwords avoid it; dev rebuilds are ad-hoc-signed so prompts can recur until P10 signing. (2) keyring v4 is a breaking meta-crate — stay on v3. Next: P2 from top (splitter lexer first).

### 2026-06-12 — P0 (session 1)
Scaffolded. rustc 1.96.0, tauri 2.11.2 (React 19.2.7, Vite, bun). Docs written. Gotcha: `time` 0.3.48 breaks tauri-utils 2.9.2 (E0119) — pinned 0.3.47 in Cargo.lock, see DECISIONS.md. Beware: `cargo build | tail` masks exit code — check PIPESTATUS or drop the pipe. Next: P1 from top.
