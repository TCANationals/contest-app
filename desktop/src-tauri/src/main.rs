#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_state;
mod config;
mod ipc_server;
mod preferences;

use std::sync::Arc;

use app_state::{AppState, Effects};
use config::{resolve, ConfigError, ConfigReport, ConfigSources, DesktopConfig};
use preferences::{load_from_path, write_atomic, Corner, LoadAction, Preferences};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, RunEvent, WindowEvent,
};
use tca_timer_ipc_server::Handler;

const OVERLAY_LABEL: &str = "overlay";
const EDGE_MARGIN: f64 = 24.0;

/// Everything bootstrap() gathers before Tauri starts. Pulled out so the
/// entire resolution is unit-testable in `config::` / `preferences::`.
struct Bootstrap {
    config: Option<DesktopConfig>,
    report: ConfigReport,
    config_error: Option<ConfigError>,
    prefs: Preferences,
    prefs_action: LoadAction,
    prefs_path: Option<std::path::PathBuf>,
}

fn bootstrap() -> Bootstrap {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let sources = ConfigSources::live(&argv);
    let (cfg, report, cfg_err) = match resolve(&sources) {
        Ok((c, r)) => (Some(c), r, None),
        Err(err) => (None, err.report.clone(), Some(err)),
    };

    let prefs_path = preferences::default_preferences_path();
    let outcome = match prefs_path.as_deref() {
        Some(p) => load_from_path(p),
        None => preferences::LoadOutcome {
            preferences: Preferences::default(),
            action: LoadAction::FallbackMalformed {
                reason: "no home directory".to_string(),
            },
        },
    };

    if let (Some(p), LoadAction::CreatedDefaults | LoadAction::Migrated { .. }) =
        (prefs_path.as_deref(), &outcome.action)
    {
        if let Err(err) = write_atomic(p, &outcome.preferences) {
            eprintln!(
                "tca-timer: failed to write preferences to {}: {err}",
                p.display()
            );
        }
    }

    Bootstrap {
        config: cfg,
        report,
        config_error: cfg_err,
        prefs: outcome.preferences,
        prefs_action: outcome.action,
        prefs_path,
    }
}

/// Payload delivered to the frontend at launch.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    config: Option<DesktopConfig>,
    config_error: Option<ConfigErrorPayload>,
    report: ConfigReport,
    preferences: Preferences,
    contestant_id: String,
    default_server_host: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConfigErrorPayload {
    missing: Vec<&'static str>,
    message: String,
}

impl From<&ConfigError> for ConfigErrorPayload {
    fn from(err: &ConfigError) -> Self {
        Self {
            missing: err.missing.clone(),
            message: err.to_string(),
        }
    }
}

/// Best-effort OS username, normalized per §3.1.
fn contestant_id() -> String {
    let raw = std::env::var("USERNAME")
        .ok()
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default();
    let lowered = raw.to_ascii_lowercase();
    lowered
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(32)
        .collect()
}

struct ManagedBootstrap(Mutex<Bootstrap>);

#[tauri::command]
fn get_bootstrap(state: tauri::State<'_, ManagedBootstrap>) -> BootstrapPayload {
    let b = state.0.lock().expect("bootstrap mutex poisoned");
    BootstrapPayload {
        config: b.config.clone(),
        config_error: b.config_error.as_ref().map(ConfigErrorPayload::from),
        report: b.report.clone(),
        preferences: b.prefs.clone(),
        contestant_id: contestant_id(),
        default_server_host: config::DEFAULT_SERVER_HOST,
    }
}

#[tauri::command]
fn save_preferences(
    prefs: Preferences,
    state: tauri::State<'_, ManagedBootstrap>,
) -> Result<(), String> {
    let mut b = state.0.lock().map_err(|e| e.to_string())?;
    let mut normalized = prefs;
    normalized.normalize();
    if let Some(p) = b.prefs_path.as_deref() {
        write_atomic(p, &normalized).map_err(|e| e.to_string())?;
    }
    b.prefs = normalized;
    Ok(())
}

