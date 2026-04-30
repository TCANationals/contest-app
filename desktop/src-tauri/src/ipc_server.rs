//! Thin Tauri-facing wrapper over `tca-timer-ipc-server`.
//!
//! All listener logic lives in the `tca-timer-ipc-server` crate so it can be
//! exercised by tests without the full Tauri toolchain. See `§9.6`.

use std::sync::Arc;

use tca_timer_ipc_server::{start, PlaceholderHandler};

pub fn run() {
    // TODO(§9.6.2): replace `PlaceholderHandler` with one that forwards into
    // the real overlay state (Tauri window API for show/hide, WS client for
    // HELP_REQUEST / HELP_CANCEL with offline queueing).
    start(Arc::new(PlaceholderHandler));
}
