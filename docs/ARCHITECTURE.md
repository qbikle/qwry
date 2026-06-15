# qwry — Architecture

> Design truth. Keep current: when implementation diverges deliberately, update this file in the same commit.

## Ideology

1. **Latency is the feature.** Every interaction <16ms perceived. Cold start <500ms.
2. **The grid is the app.** Virtualized, editable, keyboard-navigable, beautiful.
3. **SQL-first, GUI-equal.** Editor and table browser both first-class.
4. **Never lose work.** Tabs, query text, history persist across restarts.
5. **Direct manipulation.** Read-only cells say *why* they're read-only.
6. **Keyboard-first, mouse-delightful.** Springs on transitions, never on scroll/typing.
7. **No paywalls, no telemetry, local-only.**

## Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2, WKWebView | small, fast, native feel |
| Frontend | React 19 + Vite + TS strict | agent familiarity, ecosystem |
| Editor | CodeMirror 6 + custom completion | light, <16ms popup achievable |
| PG driver | tokio-postgres | RowDescription metadata (`Column::table_oid()`/`column_id()`) powers editable results; CancelToken; notices |
| State | zustand | |
| Grid | custom DOM grid on @tanstack/react-virtual (rows+cols). Fallback: Glide Data Grid — checkpoint end of P2 | full UX control |
| Animation | `motion` | springs |
| SSH tunnels | spawn system `ssh -L` (respects ~/.ssh/config) | user's bastion works as-is |
| Secrets | `keyring` crate → macOS Keychain | |
| App persistence | rusqlite in app-data dir (history, tabs, profiles — never passwords) | |

## Rust core (`src-tauri/src/`)

```
main.rs / lib.rs           tauri builder, command registration
state.rs                   AppState: SessionMap, appdb handle
driver/mod.rs              DbDriver trait + shared types (Value, ColumnMeta, RowEdit, SchemaSnapshot)
driver/postgres/mod.rs     PgDriver: connect, session registry
driver/postgres/execute.rs statement split, run, stream batches, cancel
driver/postgres/introspect.rs  pg_catalog → SchemaSnapshot
driver/postgres/edit.rs    table_oid/attnum → editability map, UPDATE gen
tunnel.rs                  ssh -L subprocess lifecycle
secrets.rs                 keyring per-profile
appdb.rs                   rusqlite: history, tabs, profiles
commands.rs                #[tauri::command] handlers (thin)
```

### DbDriver trait

```rust
#[async_trait]
trait DbDriver: Send + Sync {
    async fn connect(&self, cfg: &ConnConfig) -> Result<SessionId>;
    async fn execute(&self, session: SessionId, sql: String,
                     sink: Channel<QueryEvent>) -> Result<()>;
    async fn cancel(&self, session: SessionId) -> Result<()>;
    async fn introspect(&self, session: SessionId) -> Result<SchemaSnapshot>;
    async fn apply_edits(&self, session: SessionId, edits: Vec<RowEdit>) -> Result<EditOutcome>;
    async fn close(&self, session: SessionId) -> Result<()>;
}

enum QueryEvent {
    StatementStart { index: u32, sql: String },
    Columns { index: u32, cols: Vec<ColumnMeta> },   // name, type_oid, table_oid, attnum
    Rows { index: u32, rows: Vec<Vec<Value>> },      // batch ≤ 500 rows
    StatementDone { index: u32, affected: Option<u64>, ms: f64 },
    Notice { index: u32, severity: String, message: String },
    Error { index: u32, message: String, position: Option<u32> },
    Finished,
}
```

### Key designs

- **Streaming**: tokio-postgres `RowStream` → ≤500-row batches over Tauri `Channel`. Frontend caps in-memory rows (50k default, "load more"). JSON values v1. Cells >8KB truncated with `cell_overflow` marker; inspector fetches full value on demand.
- **Editable results**: column editable iff `table_oid != 0` AND full PK of that table present in result columns (ctid fallback = editable-with-warning). `apply_edits` → one transaction of generated `UPDATE … WHERE pk=…` with RETURNING to refresh cells. Joined/computed columns read-only with reason.
- **Sessions**: one dedicated PG connection per query tab (transactions coherent). CancelToken per session. `connect` takes an `on_close` callback the driver fires on socket death → `session-closed` event → frontend flips the dot + auto-reconnects (`ensureTabSession`).
- **Introspection**: pg_catalog queries (tables, columns+types+nullability+defaults, PKs, FKs both directions, indexes, functions+signatures, enums) → `SchemaSnapshot { version }`, pushed via event. Refresh on connect / DDL detection / manual.
- **Statement splitter**: lexer respecting `'…'`, `"…"`, `$tag$…$tag$`, `--`, `/*…*/`.
- **SSH tunnel** (`tunnel.rs`): one `ssh -N -L` subprocess shared per profile (`AppState.tunnels`). Each carries a `spec` (forward target + ssh params); `ensure_tunnel` rebuilds on spec mismatch (profile repointed) or dead socket (`is_alive`), so a stale tunnel can't keep forwarding to the old host.
- **Connection-edit invalidation** (v0.2): editing a saved profile whose connection fields changed (`connSig`) closes its sessions + drops its tunnel via `invalidate_profile` → next connect uses the new values; cosmetic edits don't disturb the live connection.

