//! Local IPC listener for the TCA Timer desktop app (§9.6).
//!
//! Lives in its own crate (not in `src-tauri`) so the listener logic can be
//! unit-tested without the full Tauri toolchain. The Tauri shell simply
//! calls [`start`] with a [`Handler`] that bridges into the overlay's state.
//!
//! Transport: `interprocess::local_socket::Stream` — a Unix domain socket
//! on Linux/macOS, a named pipe on Windows. No TCP port is exposed.
//!
//! Framing: newline-delimited JSON, one request and one response per
//! connection (see `tca-timer-ipc-proto`).

use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use std::thread;

use interprocess::local_socket::traits::ListenerExt as _;
use interprocess::local_socket::{ListenerOptions, Stream};

use tca_timer_ipc_proto::{
    decode_request, encode_response, socket_name, HelpCancelStatus, HelpRequestStatus, Request,
    Response, StatusSnapshot,
};

/// Bridges IPC commands to the overlay's state. The Tauri side implements
/// this in-process; tests implement it with a mock.
pub trait Handler: Send + Sync + 'static {
    fn help_request(&self) -> HelpRequestStatus;
    fn help_cancel(&self) -> HelpCancelStatus;
    fn timer_show(&self) -> bool;
    fn timer_hide(&self) -> bool;
    fn timer_toggle(&self) -> bool;
    fn status(&self) -> StatusSnapshot;
}

/// Handler used by the scaffolded Tauri build — returns placeholder data
/// for every command. Replace in production code with a handler that talks
/// to the real overlay state.
pub struct PlaceholderHandler;

impl Handler for PlaceholderHandler {
    fn help_request(&self) -> HelpRequestStatus {
        HelpRequestStatus::QueuedOffline
    }
    fn help_cancel(&self) -> HelpCancelStatus {
        HelpCancelStatus::NotPending
    }
    fn timer_show(&self) -> bool {
        true
    }
    fn timer_hide(&self) -> bool {
        false
    }
    fn timer_toggle(&self) -> bool {
        true
    }
    fn status(&self) -> StatusSnapshot {
        StatusSnapshot {
            help_pending: false,
            visible: true,
            connected: false,
        }
    }
}

/// Spawn the IPC listener on a background thread.
///
/// On failure the error is logged and the main app continues; the overlay
/// still renders the timer, it just cannot service shortcut commands until
/// restart.
pub fn start<H: Handler>(handler: Arc<H>) {
    thread::Builder::new()
        .name("tca-timer-ipc".into())
        .spawn(move || run(handler))
        .expect("failed to spawn IPC listener thread");
}

fn run<H: Handler>(handler: Arc<H>) {
    let name = match socket_name() {
        Ok(n) => n,
        Err(err) => {
            eprintln!("tca-timer-ipc: failed to resolve socket name: {err}");
            return;
        }
    };

    // `reclaim_name(true)` removes any stale socket file from a previous
    // unclean shutdown before binding (Unix only; no-op on Windows).
    let listener = match ListenerOptions::new()
        .name(name)
        .reclaim_name(true)
        .create_sync()
    {
        Ok(l) => l,
        Err(err) => {
            eprintln!("tca-timer-ipc: bind failed: {err}");
            return;
        }
    };

    for conn in listener.incoming() {
        match conn {
            Ok(stream) => handle_connection(&*handler, stream),
            Err(err) => eprintln!("tca-timer-ipc: accept failed: {err}"),
        }
    }
}

/// Public for testing: read one request from `stream`, dispatch via
/// `handler`, write one response back. Consumes the stream.
pub fn handle_connection<H: Handler + ?Sized>(handler: &H, stream: Stream) {
    let mut reader = BufReader::new(&stream);
    let mut line = Vec::new();
    if let Err(err) = reader.read_until(b'\n', &mut line) {
        eprintln!("tca-timer-ipc: read failed: {err}");
        return;
    }

    let response = match decode_request(&line) {
        Ok(req) => dispatch(handler, &req),
        Err(err) => Response::Error {
            code: "invalid_request".into(),
            message: err.to_string(),
        },
    };

    let mut writer = stream;
    if let Err(err) = writer.write_all(&encode_response(&response)) {
        eprintln!("tca-timer-ipc: write failed: {err}");
    }
    let _ = writer.flush();
}

/// Public for testing: pure function mapping a request to a response via
/// the handler. No I/O.
pub fn dispatch<H: Handler + ?Sized>(handler: &H, req: &Request) -> Response {
    match req {
        Request::HelpRequest => Response::HelpRequested {
            status: handler.help_request(),
        },
        Request::HelpCancel => Response::HelpCancelled {
            status: handler.help_cancel(),
        },
        Request::TimerShow => Response::TimerVisibility {
            visible: handler.timer_show(),
        },
        Request::TimerHide => Response::TimerVisibility {
            visible: handler.timer_hide(),
        },
        Request::TimerToggle => Response::TimerVisibility {
            visible: handler.timer_toggle(),
        },
        Request::Status => Response::Status(handler.status()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingHandler {
        help_requests: AtomicUsize,
    }

    impl Handler for CountingHandler {
        fn help_request(&self) -> HelpRequestStatus {
            self.help_requests.fetch_add(1, Ordering::SeqCst);
            HelpRequestStatus::Requested
        }
        fn help_cancel(&self) -> HelpCancelStatus {
            HelpCancelStatus::Cancelled
        }
        fn timer_show(&self) -> bool {
            true
        }
        fn timer_hide(&self) -> bool {
            false
        }
        fn timer_toggle(&self) -> bool {
            true
        }
        fn status(&self) -> StatusSnapshot {
            StatusSnapshot {
                help_pending: true,
                visible: false,
                connected: true,
            }
        }
    }

    #[test]
    fn dispatch_uses_handler_for_each_request_variant() {
        let handler = CountingHandler {
            help_requests: AtomicUsize::new(0),
        };

        assert!(matches!(
            dispatch(&handler, &Request::HelpRequest),
            Response::HelpRequested {
                status: HelpRequestStatus::Requested
            }
        ));
        assert_eq!(handler.help_requests.load(Ordering::SeqCst), 1);

        assert!(matches!(
            dispatch(&handler, &Request::HelpCancel),
            Response::HelpCancelled {
                status: HelpCancelStatus::Cancelled
            }
        ));
        assert!(matches!(
            dispatch(&handler, &Request::TimerShow),
            Response::TimerVisibility { visible: true }
        ));
        assert!(matches!(
            dispatch(&handler, &Request::TimerHide),
            Response::TimerVisibility { visible: false }
        ));
        assert!(matches!(
            dispatch(&handler, &Request::TimerToggle),
            Response::TimerVisibility { visible: true }
        ));
        let Response::Status(snap) = dispatch(&handler, &Request::Status) else {
            panic!("expected Status");
        };
        assert!(snap.connected);
        assert!(!snap.visible);
        assert!(snap.help_pending);
    }

    #[test]
    fn placeholder_handler_returns_documented_defaults() {
        let handler = PlaceholderHandler;
        assert!(matches!(
            dispatch(&handler, &Request::HelpRequest),
            Response::HelpRequested {
                status: HelpRequestStatus::QueuedOffline
            }
        ));
        assert!(matches!(
            dispatch(&handler, &Request::Status),
            Response::Status(StatusSnapshot {
                connected: false,
                ..
            })
        ));
    }
}
