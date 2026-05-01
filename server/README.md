# TCA Timer — Server

Backend for the TCA Timer & Help-Call System described in
[`../TCA_Timer_Design_Spec.docx.md`](../TCA_Timer_Design_Spec.docx.md) §11.

**Runtime**: Node.js 22 · Fastify 4 · `ws` 8 · Postgres 15+ · jose · bcrypt · Twilio · AWS SES v2.

## Commands

```bash
npm install
npm run lint      # tsc --noEmit
npm test          # node --test harness
npm run dev       # hot-reload via tsx
npm run build     # tsc → dist/
npm start         # node dist/index.js
npm run migrate   # run SQL files in src/db/migrations/ against $DATABASE_URL
```

## What is implemented

### Wire protocol (§5)

- `GET /judge?room=…&ticket=…` — WebSocket. Ticket-mint flow per §8.1: single-use, 30-second TTL, LRU-bounded.
- `GET /contestant?room=…&id=…&token=…` — WebSocket. Room regex + lowercased-username regex + bcrypt token compare.
- Frame handlers for every frame in §5.2 (`PING`/`PONG`, `STATE`, `HELP_QUEUE`, `ERROR`, all `TIMER_*`, `HELP_ACK`, `HELP_REQUEST`, `HELP_CANCEL`). `STATE` frames carry `connectedContestants` (for the SPA, §10.4) and `dbDegraded` (§11.5).
- Upgrades rejected with `1008` (or HTTP 429 at the router) before handshake completes when room/ticket/token are wrong or when the per-source-IP or per-room connection cap is reached.

### Timer state machine (§6.5)

- `applyTimerCommand(state, cmd, actor, now?)` in `src/timer.ts` implements every cell of the §6.5 transition table, with unit tests covering all 12 rows plus input-validation.
- `endsAtServerMs` is streamed, never "current remaining" — clients compute locally (§6.3).

### Help queue (§7)

- Idempotent `helpRequest` / `helpCancel`. `helpAck` compares caller-supplied queue version to prevent double-ack (§7.2 first-judge-wins).
- Entries are sorted by `requestedAtServerMs` and station numbers are looked up from `station_assignments` on enqueue (§7.2).

### Rate limits (§6.4)

- Per-connection token buckets with documented thresholds; per-IP new-connection cap (30/min); 200-connection per-room hard cap; 90-second application heartbeat timeout.
- Exceeding a frame-type abuse threshold writes a `RATE_LIMIT_CLOSE` audit row and closes with code 1008.

### Persistence (§11.3, §11.5)

- `src/db/schema.sql` is the authoritative DDL; `src/db/migrations/001_initial.sql` can be applied by `npm run migrate`.
- `src/db/dal.ts` is the thin DAL over `pg` — includes a `__testOverrides` hook so the unit tests run without Postgres.
- Mutation discipline per §11.5: in-memory mutation → async DB write → WebSocket broadcast (never awaits the write). Failed writes go to an in-process ring buffer (max 1000) and `isDbDegraded()` flips the `dbDegraded` bit on every outbound `STATE` frame until the ring flushes.
- Room state is rehydrated from `timer_state` on startup.

### Notifications (§7.4)

- `src/notify/dispatcher.ts` schedules a 5-second `setTimeout` on the empty→non-empty queue transition, then re-checks the queue at fire time. If the requester is gone → `NOTIFY_DROPPED` audit row and no send.
- Quiet-hours evaluation supports overnight windows (`end < start`), weekday bitmasks, and IANA timezones via `Intl.DateTimeFormat`.
- Per-judge 30-second `judgeAckedAt` debounce.
- Twilio + SES v2 adapters are lazy-loaded; absent env vars means the dispatcher will simply skip SMS or email without throwing.
- Retries each send exactly once after 10 seconds, then abandons (audit-logs `SMS_FAILED` / `EMAIL_FAILED`).

### REST surface (§11.2)

Implemented in `src/routes/`:

- `POST /api/judge/ticket`, `GET /api/judge/rooms`, `GET /api/judge/log`, `GET /api/judge/log.csv`, `GET /api/judge/prefs`, `PUT /api/judge/prefs`, `POST /api/judge/prefs/verify-phone`, `POST /api/judge/prefs/verify-email`.
- `POST /api/admin/rooms`, `POST /api/admin/rooms/:id/rotate-token` — gated on the `judges-admin` group; returns the freshly-generated room token once.
- `POST /api/webhooks/twilio` (HMAC validation), `POST /api/webhooks/ses` (SNS signature validation; auto-confirms `SubscriptionConfirmation`; routes bounces/complaints to `email_status='opted_out'`).
- `GET /healthz` reports DB state and room count.

