# qwry

A fast, keyboard-first PostgreSQL client for macOS. Built because the alternatives each miss something: Postico's intellisense is weak, Beekeeper can't edit cells from arbitrary query results (and paywalls JSON formatting), pgAdmin is pgAdmin.

Tauri 2 (Rust core) · React 19 · CodeMirror 6 · ~15 MB app, ~6 MB dmg.

## What it does well

**SQL intellisense that actually understands your query.** Columns scoped to the tables in your FROM clause, `alias.` completion, FK-aware `JOIN … ON` one-shot suggestions, usage-ranked results, PG error squiggles at the exact position. The 3.5k `pg_catalog` functions stay out of your way — Ctrl-Space or ⌘⇧U when you want them.

**Edit any query result.** Run any SELECT — joins included. Double-click a cell, type, ⌘S. qwry maps result columns back to their source tables via the wire protocol's `table_oid`/`attnum` metadata, finds the primary key, and shows you the exact `UPDATE … WHERE pk = … RETURNING …` before committing everything in one transaction. Edits to several cells of one row collapse into a single UPDATE. No primary key in the result? It falls back to `ctid`. Insert and delete rows from the table browser too. Read-only cells tell you *why* (computed expression, PK not selected, …).

**First-class JSON.** Collapsible jsonb tree in the inspector with ⌘F search (filter, highlight, jump between hits), click-to-copy values, ⌥-click for paths, and in-place type-preserving editing of values and keys right in the tree. Free.

**Real transactions.** Every query tab gets its own dedicated connection, so `BEGIN`/`COMMIT`/`ROLLBACK` and temp state stay coherent and isolated — a tab shows a dot while a transaction is open.

**Fast.** Results stream from Rust in batches over Tauri channels into a custom virtualized grid — a million-row result scrolls smoothly. ⌘. cancels instantly via the PG cancel protocol.

**Looks the part.** Floating rounded cards on a themed-glass gutter, a connection rail of customizable avatars (colour + glyph, drag to reorder), a colour engine with curated palettes + custom themes (each with a synthesised light/dark variant), and springy Linear/Arc-style motion. Edit a saved connection and it actually re-points — stale sessions and SSH tunnels are torn down so the next query hits the new host.

Also: table browser (filters with AND/OR, searchable sort, structure tab, row insert/delete), SSH tunnels via your system `ssh` (honours `~/.ssh/config`), per-connection home dashboard with recent activity, in-app database switcher, light/dark/system themes, macOS vibrancy, persistent tabs, saved queries, searchable history, ⌘K command palette, EXPLAIN ANALYZE visualizer with hot-node highlighting, guards for UPDATE/DELETE without WHERE, prod-connection warning strip, Keychain-stored credentials, no telemetry.

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
| ⌘F search JSON (inspector) | |

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

v0.2.0 — major visual overhaul on top of the full v1 + v0.1.5 feature set. v0.2 adds the floating-card shell, the colour/theme engine (curated palettes + custom dual-mode themes), the connection rail with customizable avatars, a home dashboard, in-app database switcher, per-tab results, connection liveness + edit-takes-effect re-pointing, and an inspector redesign (structured JSON/array view + edit). PostgreSQL only (driver trait is in place for SQLite/MySQL later). macOS only.
