# qwry Architecture

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
| Frontend | React 19 + Vite + TS strict | broad familiarity, ecosystem |
| Editor | CodeMirror 6 + custom completion | light, <16ms popup achievable |
| PG driver | tokio-postgres | RowDescription metadata (`Column::table_oid()`/`column_id()`) powers editable results; CancelToken; notices |
| State | zustand | |
| Grid | custom DOM grid on @tanstack/react-virtual (rows+cols). Fallback: Glide Data Grid, checkpoint end of P2 | full UX control |
| Animation | `motion` | springs |
| SSH tunnels | spawn system `ssh -L` (respects ~/.ssh/config) | user's bastion works as-is |
| Secrets | `keyring` crate → macOS Keychain | |
| App persistence | rusqlite in app-data dir (history, tabs, profiles; never passwords) | |

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
- **Statement-at-a-time execution (v0.35)**: `execute_stream` splits the buffer and runs each statement as its own `simple_query`: psql autocommit semantics. Committed means committed (no whole-buffer implicit tx silently rolling back reported work); errors stop the run at the failing statement with the position rebased to whole-buffer chars (`StmtSpan.char_offset`); explicit BEGIN/COMMIT still span statements on the same session; VACUUM etc. work mid-buffer.
- **Editable results**: column editable iff `table_oid != 0` AND full PK of that table present in result columns (ctid fallback = editable-with-warning). `apply_edits` → ONE batched `BEGIN;U₁;…;Uₙ` simple-query message, per-statement RETURNING counts verified from the result stream (matched≠1 or any error → ROLLBACK ALL), then COMMIT/ROLLBACK; 2 round trips for any N. Planning runs on a frontend-fed cached mapping (EditabilityMap + snapshot names → zero catalog trips; trusted-but-verified, silent server-side fallback when absent/incomplete). Joined/computed columns read-only with reason.
- **Sessions**: one dedicated PG connection per query tab (transactions coherent). CancelToken per session. `connect` takes an `on_close` callback the driver fires on socket death → `session-closed` event → frontend flips the dot + auto-reconnects (`ensureTabSession`).
- **Introspection**: pg_catalog queries (tables, columns+types+nullability+defaults, PKs, FKs both directions, indexes, functions+signatures, enums) → `SchemaSnapshot { version }`, pushed via event. Refresh on connect / DDL detection / manual. The last snapshot persists per profile (appdb `schema_cache`, keyed by `connSig`) and hydrates INSTANTLY at connect start (stale-while-revalidate); a hydrate never overwrites, the server fetch always wins.
- **Statement splitter**: lexer respecting `'…'`, `"…"`, `$tag$…$tag$`, `--`, `/*…*/`.
- **SSH tunnel** (`tunnel.rs`): one `ssh -N -L` subprocess per SPEC (forward target + ssh params); `AppState.tunnels` is keyed by spec, so profiles with identical specs (DB-switcher clones) share one process. `ensure_tunnel` rebuilds on dead socket (`is_alive`); a repointed profile computes a new spec and gets its own tunnel. `profile_specs` tracks bindings; invalidate/delete drops a tunnel only when its last profile unbinds.
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

- **Theme engine** (`design/theme.ts`): a palette is *seeds*, expanded to the full CSS-var token set as inline vars at startup (no flash). Two kinds: **hue** (curated 8 Pokémon palettes: accent+hue+tint → tinted neutral ramp) and **anchors** (custom: bg/fg/primary/secondary → surfaces by sRGB mix). `--accent-fg` is auto-contrast; custom themes synthesise their opposite light/dark variant so the mode toggle flips them too.
- **Floating-card shell** (`app/v2.css`): transparent window, `window-vibrancy` material showing through `--gutter` between `.card` panels; inspector animates its *width* so the main card reflows in lockstep (no transform desync).
- **Per-tab results/edits**: `useResults`/`useEdits` keyed `byTab` with the active tab mirrored to top-level store fields; every consumer reads unchanged and a background tab's stream can't corrupt the visible tab. `committing`/`preview` stay global.

### v0.2.5 frontend designs

