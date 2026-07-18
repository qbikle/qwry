use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::driver::{self, ExecOutcome, Profile, QueryEvent, Result, SessionId};
use crate::secrets;
use crate::state::AppState;

/// emitted to the frontend when a connection's socket dies, so the UI can flip
/// the status dot and auto-reconnect on next use
#[derive(Clone, serde::Serialize)]
struct SessionClosed {
    session_id: String,
    profile_id: String,
    /// what the driver knows about why (connection error text)
    reason: Option<String>,
}

/// session transaction status changed (driver-tracked) — feeds the tx chip
#[derive(Clone, serde::Serialize)]
struct TxStateChanged {
    session_id: String,
    state: &'static str,
}

/// an appdb list dropped corrupt rows — surfaced as a frontend toast
#[derive(Clone, serde::Serialize)]
struct AppDbWarning {
    table: &'static str,
    skipped: usize,
}

fn warn_skipped(app: &AppHandle, table: &'static str, skipped: usize) {
    if skipped > 0 {
        let _ = app.emit("appdb-warning", AppDbWarning { table, skipped });
    }
}

#[tauri::command]
pub async fn profiles_list(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<Profile>> {
    let (profiles, skipped) = state.appdb.list_profiles()?;
    warn_skipped(&app, "profiles", skipped);
    Ok(profiles)
}

#[tauri::command]
pub async fn profile_save(
    state: State<'_, AppState>,
    profile: Profile,
    password: Option<String>,
) -> Result<()> {
    state.appdb.save_profile(&profile)?;
    if let Some(pw) = password {
        secrets::set_password(&profile.id, &pw)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn profile_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.appdb.delete_profile(&id)?;
    // unbind its tunnel spec — the shared ssh process dies only when no other
    // profile still rides it
    state.invalidate_profile_tunnel(&id);
    secrets::delete_password(&id)
}

/// A profile was repointed: unbind it from its SSH tunnel so the next connect
/// resolves a fresh spec. The tunnel itself is dropped only when no OTHER
/// profile shares it (tunnels are keyed/shared by spec — DB-switcher clones
/// ride one ssh process). No-op when the profile has none.
#[tauri::command]
pub async fn invalidate_profile(state: State<'_, AppState>, profile_id: String) -> Result<()> {
    state.invalidate_profile_tunnel(&profile_id);
    Ok(())
}

#[tauri::command]
pub async fn set_profile_order(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    state.appdb.set_profile_order(&ids)
}

/// clone a profile onto a different database (the DB-switcher) — new id, same
/// host/creds (password carried over), name "<base> · <db>"
#[tauri::command]
pub async fn clone_connection(
    state: State<'_, AppState>,
    src_profile_id: String,
    dbname: String,
) -> Result<Profile> {
    let src = state
        .appdb
        .list_profiles()?
        .0
        .into_iter()
        .find(|p| p.id == src_profile_id)
        .ok_or(driver::DriverError::Internal("no such profile".into()))?;
    let base = src.name.split(" · ").next().unwrap_or(&src.name).to_string();
    let mut p = src.clone();
    p.id = uuid::Uuid::new_v4().to_string();
    p.dbname = dbname.clone();
    p.name = format!("{base} · {dbname}");
    state.appdb.save_profile(&p)?;
    // a keychain failure must surface, not silently leave the clone
    // password-less (same contract as every other keychain site)
    if let Some(pw) = secrets::get_password(&src_profile_id)? {
        secrets::set_password(&p.id, &pw)?;
    }
    Ok(p)
}

/// percent-encode a URI component (RFC 3986 — unreserved chars pass through)
fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// postgres:// URI for a profile. The password is read from the Keychain only
/// when explicitly requested — the redacted form is the default copy action.
#[tauri::command]
pub async fn connection_uri(
    state: State<'_, AppState>,
    profile_id: String,
    include_password: bool,
) -> Result<String> {
    let p = state
        .appdb
        .list_profiles()?
        .0
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or(driver::DriverError::Internal("no such profile".into()))?;
    let mut userinfo = uri_encode(&p.user);
    if include_password {
        let pw = secrets::get_password(&profile_id)?.unwrap_or_default();
        if !pw.is_empty() {
            userinfo.push(':');
            userinfo.push_str(&uri_encode(&pw));
        }
    }
    // IPv6 literals need brackets in the authority part
    let host = if p.host.contains(':') && !p.host.starts_with('[') {
        format!("[{}]", p.host)
    } else {
        p.host.clone()
    };
    Ok(format!(
        "postgres://{userinfo}@{host}:{}/{}?sslmode={}",
        p.port,
        uri_encode(&p.dbname),
        p.sslmode
    ))
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    statement_timeout_ms: Option<u64>,
) -> Result<SessionId> {
    let profile = state
        .appdb
        .list_profiles()?
        .0
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or(driver::DriverError::Internal("no such profile".into()))?;
    let password = secrets::get_password(&profile_id)?.unwrap_or_default();

    // session id up front so the death callback can name itself
    let session_id = uuid::Uuid::new_v4().to_string();
    let on_close: Box<dyn FnOnce(Option<String>) + Send> = {
        let app = app.clone();
        let session_id = session_id.clone();
        let profile_id = profile_id.clone();
        Box::new(move |reason| {
            let _ = app.emit(
                "session-closed",
                SessionClosed { session_id, profile_id, reason },
            );
        })
    };
    // server NOTICEs (RAISE NOTICE etc.) → frontend status strip
    let on_notice: Box<dyn Fn(String, String) + Send> = {
        let app = app.clone();
        let sid = session_id.clone();
        Box::new(move |severity, message| {
            let _ = app.emit(
                "pg-notice",
                PgNotice {
                    session_id: sid.clone(),
                    severity,
                    message,
                },
            );
        })
    };

    // through an SSH tunnel when the profile has one, else direct
    let session = if crate::tunnel::tunnel_host(&profile).is_some() {
        let tunnel = state.ensure_tunnel(&profile).await?;
        driver::postgres::connect(
            &profile,
            &password,
            Some(("127.0.0.1", tunnel.local_port)),
            statement_timeout_ms,
            on_notice,
            on_close,
        )
        .await?
    } else {
        driver::postgres::connect(
            &profile,
            &password,
            None,
            statement_timeout_ms,
            on_notice,
            on_close,
        )
        .await?
    };
    // driver-tracked transaction state → frontend tx chip
    {
        let app = app.clone();
        let sid = session_id.clone();
        session.set_tx_listener(Box::new(move |st| {
            let _ = app.emit(
                "tx-state",
                TxStateChanged { session_id: sid.clone(), state: st.as_str() },
            );
        }));
    }
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(session));
    Ok(session_id)
}

#[derive(serde::Serialize, Clone)]
struct PgNotice {
    session_id: String,
    severity: String,
    message: String,
}

#[derive(serde::Serialize, Clone)]
pub struct TestResult {
    pub latency_ms: f64,
    pub server_version: String,
    pub tls: bool,
}

/// Ephemeral connectivity probe for the connection editor: connect (through
/// the tunnel if configured — the tunnel cache keeps it for the real connect),
/// SELECT version(), disconnect. Password may be passed unsaved from the form.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    profile: Profile,
    password: Option<String>,
) -> Result<TestResult> {
    let password = match password {
        Some(p) => p,
        None => secrets::get_password(&profile.id)?.unwrap_or_default(),
    };
    let start = std::time::Instant::now();
    let session = if crate::tunnel::tunnel_host(&profile).is_some() {
        let tunnel = state.ensure_tunnel(&profile).await?;
        driver::postgres::connect(
            &profile,
            &password,
            Some(("127.0.0.1", tunnel.local_port)),
            None,
            Box::new(|_, _| {}),
            Box::new(|_| {}),
        )
        .await?
    } else {
        driver::postgres::connect(
            &profile,
            &password,
            None,
            None,
            Box::new(|_, _| {}),
            Box::new(|_| {}),
        )
        .await?
    };
    let tls = session.is_tls();
    let out = session.execute_simple("SELECT version()").await?;
    let latency_ms = start.elapsed().as_secs_f64() * 1000.0;
    let server_version = out
        .statements
        .first()
        .and_then(|s| s.rows.first())
        .and_then(|r| r.first().cloned().flatten())
        .unwrap_or_default();
    Ok(TestResult { latency_ms, server_version, tls })
}

