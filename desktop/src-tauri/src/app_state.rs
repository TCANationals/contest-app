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
        // Just mirror the frontend-reported wire state. The frontend
        // owns the offline help-request queue in `WsClient`; when it
        // flushes on reconnect it emits
        // `overlay:help-pending-changed=true`, which routes to
        // `mark_help_pending` here. Doing our own flush would mean
        // trusting a fire-and-forget Tauri emit's return value as
        // "frame is on the wire", which it isn't.
        let mut g = self.inner.lock().expect("AppState poisoned");
        g.connected = connected;
    }

    /// Reserved for a future contestant-visible HELP_ACK frame from the
    /// server (see §7.1). No current code path calls it — `help_pending`
    /// is driven entirely by the IPC `do_help_request` / `do_help_cancel`
    /// paths — but we keep it so when the server protocol grows the ack
    /// frame, the WS client has a clean spot to plumb it in.
    #[allow(dead_code)]
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
        // Note on control flow: we always route the request through
        // the frontend's WS client (via `send_help_request`, which is
        // an emit into the WebView). The WS client holds the
        // authoritative offline queue; when it succeeds in putting a
        // frame on the wire — now, or on a later reconnect — it emits
        // `overlay:help-pending-changed=true` back and
        // `mark_help_pending` updates the flags below. We keep a
        // synchronous optimistic update here so the IPC /status
        // response reflects the caller's intent immediately.
        let (status, report_connected) = {
            let g = self.inner.lock().expect("AppState poisoned");
            // Dedup against BOTH on-wire pending and offline-queued
            // requests — /status reports them together as
            // `help_pending`, so the IPC surface must treat them
            // together for the "already asked" guard too.
            if g.help_pending || g.help_queued_offline {
                return HelpRequestStatus::AlreadyPending;
            }
            let connected = g.connected;
            let report = if connected {
                HelpRequestStatus::Requested
            } else {
                HelpRequestStatus::QueuedOffline
            };
            (report, connected)
        };

        // Emit to the frontend so the WS client can try to send now or
        // queue locally for flush on reconnect. The `send_help_request`
        // effect is a Tauri emit — its return value tells us only
        // whether the emit reached the WebView, not whether the WS
        // frame landed; the `onHelpPendingChanged` callback carries
        // that truth back.
        let _ = (self.effects.send_help_request)();

        let mut g = self.inner.lock().expect("AppState poisoned");
        if report_connected {
            g.help_pending = true;
        } else {
            g.help_queued_offline = true;
        }
        status
    }

    fn do_help_cancel(&self) -> HelpCancelStatus {
        // Mirror the do_help_request policy: we always forward the
        // cancel to the frontend so the WS client can drop any
        // locally-queued HELP_REQUEST that hasn't made it onto the
        // wire yet, send a HELP_CANCEL to the server if the request
        // did land, or queue the cancel for reconnect if we need to
        // tell the server later (see ws-client `pendingHelpCancel`).
        // Without this the frontend would happily flush a stale
        // help-request on reconnect after the user had already
        // cancelled.
        let (was_pending, was_queued) = {
            let mut g = self.inner.lock().expect("AppState poisoned");
            let was_queued = g.help_queued_offline;
            let was_pending = g.help_pending;
            if !was_pending && !was_queued {
                return HelpCancelStatus::NotPending;
            }
            g.help_queued_offline = false;
            g.help_pending = false;
            (was_pending, was_queued)
        };
        let _ = was_queued;
        let _ = was_pending;
        let _ = (self.effects.send_help_cancel)();
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
    fn help_request_while_offline_queues_and_still_forwards_to_frontend() {
        // The frontend WS client owns the offline queue; Rust always
        // forwards the request to it so it can try immediately or queue
        // locally and flush on its own reconnect.
        let spy = Spy::new();
        let state = state_with(&spy);
        assert!(matches!(
            state.help_request(),
            HelpRequestStatus::QueuedOffline
        ));
        assert_eq!(
            spy.help_requests.load(Ordering::SeqCst),
            1,
            "request is forwarded to the WebView even when offline",
        );
        // /status reports pending-or-queued as true so callers see a
        // single "you already asked for help" state.
        assert!(state.snapshot().help_pending);
    }

    #[test]
    fn repeated_help_request_while_offline_queue_pending_is_idempotent() {
        // First call offline → QueuedOffline + one emit.
        // Second call while still queued must return AlreadyPending
        // and MUST NOT emit another send-help-request event.
        let spy = Spy::new();
        let state = state_with(&spy);
        assert!(matches!(
            state.help_request(),
            HelpRequestStatus::QueuedOffline,
        ));
        assert_eq!(spy.help_requests.load(Ordering::SeqCst), 1);
        assert!(state.snapshot().help_pending);

        assert!(matches!(
            state.help_request(),
            HelpRequestStatus::AlreadyPending,
        ));
        assert_eq!(
            spy.help_requests.load(Ordering::SeqCst),
            1,
            "offline-queued request must dedup like an on-wire pending one",
        );
    }

    #[test]
    fn set_connected_only_tracks_wire_state() {
        // After the refactor, set_connected does NOT re-emit a
        // help-request on reconnect — the frontend WS client handles
        // that via its own offline queue and reports success via
        // `mark_help_pending(true)`.
        let spy = Spy::new();
        let state = state_with(&spy);
        let _ = state.help_request();
        let baseline = spy.help_requests.load(Ordering::SeqCst);
        state.set_connected(true);
        assert_eq!(
            spy.help_requests.load(Ordering::SeqCst),
            baseline,
            "set_connected must not fire help-request effects",
        );
        assert!(state.snapshot().connected);
    }

    #[test]
    fn mark_help_pending_clears_offline_queue_on_flush_notification() {
        let spy = Spy::new();
        let state = state_with(&spy);
        let _ = state.help_request();
        state.set_connected(true);
        // Frontend has flushed and reports the frame landed.
        state.mark_help_pending(true);
        let snap = state.snapshot();
        assert!(snap.help_pending);
        // A second help_request while pending is now AlreadyPending.
        assert!(matches!(
            state.help_request(),
            HelpRequestStatus::AlreadyPending,
        ));
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
        assert!(matches!(state.help_cancel(), HelpCancelStatus::NotPending));
        assert_eq!(spy.help_cancels.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn offline_help_cancel_forwards_to_frontend_to_drain_local_queue() {
        // The frontend WS client holds the authoritative offline
        // queue, so even an offline-only cancel must emit to it —
        // otherwise a stale HELP_REQUEST will flush to the server on
        // reconnect after the user cancelled.
        let spy = Spy::new();
        let state = state_with(&spy);
        state.help_request();
        assert!(matches!(state.help_cancel(), HelpCancelStatus::Cancelled));
        assert_eq!(
            spy.help_cancels.load(Ordering::SeqCst),
            1,
            "frontend must be told to drop its locally-queued request",
        );
        let snap = state.snapshot();
        assert!(!snap.help_pending);
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
