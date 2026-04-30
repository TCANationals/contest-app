//! Shared IPC protocol between the TCA Timer desktop app and its
//! `tca-timer-ctl` shortcut helper (§9.6).
//!
//! The transport is an OS-local socket: a Unix domain socket on Linux/macOS
//! and a named pipe on Windows. Both are reached by name via the
//! `interprocess` crate's local-socket API, so no TCP port is used.
//!
//! Framing is **newline-delimited JSON**: each request is a single line of
//! UTF-8 JSON terminated by `\n`; each response is the same. Only one
//! request/response is exchanged per connection — the ctl helper opens the
//! socket, writes one line, reads one line, and exits.

#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
#[cfg(not(windows))]
use interprocess::local_socket::{GenericFilePath, ToFsName};

use serde::{Deserialize, Serialize};

/// Logical name used to connect to the desktop app's local IPC endpoint.
///
/// On Windows this is resolved to a named pipe at `\\.\pipe\tca-timer.sock`
/// via the `GenericNamespaced` namespace. On Unix it is resolved to a
/// filesystem-path Unix domain socket at `/tmp/tca-timer.sock` via the
/// `GenericFilePath` namespace.
pub const SOCKET_NAME: &str = "tca-timer.sock";

/// Resolve [`SOCKET_NAME`] to a platform-appropriate [`Name`].
///
/// Returns an owned [`Name<'static>`] so callers can pass it to
/// [`interprocess::local_socket::traits::Stream::connect`] /
/// [`interprocess::local_socket::traits::ListenerOptions::name`] without
/// worrying about borrow scope.
pub fn socket_name() -> std::io::Result<interprocess::local_socket::Name<'static>> {
    #[cfg(windows)]
    {
        SOCKET_NAME.to_ns_name::<GenericNamespaced>()
    }
    #[cfg(not(windows))]
    {
        // `/tmp/tca-timer.sock` — the desktop app owns this path. The CLI
        // helper only connects; it never creates or unlinks the file.
        let path = std::path::PathBuf::from("/tmp").join(SOCKET_NAME);
        path.to_fs_name::<GenericFilePath>()
    }
}

/// Commands the CLI helper can ask the desktop app to perform (§9.6.2).
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(tag = "type")]
pub enum Request {
    /// Send `HELP_REQUEST` if not already queued, otherwise store it
    /// locally and flush on reconnect.
    HelpRequest,
    /// Send `HELP_CANCEL` if currently queued.
    HelpCancel,
    /// Show the overlay window.
    TimerShow,
    /// Hide the overlay window.
    TimerHide,
    /// Toggle the overlay visibility.
    TimerToggle,
    /// Return a snapshot of the current timer / help / visibility state.
    Status,
}

/// Outcome of a request (§9.6.2).
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
#[serde(tag = "type")]
pub enum Response {
    HelpRequested { status: HelpRequestStatus },
    HelpCancelled { status: HelpCancelStatus },
    TimerVisibility { visible: bool },
    Status(StatusSnapshot),
    Error { code: String, message: String },
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum HelpRequestStatus {
    Requested,
    AlreadyPending,
    QueuedOffline,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum HelpCancelStatus {
    Cancelled,
    NotPending,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct StatusSnapshot {
    pub help_pending: bool,
    pub visible: bool,
    pub connected: bool,
}

/// Serialize a request as one line of JSON terminated by `\n`.
pub fn encode_request(req: &Request) -> Vec<u8> {
    let mut buf = serde_json::to_vec(req).expect("Request encoding never fails");
    buf.push(b'\n');
    buf
}

/// Serialize a response as one line of JSON terminated by `\n`.
pub fn encode_response(res: &Response) -> Vec<u8> {
    let mut buf = serde_json::to_vec(res).expect("Response encoding never fails");
    buf.push(b'\n');
    buf
}

pub fn decode_request(bytes: &[u8]) -> Result<Request, serde_json::Error> {
    serde_json::from_slice(trim_trailing_newline(bytes))
}

pub fn decode_response(bytes: &[u8]) -> Result<Response, serde_json::Error> {
    serde_json::from_slice(trim_trailing_newline(bytes))
}

fn trim_trailing_newline(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && (bytes[end - 1] == b'\n' || bytes[end - 1] == b'\r') {
        end -= 1;
    }
    &bytes[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip() {
        for req in [
            Request::HelpRequest,
            Request::HelpCancel,
            Request::TimerShow,
            Request::TimerHide,
            Request::TimerToggle,
            Request::Status,
        ] {
            let encoded = encode_request(&req);
            assert_eq!(*encoded.last().unwrap(), b'\n');
            let decoded = decode_request(&encoded).expect("decode ok");
            assert_eq!(decoded, req);
        }
    }

    #[test]
    fn response_round_trip() {
        let responses = [
            Response::HelpRequested {
                status: HelpRequestStatus::Requested,
            },
            Response::HelpRequested {
                status: HelpRequestStatus::AlreadyPending,
            },
            Response::HelpRequested {
                status: HelpRequestStatus::QueuedOffline,
            },
            Response::HelpCancelled {
                status: HelpCancelStatus::Cancelled,
            },
            Response::HelpCancelled {
                status: HelpCancelStatus::NotPending,
            },
            Response::TimerVisibility { visible: true },
            Response::Status(StatusSnapshot {
                help_pending: false,
                visible: true,
                connected: false,
            }),
            Response::Error {
                code: "not_implemented".into(),
                message: "placeholder".into(),
            },
        ];
        for res in responses {
            let encoded = encode_response(&res);
            let decoded = decode_response(&encoded).expect("decode ok");
            assert_eq!(decoded, res);
        }
    }

    #[test]
    fn socket_name_resolves_on_current_platform() {
        // Just ensure the resolver returns Ok on the host we build on; the
        // returned `Name` carries no user-visible identifier to compare to.
        let _ = socket_name().expect("socket name resolves");
    }
}