/// write an export to disk — path comes from the native save dialog. Async +
/// tokio::fs so a multi-MB CSV export never freezes the main thread/event loop.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<()> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| driver::DriverError::Internal(format!("write {path}: {e}")))
}

#[tauri::command]
pub async fn table_ddl(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> Result<String> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.table_ddl(&schema, &table).await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<()> {
    // a running query keeps its own Arc alive past removal — cancel it
    // best-effort so the server stops burning through it (cancel itself is
    // deadline-bounded, so a dead tunnel can't hang the disconnect)
    let session = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(s) = session {
        let _ = s.cancel().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> Result<ExecOutcome> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.execute_simple(&sql).await
}

#[tauri::command]
pub async fn execute_stream(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    on_event: Channel<QueryEvent>,
) -> Result<()> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    let mut sink = move |ev: QueryEvent| on_event.send(ev).is_ok();
    session.execute_stream(&sql, &mut sink).await
}

/// Introspect the session's database. When `cache_key`/`cache_sig` are given
/// (profile id + connection signature), the snapshot is also persisted to the
/// appdb schema cache so the NEXT connect can hydrate instantly
/// (stale-while-revalidate; see `schema_cache_get`).
#[tauri::command]
pub async fn introspect(
    state: State<'_, AppState>,
    session_id: String,
    cache_key: Option<String>,
    cache_sig: Option<String>,
) -> Result<crate::driver::postgres::introspect::SchemaSnapshot> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    let snap = session.introspect().await?;
    if let (Some(key), Some(sig)) = (cache_key, cache_sig) {
        // best-effort — a failed cache write must never fail the introspect
        if let Ok(data) = serde_json::to_string(&snap) {
            let _ = state.appdb.schema_cache_put(&key, &sig, &data);
        }
    }
    Ok(snap)
}

