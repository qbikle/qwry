use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::driver::{self, ExecOutcome, Profile, QueryEvent, Result, SessionId};
use crate::secrets;
use crate::state::AppState;

/// session → owning profile, stamped at `connect` and dropped at `disconnect`.
/// Lets the commit path write undo-log rows keyed by profile WITHOUT the
/// frontend having to thread a profile id through every edit call — grid
/// deletes and ⌘S commits both get undo rows for free.
fn session_profiles() -> &'static Mutex<HashMap<String, String>> {
    static MAP: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Persist a committed batch's revert plan (best-effort: a failed undo-log
/// write must never fail the commit that produced it).
fn log_undo(state: &AppState, session_id: &str, outcome: &crate::driver::postgres::edit::EditOutcome) {
    if !outcome.committed {
        return;
    }
    let Some(plan) = &outcome.revert else { return };
    let profile_id = session_profiles().lock().unwrap().get(session_id).cloned();
    let Some(profile_id) = profile_id else { return };
    match serde_json::to_string(plan) {
        Ok(json) => {
            if let Err(e) =
                state
                    .appdb
                    .undo_log_add(&profile_id, session_id, &plan.description, &json)
            {
                eprintln!("appdb: undo-log write failed: {e}");
            }
        }
        Err(e) => eprintln!("undo plan serialize failed: {e}"),
    }
}

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

