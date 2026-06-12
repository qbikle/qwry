# qwry — Roadmap

> Session protocol: pick the next unchecked item in the current phase. Build → verify per the phase gate → tick → append session note at bottom. One phase ≈ one session; finishing early, pull from the next phase.

## P0 — Scaffold ✅
- [x] rustup install (rustc 1.96.0)
- [x] create-tauri-app scaffold (React-TS, bun)
- [x] CLAUDE.md + docs/
- [x] git init + initial commit
- [x] Gate: `bun run tauri dev` opens window, hello IPC works

## P1 — Connect + run
- [ ] `driver/mod.rs`: DbDriver trait + shared types (Value, ColumnMeta, ConnConfig, SessionId)
- [ ] `driver/postgres/`: connect (tokio-postgres, TLS via rustls), session registry in AppState
- [ ] `secrets.rs`: keyring save/load password per profile
- [ ] `appdb.rs`: rusqlite init, `profiles` table (no passwords)
- [ ] Connection profiles UI: list + create/edit form (host/port/db/user/ssl, color badge, prod flag)
- [ ] Execute (non-streaming v0): run single statement, return rows as JSON, render plain table
- [ ] PG error display (message + position)
- [ ] Gate: connect to staging PG, `SELECT * FROM products LIMIT 50` renders

## P2 — Streaming + grid
- [ ] Statement splitter lexer (strings, dollar-quotes, comments) + unit tests
- [ ] `execute.rs`: QueryEvent stream over Tauri Channel, ≤500-row batches, per-statement timing/affected
- [ ] CancelToken wiring + ⌘. shortcut
- [ ] `ipc/`: typed QueryEvent decoder, resultsStore filling from batches
- [ ] Grid: virtualized rows+columns (TanStack Virtual), sticky header, column resize
- [ ] Cell selection, copy TSV/CSV/JSON/Markdown/INSERT
- [ ] Row cap 50k + "load more"; >8KB cell truncation marker
- [ ] Gate: `SELECT * FROM generate_series(1,1000000)` scrolls smooth, ⌘. cancels mid-stream
- [ ] **CHECKPOINT: grid perf in WKWebView. If choppy → swap to Glide Data Grid before proceeding**

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

### 2026-06-12 — P0 (session 1)
Scaffolded. rustc 1.96.0, tauri 2 template (React 19.2.7, Vite, bun). First cargo build green. Docs written. Gotchas: none yet. Next: P1 from top.
