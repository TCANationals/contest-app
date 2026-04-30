#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc_server;

fn main() {
    // TODO(§9.6.1): start the local HTTP control API on 127.0.0.1:17380 before
    // the WebSocket connection to the backend.
    ipc_server::start_placeholder();

    tauri::Builder::default()
        .setup(|_app| {
            // TODO(§9.2): pin the overlay to the configured corner, make it
            // non-interactive (click-through), and wire system tray menu.
            // TODO(§9.3): acquire single-instance lock.
            // TODO(§9.4): resolve room + room token from CLI / registry /
            //   %PROGRAMDATA%\TCATimer\config.json / env.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