/// Last persisted schema snapshot for a profile, as its raw JSON string —
/// parsed once in TS. Returns None when absent or when the stored `sig` does
/// not match (profile repointed since the cache was written).
#[tauri::command]
pub async fn schema_cache_get(
    state: State<'_, AppState>,
    profile_id: String,
    sig: String,
) -> Result<Option<String>> {
    state.appdb.schema_cache_get(&profile_id, &sig)
}

#[tauri::command]
pub async fn editability(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    tables_hint: Option<Vec<crate::driver::postgres::edit::TableIdentityHint>>,
) -> Result<crate::driver::postgres::edit::EditabilityMap> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session
        .editability(&sql, statement_index, tables_hint.as_deref())
        .await
}

#[tauri::command]
pub async fn edits_preview(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    edits: Vec<crate::driver::postgres::edit::RowEdit>,
    map_hint: Option<crate::driver::postgres::edit::EditMapHint>,
) -> Result<Vec<String>> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session
        .build_edit_statements(&sql, statement_index, &edits, map_hint)
        .await
}

#[tauri::command]
pub async fn edits_apply(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    edits: Vec<crate::driver::postgres::edit::RowEdit>,
    map_hint: Option<crate::driver::postgres::edit::EditMapHint>,
) -> Result<crate::driver::postgres::edit::EditOutcome> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session
        .apply_edits(&sql, statement_index, edits, map_hint)
        .await
}

#[tauri::command]
pub async fn delete_rows(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    table_oid: u32,
    rows: Vec<Vec<(u32, Option<String>)>>,
    map_hint: Option<crate::driver::postgres::edit::EditMapHint>,
) -> Result<crate::driver::postgres::edit::EditOutcome> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session
        .delete_rows(&sql, statement_index, table_oid, rows, map_hint)
        .await
}

