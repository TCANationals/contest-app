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
    ipc_server.rs    Local HTTP control API (§9.6)
  Cargo.toml
  tauri.conf.json
ctl/                 tca-timer-ctl.exe — desktop-shortcut CLI helper (§9.6.3)
  src/main.rs
  Cargo.toml
```

## Commands (frontend only, no Rust required)

```bash
npm install
npm run lint       # tsc -b --noEmit
npm test           # vitest run
npm run dev        # vite
npm run build      # vite build
```

## Tauri build (requires Rust toolchain + Windows host)

```bash
npm run tauri build
```

The CI cross-builds the MSI artifact via `tauri-apps/tauri-action` (§9.1).
