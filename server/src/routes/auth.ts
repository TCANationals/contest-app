// /api/auth/* — OIDC login round-trip + session introspection.
//
// Flow:
//   1. SPA hits a protected endpoint without a session cookie → 401.
//   2. SPA navigates the *browser* (not a fetch) to
//      `/api/auth/login?return_to=/some/path`.
//   3. We mint a per-login intent (state, nonce, PKCE verifier) and
//      stash it in a short-lived encrypted login-state cookie, then
//      302 to the IdP authorize URL.
//   4. IdP redirects back to `/api/auth/callback?...`. We exchange the
//      code, validate the state/nonce, derive a `JudgeIdentity` from
//      the ID-token claims, set the session cookie, and 302 to the
//      original return_to.
//   5. SPA refetches; the session cookie is now present so requests
//      succeed.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  isDevAuthBypassEnabled,
  judgeRoomAccess,
  type JudgeIdentity,
} from '../auth/identity.js';
import {
  authorizationUrl,
  completeLogin,
  loadOidcConfig,
  newLoginIntent,
  type OidcLoginIntent,
} from '../auth/oidc.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  encodeSession,
  decodeSession,
  identityFromRequest,
  isRequestSecure,
  isSessionConfigured,
  newSessionPayload,
  setSessionCookie,
  type SessionPayload,
} from '../auth/session.js';

const LOGIN_INTENT_COOKIE = 'tca_login';
const LOGIN_INTENT_TTL_MS = 10 * 60 * 1000; // 10 minutes — IdP round-trip

interface IntentPayload extends OidcLoginIntent {
  // Same self-contained encrypted-cookie format as the session cookie,
  // so we can reuse `encodeSession`/`decodeSession` by piggy-backing on
  // its envelope. The intent payload masquerades as a SessionPayload
  // by using `sub`/`email`/`groups` slots; see `intentToPayload`.
}

function intentToPayload(intent: OidcLoginIntent, now: number): SessionPayload {
  // Pack the intent fields into the SessionPayload shape so we get
  // confidentiality, integrity, and expiry checks for free. Each slot
  // re-purposed:
  //   sub    → state
  //   email  → nonce
  //   groups → [codeVerifier, returnTo]
  return {
    sub: intent.state,
    email: intent.nonce,
    groups: [intent.codeVerifier, intent.returnTo],
    iat: now,
    exp: now + LOGIN_INTENT_TTL_MS,
  };
}

function payloadToIntent(p: SessionPayload): OidcLoginIntent | null {
  if (!p.sub || !p.email || p.groups.length !== 2) return null;
  return {
    state: p.sub,
    nonce: p.email,
    codeVerifier: p.groups[0]!,
    returnTo: p.groups[1]!,
  };
}

function setIntentCookie(reply: FastifyReply, intent: OidcLoginIntent, secure: boolean): void {
  const value = encodeSession(intentToPayload(intent, Date.now()));
  const attrs = [
    `${LOGIN_INTENT_COOKIE}=${value}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(LOGIN_INTENT_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

function readIntentCookie(req: FastifyRequest): OidcLoginIntent | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const raw = cookies?.[LOGIN_INTENT_COOKIE];
  if (!raw) return null;
  const payload = decodeSession(raw);
  if (!payload) return null;
  return payloadToIntent(payload);
}

function clearIntentCookie(reply: FastifyReply, secure: boolean): void {
  const attrs = [
    `${LOGIN_INTENT_COOKIE}=`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) attrs.push('Secure');
  // Use append rather than overwrite so this can sit alongside the
  // session cookie set in the same response.
  appendSetCookie(reply, attrs.join('; '));
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader('set-cookie');
  if (existing == null) {
    reply.header('set-cookie', value);
  } else if (Array.isArray(existing)) {
    reply.header('set-cookie', [...existing, value]);
  } else {
    reply.header('set-cookie', [String(existing), value]);
  }
}

/**
 * Same-origin path guard for `return_to`. Any caller-provided URL that
 * doesn't start with a single `/` is rejected to prevent open-redirect
 * abuse via `?return_to=https://evil.example.com`.
 */
function safeReturnTo(input: string | undefined): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/login', async (req, reply) => {
    if (isDevAuthBypassEnabled()) {
      // Dev mode: short-circuit straight to the return URL without
      // touching an IdP. The session cookie is irrelevant here because
      // `requireJudge` consults `devAuthBypassIdentity` directly.
      const q = req.query as { return_to?: string };
      return reply.redirect(safeReturnTo(q.return_to));
    }
    const cfg = loadOidcConfig();
    if (!cfg) {
      return reply.code(503).send({ error: 'oidc_not_configured' });
    }
    if (!isSessionConfigured()) {
      return reply.code(503).send({ error: 'session_secret_missing' });
    }
    const q = req.query as { return_to?: string };
    const intent = newLoginIntent(safeReturnTo(q.return_to));
    let url: string;
    try {
      url = await authorizationUrl(cfg, intent);
    } catch (err) {
      req.log.error({ err }, 'oidc discovery / authorize url failed');
      return reply.code(502).send({ error: 'oidc_unavailable' });
    }
    setIntentCookie(reply, intent, isRequestSecure(req));
    return reply.redirect(url);
  });

  app.get('/api/auth/callback', async (req, reply) => {
    if (isDevAuthBypassEnabled()) {
      // Shouldn't normally get here — `/login` short-circuits — but be
      // tolerant if a stale IdP redirect lands us here.
      return reply.redirect('/');
    }
    const cfg = loadOidcConfig();
    if (!cfg) return reply.code(503).send({ error: 'oidc_not_configured' });

    const intent = readIntentCookie(req);
    if (!intent) {
      return reply.code(400).send({ error: 'missing_login_intent' });
    }

    const callbackUrl = `${cfg.redirectUri}?${new URL(req.url, 'http://internal').search.slice(1)}`;

    let identity: JudgeIdentity;
    try {
      identity = await completeLogin(cfg, intent, callbackUrl);
    } catch (err) {
      req.log.warn({ err }, 'oidc callback failed');
      clearIntentCookie(reply, isRequestSecure(req));
      return reply.code(401).send({ error: 'oidc_callback_failed' });
    }

    const secure = isRequestSecure(req);
    setSessionCookie(reply, newSessionPayload(identity), { secure });
    clearIntentCookie(reply, secure);
    return reply.redirect(intent.returnTo || '/');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    clearSessionCookie(reply, { secure: isRequestSecure(req) });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const id = identityFromRequest(req);
    if (!id) {
      reply.code(401);
      return { error: 'no_session' };
    }
    return {
      sub: id.sub,
      email: id.email,
      groups: id.groups,
      access: judgeRoomAccess(id.groups),
    };
  });
}

/**
 * Path used by the SPA for login redirects. Exported so other routes
 * (e.g. SPA static fallback in production) can construct it without
 * hard-coding the string in two places.
 */
export const LOGIN_PATH = '/api/auth/login';
export { SESSION_COOKIE_NAME };