/// one full (untruncated) cell by table identity + row locator — replaces the
/// frontend's hand-rolled fetch SQL (aliased/unquoted idents, dotted names)
#[tauri::command]
pub async fn fetch_cell(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    col: u32,
    locator: Vec<(u32, Option<String>)>,
    map_hint: Option<crate::driver::postgres::edit::EditMapHint>,
) -> Result<Option<String>> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session
        .fetch_cell(&sql, statement_index, col, locator, map_hint)
        .await
}

#[derive(serde::Serialize, Clone)]
pub struct SessionInfo {
    pub tls: bool,
    pub backend_pid: i32,
}

/// live facts about a session the frontend can't know otherwise — whether TLS
/// is actually on (sslmode=prefer can silently downgrade) and the backend pid
#[tauri::command]
pub async fn session_info(state: State<'_, AppState>, session_id: String) -> Result<SessionInfo> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    Ok(SessionInfo {
        tls: session.is_tls(),
        backend_pid: session.backend_pid(),
    })
}

/// pg_terminate_backend over a fresh control connection — the last cancel
/// tier. Only ever run on explicit user action.
#[tauri::command]
pub async fn terminate_backend(state: State<'_, AppState>, session_id: String) -> Result<()> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.terminate_backend().await
}

#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
    cols: Vec<String>,
    values: Vec<Option<String>>,
) -> Result<ExecOutcome> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.insert_row(&schema, &table, cols, values).await
}

// appdb commands are async so Tauri runs them OFF the main thread — a sync
// command body executes on the main thread and a slow sqlite write (or a
// Keychain prompt) froze the whole event loop.

#[tauri::command]
pub async fn tabs_list(state: State<'_, AppState>) -> Result<Vec<crate::appdb::TabRow>> {
    state.appdb.tabs_list()
}

#[tauri::command]
pub async fn tabs_save(state: State<'_, AppState>, tabs: Vec<crate::appdb::TabRow>) -> Result<()> {
    state.appdb.tabs_save(&tabs)
}

#[tauri::command]
pub async fn history_add(
    state: State<'_, AppState>,
    profile_id: String,
    sql: String,
    ms: f64,
    rows: i64,
    status: crate::appdb::HistoryStatus,
) -> Result<()> {
    state.appdb.history_add(&profile_id, &sql, ms, rows, status)
}

#[tauri::command]
pub async fn history_search(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: Option<String>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<crate::appdb::HistoryRow>> {
    let (rows, skipped) =
        state
            .appdb
            .history_search(profile_id.as_deref(), &query, limit.unwrap_or(100))?;
    warn_skipped(&app, "history", skipped);
    Ok(rows)
}

#[tauri::command]
pub async fn history_recent(
    app: AppHandle,
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<crate::appdb::HistoryRow>> {
    let (rows, skipped) = state.appdb.history_recent(limit.unwrap_or(8))?;
    warn_skipped(&app, "history", skipped);
    Ok(rows)
}

#[tauri::command]
pub async fn saved_list(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<crate::appdb::SavedQuery>> {
    let (rows, skipped) = state.appdb.saved_list()?;
    warn_skipped(&app, "saved_queries", skipped);
    Ok(rows)
}

#[tauri::command]
pub async fn saved_upsert(state: State<'_, AppState>, q: crate::appdb::SavedQuery) -> Result<()> {
    state.appdb.saved_upsert(&q)
}

#[tauri::command]
pub async fn saved_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.appdb.saved_delete(&id)
}

#[tauri::command]
pub async fn history_clear(
    state: State<'_, AppState>,
    profile_id: String,
    older_than_days: Option<i64>,
) -> Result<()> {
    state.appdb.history_clear(&profile_id, older_than_days)
}

#[tauri::command]
pub async fn cancel(state: State<'_, AppState>, session_id: String) -> Result<()> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.cancel().await
}
