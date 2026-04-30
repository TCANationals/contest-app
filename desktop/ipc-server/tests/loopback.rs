//! End-to-end loopback test: start the real IPC listener (on a
//! platform-appropriate Unix domain socket / named pipe) and drive it with
//! a `ctl`-style client, exercising socket resolution, newline-delimited
//! JSON framing, and the dispatch path without needing Tauri.

use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use interprocess::local_socket::traits::{ListenerExt as _, Stream as _};
use interprocess::local_socket::{ListenerOptions, Stream};

use tca_timer_ipc_proto::{
    decode_response, encode_request, socket_name, HelpRequestStatus, Request, Response,
};
use tca_timer_ipc_server::{handle_connection, PlaceholderHandler};

#[test]
fn ctl_and_server_can_talk_over_local_socket() {
    let name = socket_name().expect("socket name resolves");
    let listener = ListenerOptions::new()
        .name(name)
        .reclaim_name(true)
        .create_sync()
        .expect("listener binds");

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
