//! End-to-end loopback test: start the real IPC listener (on a
//! platform-appropriate Unix domain socket / named pipe) and drive it with
//! a `ctl`-style client, exercising socket resolution, newline-delimited
//! JSON framing, and the dispatch path without needing Tauri.

use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use interprocess::local_socket::traits::{ListenerExt as _, Stream as _};
use interprocess::local_socket::Stream;

use tca_timer_ipc_proto::{
    decode_response, encode_request, socket_name, socket_parent_dir, HelpRequestStatus, Request,
    Response,
};
use tca_timer_ipc_server::{
    bind_listener, ensure_private_dir, handle_connection, PlaceholderHandler,
};

#[test]
fn ctl_and_server_can_talk_over_local_socket() {
    if let Some(dir) = socket_parent_dir() {
        ensure_private_dir(&dir).expect("prepare runtime dir");
    }

    let name = socket_name().expect("socket name resolves");
    let listener = bind_listener(name).expect("listener binds");

    let handler = Arc::new(PlaceholderHandler);
    let server_handler = handler.clone();
    let server = thread::spawn(move || {
        let incoming = listener.incoming().next().expect("one connection");
        let stream = incoming.expect("accept ok");
        handle_connection(&*server_handler, stream);
    });

    thread::sleep(Duration::from_millis(50));

    let name = socket_name().expect("client resolves name");
    let mut stream = Stream::connect(name).expect("client connects");
    stream
        .write_all(&encode_request(&Request::HelpRequest))
        .expect("client writes");
    stream.flush().expect("client flush");

    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line).expect("client reads");

    let res = decode_response(&line).expect("decode response");
    assert!(matches!(
        res,
        Response::HelpRequested {
            status: HelpRequestStatus::QueuedOffline
        }
    ));

    server.join().expect("server thread joined");
}

/// Regression test for the macOS/Linux "Address already in use" bug:
/// after an unclean shutdown the listener's socket file is left behind,
/// and `reclaim_name(true)` alone is not enough to recover on the next
/// launch — the bind fails with `EADDRINUSE` (errno 48 on macOS, errno
/// 98 on Linux) and `tca-timer-ctl` then sees "Connection refused"
/// because the file is on disk but nothing is listening.
///
/// `bind_listener` must transparently recover by deleting the stale
/// socket file and retrying. Skipped on Windows where named pipes don't
/// have a stale-file problem.
#[cfg(not(windows))]
#[test]
fn bind_listener_recovers_from_stale_socket_file() {
    use std::fs;
    use std::os::unix::net::UnixListener;

    if let Some(dir) = socket_parent_dir() {
        ensure_private_dir(&dir).expect("prepare runtime dir");
    }
    // Use an isolated path under the same parent dir so this test can
    // run alongside `ctl_and_server_can_talk_over_local_socket`
    // without contention.
    let parent = socket_parent_dir().expect("unix has a parent dir");
    let stale = parent.join("tca-timer-stale-test.sock");
    let _ = fs::remove_file(&stale);

    // Simulate an unclean shutdown: bind a UNIX socket, then drop the
    // listener WITHOUT unlinking the file — exactly what happens when
    // the desktop app is SIGKILL'd or crashes. `UnixListener` from std
    // doesn't auto-unlink on drop, so this leaves the file on disk
    // with no one listening on it (the same state that breaks
    // `tca-timer-ctl` in the wild).
    {
        let listener = UnixListener::bind(&stale).expect("first bind ok");
        drop(listener);
    }
    assert!(stale.exists(), "test fixture: stale socket file present");

    // Plain `ListenerOptions::new().reclaim_name(true)` would still
    // fail with EADDRINUSE here. `bind_listener` must succeed.
    let path_str = stale.to_string_lossy().into_owned();
    let name = {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        path_str
            .clone()
            .to_fs_name::<GenericFilePath>()
            .expect("fs name")
    };
    let listener = bind_listener(name).expect("recovers from stale socket");
    drop(listener);

    let _ = fs::remove_file(&stale);
}
