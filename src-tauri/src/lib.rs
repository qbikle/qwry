mod appdb;
mod commands;
pub mod driver;
mod secrets;
mod state;
mod tunnel;

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

/// macOS 26 "Liquid Glass": mount an NSGlassEffectView beneath the (transparent)
/// webview. The class is resolved at RUNTIME — on older macOS this returns
/// false and the caller falls back to the NSVisualEffectView vibrancy path.
/// Must run on the main thread (Tauri's setup hook does).
#[cfg(target_os = "macos")]
fn apply_liquid_glass(window: &tauri::WebviewWindow) -> bool {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    use objc2::encode::{Encode, Encoding};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        w: f64,
        h: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    // objc2 needs type encodings to marshal struct returns/args over msg_send
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    // runtime lookup — class! would link-fail on older SDKs
    let Some(glass_cls) = objc2::runtime::AnyClass::get(c"NSGlassEffectView") else {
        return false;
    };
    let Ok(ns_window) = window.ns_window() else {
        return false;
    };
    unsafe {
        let win = ns_window as *mut AnyObject;
        let content: *mut AnyObject = msg_send![&*win, contentView];
        if content.is_null() {
            return false;
        }
        let bounds: CGRect = msg_send![&*content, bounds];
        let alloc: *mut AnyObject = msg_send![glass_cls, alloc];
        let glass: *mut AnyObject = msg_send![alloc, initWithFrame: bounds];
        if glass.is_null() {
            return false;
        }
        // NSViewWidthSizable | NSViewHeightSizable — track window resizes
        let _: () = msg_send![&*glass, setAutoresizingMask: 18usize];
        // beneath every sibling (the webview stays on top, transparent)
        let below: isize = -1; // NSWindowBelow
        let nil: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![&*content, addSubview: &*glass, positioned: below, relativeTo: nil];
        // suppress the unused warning path on non-glass builds
        let _ = class!(NSObject);
    }
    true
}

/// Build the native menu bar. Owning the menu (instead of Tauri's default)
/// gives real About/Settings entries, discoverable shortcuts, kills the
/// default File ▸ Close Window ⌘W foot-gun, and routes Quit through the
/// frontend's unsaved-work guard instead of exiting directly. Custom items
/// emit a "menu" event with their id; the frontend dispatches.
fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, label);
        (if let Some(a) = accel { b.accelerator(a) } else { b }).build(app)
    };

    // first submenu = the application menu on macOS (label is replaced)
    let app_menu = SubmenuBuilder::new(app, "qwry")
        .about(Some(AboutMetadata {
            name: Some("qwry".into()),
            comments: Some("Fast, local Postgres client".into()),
            ..Default::default()
        }))
        .separator()
        .item(&item("settings", "Settings…", Some("Cmd+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        // custom Quit → frontend guard flow (flush + confirm on dirty edits);
        // the predefined item would exit without either
        .item(&item("quit", "Quit qwry", Some("Cmd+Q"))?)
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-tab", "New Tab", Some("Cmd+T"))?)
        .item(&item("new-connection", "New Connection…", None)?)
        .separator()
        .item(&item("close-tab", "Close Tab", Some("Cmd+W"))?)
        .item(&item("restore-tab", "Reopen Closed Tab", Some("Cmd+Shift+T"))?)
        .build()?;

    // predefined edit items keep native text-field behavior working
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let query = SubmenuBuilder::new(app, "Query")
        .item(&item("run", "Run Statement", Some("Cmd+Return"))?)
        .item(&item("run-all", "Run All", Some("Cmd+Shift+Return"))?)
        .item(&item("cancel", "Cancel Query", Some("Cmd+."))?)
        .item(&item("explain", "Explain", Some("Cmd+E"))?)
        .item(&item("format", "Format SQL", Some("Cmd+Shift+F"))?)
        .separator()
        .item(&item("commit", "Commit Staged Edits / Save Query", Some("Cmd+S"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("palette", "Command Palette", Some("Cmd+K"))?)
        .item(&item("inspector", "Toggle Inspector", Some("Cmd+I"))?)
        .item(&item("theme", "Theme…", None)?)
        .separator()
        .item(&item("history", "Query History", Some("Cmd+Y"))?)
        .item(&item("refresh-schema", "Refresh Schema", Some("Cmd+R"))?)
        .build()?;

    // deliberately NO Close Window item — ⌘W belongs to tab close
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("shortcuts", "Keyboard Shortcuts", Some("Cmd+Shift+/"))?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &query, &view, &window, &help])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // must be registered FIRST (plugins run in registration order): a
        // second launch focuses this instance and exits instead of racing it
        // for the shared appdb
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        // remembers window size/position across launches (saves on close/move)
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let appdb = match appdb::AppDb::open(&dir) {
                Ok(db) => db,
                Err(e) => {
                    // A refused appdb (e.g. written by a NEWER qwry, or an
                    // open/migrate failure) used to bubble into the builder's
                    // bare .expect — the app bounced and died with no
                    // explanation. Tell the user why, then exit cleanly.
                    // blocking_show must run OFF the main thread (it would
                    // deadlock the not-yet-started event loop), so the dialog
                    // is deferred to a thread and setup completes hidden.
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.hide();
                    }
                    // throwaway state keeps IPC well-defined while the dialog
                    // is up (the webview still loads and invokes commands)
                    let stub_dir =
                        std::env::temp_dir().join(format!("qwry-refused-{}", uuid::Uuid::new_v4()));
                    if let Ok(stub) = appdb::AppDb::open(&stub_dir) {
                        app.manage(state::AppState::new(stub));
                    }
                    let handle = app.handle().clone();
                    let message = e.to_string();
                    std::thread::spawn(move || {
                        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                        handle
                            .dialog()
                            .message(&message)
                            .title("qwry can't start")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                        handle.exit(1);
                    });
                    return Ok(());
                }
            };
            app.manage(state::AppState::new(appdb));

            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            app.on_menu_event(|handle, event| {
                // predefined items handle themselves; customs route to the UI
                let _ = handle.emit("menu", event.id().0.clone());
            });

            // Window material behind the transparent webview: macOS 26+
            // Liquid Glass (NSGlassEffectView, runtime-resolved) with the
            // classic NSVisualEffectView vibrancy as the fallback.
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                if let Some(window) = app.get_webview_window("main") {
                    if !apply_liquid_glass(&window) {
                        let _ = apply_vibrancy(
                            &window,
                            NSVisualEffectMaterial::Sidebar,
                            Some(NSVisualEffectState::FollowsWindowActiveState),
                            None,
                        );
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profiles_list,
            commands::profile_save,
            commands::profile_delete,
            commands::invalidate_profile,
            commands::set_profile_order,
            commands::clone_connection,
            commands::connection_uri,
            commands::connect,
            commands::test_connection,
            commands::write_text_file,
            commands::disconnect,
            commands::execute,
            commands::execute_stream,
            commands::introspect,
            commands::schema_cache_get,
            commands::table_ddl,
            commands::table_stats,
            commands::editability,
            commands::edits_preview,
            commands::edits_apply,
            commands::delete_rows,
            commands::fetch_cell,
            commands::session_info,
            commands::terminate_backend,
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
