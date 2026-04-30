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
//!
//! ## Per-user / per-session scoping
//!
//! Desktops in RDP / terminal-server environments routinely have multiple
//! interactive users logged into one host simultaneously. The ctl helper
//! MUST talk to **its own user's** app instance, never someone else's. The
//! socket name is therefore scoped so it is unique per interactive session:
//!
//! - **Windows:** named pipes live in a single machine-global namespace, so
//!   the pipe name itself includes the session name (`SESSIONNAME`, e.g.
//!   `Console`, `RDP-Tcp#0`) and the username (`USERNAME`). Windows ACLs on
//!   the pipe further limit access to the creating user.
//! - **Unix:** sockets are filesystem objects, so we place them under
//!   `$XDG_RUNTIME_DIR` when available (systemd creates that directory per
//!   user with mode `0700`). When it is missing we fall back to
//!   `/tmp/tca-timer-<user>/tca-timer.sock`, with the listener creating
//!   the subdirectory as `0700`.
//!
//! Both the server and the ctl helper compute the name with the same logic
//! against the same environment, so they always agree.

#[cfg(not(windows))]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};

use serde::{Deserialize, Serialize};

/// Base identifier for our socket. Session / user qualifiers are appended
/// by [`resolve_socket_name`] so RDP-style multi-user hosts get one
/// instance per logged-in user without collisions.
pub const SOCKET_BASENAME: &str = "tca-timer";

/// Compute the **name string** that will be used for the local socket on
/// this session, without resolving it into an `interprocess::Name`.
///
/// Exposed separately so the listener can use the parent directory to
/// enforce `0700` on Unix fallbacks, and so tests can compare names.
pub fn socket_name_string() -> String {
    compute_name_string(&EnvSource::live())
}

/// Resolve [`socket_name_string`] to a platform-appropriate
/// [`interprocess::local_socket::Name<'static>`].
pub fn socket_name() -> std::io::Result<interprocess::local_socket::Name<'static>> {
    let name = compute_name_string(&EnvSource::live());
    resolve_name(&name)
}

fn resolve_name(name: &str) -> std::io::Result<interprocess::local_socket::Name<'static>> {
    #[cfg(windows)]
    {
        name.to_owned().to_ns_name::<GenericNamespaced>()
    }
    #[cfg(not(windows))]
    {
        // Treat `name` as an absolute filesystem path on Unix. On Windows it
        // is the raw pipe basename.
        std::path::PathBuf::from(name).to_fs_name::<GenericFilePath>()
    }
}

/// Environment lookups, extracted so tests can inject deterministic values
/// without mutating the real process environment.
#[derive(Clone, Debug)]
struct EnvSource {
    /// `%SESSIONNAME%` — only meaningful on Windows, where named-pipe names
    /// must include it to distinguish RDP sessions.
    #[cfg_attr(not(windows), allow(dead_code))]
    session: Option<String>,
    /// `%USERNAME%` / `$USER`.
    user: Option<String>,
    /// `$XDG_RUNTIME_DIR` — only consulted on Unix.
    #[cfg_attr(windows, allow(dead_code))]
    xdg_runtime_dir: Option<String>,
}

impl EnvSource {
    fn live() -> Self {
        Self {
            session: std::env::var("SESSIONNAME").ok(),
            user: std::env::var("USERNAME")
                .ok()
                .or_else(|| std::env::var("USER").ok()),
            xdg_runtime_dir: std::env::var("XDG_RUNTIME_DIR").ok(),
        }
    }
}

#[cfg(windows)]
fn compute_name_string(env: &EnvSource) -> String {
    // Named-pipe name — must be valid as a pipe path component: no `\` or
    // null bytes. Sanitize aggressively to be safe.
    let session = sanitize(env.session.as_deref().unwrap_or("Console"));
    let user = sanitize(env.user.as_deref().unwrap_or("default"));
    format!("{SOCKET_BASENAME}-{session}-{user}.sock")
}

#[cfg(not(windows))]
fn compute_name_string(env: &EnvSource) -> String {
    // Prefer the per-user runtime directory that systemd creates with mode
    // 0700. This is the canonical home for user-scoped sockets on Linux.
    if let Some(dir) = env.xdg_runtime_dir.as_deref() {
        if !dir.is_empty() {
            return format!("{dir}/{SOCKET_BASENAME}.sock");
        }
    }
    // Fallback: /tmp/tca-timer-<user>/tca-timer.sock. The listener locks
    // this down to mode 0700 when it creates the subdirectory.
    let user = sanitize(env.user.as_deref().unwrap_or("default"));
    format!(
        "/tmp/{base}-{user}/{base}.sock",
        base = SOCKET_BASENAME,
        user = user
    )
}

/// Permit ASCII alphanumerics plus `_-.`; everything else becomes `_`.
fn sanitize(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// The parent directory the listener must create (with `0700` on Unix)
/// before binding. Returns `None` if the socket's name is not a filesystem
/// path (Windows).
pub fn socket_parent_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        None
    }
    #[cfg(not(windows))]
    {
        std::path::Path::new(&socket_name_string())
            .parent()
            .map(std::path::Path::to_path_buf)
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

    fn env(session: Option<&str>, user: Option<&str>, xdg: Option<&str>) -> EnvSource {
        EnvSource {
            session: session.map(ToOwned::to_owned),
            user: user.map(ToOwned::to_owned),
            xdg_runtime_dir: xdg.map(ToOwned::to_owned),
        }
    }

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
        let _ = socket_name().expect("socket name resolves");
    }

    #[cfg(windows)]
    #[test]
    fn windows_names_are_unique_per_session_and_user() {
        let a = compute_name_string(&env(Some("Console"), Some("alice"), None));
        let b = compute_name_string(&env(Some("Console"), Some("bob"), None));
        let c = compute_name_string(&env(Some("RDP-Tcp#0"), Some("alice"), None));
        let d = compute_name_string(&env(Some("RDP-Tcp#1"), Some("alice"), None));
        assert_ne!(a, b, "different users must get distinct pipes");
        assert_ne!(a, c, "different sessions must get distinct pipes");
        assert_ne!(c, d, "different RDP sessions must get distinct pipes");
        assert!(a.contains("Console") && a.contains("alice"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_sanitizes_unsafe_chars() {
        let n = compute_name_string(&env(Some("RDP\\Tcp 0"), Some("ali\\ce"), None));
        assert!(!n.contains('\\'), "backslashes must be removed: {n}");
        assert!(!n.contains(' '), "spaces must be removed: {n}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_falls_back_when_env_missing() {
        let n = compute_name_string(&env(None, None, None));
        assert!(n.contains("Console") && n.contains("default"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_prefers_xdg_runtime_dir() {
        let a = compute_name_string(&env(None, Some("alice"), Some("/run/user/1000")));
        assert_eq!(a, "/run/user/1000/tca-timer.sock");
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_falls_back_per_user_under_tmp() {
        let a = compute_name_string(&env(None, Some("alice"), None));
        let b = compute_name_string(&env(None, Some("bob"), None));
        let c = compute_name_string(&env(None, Some("alice"), Some("")));
        assert_eq!(a, "/tmp/tca-timer-alice/tca-timer.sock");
        assert_ne!(a, b, "different users must get distinct paths");
        assert_eq!(c, a, "empty XDG_RUNTIME_DIR must be treated as absent");
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_fallback_matches_parent_dir() {
        let name = compute_name_string(&env(None, Some("alice"), None));
        let parent = std::path::Path::new(&name)
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(parent, "/tmp/tca-timer-alice");
    }
}
