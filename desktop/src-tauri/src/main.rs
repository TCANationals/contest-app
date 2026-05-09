#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_state;
mod config;
mod display_watch;
mod ipc_server;
mod preferences;

use std::sync::Arc;

use app_state::{AppState, Effects};
use config::{resolve, ConfigError, ConfigReport, ConfigSources, DesktopConfig};
use preferences::{
    load_from_path, write_atomic, Corner, FlashPrefs, LoadAction, Preferences,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, RunEvent, Theme, WindowEvent,
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
    app: AppHandle,
    state: tauri::State<'_, ManagedBootstrap>,
) -> Result<(), String> {
    let mut b = state.0.lock().map_err(|e| e.to_string())?;
    let mut normalized = prefs;
    normalized.normalize();
    if let Some(p) = b.prefs_path.as_deref() {
        write_atomic(p, &normalized).map_err(|e| e.to_string())?;
    }
    b.prefs = normalized.clone();
    let _ = app.emit("overlay:preferences-changed", normalized);
    Ok(())
}

/// Update in-memory preferences, write them to disk (§9.5), and notify
/// the overlay (`overlay:preferences-changed`). Tray and IPC paths use
/// this so corner / visibility / alarm / flash survive restart without the
/// frontend calling `save_preferences`.
fn persist_preferences(app: &AppHandle, patch: impl FnOnce(&mut Preferences)) {
    let snapshot = {
        let state = app.state::<ManagedBootstrap>();
        let mut guard = match state.0.lock() {
            Ok(g) => g,
            Err(e) => {
                eprintln!("tca-timer: bootstrap mutex poisoned, cannot save preferences: {e}");
                return;
            }
        };
        patch(&mut guard.prefs);
        guard.prefs.normalize();
        if let Some(p) = guard.prefs_path.as_deref() {
            if let Err(err) = write_atomic(p, &guard.prefs) {
                eprintln!(
                    "tca-timer: failed to write preferences to {}: {err}",
                    p.display()
                );
            }
        }
        guard.prefs.clone()
    };
    let _ = app.emit("overlay:preferences-changed", snapshot);
}

fn flash_row_selected(flash: &FlashPrefs, seconds: u32) -> bool {
    flash.enabled && flash.threshold_seconds == seconds
}

fn sync_flash_checkmarks(
    off: &CheckMenuItem<tauri::Wry>,
    m1: &CheckMenuItem<tauri::Wry>,
    m2: &CheckMenuItem<tauri::Wry>,
    m5: &CheckMenuItem<tauri::Wry>,
    flash: &FlashPrefs,
) {
    let _ = off.set_checked(!flash.enabled);
    let _ = m1.set_checked(flash_row_selected(flash, 60));
    let _ = m2.set_checked(flash_row_selected(flash, 120));
    let _ = m5.set_checked(flash_row_selected(flash, 300));
}

/// Handles for tray items that must stay alive for the menu (checkmarks
/// are updated from the menu event handler; other fields are kept so the
/// native items are not dropped).
#[allow(dead_code)]
struct TrayMenuControls {
    visibility: MenuItem<tauri::Wry>,
    tray: TrayIcon<tauri::Wry>,
    alarm: CheckMenuItem<tauri::Wry>,
    flash_off: CheckMenuItem<tauri::Wry>,
    flash_1: CheckMenuItem<tauri::Wry>,
    flash_2: CheckMenuItem<tauri::Wry>,
    flash_5: CheckMenuItem<tauri::Wry>,
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

/// Label shown on the visibility toggle menu item for a given overlay
/// visibility. Pulled out of `build_tray` so the main.rs
/// `overlay:set-visible` listener can reuse the exact same wording when
/// flipping the label after a visibility change from any source (tray,
/// IPC/ctl, or initial bootstrap).
fn visibility_menu_label(visible: bool) -> &'static str {
    if visible {
        "Hide"
    } else {
        "Show"
    }
}

/// Resolved system chrome theme for the overlay window (`Light` / `Dark`).
/// Falls back to dark so the legacy white-on-alpha tray glyph stays the
/// default when theme cannot be read.
fn resolved_tray_theme(app: &AppHandle) -> Theme {
    app.get_webview_window(OVERLAY_LABEL)
        .and_then(|w| w.theme().ok())
        .unwrap_or(Theme::Dark)
}

fn tray_image_for_theme(theme: Theme) -> tauri::image::Image<'static> {
    match theme {
        Theme::Dark => tauri::include_image!("icons/tray-dark.png"),
        Theme::Light => tauri::include_image!("icons/tray-light.png"),
        _ => tauri::include_image!("icons/tray-dark.png"),
    }
}

