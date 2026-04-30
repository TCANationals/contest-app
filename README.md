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

## Local dev with Docker Compose

For end-to-end local development of the **server + SPA + Postgres**
stack you can use the compose file at the repo root:

```bash
docker compose up           # foreground; Ctrl+C to stop
docker compose up -d        # detached
docker compose logs -f server
docker compose down         # stop, keep the db volume
docker compose down -v      # also drop the postgres volume (full reset)
```

What it brings up:

| Service   | Image / source                          | Host port                | Notes                                           |
| :-------- | :-------------------------------------- | :----------------------- | :---------------------------------------------- |
| `db`      | `postgres:16-alpine`                    | `127.0.0.1:5432`         | Volume `tca_timer_pgdata`                        |
| `migrate` | `server/Dockerfile.dev`, one-shot       | n/a                      | Runs `npm run migrate` on first boot            |
| `server`  | `server/Dockerfile.dev`                 | `0.0.0.0:3000`           | `npm run dev` (`tsx watch`) with bind-mounted source so host edits hot-reload |
| `spa`     | `spa/Dockerfile.dev`                    | `0.0.0.0:5173`           | `vite --host` with bind-mounted source          |

The `desktop/` app is a native Tauri binary; it's not part of the
compose stack and is run from its own directory (`npm run tauri dev`).

The compose file is intentionally dev-only — bind mounts, watcher
processes, and a permissive Postgres password. Production server
deployment continues to go through Railway (`server/railway.json`).

## Component status

| Component | Lint | Test | Notes |
| --------- | ---- | ---- | ----- |
| server    | `tsc --noEmit` | `node --test` | Fastify + `ws` backend with timer/help-queue state machines, full wire protocol, CF Access JWT + ticket cache, bcrypt room tokens, Twilio + SES adapters with quiet-hours/auto-cancel dispatcher, `pg` DAL + SQL migrations, audit-log retention, clock-drift sampler. |
| spa       | `tsc -b --noEmit` | `vitest` | React app w/ routing + pages, `computeRemainingMs` helper, PWA plugin, CountdownWithBorder stub. |
| desktop   | `tsc -b --noEmit` + `cargo clippy` | `vitest` + `cargo test` | Vite+React overlay (§9.2 colors/borders, §6.3 time-sync, §9.5 preferences), Tauri 2 shell with tray menu + single-instance + config resolution (§9.4, default host `timer.tcanationals.com`), OS-agnostic local-socket IPC (`ipc-proto` + `ipc-server` + `ctl`). |
