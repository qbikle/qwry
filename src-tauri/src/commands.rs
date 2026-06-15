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
}

#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> Result<Vec<Profile>> {
    state.appdb.list_profiles()
}

#[tauri::command]
pub fn profile_save(
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
pub fn profile_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.appdb.delete_profile(&id)?;
    secrets::delete_password(&id)
}

/// Drop a profile's cached SSH tunnel so the next connect rebuilds it against the
/// (possibly repointed) host. Frontend closes the profile's sessions separately;
/// this just discards the shared tunnel. No-op when the profile has none.
#[tauri::command]
pub fn invalidate_profile(state: State<'_, AppState>, profile_id: String) -> Result<()> {
    state.tunnels.lock().unwrap().remove(&profile_id);
    Ok(())
}

#[tauri::command]
pub fn set_profile_order(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    state.appdb.set_profile_order(&ids)
}

/// clone a profile onto a different database (the DB-switcher) — new id, same
/// host/creds (password carried over), name "<base> · <db>"
#[tauri::command]
pub fn clone_connection(
    state: State<'_, AppState>,
    src_profile_id: String,
    dbname: String,
) -> Result<Profile> {
    let src = state
        .appdb
        .list_profiles()?
        .into_iter()
        .find(|p| p.id == src_profile_id)
        .ok_or(driver::DriverError::Internal("no such profile".into()))?;
    let base = src.name.split(" · ").next().unwrap_or(&src.name).to_string();
    let mut p = src.clone();
    p.id = uuid::Uuid::new_v4().to_string();
    p.dbname = dbname.clone();
    p.name = format!("{base} · {dbname}");
    state.appdb.save_profile(&p)?;
    if let Ok(pw) = secrets::get_password(&src_profile_id) {
        let _ = secrets::set_password(&p.id, &pw);
    }
    Ok(p)
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<SessionId> {
    let profile = state
        .appdb
        .list_profiles()?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or(driver::DriverError::Internal("no such profile".into()))?;
    let password = secrets::get_password(&profile_id).unwrap_or_default();

    // session id up front so the death callback can name itself
    let session_id = uuid::Uuid::new_v4().to_string();
    let on_close: Box<dyn FnOnce() + Send> = {
        let app = app.clone();
        let payload = SessionClosed {
            session_id: session_id.clone(),
            profile_id: profile_id.clone(),
        };
        Box::new(move || {
            let _ = app.emit("session-closed", payload);
        })
    };

    // through an SSH tunnel when the profile has one, else direct
    let session = if crate::tunnel::tunnel_host(&profile).is_some() {
        let tunnel = state.ensure_tunnel(&profile).await?;
        driver::postgres::connect(&profile, &password, Some(("127.0.0.1", tunnel.local_port)), on_close).await?
    } else {
        driver::postgres::connect(&profile, &password, None, on_close).await?
    };
    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(session));
    Ok(session_id)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state.sessions.lock().unwrap().remove(&session_id);
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

#[tauri::command]
pub async fn introspect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::driver::postgres::introspect::SchemaSnapshot> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.introspect().await
}

#[tauri::command]
pub async fn editability(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
) -> Result<crate::driver::postgres::edit::EditabilityMap> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.editability(&sql, statement_index).await
}

#[tauri::command]
pub async fn edits_preview(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    edits: Vec<crate::driver::postgres::edit::RowEdit>,
) -> Result<Vec<String>> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session
        .build_edit_statements(&sql, statement_index, &edits)
        .await
}

#[tauri::command]
pub async fn edits_apply(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    edits: Vec<crate::driver::postgres::edit::RowEdit>,
) -> Result<crate::driver::postgres::edit::EditOutcome> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.apply_edits(&sql, statement_index, edits).await
}

#[tauri::command]
pub async fn delete_rows(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    statement_index: u32,
    table_oid: u32,
    rows: Vec<Vec<(u32, Option<String>)>>,
) -> Result<crate::driver::postgres::edit::EditOutcome> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session
        .delete_rows(&sql, statement_index, table_oid, rows)
        .await
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

#[tauri::command]
pub fn tabs_list(state: State<'_, AppState>) -> Result<Vec<crate::appdb::TabRow>> {
    state.appdb.tabs_list()
}

#[tauri::command]
pub fn tabs_save(state: State<'_, AppState>, tabs: Vec<crate::appdb::TabRow>) -> Result<()> {
    state.appdb.tabs_save(&tabs)
}

#[tauri::command]
pub fn history_add(
    state: State<'_, AppState>,
    profile_id: String,
    sql: String,
    ms: f64,
    rows: i64,
) -> Result<()> {
    state.appdb.history_add(&profile_id, &sql, ms, rows)
}

#[tauri::command]
pub fn history_search(
    state: State<'_, AppState>,
    profile_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<crate::appdb::HistoryRow>> {
    state
        .appdb
        .history_search(&profile_id, &query, limit.unwrap_or(100))
}

#[tauri::command]
pub fn history_recent(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<crate::appdb::HistoryRow>> {
    state.appdb.history_recent(limit.unwrap_or(8))
}

#[tauri::command]
pub fn saved_list(state: State<'_, AppState>) -> Result<Vec<crate::appdb::SavedQuery>> {
    state.appdb.saved_list()
}

#[tauri::command]
pub fn saved_upsert(state: State<'_, AppState>, q: crate::appdb::SavedQuery) -> Result<()> {
    state.appdb.saved_upsert(&q)
}

#[tauri::command]
pub fn saved_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.appdb.saved_delete(&id)
}

#[tauri::command]
pub fn history_clear(
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
