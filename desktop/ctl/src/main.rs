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
//!   [`show_toast`]: "Timer is not running." and exits with code 2.
//! - Built as a Windows GUI subsystem binary so no console window flashes
//!   when launched from a desktop shortcut. To still get textual output
//!   when launched from cmd/PowerShell, we call
//!   [`AttachConsole(ATTACH_PARENT_PROCESS)`] at startup — if a parent
//!   console exists, stdout/stderr inherit it; otherwise the call is a
//!   harmless no-op and we keep the silent-GUI behavior.

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

/// Pre-formatted usage block. Kept as a single `const &str` so the
/// `--help` and "unknown command" branches print byte-identical text;
/// keeping them in lockstep means `parse_args` can stay the single
/// source of truth for the supported verbs.
const USAGE: &str = "\
timer-ctl — local control helper for the Timer desktop app.

USAGE:
    timer-ctl <command> [args]

COMMANDS:
    help request      Raise a help request for this contestant.
    help cancel       Cancel a pending help request.
    timer show        Show the timer overlay window.
    timer hide        Hide the timer overlay window.
    timer toggle      Toggle the timer overlay window.
    status            Print connection / visibility / help-pending state.

OPTIONS:
    -h, --help        Print this usage and exit.

EXIT CODES:
    0   Command succeeded.
    2   The Timer desktop app is not running on the local IPC socket.
    64  Unrecognised command. Run with --help for the supported verbs.
";

/// What `parse_args` decides to do with the argv it was given. Keeping
/// this as an enum (rather than just `Option<Request>` like before) lets
/// the help branch and the unknown-command branch share the same dispatch
/// site in `main`, which in turn makes both paths honor the
/// "console-attached → stdout, otherwise → toast" rule consistently.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Print the usage block and exit 0. Triggered by no args, `help`
    /// (with no sub-verb), `-h`, or `--help`.
    PrintHelp,
    /// Forward a request to the IPC server.
    Send(Request),
    /// Argv didn't match any known verb; the original argv is captured
    /// so the unknown-command message can echo it back.
    Unknown,
}

fn main() -> ExitCode {
    // Try to attach the parent console up-front so every later
    // `println!` / `eprintln!` reaches the shell that launched us. On
    // non-Windows this is always a no-op success; on Windows GUI builds
    // it succeeds when invoked from cmd/PowerShell and fails (silently)
    // when invoked from Explorer / a shortcut, which is exactly the
    // split we want.
    let has_console = console::attach();

    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Action::PrintHelp => {
            // Help only makes sense when there's somewhere for the text
            // to land. From a shortcut click, double-clicking the .exe,
            // or any other no-console launch, we deliberately stay
            // silent so we don't pop a toast saying "here's the CLI
            // help" — the user wasn't asking for that.
            if has_console {
                print!("{USAGE}");
                let _ = std::io::stdout().flush();
            }
            ExitCode::SUCCESS
        }
        Action::Unknown => {
            // The "no shell + bad argv" path is essentially unreachable
            // in normal use (shortcuts always pass a fixed verb), so
            // the toast there is just a debugging aid. The "shell + bad
            // argv" path is the one operators hit, and they get usage
            // on stderr just like any other CLI.
            if has_console {
                let argv = args.join(" ");
                eprintln!("timer-ctl: unknown command: {argv}\n");
                eprintln!("{USAGE}");
            } else {
                show_toast(
                    "Timer",
                    "Unknown command.\nUsage: timer-ctl help|timer|status ...",
                );
            }
            ExitCode::from(64)
        }
        Action::Send(req) => match send(&req) {
            Ok(res) => {
                let (title, body) = format_response(&req, &res);
                emit(has_console, title, &body, false);
                ExitCode::SUCCESS
            }
            Err(err) => {
                let body = format!("Timer is not running. ({err})");
                emit(has_console, "Timer", &body, true);
                ExitCode::from(2)
            }
        },
    }
}

fn parse_args(args: &[String]) -> Action {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        // No args, a bare `help`, or `-h`/`--help` → usage. `help` on
        // its own is intentionally treated as "show help" rather than
        // an unknown command, because that's what every shell user
        // will try first.
        [] | ["help"] | ["-h"] | ["--help"] => Action::PrintHelp,
        ["help", "request"] => Action::Send(Request::HelpRequest),
        ["help", "cancel"] => Action::Send(Request::HelpCancel),
        ["timer", "show"] => Action::Send(Request::TimerShow),
        ["timer", "hide"] => Action::Send(Request::TimerHide),
        ["timer", "toggle"] => Action::Send(Request::TimerToggle),
        ["status"] => Action::Send(Request::Status),
        _ => Action::Unknown,
    }
}

