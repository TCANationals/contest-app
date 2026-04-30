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

The Rust side is organized as a Cargo workspace so the IPC server and the
`ctl` helper can share a single protocol crate.

```bash
# From desktop/
cargo test -p tca-timer-ipc-proto            # Request/Response framing.
cargo test -p tca-timer-ipc-server           # Listener + dispatcher.
cargo test -p tca-timer-ctl                  # (currently compile-only)
```

The `ipc-server` tests include a real-socket loopback that spins up the
listener and drives it with a `ctl`-style client, so the OS-agnostic
transport is exercised end-to-end without Tauri.

## Tauri build (requires Rust toolchain + Windows host)

```bash
npm run tauri build
```

The CI cross-builds the MSI artifact via `tauri-apps/tauri-action` (§9.1).
