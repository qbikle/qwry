use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::driver::{self, ExecOutcome, Profile, QueryEvent, Result, SessionId};
use crate::secrets;
use crate::state::AppState;

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

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, profile_id: String) -> Result<SessionId> {
    let profile = state
        .appdb
        .list_profiles()?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or(driver::DriverError::Internal("no such profile".into()))?;
    let password = secrets::get_password(&profile_id).unwrap_or_default();

    let session = driver::postgres::connect(&profile, &password).await?;
    let session_id = uuid::Uuid::new_v4().to_string();
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
pub async fn cancel(state: State<'_, AppState>, session_id: String) -> Result<()> {
    let session = state
        .session(&session_id)
        .ok_or(driver::DriverError::NoSession)?;
    session.cancel().await
}
