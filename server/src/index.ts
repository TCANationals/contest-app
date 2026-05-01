// TCA Timer server entry point (§11). Wires Fastify + WebSocket + REST.

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';

import { registerJudgeWs } from './ws/judge.js';
import { registerContestantWs } from './ws/contestant.js';
import { registerJudgeRoutes } from './routes/judge.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { pingDb, hasDatabase, closePool } from './db/pool.js';
import { listActiveRooms } from './db/dal.js';
import { rehydrateFromDb, allRoomStates } from './rooms.js';
import { startClockDriftMonitor } from './clock.js';
import { startRetentionJob } from './retention.js';
import { startRetryDrain } from './db/retry-drain.js';
import { IpConnectionLimiter } from './ratelimit.js';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
    trustProxy: true,
  });

  await app.register(cookie);
  // Twilio webhooks arrive as application/x-www-form-urlencoded, so we need
  // the formbody plugin before registering the webhook routes.
  await app.register(formbody);
  await app.register(websocket);

  // Per-source-IP connection limiter for WS upgrades (§6.4).
  const ipLimiter = new IpConnectionLimiter();
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      const ip = req.ip;
      if (!ipLimiter.allow(ip)) {
        return reply.code(429).send({ error: 'rate_limited' });
      }
    }
  });

  app.get('/healthz', async () => {
    const db = await pingDb();
    return {
      ok: true,
      db,
      rooms: allRoomStates().size,
    };
  });

  registerAuthRoutes(app);
  registerJudgeRoutes(app);
  registerAdminRoutes(app);
  registerWebhookRoutes(app);
  registerJudgeWs(app);
  registerContestantWs(app);

  // Background jobs. All three are no-ops when there's nothing to do, so
  // they're safe to start even in tests. Critically, we own the stop
  // handles so `app.close()` shuts them down cleanly — otherwise their
  // callbacks could fire after the DB pool has been ended and throw
  // unhandled errors during graceful shutdown / test teardown.
  const stops: Array<() => void> = [
    startClockDriftMonitor((msg, extra) => app.log.warn({ extra }, msg)),
    startRetentionJob((msg, extra) => app.log.info({ extra }, msg)),
    startRetryDrain((msg, extra) => app.log.warn({ extra }, msg)),
  ];

  app.addHook('onClose', async () => {
    for (const stop of stops) {
      try {
        stop();
      } catch {
        /* best effort */
      }
    }
    await closePool().catch(() => {});
  });

  return app;
}

async function main() {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);

  // Warm up per-room state from Postgres if configured.
  if (hasDatabase()) {
    try {
      const rooms = await listActiveRooms();
      await rehydrateFromDb(rooms.map((r) => r.id));
      app.log.info({ rooms: rooms.length }, 'rehydrated rooms from db');
    } catch (err) {
      app.log.warn({ err }, 'room rehydration skipped');
    }
  }

  try {
    await app.listen({ host: '0.0.0.0', port });
    app.log.info({ port }, 'tca-timer-server listening');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  void main();
}
