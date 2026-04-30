//! Overlay state shared between the IPC handler, the tray menu, the
//! WebView (via Tauri events), and the WebSocket client.
//!
//! The state machine described here is small but important: the IPC
//! handler needs to know whether a help-call is already pending, whether
//! the socket is online, and how to make "Show Timer" / "Hide Timer" take
//! effect on the overlay window. Each concrete side-effect is injected as
//! a closure so the unit tests can exercise every code path without
//! spinning up Tauri.

use std::sync::{Arc, Mutex};

use tca_timer_ipc_proto::{HelpCancelStatus, HelpRequestStatus, StatusSnapshot};
use tca_timer_ipc_server::Handler;

/// Side-effects the IPC handler needs to perform. Injected as boxed
/// closures so Tauri-specific code lives in `main.rs` and the tests can
/// swap in spies.
pub struct Effects {
    /// Send a `HELP_REQUEST` frame immediately. Returns `true` if the
    /// frame was put on the wire. When the socket is down this MUST
    /// return `false` so the caller knows to queue offline.
    pub send_help_request: Box<dyn Fn() -> bool + Send + Sync>,
    /// Send a `HELP_CANCEL` frame. Returns whether the frame was written.
    pub send_help_cancel: Box<dyn Fn() -> bool + Send + Sync>,
    /// Apply a visibility change to the overlay window. `true` = visible.
    pub set_visible: Box<dyn Fn(bool) + Send + Sync>,
}

/// Minimal view of timer state the IPC surface exposes via `/status`.
#[derive(Debug, Clone, PartialEq)]
pub struct TimerSnapshot {
    pub status: &'static str,
    pub remaining_ms: Option<i64>,
}

impl Default for TimerSnapshot {
    fn default() -> Self {
        Self {
            status: "idle",
            remaining_ms: None,
        }
    }
}

/// Mutex-guarded overlay state. One instance per app. Cheap to clone
/// (Arc-wrapped internally).
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<Inner>>,
    effects: Arc<Effects>,
}

struct Inner {
    visible: bool,
    connected: bool,
    help_pending: bool,
    help_queued_offline: bool,
    #[allow(dead_code)]
    timer: TimerSnapshot,
}

impl AppState {
    pub fn new(initial_visible: bool, effects: Effects) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                visible: initial_visible,
                connected: false,
                help_pending: false,
                help_queued_offline: false,
                timer: TimerSnapshot::default(),
            })),
            effects: Arc::new(effects),
        }
    }

    pub fn set_connected(&self, connected: bool) {
        let mut g = self.inner.lock().expect("AppState poisoned");
        g.connected = connected;
        if connected
            && g.help_queued_offline
            && !g.help_pending
            && (self.effects.send_help_request)()
        {
            g.help_pending = true;
            g.help_queued_offline = false;
        }
    }

    pub fn mark_help_pending(&self, pending: bool) {
        let mut g = self.inner.lock().expect("AppState poisoned");
        g.help_pending = pending;
        if !pending {
            g.help_queued_offline = false;
        }
    }

    #[allow(dead_code)]
    pub fn set_timer(&self, snap: TimerSnapshot) {
        self.inner.lock().expect("AppState poisoned").timer = snap;
    }

    #[allow(dead_code)]
    pub fn visible(&self) -> bool {
        self.inner.lock().expect("AppState poisoned").visible
    }

    pub fn snapshot(&self) -> StatusSnapshot {
        let g = self.inner.lock().expect("AppState poisoned");
        StatusSnapshot {
            help_pending: g.help_pending || g.help_queued_offline,
            visible: g.visible,
            connected: g.connected,
        }
    }

    fn do_help_request(&self) -> HelpRequestStatus {
        let mut g = self.inner.lock().expect("AppState poisoned");
        if g.help_pending {
            return HelpRequestStatus::AlreadyPending;
        }
        if g.connected {
            drop(g);
            let sent = (self.effects.send_help_request)();
            let mut g = self.inner.lock().expect("AppState poisoned");
            if sent {
                g.help_pending = true;
                HelpRequestStatus::Requested
            } else {
                g.help_queued_offline = true;
                HelpRequestStatus::QueuedOffline
            }
        } else {
            g.help_queued_offline = true;
            HelpRequestStatus::QueuedOffline
        }
    }

    fn do_help_cancel(&self) -> HelpCancelStatus {
        let mut g = self.inner.lock().expect("AppState poisoned");
        let was_queued = g.help_queued_offline;
        let was_pending = g.help_pending;
        if !was_pending && !was_queued {
            return HelpCancelStatus::NotPending;
        }
        g.help_queued_offline = false;
        if was_pending {
            drop(g);
            let _ = (self.effects.send_help_cancel)();
            self.inner.lock().expect("AppState poisoned").help_pending = false;
        }
        HelpCancelStatus::Cancelled
    }

    fn do_set_visible(&self, visible: bool) -> bool {
        {
            let mut g = self.inner.lock().expect("AppState poisoned");
            g.visible = visible;
        }
        (self.effects.set_visible)(visible);
        visible
    }

    fn do_toggle(&self) -> bool {
        let new_visible = {
            let g = self.inner.lock().expect("AppState poisoned");
            !g.visible
        };
        self.do_set_visible(new_visible)
    }
}

