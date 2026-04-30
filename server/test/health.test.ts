import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/index.js';

describe('GET /healthz', () => {
  it('returns ok=true with db status', async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { ok: boolean; db: string; rooms: number };
      assert.equal(body.ok, true);
      assert.ok(['ok', 'degraded', 'unknown'].includes(body.db));
      assert.equal(typeof body.rooms, 'number');
    } finally {
      await app.close();
    }
  });
});
