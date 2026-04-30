//! Thin Tauri-facing wrapper over `tca-timer-ipc-server`.
//!
//! All listener logic lives in the `tca-timer-ipc-server` crate so it can be
//! exercised by tests without the full Tauri toolchain. See `§9.6`.

use std::sync::Arc;

use tca_timer_ipc_server::{start, Handler};

pub fn run<H: Handler>(handler: Arc<H>) {
    start(handler);
}