impl Handler for AppState {
    fn help_request(&self) -> HelpRequestStatus {
        self.do_help_request()
    }
    fn help_cancel(&self) -> HelpCancelStatus {
        self.do_help_cancel()
    }
    fn timer_show(&self) -> bool {
        self.do_set_visible(true)
    }
    fn timer_hide(&self) -> bool {
        self.do_set_visible(false)
    }
    fn timer_toggle(&self) -> bool {
        self.do_toggle()
    }
    fn status(&self) -> StatusSnapshot {
        self.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct Spy {
        help_requests: AtomicUsize,
        help_cancels: AtomicUsize,
        last_visible: Mutex<Option<bool>>,
        send_ok: AtomicBool,
    }

    impl Spy {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                help_requests: AtomicUsize::new(0),
                help_cancels: AtomicUsize::new(0),
                last_visible: Mutex::new(None),
                send_ok: AtomicBool::new(true),
            })
        }
    }

    fn state_with(spy: &Arc<Spy>) -> AppState {
        let s1 = spy.clone();
        let s2 = spy.clone();
        let s3 = spy.clone();
        AppState::new(
            true,
            Effects {
                send_help_request: Box::new(move || {
                    s1.help_requests.fetch_add(1, Ordering::SeqCst);
                    s1.send_ok.load(Ordering::SeqCst)
                }),
                send_help_cancel: Box::new(move || {
                    s2.help_cancels.fetch_add(1, Ordering::SeqCst);
                    s2.send_ok.load(Ordering::SeqCst)
                }),
                set_visible: Box::new(move |v| {
                    *s3.last_visible.lock().unwrap() = Some(v);
                }),
            },
        )
    }

    #[test]
    fn help_request_while_offline_is_queued_and_flushed_on_reconnect() {
        let spy = Spy::new();
        let state = state_with(&spy);
        assert!(matches!(
            state.help_request(),
            HelpRequestStatus::QueuedOffline
        ));
        assert_eq!(spy.help_requests.load(Ordering::SeqCst), 0);
        assert!(state.snapshot().help_pending);

        state.set_connected(true);
        assert_eq!(spy.help_requests.load(Ordering::SeqCst), 1);
        assert!(state.snapshot().help_pending);
    }

    #[test]
    fn help_request_while_online_sends_immediately() {
        let spy = Spy::new();
        let state = state_with(&spy);
        state.set_connected(true);
        assert!(matches!(state.help_request(), HelpRequestStatus::Requested));
        assert_eq!(spy.help_requests.load(Ordering::SeqCst), 1);

        assert!(matches!(
            state.help_request(),
            HelpRequestStatus::AlreadyPending
        ));
        assert_eq!(
            spy.help_requests.load(Ordering::SeqCst),
            1,
            "idempotent — no second send"
        );
    }

    #[test]
    fn help_cancel_is_noop_when_nothing_pending() {
        let spy = Spy::new();
        let state = state_with(&spy);
        assert!(matches!(
            state.help_cancel(),
            HelpCancelStatus::NotPending
        ));
        assert_eq!(spy.help_cancels.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn help_cancel_drains_offline_queue_without_send() {
        let spy = Spy::new();
        let state = state_with(&spy);
        state.help_request();
        assert!(matches!(state.help_cancel(), HelpCancelStatus::Cancelled));
        assert_eq!(
            spy.help_cancels.load(Ordering::SeqCst),
            0,
            "offline-only cancel never hits the wire"
        );
        assert!(!state.snapshot().help_pending);

        state.set_connected(true);
        assert_eq!(
            spy.help_requests.load(Ordering::SeqCst),
            0,
            "cancelled before connect so nothing is sent on reconnect"
        );
    }

    #[test]
    fn visibility_toggle_round_trips() {
        let spy = Spy::new();
        let state = state_with(&spy);

        state.timer_hide();
        assert_eq!(*spy.last_visible.lock().unwrap(), Some(false));
        assert!(!state.snapshot().visible);

        assert!(state.timer_toggle());
        assert_eq!(*spy.last_visible.lock().unwrap(), Some(true));
        assert!(state.snapshot().visible);
    }
}
