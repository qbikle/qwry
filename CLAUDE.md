# qwry

Fast, beautiful, local macOS PostgreSQL client. Tauri 2 (Rust) + React 19 + TypeScript + CodeMirror 6.

## Session protocol (READ FIRST)

This repo is built across many Claude Code sessions by different agents.

1. Read `docs/ROADMAP.md` — find the current phase and next unchecked item.
2. Read `docs/ARCHITECTURE.md` for the design you must fit into. Don't invent parallel structures.
   `docs/COPY.md` (text registers) and `docs/LESSONS.md` (bug-class law) bind every change;
   when a request — including the user's own idea — violates one, say so and cite it: the pushback is wanted.
3. Build the item. Verify it per the phase's verification gate.
4. Tick the checkbox, append a dated session note at the bottom of ROADMAP.md (what was done, what's half-done, gotchas).
5. Record any new design decision as one line in `docs/DECISIONS.md`.
6. Commit with a conventional message (`feat:`, `fix:`, `chore:`). Never commit broken builds.

## Commands

```sh
source ~/.cargo/env              # Rust toolchain (required every shell)
bun install                      # frontend deps
bun run tauri dev                # run app (dev, hot reload)
bun run tauri build              # release .app/.dmg
cd src-tauri && cargo check      # fast Rust typecheck
cd src-tauri && cargo clippy     # lint
bunx tsc --noEmit                # TS typecheck
```

## Layout

- `src/` — React frontend. Subdirs: `app/` shell, `stores/` zustand, `ipc/` typed Tauri bridge, `editor/` CodeMirror + completion engine, `grid/` virtualized results grid, `inspector/`, `sidebar/`, `browser/`, `palette/`, `explain/`, `design/` tokens+springs.
- `src-tauri/src/` — Rust core. `driver/` DbDriver trait + `driver/postgres/`, `tunnel.rs` ssh, `secrets.rs` keychain, `appdb.rs` rusqlite app-state, `commands.rs` IPC handlers.
- `docs/` — ARCHITECTURE.md (design truth), ROADMAP.md (phases + session log), DECISIONS.md (ADR-lite).

## Conventions

- Rust: `thiserror` error enums per module; no `unwrap()` outside tests; clippy clean.
- TS: strict mode; no `any` without a comment explaining why; zustand stores in `src/stores/` only.
- IPC types defined once in Rust, mirrored by hand in `src/ipc/types.ts` — keep in sync (check both when changing either).
- Springs/animation only via presets in `src/design/springs.ts`. Never animate scroll or typing.
- Perf budgets are law: cold start <500ms, keystroke→completion <16ms, grid scroll 60fps minimum.

## Testing against a real DB

User's staging Postgres creds: `source ~/.claude/.env.claude`, then
`PGPASSWORD=$STAGING_DB_PASSWORD psql -h $STAGING_DB_HOST -U $STAGING_DB_USER -d crawler_data_production`.
Staging is safe for read/write. NEVER point tests at prod ($PROD_*).
