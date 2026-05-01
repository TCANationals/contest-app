// OIDC client (Authorization Code + PKCE) for the judge SPA.
//
// Replaces the previous Cloudflare-Access-cookie-on-every-request model
// (§8.1) with a generic, server-mediated OIDC login flow. The server is
// the OIDC client; the SPA never sees an access/ID token. After a
// successful callback, identity is persisted in the encrypted session
// cookie owned by `auth/session.ts`.
//
// Single-provider on purpose: this app only ever wants one identity
// provider configured at a time. Cloudflare Access (with an OIDC SaaS
// app), Google, Microsoft, Okta, Auth0, etc. all expose the same
// discovery + code-flow surface, so a single set of env vars works for
// all of them.
//
// Required env (when not in `DEV_AUTH_BYPASS` mode):
//   OIDC_ISSUER          — base URL of the IdP (discovery doc lives at
//                          `${issuer}/.well-known/openid-configuration`).
//   OIDC_CLIENT_ID       — public client id.
//   OIDC_CLIENT_SECRET   — confidential client secret. Required for the
//                          standard `client_secret_basic` auth method;
//                          set to empty string for IdPs that allow
//                          public clients (rare for server-side flows).
//   OIDC_REDIRECT_URI    — the absolute URL of /api/auth/callback as
//                          seen by the user agent (e.g. https://timer.example.com/api/auth/callback).
//   SESSION_SECRET       — ≥32 characters; used by `auth/session.ts`.
//
// Optional env:
//   OIDC_SCOPES          — defaults to `openid profile email`.
//   OIDC_GROUPS_CLAIM    — name of an ID-token claim to read groups
//                          from. Defaults to `groups`. Cloudflare
//                          Access populates this; Google/Microsoft do
//                          not, in which case combine with
//                          OIDC_ADMIN_EMAILS / OIDC_ALLOW_ALL_ROOMS.
//   OIDC_ADMIN_EMAILS    — comma-separated email allowlist; matching
//                          users get added to the synthetic
//                          `judges-admin` group post-mapping.
//   OIDC_ALLOW_ALL_ROOMS — `1`/`true`: every authenticated user gets
//                          `judges-admin`. Useful for tiny single-
//                          tenant deploys; not recommended for shared
//                          IdPs.

import { Issuer, generators, type Client, type IdTokenClaims } from 'openid-client';

import type { JudgeIdentity } from './identity.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  groupsClaim: string;
  adminEmails: Set<string>;
  allowAllRooms: boolean;
}

export function loadOidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const redirectUri = process.env.OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !redirectUri) return null;
  return {
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    redirectUri,
    scopes: process.env.OIDC_SCOPES ?? 'openid profile email',
    groupsClaim: process.env.OIDC_GROUPS_CLAIM ?? 'groups',
    adminEmails: new Set(
      (process.env.OIDC_ADMIN_EMAILS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    allowAllRooms: ['1', 'true'].includes(
      (process.env.OIDC_ALLOW_ALL_ROOMS ?? '').toLowerCase(),
    ),
  };
}

let cachedClient: { issuerUrl: string; clientId: string; client: Client } | null = null;

export async function getOidcClient(cfg: OidcConfig): Promise<Client> {
  if (
    cachedClient &&
    cachedClient.issuerUrl === cfg.issuer &&
    cachedClient.clientId === cfg.clientId
  ) {
    return cachedClient.client;
  }
  const issuer = await Issuer.discover(cfg.issuer);
  const client = new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret || undefined,
    redirect_uris: [cfg.redirectUri],
    response_types: ['code'],
    // `client_secret_basic` is the OIDC default; if no secret is
    // configured (public client), fall back to `none`.
    token_endpoint_auth_method: cfg.clientSecret ? 'client_secret_basic' : 'none',
  });
  cachedClient = { issuerUrl: cfg.issuer, clientId: cfg.clientId, client };
  return client;
}

/**
 * One-shot per-login state pulled from the cryptographic generators
 * inside openid-client. The state + nonce + code_verifier all need to
 * survive the round-trip to the IdP, which is what we put inside the
 * encrypted login-state cookie set by `routes/auth.ts`.
 */
export interface OidcLoginIntent {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

export function newLoginIntent(returnTo: string): OidcLoginIntent {
  return {
    state: generators.state(),
    nonce: generators.nonce(),
    codeVerifier: generators.codeVerifier(),
    returnTo,
  };
}

export async function authorizationUrl(
  cfg: OidcConfig,
  intent: OidcLoginIntent,
): Promise<string> {
  const client = await getOidcClient(cfg);
  const codeChallenge = generators.codeChallenge(intent.codeVerifier);
  return client.authorizationUrl({
    scope: cfg.scopes,
    state: intent.state,
    nonce: intent.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: cfg.redirectUri,
  });
}

/**
 * Exchange the IdP's authorization code for tokens, validate, and
 * project the ID-token claims onto a `JudgeIdentity`.
 */
export async function completeLogin(
  cfg: OidcConfig,
  intent: OidcLoginIntent,
  callbackUrl: string,
): Promise<JudgeIdentity> {
  const client = await getOidcClient(cfg);
  const params = client.callbackParams(callbackUrl);
  const tokenSet = await client.callback(cfg.redirectUri, params, {
    state: intent.state,
    nonce: intent.nonce,
    code_verifier: intent.codeVerifier,
  });
  const claims = tokenSet.claims();
  return identityFromClaims(cfg, claims);
}

export function identityFromClaims(cfg: OidcConfig, claims: IdTokenClaims): JudgeIdentity {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) throw new Error('missing_sub');
  const email = typeof claims.email === 'string' ? claims.email : '';
  const rawGroups = (claims as Record<string, unknown>)[cfg.groupsClaim];
  const claimGroups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === 'string')
    : [];

  // Merge: claim groups + admin allowlist (config-side) + optional
  // wildcard. Deduplicate so downstream `judgeRoomAccess` sees a
  // canonical list.
  const groups = new Set(claimGroups);
  if (cfg.allowAllRooms) groups.add('judges-admin');
  if (email && cfg.adminEmails.has(email.toLowerCase())) groups.add('judges-admin');

  return { sub, email, groups: Array.from(groups) };
}
