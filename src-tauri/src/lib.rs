mod appdb;
mod commands;
pub mod driver;
mod secrets;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let appdb = appdb::AppDb::open(&dir)
                .map_err(|e| format!("app db init failed: {e}"))?;
            app.manage(state::AppState::new(appdb));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profiles_list,
            commands::profile_save,
            commands::profile_delete,
            commands::connect,
            commands::disconnect,
            commands::execute,
            commands::execute_stream,
            commands::introspect,
            commands::editability,
            commands::edits_preview,
            commands::edits_apply,
            commands::cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
