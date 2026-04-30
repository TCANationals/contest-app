import Fastify from 'fastify';
import websocket from '@fastify/websocket';

import { registerJudgeWs } from './ws/judge.js';
import { registerContestantWs } from './ws/contestant.js';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  await app.register(websocket);

  app.get('/healthz', async () => {
    // TODO(§11.2): include DB connectivity status in body
    return { ok: true, db: 'unknown' };
  });

  // REST surface stubs (§11.2) — all return 501 until wired up.
  const stubPaths: Array<{ method: 'GET' | 'POST' | 'PUT'; url: string }> = [
    { method: 'POST', url: '/api/judge/ticket' },
    { method: 'GET', url: '/api/judge/rooms' },
    { method: 'GET', url: '/api/judge/log' },
    { method: 'GET', url: '/api/judge/log.csv' },
    { method: 'GET', url: '/api/judge/prefs' },
    { method: 'PUT', url: '/api/judge/prefs' },
    { method: 'POST', url: '/api/judge/prefs/verify-phone' },
    { method: 'POST', url: '/api/judge/prefs/verify-email' },
    { method: 'POST', url: '/api/admin/rooms' },
    { method: 'POST', url: '/api/admin/rooms/:id/rotate-token' },
    { method: 'POST', url: '/api/webhooks/twilio' },
    { method: 'POST', url: '/api/webhooks/ses' },
  ];

  for (const { method, url } of stubPaths) {
    app.route({
      method,
      url,
      handler: async (_req, reply) => {
        reply
          .code(501)
          .send({ error: 'not_implemented', route: `${method} ${url}` });
      },
    });
  }

  registerJudgeWs(app);
  registerContestantWs(app);

  return app;
}

async function main() {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  try {
    await app.listen({ host: '0.0.0.0', port });
    app.log.info({ port }, 'tca-timer-server listening');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only run when executed directly, not when imported by tests.
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  void main();
}
