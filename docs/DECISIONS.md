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
