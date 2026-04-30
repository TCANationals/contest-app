// Coverage for webhook audit FK-safety: opt-out events must NEVER attempt
// to insert an audit row referencing a non-existent room. The
// `audit_log.room` column is FK-bound to `rooms.id`, so a synthetic
// `_global_` fallback would violate the constraint and silently lose the
// event. We verify (a) the fallback path doesn't call insertAuditEvent,
// and (b) one row per enabled room is written when the judge is enrolled.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createHmac } from 'node:crypto';

import { buildServer } from '../src/index.js';
import { __testOverrides } from '../src/db/dal.js';

type App = Awaited<ReturnType<typeof buildServer>>;

describe('Twilio STOP webhook audit routing', () => {
  let app: App;
  const audits: string[] = [];

  before(async () => {
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    audits.length = 0;
    __testOverrides.setPhoneStatus = async () => {};
    __testOverrides.insertAuditEvent = async (ev) => {
      audits.push(ev.room);
    };
    app = await buildServer();
  });

  after(async () => {
    await app.close();
    delete process.env.TWILIO_AUTH_TOKEN;
    delete __testOverrides.findJudgeByPhone;
    delete __testOverrides.setPhoneStatus;
    delete __testOverrides.insertAuditEvent;
  });

  it('rejects requests without a signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/twilio',
      headers: { host: 'timer.example.com' },
      payload: { Body: 'STOP', From: '+15555550123' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('does NOT try to insert an audit row with a synthetic room when judge has no enabled rooms', async () => {
    audits.length = 0;
    __testOverrides.findJudgeByPhone = async () => ({
      sub: 'judge-1',
      last_seen_email: 'j@example.com',
      phone_e164: '+15555550123',
      phone_status: 'verified',
      pending_phone_code_hash: null,
      pending_phone_expires_at: null,
      email_address: null,
      email_status: 'none',
      pending_email_code_hash: null,
      pending_email_expires_at: null,
      enabled_rooms: [],
      quiet_hours_start: null,
      quiet_hours_end: null,
      quiet_hours_weekdays: 0,
      timezone: 'UTC',
      updated_at: new Date(),
    });

    const signed = signTwilio(app, '/api/webhooks/twilio', {
      Body: 'STOP',
      From: '+15555550123',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/twilio',
      headers: {
        host: 'timer.example.com',
        'x-twilio-signature': signed.sig,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: signed.body,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      audits.length,
      0,
      'no audit row should be written when the judge has no enabled rooms',
    );
  });

  it('writes one audit row per enabled room when judge is enrolled', async () => {
    audits.length = 0;
    __testOverrides.findJudgeByPhone = async () => ({
      sub: 'judge-2',
      last_seen_email: 'j2@example.com',
      phone_e164: '+15555550124',
      phone_status: 'verified',
      pending_phone_code_hash: null,
      pending_phone_expires_at: null,
      email_address: null,
      email_status: 'none',
      pending_email_code_hash: null,
      pending_email_expires_at: null,
      enabled_rooms: ['nationals-2026', 'region-3'],
      quiet_hours_start: null,
      quiet_hours_end: null,
      quiet_hours_weekdays: 0,
      timezone: 'UTC',
      updated_at: new Date(),
    });

    const signed = signTwilio(app, '/api/webhooks/twilio', {
      Body: 'STOP',
      From: '+15555550124',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/twilio',
      headers: {
        host: 'timer.example.com',
        'x-twilio-signature': signed.sig,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: signed.body,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(audits.sort(), ['nationals-2026', 'region-3']);
  });
});

// --- Twilio signature helper (matches server/src/routes/webhooks.ts) ---

function signTwilio(
  _app: App,
  path: string,
  params: Record<string, string>,
): { sig: string; body: string } {
  // The inject path is served over plain http in tests and the Host
  // header is set to `timer.example.com`, so Fastify's trustProxy
  // middleware returns those values from `req.protocol` / `req.headers.host`.
  const url = `http://timer.example.com${path}`;
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, k) => acc + k + (params[k] ?? ''), url);
  const token = process.env.TWILIO_AUTH_TOKEN ?? '';
  const sig = createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  const body = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? '')}`)
    .join('&');
  return { sig, body };
}
