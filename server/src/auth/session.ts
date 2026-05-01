// Encrypted, signed session cookie for the judge SPA (replaces §8.1
// Cloudflare Access JWT-on-every-request).
//
// Why a self-contained cookie instead of a server-side session table:
//   * Zero schema migration / DB round-trip per request.
//   * Trivially horizontal — every Fastify instance can verify a
//     session offline using the shared `SESSION_SECRET`.
//   * Logout = clear the cookie; no revocation list needed for the
//     short (24h sliding) lifetime we use here.
//
// Wire format: `<base64url(iv)>.<base64url(ciphertext+gcm-tag)>` where
// the plaintext is `JSON.stringify(SessionPayload)`. AES-256-GCM with
// a per-purpose additional-authenticated-data label protects against
// cross-cookie substitution: a value sealed with one purpose
// ("session") cannot be opened as another ("login-intent"), which
// matters because both `routes/auth.ts` cookies share this envelope.
// The encryption key is derived from `SESSION_SECRET` via HKDF-SHA256
// so the operator-supplied secret can be any printable string of
// sufficient entropy (≥32 bytes).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  devAuthBypassIdentity,
  isDevAuthBypassEnabled,
  type JudgeIdentity,
} from './identity.js';

export const SESSION_COOKIE_NAME = 'tca_sess';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h sliding window
const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000; // re-issue once it's >1h old

export interface SessionPayload {
  sub: string;
  email: string;
  groups: string[];
  iat: number; // ms since epoch
  exp: number; // ms since epoch
}

interface DerivedKey {
  secret: string;
  key: Buffer;
}

let cachedKey: DerivedKey | null = null;

function getKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  // HKDF with a fixed info label binds the derived key to this app's
  // session-cookie purpose. If the same SESSION_SECRET is ever reused
  // for another encryption context, derive a different key there with
  // a different info label rather than reusing this one directly.
  const ikm = Buffer.from(secret, 'utf8');
  const salt = Buffer.alloc(0);
  const info = Buffer.from('tca-timer:session-cookie:v1');
  const derived = Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
  cachedKey = { secret, key: derived };
  return derived;
}

export function isSessionConfigured(): boolean {
  return getKey() !== null;
}

/**
 * Domain-separation label baked into the GCM AAD. Each cookie that
 * reuses `sealCookie`/`openCookie` MUST pass a distinct purpose so a
 * value sealed under one purpose can't be opened under another. The
 * session cookie hard-codes `'session'`; `routes/auth.ts` passes
 * `'login-intent'` for its short-lived state cookie.
 */
export const SESSION_PURPOSE = 'session';

function aadFor(purpose: string): Buffer {
  // The literal prefix prevents collisions with any historical
  // sealed-with-cookie-name values that might still be in flight
  // (none in production, but cheap insurance).
  return Buffer.from(`tca-timer:cookie:${purpose}`, 'utf8');
}

/**
 * AES-256-GCM seal of a JSON-encodable payload. The `purpose` becomes
 * the AAD, so opening with a different purpose throws.
 */
export function sealCookie(payload: unknown, purpose: string): string {
  const key = getKey();
  if (!key) throw new Error('session_secret_missing');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(purpose));
  const enc = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${Buffer.concat([enc, tag]).toString('base64url')}`;
}

/**
 * AES-256-GCM open. Returns `null` on any failure (bad format, wrong
 * key, wrong purpose / AAD mismatch, malformed JSON).
 */
export function openCookie(cookie: string, purpose: string): unknown {
  const key = getKey();
  if (!key) return null;
  const dot = cookie.indexOf('.');
  if (dot < 0) return null;
  let iv: Buffer;
  let body: Buffer;
  try {
    iv = Buffer.from(cookie.slice(0, dot), 'base64url');
    body = Buffer.from(cookie.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  if (iv.length !== 12 || body.length < 17) return null;
  const tag = body.subarray(body.length - 16);
  const enc = body.subarray(0, body.length - 16);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aadFor(purpose));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    return null;
  }
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    return null;
  }
}

export function encodeSession(payload: SessionPayload): string {
  return sealCookie(payload, SESSION_PURPOSE);
}

export function decodeSession(cookie: string, now = Date.now()): SessionPayload | null {
  const parsed = openCookie(cookie, SESSION_PURPOSE);
  if (!isSessionPayload(parsed)) return null;
  if (parsed.exp < now) return null;
  return parsed;
}

function isSessionPayload(v: unknown): v is SessionPayload {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.sub === 'string' &&
    typeof r.email === 'string' &&
    Array.isArray(r.groups) &&
    r.groups.every((g) => typeof g === 'string') &&
    typeof r.iat === 'number' &&
    typeof r.exp === 'number'
  );
}

export function newSessionPayload(id: JudgeIdentity, now = Date.now()): SessionPayload {
  return {
    sub: id.sub,
    email: id.email,
    groups: id.groups,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
}

/**
 * Set the session cookie on a Fastify reply. Honors the same
 * `Secure` heuristic as Fastify's `req.protocol`: in dev / behind
 * `localhost` we omit `Secure` so the cookie still rides on HTTP.
 */
export function setSessionCookie(
  reply: FastifyReply,
  payload: SessionPayload,
  opts: { secure: boolean },
): void {
  const value = encodeSession(payload);
  const attrs = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (opts.secure) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

export function clearSessionCookie(
  reply: FastifyReply,
  opts: { secure: boolean },
): void {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (opts.secure) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

export function readSessionFromRequest(req: FastifyRequest): SessionPayload | null {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const raw = cookies?.[SESSION_COOKIE_NAME];
  if (!raw) return null;
  return decodeSession(raw);
}

/**
 * If the session is past its renewal threshold but still valid, mint a
 * new payload (sliding window) so long-lived sessions keep working
 * without forcing a re-login on every page nav.
 */
export function maybeRenewSession(
  payload: SessionPayload,
  now = Date.now(),
): SessionPayload | null {
  if (now - payload.iat < SESSION_RENEW_AFTER_MS) return null;
  return {
    ...payload,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
}

/**
 * Resolve the calling judge's identity from either the session cookie
 * or the dev-bypass env. Returns `null` when no identity is established
 * (caller is responsible for the 401 / login redirect).
 *
 * Side effect: when the cookie is past the renewal threshold and a
 * `reply` is provided, this silently re-issues a fresh cookie so
 * long-lived sessions stay alive without forcing a re-login.
 */
export function identityFromRequest(
  req: FastifyRequest,
  reply?: FastifyReply,
): JudgeIdentity | null {
  if (isDevAuthBypassEnabled()) {
    return devAuthBypassIdentity();
  }
  const payload = readSessionFromRequest(req);
  if (!payload) return null;
  if (reply) {
    const renewed = maybeRenewSession(payload);
    if (renewed) {
      setSessionCookie(reply, renewed, { secure: isRequestSecure(req) });
    }
  }
  return { sub: payload.sub, email: payload.email, groups: payload.groups };
}

export function isRequestSecure(req: FastifyRequest): boolean {
  // Fastify with `trustProxy: true` resolves `protocol` to the value
  // signaled by `X-Forwarded-Proto` when present, which is what we
  // want behind Railway / Cloudflare. In tests / local docker the
  // request is plain HTTP and we don't want to refuse to set the
  // cookie just because we couldn't add `Secure`.
  return req.protocol === 'https';
}
