mod appdb;
mod commands;
pub mod driver;
mod secrets;
mod state;
mod tunnel;

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

            // macOS sidebar vibrancy. The window is transparent; only the
            // sidebar region is left translucent in CSS, so the NSVisualEffect
            // material shows there while content panels stay opaque.
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::FollowsWindowActiveState),
                        None,
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profiles_list,
            commands::profile_save,
            commands::profile_delete,
            commands::set_profile_order,
            commands::clone_connection,
            commands::connect,
            commands::disconnect,
            commands::execute,
            commands::execute_stream,
            commands::introspect,
            commands::editability,
            commands::edits_preview,
            commands::edits_apply,
            commands::delete_rows,
            commands::insert_row,
            commands::tabs_list,
            commands::tabs_save,
            commands::history_add,
            commands::history_search,
            commands::history_recent,
            commands::history_clear,
            commands::saved_list,
            commands::saved_upsert,
            commands::saved_delete,
            commands::cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
