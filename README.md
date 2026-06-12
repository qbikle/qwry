# qwry

A fast, keyboard-first PostgreSQL client for macOS. Built because the alternatives each miss something: Postico's intellisense is weak, Beekeeper can't edit cells from arbitrary query results (and paywalls JSON formatting), pgAdmin is pgAdmin.

Tauri 2 (Rust core) · React 19 · CodeMirror 6 · ~15 MB app, ~6 MB dmg.

## What it does well

**SQL intellisense that actually understands your query.** Columns scoped to the tables in your FROM clause, `alias.` completion, FK-aware `JOIN … ON` one-shot suggestions, usage-ranked results, PG error squiggles at the exact position. The 3.5k `pg_catalog` functions stay out of your way — Ctrl-Space or ⌘⇧U when you want them.

**Edit any query result.** Run any SELECT — joins included. Double-click a cell, type, ⌘S. qwry maps result columns back to their source tables via the wire protocol's `table_oid`/`attnum` metadata, finds the primary key, and shows you the exact `UPDATE … WHERE pk = … RETURNING …` before committing everything in one transaction. Read-only cells tell you *why* (computed expression, PK not selected, …).

**First-class JSON.** Collapsible jsonb tree in the inspector, click-to-copy values, ⌥-click for paths, validated in-place editing. Free.

**Fast.** Results stream from Rust in batches over Tauri channels into a custom virtualized grid — a million-row result scrolls smoothly. ⌘. cancels instantly via the PG cancel protocol.

Also: table browser (filters with AND/OR, searchable sort, structure tab), persistent tabs, saved queries, searchable history, ⌘K command palette, EXPLAIN ANALYZE visualizer with hot-node highlighting, guards for UPDATE/DELETE without WHERE, prod-connection warning strip, Keychain-stored credentials, no telemetry.

## Keyboard map

| | |
|---|---|
| ⌘↵ run (selection if any) | ⌘. cancel |
| ⌘E explain analyze | ⌘K palette |
| ⌘S save tab / commit cell edits | ⌘⇧D discard edits |
| ⌘T / ⌘W new / close tab | ⌘⇧T restore closed tab |
| ⌃Tab cycle tabs | ⌘1–9, ⌘0 jump to tab |
| ⌘I inspector | ⌘⇧U function search |
| ⌘⇧F filter tables | ⌘R refresh schema |

## Build

```sh
# prerequisites: rust (rustup), bun, xcode CLT
bun install
bun run tauri dev      # development
bun run tauri build    # release .app + .dmg
```

Backend integration tests run live against a real database:

```sh
QWRY_TEST_HOST=… QWRY_TEST_USER=… QWRY_TEST_PASSWORD=… QWRY_TEST_DB=… \
  cargo test --test staging_smoke -- --ignored
```

## Architecture

Rust core (`src-tauri/`): tokio-postgres over the **simple protocol** (every type arrives as psql-identical wire text), streaming executor, one-round-trip pg_catalog introspection, editability mapping via `prepare()`, SQLite app-state, Keychain secrets. Frontend (`src/`): zustand stores, custom completion engine on lezer, virtualized grid on TanStack Virtual, motion springs.

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Development happens phase-by-phase per [docs/ROADMAP.md](docs/ROADMAP.md) — read it first if you're contributing (or if you're an AI agent: especially you, the gotcha ledger is for you).

## Status

v0.1.0 — full v1 roadmap shipped. PostgreSQL only (driver trait is in place for SQLite/MySQL later). macOS only. Dark theme only, by choice.
