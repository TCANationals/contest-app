import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeSession,
  encodeSession,
  isSessionConfigured,
  maybeRenewSession,
  newSessionPayload,
  SESSION_TTL_MS,
} from '../src/auth/session.js';
import { identityFromClaims, loadOidcConfig } from '../src/auth/oidc.js';

describe('session cookie (encrypted)', () => {
  let prevSecret: string | undefined;

  before(() => {
    prevSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-32+';
  });

  after(() => {
    if (prevSecret == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
  });

  it('reports configured when SESSION_SECRET is set', () => {
    assert.equal(isSessionConfigured(), true);
  });

  it('round-trips an identity through encode/decode', () => {
    const payload = newSessionPayload({
      sub: 'judge-1',
      email: 'a@b',
      groups: ['judges-admin'],
    });
    const cookie = encodeSession(payload);
    const decoded = decodeSession(cookie);
    assert.deepEqual(decoded, payload);
  });

  it('rejects a tampered cookie', () => {
    const cookie = encodeSession(
      newSessionPayload({ sub: 'judge-1', email: 'a@b', groups: [] }),
    );
    // Flip a byte in the middle — GCM tag verification must fail.
    const dot = cookie.indexOf('.');
    const tampered =
      cookie.slice(0, dot + 5) +
      (cookie.charAt(dot + 5) === 'a' ? 'b' : 'a') +
      cookie.slice(dot + 6);
    assert.equal(decodeSession(tampered), null);
  });

  it('treats an expired cookie as null', () => {
    const payload = newSessionPayload(
      { sub: 'x', email: 'x', groups: [] },
      Date.now() - SESSION_TTL_MS - 1000,
    );
    const cookie = encodeSession(payload);
    assert.equal(decodeSession(cookie), null);
  });

  it('only renews after the renewal threshold', () => {
    const now = Date.now();
    const fresh = newSessionPayload({ sub: 'x', email: 'x', groups: [] }, now);
    assert.equal(maybeRenewSession(fresh, now + 5_000), null);
    const stale = maybeRenewSession(fresh, now + 2 * 60 * 60 * 1000);
    assert.ok(stale);
    assert.ok(stale.exp > fresh.exp);
  });
});

describe('OIDC claim → identity mapping', () => {
  it('returns null config when OIDC_* env vars are missing', () => {
    const prev = {
      issuer: process.env.OIDC_ISSUER,
      clientId: process.env.OIDC_CLIENT_ID,
      redirectUri: process.env.OIDC_REDIRECT_URI,
    };
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_REDIRECT_URI;
    try {
      assert.equal(loadOidcConfig(), null);
    } finally {
      if (prev.issuer != null) process.env.OIDC_ISSUER = prev.issuer;
      if (prev.clientId != null) process.env.OIDC_CLIENT_ID = prev.clientId;
      if (prev.redirectUri != null) process.env.OIDC_REDIRECT_URI = prev.redirectUri;
    }
  });

  it('reads groups from the configured claim and merges admin allowlist', () => {
    process.env.OIDC_ISSUER = 'https://issuer.test';
    process.env.OIDC_CLIENT_ID = 'cid';
    process.env.OIDC_REDIRECT_URI = 'https://app.test/api/auth/callback';
    process.env.OIDC_GROUPS_CLAIM = 'roles';
    process.env.OIDC_ADMIN_EMAILS = 'admin@example.com';
    const cfg = loadOidcConfig();
    assert.ok(cfg);
    if (!cfg) return;

    const id = identityFromClaims(cfg, {
      sub: 'u1',
      email: 'admin@example.com',
      roles: ['judges-region-3'],
      // Required by the IdToken type contract; values don't matter here.
      iss: cfg.issuer,
      aud: cfg.clientId,
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    });
    assert.equal(id.sub, 'u1');
    assert.equal(id.email, 'admin@example.com');
    assert.ok(id.groups.includes('judges-region-3'));
    assert.ok(id.groups.includes('judges-admin'));
  });

  it('OIDC_ALLOW_ALL_ROOMS=1 promotes everyone to admin', () => {
    process.env.OIDC_ISSUER = 'https://issuer.test';
    process.env.OIDC_CLIENT_ID = 'cid';
    process.env.OIDC_REDIRECT_URI = 'https://app.test/api/auth/callback';
    process.env.OIDC_ALLOW_ALL_ROOMS = '1';
    delete process.env.OIDC_ADMIN_EMAILS;
    delete process.env.OIDC_GROUPS_CLAIM;
    const cfg = loadOidcConfig();
    assert.ok(cfg);
    if (!cfg) return;

    const id = identityFromClaims(cfg, {
      sub: 'u2',
      email: 'random@example.com',
      iss: cfg.issuer,
      aud: cfg.clientId,
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    });
    assert.ok(id.groups.includes('judges-admin'));

    delete process.env.OIDC_ALLOW_ALL_ROOMS;
  });
});