- **Unified tabs**: `Tab.kind` is `query` | `table` (+ a `table` ref). The tab bar holds both; `App` renders the editor or `TableBrowser` by the active tab's kind. Query tabs persist (appdb); table tabs are session-only (`persist()` filters them out, stripped to the appdb fields). The store wiring is a chain of module-level `subscribe()`s (`tabs.activeId → results.active → edits.active → browser`), so all three follow the active tab. **(HMR caveat: heavy store-file hot-reload can bind this wiring to a stale store instance and desync `edits.active`; relaunch `tauri dev` after store churn.)**
- **Per-tab browser state**: `useBrowser` keyed `byTab` (mirrored from the active tab), with the browsed table on the `Tab`; every table tab keeps its own filters/sort/scroll/draft.
- **Type-icon headers**: `grid/typeIcon.tsx` maps a column's `type_name` (from the editability map, fetched eagerly per result) to a lucide glyph + `--syn-*` color, shown left of each header name.
- **Inline add-row**: a `position:sticky` draft band under the grid header (outside the virtualizer; data cells offset `+draftH`), per-tab `draftRow` in `useBrowser`; ⌘↵ insert / Esc cancel.
- **Close guard** (`closeGuard` + `app/CloseGuardModal`): every close affordance routes through `request(tabId)` → prompts on uncommitted cell edits (Esc keep · Enter discard · ⌘↵ commit). 
- **Connect-error UX**: driver TLS→plain fallback reports server-sent errors instead of masking them; global `app/ConnToast` surfaces connect failures on any view.

### v0.5 designs

- **Native menu bar** (`lib.rs build_menu`): app owns the macOS menu. Edit submenu uses PREDEFINED items (native clipboard in text fields); every other item is custom, emitting a `menu` event with its id; `App.tsx` dispatches ids to the same store actions the keyboard uses. Custom Quit routes through `requestQuit()` (flush tab persist → dirty-edit confirm → `destroy()`), shared with `onCloseRequested`. Deliberately NO File▸Close Window; ⌘W belongs to tab close. Webview keydown handlers keep winning key equivalents (empirical on this setup); menu clicks are the discoverable/mouse path.
- **Prod safe-mode (enforced, server-side)**: `is_prod` → `pg_config` appends `-c default_transaction_read_only=on`, so EVERY session (primary, per-tab, spare) starts read-only at the server; CTEs/DO-blocks/functions can't sneak a write past a client-side sniffer because there isn't one. Unlock is per-tab: titlebar chip → confirm → `setSessionWrites` runs `SET default_transaction_read_only = off` on that tab's session only (`writeTabs[skey]`, lifecycle mirrors `txTabs`). PG caveat: existing TEMP tables stay writable in read-only txns (CREATE TEMP is blocked).
- **Settings** (`useSettings`, persisted): mode/palette + editor font size (via `--editor-fs` CSS var, no CodeMirror remount), wrap-lines (extension → remount), statement timeout (read by `ipc.connect` at call time → `pg_config`; existing sessions keep theirs until rebuilt).
- **History panel ⌘Y**: appdb `history_search` with `profile_id` optional (NULL = all connections); debounced LIKE search (metachar-escaped), open-in-new-tab.
- **Persistence**: window geometry via `tauri-plugin-window-state`; last-active tab id in localStorage (`qwry.activeTab`), restored if the tab survives (table tabs are session-only → fallback first tab).
- **Cancel escape hatch**: `ipc.cancel` failure (dead tunnel: cancel needs a NEW server connection) → confirm → force-disconnect the tab session; next run builds a fresh one via the spare pool.

### Completion engine (the intellisense)

Day-one: `@codemirror/lang-sql` PostgreSQL dialect with schema from SchemaSnapshot.
Then replace its completion source: walk lezer parse tree → query context (current clause, FROM/JOIN tables, aliases) → scope column suggestions to in-scope tables, FK-aware `JOIN … ON` suggestions, rank = fuzzy score × usage frequency × context boost. Usage counts persist in appdb. Fully synchronous from in-memory snapshot; zero IPC on keystroke.

### Grid

Custom DOM grid, TanStack Virtual on both axes. Pending-edit overlay model in `editsStore` keyed (statementIdx, rowIdx, colIdx); dirty cells show ✎; ⌘S opens SQL preview → commit. Read-only cells show reason on hover.

## Wireframe (v0.2: floating cards on a themed-glass gutter)

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
