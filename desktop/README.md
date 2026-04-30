# TCA Timer — Desktop

Scaffolding for the contestant overlay described in `TCA_Timer_Design_Spec.docx.md` §9.

All business logic is currently a placeholder.

## Layout

```
src/                 Frontend (React + Vite) — display only
  main.tsx
  Overlay.tsx
  format.ts
src-tauri/           Rust host
  src/
    main.rs          Tauri shell + window setup (§9.2)
    ipc_server.rs    Local IPC listener (§9.6) — Unix domain socket /
                     Windows named pipe, via `interprocess`.
  Cargo.toml
  tauri.conf.json
ipc-proto/           Shared Request/Response + socket-name helper used by
                     both src-tauri and ctl. Newline-delimited JSON framing.
                     Socket name is scoped per interactive session so RDP /
                     terminal-server hosts with multiple simultaneous users
                     don't collide (see "Multi-user / RDP" below).
ctl/                 tca-timer-ctl.exe — desktop-shortcut CLI helper (§9.6.3)
  src/main.rs
  Cargo.toml
Cargo.toml           Rust workspace covering src-tauri, ipc-proto, and ctl.
```

## Commands (frontend only, no Rust required)

```bash
npm install
npm run lint       # tsc -b --noEmit
npm test           # vitest run
npm run dev        # vite
npm run build      # vite build
```

## Rust crates

The Rust side is organized as a Cargo workspace (`desktop/Cargo.toml`) with
a pinned toolchain in `desktop/rust-toolchain.toml` (latest stable — 1.95).
Stable is required because Tauri 2's transitive deps use `edition2024`.

```bash
# From desktop/
cargo test --workspace                       # All crates, incl. Tauri bin.
cargo clippy --workspace --all-targets -- -D warnings
```

The `ipc-server` tests include a real-socket loopback that spins up the
listener and drives it with a `ctl`-style client, so the OS-agnostic
transport is exercised end-to-end.

## Multi-user / RDP

Contestant VMs may run inside Remote Desktop Services or other
terminal-server environments where multiple users are logged into the
same machine at once. The IPC socket name is scoped per-session so the
`ctl` helper always talks to its own user's app instance:

- **Windows:** the named pipe name is
  `tca-timer-<SESSIONNAME>-<USERNAME>.sock` (e.g.
  `tca-timer-RDP-Tcp#0-alice.sock`). `SESSIONNAME` is `Console` for a
  local login and something like `RDP-Tcp#0` for RDP logins. Unsafe
  characters are sanitized to `_`.
- **Linux / macOS:** the socket is created under `$XDG_RUNTIME_DIR` when
  available (systemd provides that per-user, mode `0700`). If
  `XDG_RUNTIME_DIR` is missing the listener falls back to
  `/tmp/tca-timer-<user>/tca-timer.sock` and creates the parent
  directory itself with mode `0700` so only the owning user can reach it.

Both the listener in `ipc-server` and the client in `ctl` compute the
name with the same logic against the same environment, so they always
agree without any configuration.

## Linux system deps for Tauri

On Linux the Tauri crate needs the system libs below; the Desktop CI job
installs them automatically:

```bash
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
```

## Tauri build (requires Rust toolchain + Windows host)

```bash
npm run tauri build
```

The CI cross-builds the MSI artifact via `tauri-apps/tauri-action` (§9.1).
