mod ipc_server;

use tauri::{AppHandle, Manager};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();
            start_placeholder_services(app_handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TCA Timer desktop scaffold");
}

fn start_placeholder_services(app_handle: AppHandle) {
    let _window = app_handle.get_webview_window("main");
    ipc_server::start_local_control_api();
    // TODO(spec §9): configure non-interactive always-on-top window and WS client.
}
