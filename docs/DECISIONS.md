# Decisions (ADR-lite — one line each: what + why)

- 2026-06-12 · Tauri 2 over Electron/SwiftUI — small/fast/native feel; Rust core for streaming perf.
- 2026-06-12 · tokio-postgres over sqlx — need RowDescription `table_oid()`/`column_id()` for editable results, CancelToken, notices.
- 2026-06-12 · CodeMirror 6 over Monaco — ~1MB vs ~5MB, faster in WKWebView; intellisense quality comes from our completion engine either way.
- 2026-06-12 · Custom DOM grid (TanStack Virtual) over Glide Data Grid — full UX control; Glide is the fallback at P2 checkpoint.
- 2026-06-12 · SSH tunnels via system `ssh -L` subprocess — respects ~/.ssh/config; russh only if subprocess proves flaky.
- 2026-06-12 · Passwords in macOS Keychain (keyring crate); rusqlite app-db stores everything else.
- 2026-06-12 · JSON row values over Channel v1; binary/Arrow only if profiling demands.
- 2026-06-12 · zustand for state; `motion` for springs; lucide icons; cmdk palette.
- 2026-06-12 · `time` pinned to 0.3.47 in Cargo.lock — 0.3.48 breaks tauri-utils 2.9.2 with E0119 (conflicting From impls). Unpin when tauri-utils ships a fix; don't `cargo update` blindly.
- 2026-06-12 · keyring crate pinned to v3 (apple-native) — v4 is a restructured meta-crate needing store init; v3 API is stable and sufficient.
- 2026-06-12 · Execution uses PG **simple protocol** (`simple_query`): every type arrives as wire text (psql-identical), multi-statement native. P5 editability metadata comes from a separate `prepare()` (RowDescription table_oid/attnum) without re-executing.
- 2026-06-12 · TLS = rustls with no-verify ServerCertVerifier ≈ psql `sslmode=require` semantics (RDS works out of the box); `prefer` tries TLS then falls back to plain.

### v0.1.5
- 2026-06-13 · Editability via `prepare()` only (no re-exec); ctid is the row-locator fallback when no PK is in the result (editable-with-warning); multi-cell edits to one row batch into a single UPDATE (`plan_edits` groups by table+row).
- 2026-06-13 · One dedicated PG connection per query tab (`ensureTabSession`) so transactions/temp state stay coherent; schema introspection runs on a separate per-profile *primary* session. Tx-open indicator is a SQL-sniff heuristic (tokio-postgres doesn't expose ReadyForQuery).
- 2026-06-13 · `window.confirm()` is a silent no-op in WKWebView → all destructive actions use a custom DangerModal or a two-click arm pattern, never `confirm()`.
- 2026-06-13 · WKWebView forces macOS autocorrect/capitalize on every field with no global switch → `app/noAutocorrect.ts` stamps it off per-field + a MutationObserver for new fields (opt-out `data-allow-autocorrect`).
- 2026-06-14 · SSH tunnel = system `ssh -N -L` subprocess, one shared per profile (`AppState.tunnels`), `BatchMode=yes`, honours `~/.ssh/config`; routes connect through the local port. `kill_on_drop` reaps it.

### v0.2
- 2026-06-14 · Theme engine (`design/theme.ts`): a palette is *seeds*, expanded to the full CSS-var token set as inline vars at startup (no flash). Two kinds — **hue** (curated: accent+hue+tint → tinted neutral ramp) and **anchors** (custom: bg/fg/primary/secondary → surfaces by sRGB mix). `--accent-fg` is auto-contrast. Custom themes are authored once; the opposite light/dark variant is synthesised so the mode toggle flips them too.
- 2026-06-14 · Floating-card shell on a vibrancy gutter: transparent window + `window-vibrancy` material shows through `--gutter` between `.card` panels (rail / sidebar / main / inspector). Replaced the old flush `.app-shell/.sidebar/.main-area`.
- 2026-06-14 · Per-tab results+edits keyed `byTab` with the active tab mirrored to top-level store fields → every consumer reads unchanged and a background tab's stream can't corrupt the visible tab. `committing`/`preview` stay global (one commit at a time).
- 2026-06-14 · Connection liveness: `connect` takes an `on_close` callback the driver task fires on socket death → `session-closed` event → frontend flips the dot + drops dead sessions; `ensureTabSession` auto-reconnects on next use.
- 2026-06-15 · Editing a saved connection invalidates its live state when connection-affecting fields change (`connSig`): close the profile's sessions + drop its cached tunnel so the next connect uses the new values. The tunnel also carries a `spec` (host+ssh params) and `ensure_tunnel` rebuilds on mismatch — a repointed host can't keep forwarding to the old one. Cosmetic edits leave the live connection alone.
- 2026-06-15 · Inspector commit/preview re-resolve a live session via `ensureTabSession` instead of the result's `executedSessionId` (which can be dead after a repoint/drop/dev-rebuild) — edits are pk-based so they apply on a fresh connection.
- 2026-06-15 · Colorized JSON view/edit uses a CodeMirror `JsonField`, never a transparent-textarea-over-`<pre>` overlay — WKWebView's opaque native field background always covers the colored layer.
- 2026-06-15 · App icon built from the transparent SVG via `scripts/make_icon.py` → `icon-master.png` composited onto Apple's grid (824² rounded squircle in 1024, charcoal gradient, soft shadow); all sizes regenerated by `tauri icon`.

### v0.2.5
- 2026-06-17 · Tabs unified: `Tab` gains `kind: "query"|"table"` + `table` ref; opening a table creates a **session-only** table tab (persist only query tabs, stripped to the appdb fields) instead of a full-panel swap. App renders editor vs `TableBrowser` by the active tab's kind; tab strip shows a kind icon.
- 2026-06-17 · Browser state went **per-tab**: `useBrowser` keyed `byTab` mirrored from the active tab (results/edits pattern); the table ref lives on the `Tab`, so every table tab keeps its own filters/sort/scroll/draft. Opening an already-open table focuses it (no dupes).
- 2026-06-17 · Column-header data-type icons come from the **editability map's `type_name`** (already fetched eagerly per result) — the simple-protocol `ColumnMeta` carries no type, so no Rust change. `grid/typeIcon.tsx` maps type families → lucide glyph + `--syn-*` color; reuses `isArrayType`.
- 2026-06-17 · Inline add-row replaces the `InsertPanel` overlay: a sticky draft band pinned under the grid header (outside the virtualizer — cells offset `+draftH`), per-tab `draftRow` in the browser store; `⌘↵` insert / `Esc` cancel / `∅` NULL. Add-row button moved into the bottom toolbar (far left; Filter+Sort right).
- 2026-06-17 · Close-with-unsaved-edits guard: `closeGuard` store routes every close (tab X / ⌘W / browser header X) → prompts when `useEdits.byTab[id].pending` is non-empty. `Esc` keep · `Enter` discard&close · `⌘↵` commit&close (selects the tab first so the commit targets it; keeps the tab open if commit fails).
- 2026-06-17 · Connect errors surfaced: TLS→plain fallback no longer masks **server-sent** errors (`e.as_db_error()`) — a bad password / pg_hba now reports its real reason instead of a misleading "no encryption". Global `ConnToast` shows connect failures on any view (dashboard included) with an Edit shortcut.
- 2026-06-17 · Tab strip auto-scrolls the active tab into view via `scrollIntoView({ inline: "nearest" })` — minimal slide, no jitter when already visible; reveals the `+` for the last tab. Native horizontal scrollbar hidden.