/// Apply `corner` to the overlay window, placing it `EDGE_MARGIN` from the
/// work-area edges of its current monitor.
fn apply_corner(app: &AppHandle, corner: Corner) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let m_size = monitor.size();
    let margin_px = EDGE_MARGIN * scale;

    let win_w = size.width as f64;
    let win_h = size.height as f64;
    let mon_w = m_size.width as f64;
    let mon_h = m_size.height as f64;
    let mon_x = pos.x as f64;
    let mon_y = pos.y as f64;

    let (x, y) = match corner {
        Corner::TopLeft => (mon_x + margin_px, mon_y + margin_px),
        Corner::TopRight => (mon_x + mon_w - win_w - margin_px, mon_y + margin_px),
        Corner::BottomLeft => (mon_x + margin_px, mon_y + mon_h - win_h - margin_px),
        Corner::BottomRight => (
            mon_x + mon_w - win_w - margin_px,
            mon_y + mon_h - win_h - margin_px,
        ),
    };

    let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
}

fn apply_visibility(app: &AppHandle, visible: bool) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        if visible {
            let _ = w.show();
        } else {
            let _ = w.hide();
        }
    }
}

/// Shared current-corner state. Written whenever the tray menu reposition
/// option is used; read by the scale-factor handler so multi-monitor /
/// DPI-change events re-pin to the user's latest choice (§9.2).
pub type CurrentCorner = Arc<Mutex<Corner>>;

