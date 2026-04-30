# TCA Timer

Scaffolding for the TCA Timer & Help-Call System described in
[`TCA_Timer_Design_Spec.docx.md`](./TCA_Timer_Design_Spec.docx.md) (v2.1).

All business logic is currently **placeholder** — this repo provides the
three-component layout, CI workflows, and test harnesses that subsequent
work plugs into.

## Layout

```
tca-timer/
├── .github/workflows/   # server / spa / desktop CI (§14.1)
├── server/              # §11 — Node.js + Fastify + ws backend
├── spa/                 # §10 — React + Vite judge web app
└── desktop/             # §9  — Tauri 2 contestant overlay
```

Each subdirectory has its own README describing what has been stubbed and
the spec section(s) that still need to be implemented.

## Common commands

From each component directory:

```bash
npm install
npm run lint
npm test
npm run build
```

## Component status

| Component | Lint | Test | Notes |
| --------- | ---- | ---- | ----- |
| server    | `tsc --noEmit` | `node --test` | Fastify + `ws` backend with timer/help-queue state machines, full wire protocol, CF Access JWT + ticket cache, bcrypt room tokens, Twilio + SES adapters with quiet-hours/auto-cancel dispatcher, `pg` DAL + SQL migrations, audit-log retention, clock-drift sampler. |
| spa       | `tsc -b --noEmit` | `vitest` | React app w/ routing + pages, `computeRemainingMs` helper, PWA plugin, CountdownWithBorder stub. |
| desktop   | `tsc -b --noEmit` + `cargo clippy` | `vitest` + `cargo test` | Vite+React overlay, Tauri 2 config (stable Rust 1.95+ pinned via `rust-toolchain.toml`), OS-agnostic local-socket IPC (`ipc-proto` + `ipc-server` + `ctl`) with a real-socket loopback test. |
