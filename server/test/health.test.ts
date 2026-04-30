import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/index.js';

describe('GET /healthz', () => {
  it('returns ok=true', async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { ok: boolean };
      assert.equal(body.ok, true);
    } finally {
      await app.close();
    }
  });
});