fn build_tray(
    app: &AppHandle,
    current_corner: CurrentCorner,
    state: AppState,
    initial_visible: bool,
    prefs: &Preferences,
) -> tauri::Result<TrayMenuControls> {
    // A single toggle item that flips between "Show" and "Hide" based on
    // the current overlay visibility. Displaying both at once (the old
    // behavior) is confusing — at any moment only one of the two actions
    // is meaningful.
    let visibility = MenuItem::with_id(
        app,
        "toggle-visibility",
        visibility_menu_label(initial_visible),
        true,
        None::<&str>,
    )?;
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

    let alarm = CheckMenuItem::with_id(
        app,
        "audio-alarm",
        "Audio Alarm",
        true,
        prefs.alarm.enabled,
        None::<&str>,
    )?;
    let flash_off = CheckMenuItem::with_id(
        app,
        "flash-off",
        "Off",
        true,
        !prefs.flash.enabled,
        None::<&str>,
    )?;
    let flash_1 = CheckMenuItem::with_id(
        app,
        "flash-1",
        "1 Minute Remaining",
        true,
        flash_row_selected(&prefs.flash, 60),
        None::<&str>,
    )?;
    let flash_2 = CheckMenuItem::with_id(
        app,
        "flash-2",
        "2 Minutes Remaining",
        true,
        flash_row_selected(&prefs.flash, 120),
        None::<&str>,
    )?;
    let flash_5 = CheckMenuItem::with_id(
        app,
        "flash-5",
        "5 Minutes Remaining",
        true,
        flash_row_selected(&prefs.flash, 300),
        None::<&str>,
    )?;
    let flash_menu = Submenu::with_id_and_items(
        app,
        "flash-submenu",
        "Flash",
        true,
        &[&flash_off, &flash_1, &flash_2, &flash_5],
    )?;

    // Native menu toolkits (GTK on Linux, Cocoa on macOS) only allow a
    // menu item to appear at one position in a menu hierarchy, so each
    // separator needs its own instance.
    let sep1 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&visibility, &position, &sep1, &alarm, &flash_menu],
    )?;

    let app_for_tray = app.clone();
    let corner_for_tray = current_corner.clone();
    let state_for_tray = state.clone();
    let alarm_for_tray = alarm.clone();
    let flash_off_tray = flash_off.clone();
    let flash_1_tray = flash_1.clone();
    let flash_2_tray = flash_2.clone();
    let flash_5_tray = flash_5.clone();
    let tray_theme = resolved_tray_theme(app);
    // Glyph-only stopwatch (transparent background). We ship separate PNGs
    // for light vs dark system chrome (`tray-light.png` / `tray-dark.png`)
    // and swap on `ThemeChanged`. Template mode is off so each asset is
    // shown as-authored (Windows/Linux tray and macOS menu bar).
    let tray_icon = TrayIconBuilder::with_id("main")
        .icon(tray_image_for_theme(tray_theme))
        .icon_as_template(false)
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
                persist_preferences(&app_for_tray, |prefs| {
                    prefs.position.corner = c;
                });
            };
            let sync_flash = || {
                if let Ok(g) = app_for_tray.state::<ManagedBootstrap>().0.lock() {
                    sync_flash_checkmarks(
                        &flash_off_tray,
                        &flash_1_tray,
                        &flash_2_tray,
                        &flash_5_tray,
                        &g.prefs.flash,
                    );
                }
            };
            match id {
                // Route visibility through AppState so the IPC /status
                // handler and a follow-up tca-timer-ctl timer toggle
                // always see the tray's effect. The Handler impl on
                // AppState already applies the Tauri window show/hide
                // via its `set_visible` effect, which also fires the
                // `overlay:set-visible` event we listen for in main.rs
                // to update this menu item's label.
                "toggle-visibility" => {
                    let _ = state_for_tray.timer_toggle();
                }
                "pos-tl" => reposition(Corner::TopLeft, "topLeft"),
                "pos-tr" => reposition(Corner::TopRight, "topRight"),
                "pos-bl" => reposition(Corner::BottomLeft, "bottomLeft"),
                "pos-br" => reposition(Corner::BottomRight, "bottomRight"),
                "audio-alarm" => {
                    persist_preferences(&app_for_tray, |p| {
                        p.alarm.enabled = !p.alarm.enabled;
                        p.alarm.volume = 1.0;
                    });
                    if let Ok(g) = app_for_tray.state::<ManagedBootstrap>().0.lock() {
                        let _ = alarm_for_tray.set_checked(g.prefs.alarm.enabled);
                    }
                }
                "flash-off" => {
                    persist_preferences(&app_for_tray, |p| {
                        p.flash.enabled = false;
                    });
                    sync_flash();
                }
                "flash-1" => {
                    persist_preferences(&app_for_tray, |p| {
                        p.flash.enabled = true;
                        p.flash.threshold_seconds = 60;
                    });
                    sync_flash();
                }
                "flash-2" => {
                    persist_preferences(&app_for_tray, |p| {
                        p.flash.enabled = true;
                        p.flash.threshold_seconds = 120;
                    });
                    sync_flash();
                }
                "flash-5" => {
                    persist_preferences(&app_for_tray, |p| {
                        p.flash.enabled = true;
                        p.flash.threshold_seconds = 300;
                    });
                    sync_flash();
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|_icon, _event: TrayIconEvent| {})
        .build(app)?;
    Ok(TrayMenuControls {
        visibility,
        tray: tray_icon,
        alarm,
        flash_off,
        flash_1: flash_1,
        flash_2: flash_2,
        flash_5: flash_5,
    })
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

            // Wire up the optional Windows-only display-change command
            // (e.g. BgInfo refresh — see `display_watch` module docs and
            // the legacy timer-desktop `index.js`). The watcher runs on
            // every platform but only spawns the configured command on
            // Windows. We start it before the `ScaleFactorChanged`
            // handler so the handler can trigger an immediate re-check
            // without waiting for the next 2 s poll.
            let display_watcher = {
                let argv = handle
                    .state::<ManagedBootstrap>()
                    .0
                    .lock()
                    .expect("bootstrap mutex poisoned")
                    .config
                    .as_ref()
                    .and_then(|c| c.display_change_command.clone());
                if let Some(ref cmd) = argv {
                    display_watch::run_startup(cmd);
                }
                argv.map(|argv| display_watch::start(handle.clone(), argv))
            };

            // Re-pin to whichever corner the user most recently chose
            // whenever the monitor setup changes (§9.2 "Multi-monitor").
            // Reading from the shared `CurrentCorner` means a tray
            // reposition made after launch survives later DPI / display
            // events. We also forward DPI events to the display watcher
            // so the configured command fires on the same tick the OS
            // tells us about a scale change, instead of up to 2 s
            // later. `ThemeChanged` + tray icon swap are registered after
            // `build_tray` (see below) so we hold a `TrayIcon` handle.

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
                        persist_preferences(&handle_vis, |prefs| {
                            prefs.hidden = !v;
                        });
                    }),
                },
            );
            let state_for_ipc = Arc::new(state.clone());
            ipc_server::run(state_for_ipc);

            // Tray menu is built after AppState so tray Show/Hide can
            // route through it — otherwise AppState.visible would
            // drift away from the real window state and /status would
            // lie.
            //
            // The tray holds a single toggle item whose label needs to
            // track the overlay's visibility (so it reads "Hide" while
            // visible and "Show" while hidden — never both at once).
            // `build_tray` returns the live `MenuItem` handle so we can
            // update the label whenever visibility changes from ANY
            // source: the tray item itself, the IPC /timer/show/hide/
            // toggle surface, or the initial-state logic above.
            let prefs_for_tray = handle
                .state::<ManagedBootstrap>()
                .0
                .lock()
                .expect("bootstrap mutex poisoned")
                .prefs
                .clone();
            let tray_controls = match build_tray(
                &handle,
                current_corner.clone(),
                state.clone(),
                initial_visible,
                &prefs_for_tray,
            ) {
                Ok(c) => Some(c),
                Err(err) => {
                    eprintln!("tca-timer: tray init failed: {err}");
                    None
                }
            };
            let tray_icon_opt = tray_controls.as_ref().map(|c| c.tray.clone());
            let visibility_item = tray_controls.map(|c| c.visibility);

            if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
                let handle_for_win = handle.clone();
                let corner_for_scale = current_corner.clone();
                let watcher_for_scale = display_watcher.clone();
                let tray_for_theme = tray_icon_opt.clone();
                w.on_window_event(move |event| {
                    match event {
                        WindowEvent::ScaleFactorChanged { .. } => {
                            let c = *corner_for_scale
                                .lock()
                                .expect("current-corner mutex poisoned");
                            apply_corner(&handle_for_win, c);
                            if let Some(w) = watcher_for_scale.as_ref() {
                                w.trigger(&handle_for_win);
                            }
                        }
                        WindowEvent::ThemeChanged(theme) => {
                            if let Some(tray) = tray_for_theme.as_ref() {
                                let _ = tray.set_icon(Some(tray_image_for_theme(*theme)));
                            }
                        }
                        _ => {}
                    }
                });
            }

            if let Some(item) = visibility_item {
                // `overlay:set-visible` is emitted by the `set_visible`
                // effect closure above — i.e. by every AppState path
                // that actually changes visibility (tray toggle, IPC
                // show/hide/toggle). Listening here means we update
                // the label exactly once per real visibility change.
                handle.listen("overlay:set-visible", move |event| {
                    let visible: bool = serde_json::from_str(event.payload()).unwrap_or(true);
                    if let Err(err) = item.set_text(visibility_menu_label(visible)) {
                        eprintln!("tca-timer: failed to update visibility menu label: {err}",);
                    }
                });
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
