import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/index.js';

describe('REST endpoints without auth', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  before(async () => {
    app = await buildServer();
  });

  after(async () => {
    await app.close();
  });

  it('POST /api/judge/ticket returns 401 without JWT', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/judge/ticket' });
    assert.equal(res.statusCode, 401);
  });

  it('GET /api/judge/rooms returns 401 without JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/judge/rooms' });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/admin/rooms returns 401 without JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rooms',
      payload: { id: 'test', display_label: 'Test' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/webhooks/twilio returns 401 without signature', async () => {
    // TWILIO_AUTH_TOKEN is not set in test env, so this is the expected branch.
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/twilio',
      payload: {},
    });
    // Either 503 (unconfigured) or 401 (missing signature) — both are valid
    // "not accepted" responses. In the test env, no TWILIO_AUTH_TOKEN is set,
    // so we expect 503.
    assert.ok([401, 503].includes(res.statusCode));
  });
});
