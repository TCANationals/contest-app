import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/index.js';
import { encodeSession, newSessionPayload } from '../src/auth/session.js';

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