/// Print to the shell when we have one, otherwise raise a toast.
///
/// `is_error` decides between stdout and stderr (and, eventually, the
/// notification severity). All command results currently use stdout
/// because they're informational; only the "not running" branch goes
/// to stderr so it's redirectable independently of `2>&1` consumers.
fn emit(has_console: bool, title: &str, body: &str, is_error: bool) {
    if has_console {
        if is_error {
            eprintln!("{body}");
        } else {
            println!("{body}");
        }
    } else {
        show_toast(title, body);
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
            "Timer",
            match status {
                HelpRequestStatus::Requested => "Help requested.".to_string(),
                HelpRequestStatus::AlreadyPending => "Help is already pending.".to_string(),
                HelpRequestStatus::QueuedOffline => {
                    "Offline — help will be sent when reconnected.".to_string()
                }
            },
        ),
        (_, Response::HelpCancelled { status }) => (
            "Timer",
            match status {
                HelpCancelStatus::Cancelled => "Help request cancelled.".to_string(),
                HelpCancelStatus::NotPending => "No help request was pending.".to_string(),
            },
        ),
        (_, Response::TimerVisibility { visible }) => (
            "Timer",
            if *visible {
                "Timer shown.".to_string()
            } else {
                "Timer hidden.".to_string()
            },
        ),
        (_, Response::Status(s)) => (
            "Timer status",
            format!(
                "connected={} visible={} help_pending={}",
                s.connected, s.visible, s.help_pending
            ),
        ),
        (_, Response::Error { code, message }) => ("Timer", format!("Error {code}: {message}")),
    }
}

/// AppUserModelID under which Windows toasts from this binary are
/// surfaced. Must match the AUMID Tauri's NSIS installer assigns to
/// the desktop app's Start Menu shortcut (which it derives from
/// `bundle.identifier` in `tauri.conf.json`); using the same value
/// here means toasts from `timer-ctl` appear in the same
/// "Timer" channel as toasts from the main app — same icon,
/// same Action Center grouping. Override at runtime with
/// `TCA_TIMER_TOAST_AUMID=...` for dev / packaging variants.
#[cfg(windows)]
const TOAST_AUMID: &str = "com.tcanationals.timer";

/// Show a brief toast notification (§9.6.3).
///
/// On Windows this calls into the WinRT
/// `ToastNotificationManager` via the `tauri-winrt-notification`
/// crate; if the toast can't be displayed (no AUMID registration on a
/// non-installed dev build, locked-down system, very old Windows,
/// etc.) we fall back to `eprintln!` so the message isn't lost. On
/// non-Windows hosts the toast call is a plain `eprintln!` because
/// Linux/macOS dev hosts and CI are the only consumers there and a
/// real notification daemon is not worth a dependency.
fn show_toast(title: &str, body: &str) {
    #[cfg(windows)]
    {
        if try_windows_toast(title, body) {
            return;
        }
    }
    eprintln!("[{title}] {body}");
}

/// Best-effort WinRT toast. Returns `true` when the OS accepted the
/// toast for delivery; `false` for any failure so the caller can
/// fall back to stderr.
///
/// We deliberately swallow errors rather than propagating them: the
/// toast is an end-user nicety, not part of the IPC contract. A
/// failure here (typically: AUMID not registered because the binary
/// is being run outside the installed NSIS bundle) shouldn't change
/// the exit code or block the rest of `main`.
#[cfg(windows)]
fn try_windows_toast(title: &str, body: &str) -> bool {
    use tauri_winrt_notification::Toast;

    let aumid = std::env::var("TCA_TIMER_TOAST_AUMID").unwrap_or_else(|_| TOAST_AUMID.to_string());
    Toast::new(&aumid).title(title).text1(body).show().is_ok()
}