## Frontend (`src/`)

```
app/         floating-card shell (v2.css), breadcrumb, menu wiring
home/        Dashboard (connection grid + recent activity) + ConnectionEditor
stores/      zustand: connections, tabs, results, schema, edits, settings, inspector
ipc/         typed invoke/Channel wrappers; types.ts mirrors Rust types
editor/      SqlEditor.tsx; completion/{context,engine,joins}.ts; lint.ts
grid/        Grid/Cell/Header; selection.ts; clipboard.ts; editing.ts
inspector/   cell detail; JsonTree.tsx; JsonField.tsx (CodeMirror); format.ts
sidebar/     ConnectionRail + Avatar; DbSwitcher; schema→table tree; SavedQueries
browser/     table data browser + structure tab
palette/     cmdk ⌘K
explain/     plan tree visualizer
design/      tokens.css, theme.ts (palette engine), springs.ts, icons (lucide)
```

### v0.2 frontend designs

- **Theme engine** (`design/theme.ts`): a palette is *seeds*, expanded to the full CSS-var token set as inline vars at startup (no flash). Two kinds — **hue** (curated 8 Pokémon palettes: accent+hue+tint → tinted neutral ramp) and **anchors** (custom: bg/fg/primary/secondary → surfaces by sRGB mix). `--accent-fg` is auto-contrast; custom themes synthesise their opposite light/dark variant so the mode toggle flips them too.
- **Floating-card shell** (`app/v2.css`): transparent window, `window-vibrancy` material showing through `--gutter` between `.card` panels; inspector animates its *width* so the main card reflows in lockstep (no transform desync).
- **Per-tab results/edits**: `useResults`/`useEdits` keyed `byTab` with the active tab mirrored to top-level store fields — every consumer reads unchanged and a background tab's stream can't corrupt the visible tab. `committing`/`preview` stay global.

### Completion engine (the intellisense)

Day-one: `@codemirror/lang-sql` PostgreSQL dialect with schema from SchemaSnapshot.
Then replace its completion source: walk lezer parse tree → query context (current clause, FROM/JOIN tables, aliases) → scope column suggestions to in-scope tables, FK-aware `JOIN … ON` suggestions, rank = fuzzy score × usage frequency × context boost. Usage counts persist in appdb. Fully synchronous from in-memory snapshot — zero IPC on keystroke.

### Grid

Custom DOM grid, TanStack Virtual on both axes. Pending-edit overlay model in `editsStore` keyed (statementIdx, rowIdx, colIdx); dirty cells show ✎; ⌘S opens SQL preview → commit. Read-only cells show reason on hover.

## Wireframe (v0.2 — floating cards on a themed-glass gutter)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ●●●   connection / database / table·tab            ⌘K   theme   qwry      │
│  ┌──┐ ┌───────────┐ ┌──────────────────────────────────┐ ┌─────────────┐ │
│  │🏠│ │ Databases ▾│ │ orders.sql ● │ users │ +         │ │ INSPECTOR   │ │
│  │🐢│ │ Tables     │ │  SQL editor (CodeMirror 6)        │ │ cell / jsonb│ │
│  │🔥│ │  orders    │ │  completion popup, lint squiggles │ │ tree / array│ │
│  │＋│ │  users…    │ ├───────────────────────────────────┤ │ struct      │ │
│  └──┘ │ Saved      │ │  virtualized grid · status bar    │ │ pending ✎   │ │
│ rail  └───────────┘ └───────────────────────────────────┘ └─────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

Left **connection rail** = circular avatars (colour + glyph), drag-reorder, 🏠 → home (dashboard / connection editor). Floating **sidebar card** (Databases switcher / Tables / Saved), **main card** (tabs / editor / results), **inspector card** slides in by animating its width so the main card reflows in lockstep. `--gutter` between cards shows the window vibrancy, tinted to the active theme.

## Keyboard map (core)

⌘Enter run · ⌘. cancel · ⌘S commit edits · ⌘K palette · ⌘T new tab · ⌘W close tab · ⌘⇧F filter sidebar · ⌘R refresh schema · ⌘D duplicate line · ⌘/ comment
