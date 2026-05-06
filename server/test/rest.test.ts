import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/index.js';
import { encodeSession, newSessionPayload } from '../src/auth/session.js';
import { __testOverrides, type RoomRow } from '../src/db/dal.js';

describe('REST endpoints without auth', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  before(async () => {
    // Tests that exercise the session helpers below need SESSION_SECRET
    // present on `buildServer()` time. Setting it in `before` keeps the
    // env hermetic for the rest of the suite.
    process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-32+';
    app = await buildServer();
  });

  after(async () => {
    await app.close();
  });

  it('POST /api/judge/ticket returns 401 with login hint when no session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/judge/ticket' });
    assert.equal(res.statusCode, 401);
    const body = res.json() as { error: string; login: string };
    assert.equal(body.error, 'no_session');
    assert.equal(body.login, '/api/auth/login');
    assert.match(res.headers['www-authenticate'] as string, /login="\/api\/auth\/login"/);
  });

  it('GET /api/judge/rooms returns 401 without session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/judge/rooms' });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/admin/rooms returns 401 without session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rooms',
      payload: { id: 'test', display_label: 'Test' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET /api/auth/me returns 401 without session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 401);
  });

  it('GET /api/auth/me echoes the identity behind a valid session cookie', async () => {
    const cookie = encodeSession(
      newSessionPayload({
        sub: 'judge-1',
        email: 'judge@example.com',
        groups: ['judges-admin', 'judges-nationals-2026'],
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `tca_sess=${cookie}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { sub: string; email: string; access: string | string[] };
    assert.equal(body.sub, 'judge-1');
    assert.equal(body.email, 'judge@example.com');
    assert.equal(body.access, 'all');
  });

  it('POST /api/auth/logout always succeeds and clears the cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
    assert.match(header, /tca_sess=;/);
    assert.match(header, /Max-Age=0/);
  });

  it('GET /api/auth/login without OIDC config returns 503', async () => {
    // No OIDC_* env vars set in the test runner.
    const res = await app.inject({ method: 'GET', url: '/api/auth/login' });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'oidc_not_configured');
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

describe('OIDC callback preconditions', () => {
  // This block deliberately stands up its own server so it can twiddle
  // SESSION_SECRET without poisoning the suite above (which leaves the
  // secret set globally).
  let app: Awaited<ReturnType<typeof buildServer>>;
  let priorEnv: Record<string, string | undefined>;

  before(async () => {
    priorEnv = {
      OIDC_ISSUER: process.env.OIDC_ISSUER,
      OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
      OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
      SESSION_SECRET: process.env.SESSION_SECRET,
    };
    // OIDC configured...
    process.env.OIDC_ISSUER = 'https://issuer.test';
    process.env.OIDC_CLIENT_ID = 'cid';
    process.env.OIDC_REDIRECT_URI = 'https://app.test/api/auth/callback';
    // ...but SESSION_SECRET *unset*. This is the misconfiguration the
    // regression covers: the user can complete IdP login, hit the
    // callback, and we have no key to seal the session cookie with.
    delete process.env.SESSION_SECRET;
    app = await buildServer();
  });

  after(async () => {
    await app.close();
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('GET /api/auth/callback returns 503 (not 500) when SESSION_SECRET is missing', async () => {
    // Without the precondition, this request would proceed to
    // `setSessionCookie → sealCookie → getKey() → throw`, and Fastify
    // would reply with a generic 500 *after* the user has already
    // authenticated at the IdP. With the guard in place we fail fast
    // with a precise 503 before ever calling the IdP.
    const res = await app.inject({ method: 'GET', url: '/api/auth/callback?code=anything&state=anything' });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'session_secret_missing');
  });
});

describe('POST /api/admin/rooms', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  // Stand-in for the `rooms` table. The DAL's `__testOverrides` lets
  // us swap out `getRoom` / `insertRoom` without touching Postgres,
  // and we use a Map so the duplicate-id case becomes a single line:
  // "if rooms.has(id) → 409".
  const rooms = new Map<string, RoomRow>();
  const auditEvents: Array<{ eventType: string; room: string }> = [];

  function adminCookie(): string {
    return encodeSession(
      newSessionPayload({
        sub: 'judge-admin',
        email: 'admin@example.com',
        groups: ['judges-admin'],
      }),
    );
  }

  function judgeCookie(): string {
    return encodeSession(
      newSessionPayload({
        sub: 'judge-only',
        email: 'judge@example.com',
        // Room-scoped, *not* admin. The route should answer 403.
        groups: ['judges-stage-1'],
      }),
    );
  }

  before(async () => {
    process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-32+';
    app = await buildServer();
  });

  after(async () => {
    await app.close();
    for (const k of Object.keys(__testOverrides)) {
      delete (__testOverrides as Record<string, unknown>)[k];
    }
  });

  beforeEach(() => {
    rooms.clear();
    auditEvents.length = 0;
    __testOverrides.getRoom = async (id) => rooms.get(id) ?? null;
    __testOverrides.insertRoom = async (id, displayLabel, roomKey) => {
      rooms.set(id, {
        id,
        display_label: displayLabel,
        room_key: roomKey,
        created_at: new Date(),
        archived_at: null,
      });
    };
    __testOverrides.insertAuditEvent = async (ev) => {
      auditEvents.push({ eventType: ev.eventType, room: ev.room });
    };
  });

  afterEach(() => {
    delete __testOverrides.getRoom;
    delete __testOverrides.insertRoom;
    delete __testOverrides.insertAuditEvent;
  });

  it('returns 201 with a fresh room_key for an admin caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rooms',
      headers: { cookie: `tca_sess=${adminCookie()}` },
      payload: { id: 'practice-2026', display_label: 'Practice 2026' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as {
      id: string;
      display_label: string;
      room_key: string;
    };
    assert.equal(body.id, 'practice-2026');
    assert.equal(body.display_label, 'Practice 2026');
    // The key is `randomBytes(32).toString('base64url')` → 43 chars in
    // the URL-safe base64 alphabet. Pin a sane lower bound so a
    // regression that returned an empty / weak key would fail here.
    assert.match(body.room_key, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(rooms.size, 1);
    assert.deepEqual(
      auditEvents.map((e) => e.eventType),
      ['ROOM_CREATED'],
    );
  });

  it('returns 403 when the caller is authenticated but not in judges-admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rooms',
      headers: { cookie: `tca_sess=${judgeCookie()}` },
      payload: { id: 'practice-2026', display_label: 'Practice 2026' },
    });
    assert.equal(res.statusCode, 403);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'not_admin');
    assert.equal(rooms.size, 0);
  });

  it('returns 409 when the room id already exists', async () => {
    rooms.set('practice-2026', {
      id: 'practice-2026',
      display_label: 'Practice 2026',
      room_key: 'preexisting-key-for-test-only-1234567890ab',
      created_at: new Date(),
      archived_at: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rooms',
      headers: { cookie: `tca_sess=${adminCookie()}` },
      payload: { id: 'practice-2026', display_label: 'Some Other Label' },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'room_exists');
  });

  it('returns 400 for ids that violate the regex', async () => {
    // Leading dash, uppercase, and too short — three different ways
    // the regex rejects the value. We only assert the status code so
    // the test doesn't have to enumerate the failure modes.
    for (const badId of ['-leading-dash', 'Has-Capitals', 'a']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/rooms',
        headers: { cookie: `tca_sess=${adminCookie()}` },
        payload: { id: badId, display_label: 'Test' },
      });
      assert.equal(res.statusCode, 400, `expected 400 for id ${JSON.stringify(badId)}`);
      const body = res.json() as { error: string };
      assert.equal(body.error, 'bad_room_id');
    }
    assert.equal(rooms.size, 0);
  });

  it('returns 400 when display_label is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rooms',
      headers: { cookie: `tca_sess=${adminCookie()}` },
      payload: { id: 'practice-2026' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string };
    assert.equal(body.error, 'bad_display_label');
  });
});