/// Console-attach shim. Cross-platform `attach()` returns `true` when
/// stdout/stderr are connected to a place a human will read from.
mod console {
    /// Attempt to attach to the parent process's console and rewire
    /// the standard handles so `println!` / `eprintln!` reach it.
    /// Returns `true` if both steps succeeded.
    ///
    /// ## Why two steps
    ///
    /// On a GUI-subsystem build the OS gives us NULL for `STD_OUTPUT_HANDLE`
    /// and `STD_ERROR_HANDLE` at startup, and `AttachConsole` does
    /// **not** reset them — it just associates a console with the
    /// process. Rust's `io::stdout()` calls `GetStdHandle` and writes
    /// to the result, so without an explicit `SetStdHandle` the
    /// process keeps writing into the void. The fix is the canonical
    /// "attach + open `CONOUT$` + redirect both std handles" dance
    /// (see <https://learn.microsoft.com/en-us/windows/console/attachconsole>).
    ///
    /// ## Why not `AllocConsole`
    ///
    /// `AllocConsole` would *create* a console window every time the
    /// binary runs, which is exactly the "no windows from a shortcut"
    /// behavior the user is trying to avoid. `AttachConsole(ATTACH_PARENT_PROCESS)`
    /// reuses the shell's existing console when there is one and
    /// returns FALSE (we treat it as "no console — stay silent")
    /// when there isn't.
    #[cfg(windows)]
    pub fn attach() -> bool {
        use std::fs::OpenOptions;
        use std::os::windows::io::IntoRawHandle;
        use windows_sys::Win32::System::Console::{
            AttachConsole, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
        };

        // SAFETY: `AttachConsole` is a Win32 FFI call with no Rust-
        // side invariants. A non-zero return means a parent console
        // is now associated with this process.
        if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
            return false;
        }

        // `CONOUT$` is the well-known device name for the attached
        // console's screen buffer. Opening it read+write is what the
        // C runtime (and every working sample of this idiom) does;
        // read access is required for some console-mode IOCTLs even
        // though we only ever write here.
        let Ok(conout) = OpenOptions::new().read(true).write(true).open("CONOUT$") else {
            return false;
        };

        // Transfer ownership of the OS handle out of the `File`. The
        // process needs the handle to stay open for as long as it
        // might call `println!`, which in this binary means "for the
        // rest of main". Letting the `File` drop would close it and
        // the very next write would silently fail. The handle is
        // intentionally leaked: the process is short-lived enough
        // (≤500 ms per §9.6.3) that bookkeeping a single FD is not
        // worth the complexity.
        let raw = conout.into_raw_handle();

        // SAFETY: `raw` is a valid kernel handle to CONOUT$ that we
        // just took ownership of via `into_raw_handle`. Both
        // `STD_OUTPUT_HANDLE` and `STD_ERROR_HANDLE` are documented
        // as accepting any writable handle. Using the same underlying
        // handle for both is the standard pattern (the C runtime does
        // the same with `freopen` against `CONOUT$`).
        unsafe {
            SetStdHandle(STD_OUTPUT_HANDLE, raw as _);
            SetStdHandle(STD_ERROR_HANDLE, raw as _);
        }

        // Print a leading newline so the first real line of output
        // doesn't end up glued to the shell prompt that's already on
        // the current row. Best-effort — failing here only affects
        // visual polish.
        println!();

        true
    }

    /// Non-Windows targets always have a real stdio set up by the
    /// shell (or a working `eprintln!` for daemon contexts), so the
    /// "do we have a console?" question is trivially `true`. Keeping
    /// this stub means the call site in `main` doesn't have to gate
    /// every interaction on `cfg(windows)`.
    #[cfg(not(windows))]
    pub fn attach() -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(argv: &[&str]) -> Action {
        let owned: Vec<String> = argv.iter().map(|s| (*s).to_string()).collect();
        parse_args(&owned)
    }

    #[test]
    fn no_args_prints_help() {
        assert_eq!(parse(&[]), Action::PrintHelp);
    }

    #[test]
    fn help_flag_prints_help() {
        assert_eq!(parse(&["-h"]), Action::PrintHelp);
        assert_eq!(parse(&["--help"]), Action::PrintHelp);
    }

    #[test]
    fn bare_help_prints_help_not_unknown() {
        // Regression: `tca-timer-ctl help` (a single arg) used to fall
        // through to the "Unknown command" toast because `parse_args`
        // only matched the two-token forms. Now it prints usage like
        // every other CLI.
        assert_eq!(parse(&["help"]), Action::PrintHelp);
    }

    #[test]
    fn known_verbs_dispatch_to_send() {
        assert_eq!(
            parse(&["help", "request"]),
            Action::Send(Request::HelpRequest)
        );
        assert_eq!(
            parse(&["help", "cancel"]),
            Action::Send(Request::HelpCancel)
        );
        assert_eq!(parse(&["timer", "show"]), Action::Send(Request::TimerShow));
        assert_eq!(parse(&["timer", "hide"]), Action::Send(Request::TimerHide));
        assert_eq!(
            parse(&["timer", "toggle"]),
            Action::Send(Request::TimerToggle)
        );
        assert_eq!(parse(&["status"]), Action::Send(Request::Status));
    }

    #[test]
    fn unknown_verbs_return_unknown() {
        assert_eq!(parse(&["bogus"]), Action::Unknown);
        assert_eq!(parse(&["timer", "explode"]), Action::Unknown);
        assert_eq!(parse(&["help", "request", "extra"]), Action::Unknown);
    }
}
