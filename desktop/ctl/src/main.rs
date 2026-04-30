#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// tca-timer-ctl.exe — desktop-shortcut helper (§9.6.3).
//
// Usage:
//   tca-timer-ctl help request
//   tca-timer-ctl help cancel
//   tca-timer-ctl timer show
//   tca-timer-ctl timer hide
//
// Behavior:
//   - Single HTTP POST to http://127.0.0.1:17380/<path>.
//   - Brief Windows toast with the result.
//   - If main app not running: toast "TCA Timer is not running."
//   - Runtime < 500 ms.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let _path: Option<&'static str> = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["help", "request"] => Some("/help/request"),
        ["help", "cancel"] => Some("/help/cancel"),
        ["timer", "show"] => Some("/timer/show"),
        ["timer", "hide"] => Some("/timer/hide"),
        _ => None,
    };

    // TODO(§9.6.3): POST to 127.0.0.1:17380<path>, show a toast with the result.
}
