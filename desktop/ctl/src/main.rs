#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! `tca-timer-ctl` — desktop-shortcut helper (§9.6.3).
//!
//! Usage:
//!
//! ```text
//! tca-timer-ctl help request
//! tca-timer-ctl help cancel
//! tca-timer-ctl timer show
//! tca-timer-ctl timer hide
//! tca-timer-ctl timer toggle
//! tca-timer-ctl status
//! ```
//!
//! Behavior:
//!
//! - Resolves the OS-local socket via [`tca_timer_ipc_proto::socket_name`]
//!   (Unix domain socket on Linux/macOS, named pipe on Windows — no TCP).
//! - Sends exactly one JSON request line, reads one JSON response line,
//!   exits in well under 500 ms total.
//! - On any connection failure surfaces a toast via
//!   [`show_toast`]: "TCA Timer is not running." and exits with code 2.
//! - Built as a Windows GUI subsystem binary so no console window flashes.

use std::io::{BufRead, BufReader, Write};
use std::process::ExitCode;
use std::time::Duration;

use interprocess::local_socket::traits::Stream as _;
use interprocess::local_socket::Stream;

use tca_timer_ipc_proto::{
    decode_response, encode_request, socket_name, HelpCancelStatus, HelpRequestStatus, Request,
    Response,
};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let req = match parse_args(&args) {
        Some(r) => r,
        None => {
            show_toast(
                "TCA Timer",
                "Unknown command.\nUsage: tca-timer-ctl help|timer|status ...",
            );
            return ExitCode::from(64);
        }
    };

    match send(&req) {
        Ok(res) => {
            let (title, body) = format_response(&req, &res);
            show_toast(title, &body);
            ExitCode::SUCCESS
        }
        Err(err) => {
            show_toast("TCA Timer", &format!("TCA Timer is not running. ({err})"));
            ExitCode::from(2)
        }
    }
}

fn parse_args(args: &[String]) -> Option<Request> {
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["help", "request"] => Some(Request::HelpRequest),
        ["help", "cancel"] => Some(Request::HelpCancel),
        ["timer", "show"] => Some(Request::TimerShow),
        ["timer", "hide"] => Some(Request::TimerHide),
        ["timer", "toggle"] => Some(Request::TimerToggle),
        ["status"] => Some(Request::Status),
        _ => None,
    }
}

fn send(req: &Request) -> std::io::Result<Response> {
    let name = socket_name()?;
    let mut stream = Stream::connect(name)?;
    // Best-effort timeouts — supported on both Unix domain sockets and Windows
    // named pipes. Ignore failure on platforms that do not support them.
    let _ = stream.set_recv_timeout(Some(CONNECT_TIMEOUT));
    let _ = stream.set_send_timeout(Some(CONNECT_TIMEOUT));

    stream.write_all(&encode_request(req))?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line)?;
    if line.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "empty response",
        ));
    }

    decode_response(&line).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn format_response(req: &Request, res: &Response) -> (&'static str, String) {
    match (req, res) {
        (_, Response::HelpRequested { status }) => (
            "TCA Timer",
            match status {
                HelpRequestStatus::Requested => "Help requested.".to_string(),
                HelpRequestStatus::AlreadyPending => "Help is already pending.".to_string(),
                HelpRequestStatus::QueuedOffline => {
                    "Offline — help will be sent when reconnected.".to_string()
                }
            },
        ),
        (_, Response::HelpCancelled { status }) => (
            "TCA Timer",
            match status {
                HelpCancelStatus::Cancelled => "Help request cancelled.".to_string(),
                HelpCancelStatus::NotPending => "No help request was pending.".to_string(),
            },
        ),
        (_, Response::TimerVisibility { visible }) => (
            "TCA Timer",
            if *visible {
                "Timer shown.".to_string()
            } else {
                "Timer hidden.".to_string()
            },
        ),
        (_, Response::Status(s)) => (
            "TCA Timer status",
            format!(
                "connected={} visible={} help_pending={}",
                s.connected, s.visible, s.help_pending
            ),
        ),
        (_, Response::Error { code, message }) => {
            ("TCA Timer", format!("Error {code}: {message}"))
        }
    }
}

/// Show a brief toast notification. Stubbed here; the real implementation
/// uses the OS notification API on Windows (§9.6.3). For Linux/macOS dev
/// hosts and for CI we fall back to stderr so there is no console window.
fn show_toast(title: &str, body: &str) {
    // TODO(§9.6.3): replace with a real Windows toast (e.g. `winrt-notification`
    // or `winrt-toast`) for the production Windows build.
    eprintln!("[{title}] {body}");
}