### Authentication (§8)

- Server-mediated OIDC login (Authorization Code + PKCE) via
  `openid-client`. Identity is persisted in an encrypted, signed
  `tca_sess` cookie (AES-256-GCM, key derived via HKDF from
  `SESSION_SECRET`). 24-hour sliding TTL with 1-hour renewal. Single
  provider per deployment — Cloudflare Access (with an OIDC SaaS app),
  Google, Microsoft, Okta, Auth0, etc. all work behind the same env-driven
  config. Group membership comes from `OIDC_GROUPS_CLAIM` (default
  `groups`) plus `OIDC_ADMIN_EMAILS` allowlist; `judgeRoomAccess` then
  maps `judges-admin` / `judges-<roomId>` to authorized rooms.
- Contestant: bcrypt(12) hashed room tokens; constant-time compare.

### Background jobs

- `src/clock.ts` samples `https://time.cloudflare.com` every 5 minutes; drifts > 200 ms append a `SYSTEM_CLOCK_WARN` audit row (§11.6).
- `src/retention.ts` prunes `audit_log` rows older than 90 days daily (§11.4).

## Layout

```
src/
  index.ts                    entry point — Fastify + ws wiring, background jobs
  auth/
    identity.ts               JudgeIdentity + group/role mapping + ticket LRU (§8.1)
    oidc.ts                   OIDC client (discovery, code-flow, claim → identity)
    session.ts                Encrypted session cookie (AES-256-GCM)
    room-token.ts             bcrypt hash + regexes (§8.2)
  clock.ts                    clock-drift sampler (§11.6)
  db/
    dal.ts                    Postgres DAL + retry ring buffer (§11.5)
    migrate.ts                SQL migration runner (npm run migrate)
    migrations/001_initial.sql initial schema
    pool.ts                   pg.Pool singleton
    schema.sql                authoritative DDL (§11.3)
  help-queue.ts               help-queue state machine (§7)
  notify/
    dispatcher.ts             debounce + auto-cancel + fan-out (§7.4)
    quiet-hours.ts            quiet-hours evaluator (§7.4.4)
    ses.ts                    AWS SES v2 adapter (§7.4.3)
    twilio.ts                 Twilio Messaging adapter (§7.4.2)
  ratelimit.ts                token buckets + abuse tracker (§6.4)
  retention.ts                90-day audit prune (§11.4)
  rooms.ts                    in-memory RoomState + broadcasts (§11.5)
  routes/
    admin.ts                  POST /api/admin/rooms*
    auth.ts                   /api/auth/{login,callback,logout,me}
    judge.ts                  /api/judge/*
    webhooks.ts               Twilio + SES webhooks
  timer.ts                    timer state machine (§6.5)
  ws/
    contestant.ts             /contestant WS handler
    judge.ts                  /judge WS handler
```

## Environment variables

See `.env.example`. All are required in production; the `TWILIO_*` and
`AWS_*` / `SES_*` groups may be omitted to disable SMS / email,
respectively.

Auth-related vars:

| Var                   | Required                | Notes |
| --------------------- | ----------------------- | ----- |
| `SESSION_SECRET`      | yes (when no bypass)    | ≥32 chars; encryption + integrity for the session cookie |
| `OIDC_ISSUER`         | yes (when no bypass)    | e.g. `https://<team>.cloudflareaccess.com`, `https://accounts.google.com` |
| `OIDC_CLIENT_ID`      | yes (when no bypass)    | OIDC client id from the IdP |
| `OIDC_CLIENT_SECRET`  | typically yes           | confidential client secret; empty string for public clients |
| `OIDC_REDIRECT_URI`   | yes (when no bypass)    | absolute URL of `/api/auth/callback` as seen by the user agent |
| `OIDC_SCOPES`         | no                      | default `openid profile email` |
| `OIDC_GROUPS_CLAIM`   | no                      | ID-token claim that carries groups; default `groups` |
| `OIDC_ADMIN_EMAILS`   | no                      | comma-separated email allowlist promoted to `judges-admin` |
| `OIDC_ALLOW_ALL_ROOMS`| no                      | `1`/`true`: every authenticated user becomes admin (single-tenant convenience) |
| `DEV_AUTH_BYPASS`     | dev only                | `1`/`true`: skip OIDC, synthesize a dev judge identity. Hard-disabled when `NODE_ENV=production`. |

When OIDC is unconfigured (and the dev bypass isn't set), every
`/api/judge/*` and `/api/admin/*` route responds `401 no_session` with
a `login` hint pointing at `/api/auth/login`; the SPA's fetch wrapper
then navigates the browser to that URL to start the IdP redirect.
