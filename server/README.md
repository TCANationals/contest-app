# TCA Timer — Server

Scaffolding for the TCA Timer backend described in `TCA_Timer_Design_Spec.docx.md` §11.

All business logic is currently a placeholder. This package gives you:

- A Fastify app with a `GET /healthz` route.
- WebSocket upgrade stubs at `/judge` and `/contestant`.
- REST handler stubs for the endpoints in §11.2.
- A timer state machine stub (§6.5) and help-queue stub (§7).
- Notification adapter stubs (Twilio SMS + AWS SES email).
- Authoritative Postgres DDL at `src/db/schema.sql` (§11.3).
- A `node --test` harness under `test/` to grow against.

## Commands

```bash
npm install
npm run lint      # tsc --noEmit
npm test          # node --test harness
npm run dev       # hot-reload via tsx
npm run build     # tsc → dist/
npm start         # node dist/index.js
```

## Structure

```
src/
  index.ts              entry point, wires Fastify + WS
  auth/
    cf-jwt.ts           CF Access JWT verification (§8.1)
    room-token.ts       contestant room-token verification (§8.2)
  rooms.ts              in-memory RoomState map (§11.5)
  timer.ts              timer state machine (§6.5)
  help-queue.ts         help-queue state machine (§7)
  notify/
    dispatcher.ts       debounce + auto-cancel logic (§7.4)
    twilio.ts           SMS adapter stub
    ses.ts              AWS SES email adapter stub
  db/
    schema.sql          exact DDL from §11.3
    migrations/         node-pg-migrate files (TBD)
  ws/
    judge.ts            /judge handler
    contestant.ts       /contestant handler
  ratelimit.ts          per-conn token buckets (§6.4)
```