/// false only on the refused-appdb path (stub state + fatal dialog) — the
/// frontend must keep the hidden window hidden instead of revealing an
/// empty app beside "qwry can't start"
#[tauri::command]
pub fn startup_ok(state: State<'_, AppState>) -> bool {
    !state.startup_fatal
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

    // through an SSH tunnel when the profile has one, else direct. Cancel and
    // terminate signals ride the tunnel's control lane (a second ssh process)
    // when it spawned — a bulk result saturating the data lane can no longer
    // starve the cancel handshake.
    let session = if crate::tunnel::tunnel_host(&profile).is_some() {
        let tunnel = state.ensure_tunnel(&profile).await?;
        driver::postgres::connect(
            &profile,
            &password,
            Some(("127.0.0.1", tunnel.local_port)),
            tunnel.control_port.map(|p| ("127.0.0.1", p)),
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
    session_profiles()
        .lock()
        .unwrap()
        .insert(session_id.clone(), profile_id);
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
        // no control lane: the probe runs one SELECT and never cancels
        driver::postgres::connect(
            &profile,
            &password,
            Some(("127.0.0.1", tunnel.local_port)),
            None,
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

/// read a .sql file from disk — path comes from the native open dialog or a
/// drag-drop onto the window
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| driver::DriverError::Internal(format!("read {path}: {e}")))
}

/// mtime + size identity for a file on disk — the frontend's cheap probe for
/// on-disk .sql conflict detection and import size gating
#[tauri::command]
pub async fn file_stat(path: String) -> Result<crate::import::FileStat> {
    tauri::async_runtime::spawn_blocking(move || crate::import::stat_file(&path))
        .await
        .map_err(|e| driver::DriverError::Internal(format!("stat task failed: {e}")))?
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

/// Structure-tab depth for one relation: constraints, indexes (with scan
/// counts), triggers, sizes, pg_stat activity, comments — one round trip,
/// read-only, runs on whichever session the tab holds.
#[tauri::command]
pub async fn table_stats(
    state: State<'_, AppState>,
    session_id: String,
    schema: String,
    table: String,
) -> Result<crate::driver::postgres::stats::TableStats> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.table_stats(&schema, &table).await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<()> {
    // a running query keeps its own Arc alive past removal — cancel it
    // best-effort so the server stops burning through it (cancel itself is
    // deadline-bounded, so a dead tunnel can't hang the disconnect), then
    // hard-abort the connection: even when every cancel tier failed, the
    // in-flight execute must error out NOW, not drain to completion on a
    // session the app already forgot
    let session = state.sessions.lock().unwrap().remove(&session_id);
    session_profiles().lock().unwrap().remove(&session_id);
    if let Some(s) = session {
        // an already-aborted connection (terminate tier, cap hard-abort) has
        // nothing left to cancel — skip ~8s of pointless dialing
        if !s.is_aborted() {
            let _ = s.cancel().await;
        }
        s.abort_connection();
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
///
/// pg_catalog functions (~3k rows, only change with the server build) come
/// from the appdb cache keyed by the full server_version string; a miss
/// fetches them once and persists. A corrupt cache row parses as a miss and
/// self-heals on the re-put. User-schema functions are always fetched live.
#[tauri::command]
pub async fn introspect(
    state: State<'_, AppState>,
    session_id: String,
    cache_key: Option<String>,
    cache_sig: Option<String>,
) -> Result<crate::driver::postgres::introspect::SchemaSnapshot> {
    use crate::driver::postgres::introspect::FuncInfo;
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    let ver = session.server_version();
    let cached: Option<Vec<FuncInfo>> = if ver.is_empty() {
        None // unknown build — never serve possibly-wrong catalog functions
    } else {
        state
            .appdb
            .pg_catalog_funcs_get(&ver)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
    };
    let (snap, fresh_catalog) = session.introspect(cached).await?;
    if !ver.is_empty() {
        if let Some(cat) = &fresh_catalog {
            // best-effort — a failed cache write must never fail the introspect
            if let Ok(data) = serde_json::to_string(cat) {
                let _ = state.appdb.pg_catalog_funcs_put(&ver, &data);
            }
        }
    }
    if let (Some(key), Some(sig)) = (cache_key, cache_sig) {
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
    let outcome = session
        .apply_edits(&sql, statement_index, edits, map_hint)
        .await?;
    log_undo(&state, &session_id, &outcome);
    Ok(outcome)
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
    let outcome = session
        .delete_rows(&sql, statement_index, table_oid, rows, map_hint)
        .await?;
    log_undo(&state, &session_id, &outcome);
    Ok(outcome)
}

/// newest unexpired undo-log row for a profile — the frontend's undo offer
#[tauri::command]
pub async fn undo_log_latest(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Option<crate::appdb::UndoLogRow>> {
    state.appdb.undo_log_latest(&profile_id)
}

/// Apply a persisted revert plan on the session that committed it. Session
/// identity is verified on a PEEK first — a refused undo must not consume the
/// offer — and only a passing row is taken (an undo is single-shot — NEVER
/// auto-retried); the plan re-enters the verified-batch pipeline, so a stale
/// undo rolls back honestly. A session mismatch refuses: undo is never
/// offered across reconnects, and the server-side check backs the frontend's
/// session stamp.
#[tauri::command]
pub async fn undo_apply(
    state: State<'_, AppState>,
    session_id: String,
    undo_id: i64,
) -> Result<crate::driver::postgres::edit::UndoOutcome> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    let peeked = state
        .appdb
        .undo_log_peek(undo_id)?
        .ok_or_else(|| driver::DriverError::Internal("undo offer expired — nothing to undo".into()))?;
    if peeked.session_key != session_id {
        return Err(driver::DriverError::Internal(
            "undo offer is stale — it belongs to a previous connection".into(),
        ));
    }
    let row = state
        .appdb
        .undo_log_take(undo_id)?
        .ok_or_else(|| driver::DriverError::Internal("undo offer expired — nothing to undo".into()))?;
    let plan: crate::driver::postgres::edit::UndoPlan = serde_json::from_str(&row.revert_sql)
        .map_err(|e| driver::DriverError::Internal(format!("undo record unreadable: {e}")))?;
    let (outcome, redo) = session.apply_revert(&plan).await?;
    if outcome.committed {
        if let Some(redo) = redo {
            // the undo commit writes its own undo row — redo emerges naturally
            if let Ok(json) = serde_json::to_string(&redo) {
                if let Err(e) = state.appdb.undo_log_add(
                    &row.profile_id,
                    &session_id,
                    &redo.description,
                    &json,
                ) {
                    eprintln!("appdb: redo-log write failed: {e}");
                }
            }
        }
    }
    Ok(outcome)
}

// ---- buffer time-machine (executed buffer versions per tab) ----------------

#[tauri::command]
pub async fn buffer_snapshot_add(
    state: State<'_, AppState>,
    tab_id: String,
    sql: String,
) -> Result<()> {
    state.appdb.buffer_snapshot_add(&tab_id, &sql)
}

#[tauri::command]
pub async fn buffer_snapshots_list(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Vec<crate::appdb::BufferSnapshot>> {
    let (rows, skipped) = state.appdb.buffer_snapshots_list(&tab_id)?;
    warn_skipped(&app, "buffer_snapshots", skipped);
    Ok(rows)
}

#[tauri::command]
pub async fn buffer_snapshots_clear(state: State<'_, AppState>, tab_id: String) -> Result<()> {
    state.appdb.buffer_snapshots_clear(&tab_id)
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
/// tier. Only ever run on explicit user action. The tier's contract is
/// "this session is dead, fresh one next run": whether or not the server-side
/// terminate landed, the local connection is hard-aborted so nothing keeps
/// draining, and on_close reports the death (session-closed → status dot).
#[tauri::command]
pub async fn terminate_backend(state: State<'_, AppState>, session_id: String) -> Result<()> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    let res = session.terminate_backend().await;
    session.abort_connection_notify("session terminated");
    res
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