fn build_tray(
    app: &AppHandle,
    current_corner: CurrentCorner,
    state: AppState,
) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let pos_tl = MenuItem::with_id(app, "pos-tl", "Top left", true, None::<&str>)?;
    let pos_tr = MenuItem::with_id(app, "pos-tr", "Top right", true, None::<&str>)?;
    let pos_bl = MenuItem::with_id(app, "pos-bl", "Bottom left", true, None::<&str>)?;
    let pos_br = MenuItem::with_id(app, "pos-br", "Bottom right", true, None::<&str>)?;
    let position = Submenu::with_id_and_items(
        app,
        "position",
        "Position",
        true,
        &[&pos_tl, &pos_tr, &pos_bl, &pos_br],
    )?;
    let prefs = MenuItem::with_id(app, "prefs", "Preferences\u{2026}", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    // Native menu toolkits (GTK on Linux, Cocoa on macOS) only allow a
    // menu item to appear at one position in a menu hierarchy, so each
    // separator needs its own instance.
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &hide, &position, &sep1, &prefs, &sep2, &quit])?;

    let app_for_tray = app.clone();
    let corner_for_tray = current_corner.clone();
    let state_for_tray = state.clone();
    let _tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("TCA Timer")
        .on_menu_event(move |_icon, event| {
            let id = event.id().0.as_str();
            let reposition = |c: Corner, label: &'static str| {
                apply_corner(&app_for_tray, c);
                *corner_for_tray
                    .lock()
                    .expect("current-corner mutex poisoned") = c;
                let _ = app_for_tray.emit("overlay:set-corner", label);
            };
            match id {
                // Route visibility through AppState so the IPC /status
                // handler and a follow-up tca-timer-ctl timer toggle
                // always see the tray's effect. The Handler impl on
                // AppState already applies the Tauri window show/hide
                // via its `set_visible` effect.
                "show" => {
                    let _ = state_for_tray.timer_show();
                }
                "hide" => {
                    let _ = state_for_tray.timer_hide();
                }
                "pos-tl" => reposition(Corner::TopLeft, "topLeft"),
                "pos-tr" => reposition(Corner::TopRight, "topRight"),
                "pos-bl" => reposition(Corner::BottomLeft, "bottomLeft"),
                "pos-br" => reposition(Corner::BottomRight, "bottomRight"),
                "prefs" => {
                    let _ = app_for_tray.emit("overlay:open-preferences", ());
                }
                "quit" => {
                    app_for_tray.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|_icon, _event: TrayIconEvent| {})
        .build(app)?;
    Ok(())
}

fn main() {
    let b = bootstrap();
    let initial_visible = !b.prefs.hidden;
    let current_corner: CurrentCorner = Arc::new(Mutex::new(b.prefs.position.corner));
    let prefs_action_log = format!("{:?}", b.prefs_action);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(ManagedBootstrap(Mutex::new(b)))
        .invoke_handler(tauri::generate_handler![get_bootstrap, save_preferences])
        .setup(move |app| {
            // On macOS the app is agent-mode: no Dock icon, no menu-bar
            // takeover — only the status-bar tray and the overlay window
            // itself. This mirrors the `skipTaskbar` behavior we get on
            // Windows for free. `set_activation_policy` is a no-op on
            // other platforms per the tauri docs, but it only exists when
            // compiling for macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();

            if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
                // §9.2: overlay MUST ignore ALL mouse events — purely visual.
                let _ = w.set_ignore_cursor_events(true);
            }

            if !initial_visible {
                apply_visibility(&handle, false);
            }

            apply_corner(
                &handle,
                *current_corner
                    .lock()
                    .expect("current-corner mutex poisoned"),
            );

            // Re-pin to whichever corner the user most recently chose
            // whenever the monitor setup changes (§9.2 "Multi-monitor").
            // Reading from the shared `CurrentCorner` means a tray
            // reposition made after launch survives later DPI / display
            // events.
            if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
                let handle_for_scale = handle.clone();
                let corner_for_scale = current_corner.clone();
                w.on_window_event(move |event| {
                    if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
                        let c = *corner_for_scale
                            .lock()
                            .expect("current-corner mutex poisoned");
                        apply_corner(&handle_for_scale, c);
                    }
                });
            }

            // Bridge IPC -> overlay state. The WebView owns the WS
            // connection, so IPC "send" effects translate to Tauri
            // events that the frontend subscribes to.
            let handle_req = handle.clone();
            let handle_cancel = handle.clone();
            let handle_vis = handle.clone();
            let state = AppState::new(
                initial_visible,
                Effects {
                    send_help_request: Box::new(move || {
                        handle_req.emit("overlay:send-help-request", ()).is_ok()
                    }),
                    send_help_cancel: Box::new(move || {
                        handle_cancel.emit("overlay:send-help-cancel", ()).is_ok()
                    }),
                    set_visible: Box::new(move |v| {
                        apply_visibility(&handle_vis, v);
                        let _ = handle_vis.emit("overlay:set-visible", v);
                    }),
                },
            );
            let state_for_ipc = Arc::new(state.clone());
            ipc_server::run(state_for_ipc);

            // Tray menu is built after AppState so tray Show/Hide can
            // route through it — otherwise AppState.visible would
            // drift away from the real window state and /status would
            // lie.
            if let Err(err) = build_tray(&handle, current_corner.clone(), state.clone()) {
                eprintln!("tca-timer: tray init failed: {err}");
            }

            // Listen for overlay frontend status updates (§9.6.2 /status).
            // The frontend drives both signals authoritatively: it
            // knows when the WebSocket is actually open and when a
            // HELP_REQUEST / HELP_CANCEL frame made it onto the wire
            // (including the reconnect flush of an offline-queued
            // request). The Rust side just mirrors those transitions
            // so IPC /status reflects real wire state.
            let state_for_conn = state.clone();
            handle.listen("overlay:connection-changed", move |event| {
                let connected: bool = serde_json::from_str(event.payload()).unwrap_or(false);
                state_for_conn.set_connected(connected);
            });
            let state_for_pending = state.clone();
            handle.listen("overlay:help-pending-changed", move |event| {
                let pending: bool = serde_json::from_str(event.payload()).unwrap_or(false);
                state_for_pending.mark_help_pending(pending);
            });

            eprintln!("tca-timer: preferences {}", prefs_action_log);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // nothing to clean up beyond what Tauri does
            }
        });
}
