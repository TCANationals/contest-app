#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc_server;

fn main() {
    // §9.6.1: the local IPC server (OS-agnostic socket — Unix domain socket
    // on Linux/macOS, named pipe on Windows) MUST start before the backend
    // WebSocket so shortcut actions work while offline.
    ipc_server::run();

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
