// Cloudflare Access JWT verification (§8.1).

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes } from 'node:crypto';

export interface JudgeIdentity {
  sub: string;
  email: string;
  groups: string[];
}

interface CfJwtConfig {
  aud: string;
  issuer: string;
  jwksUrl: string;
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;

function getJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks && cachedJwksUrl === jwksUrl) return cachedJwks;
  cachedJwks = createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: 60 * 60 * 1000,
  });
  cachedJwksUrl = jwksUrl;
  return cachedJwks;
}

export function loadCfJwtConfig(): CfJwtConfig | null {
  const aud = process.env.CF_ACCESS_AUD;
  const issuer = process.env.CF_ACCESS_ISSUER;
  const jwksUrl = process.env.CF_ACCESS_JWKS_URL;
  if (!aud || !issuer || !jwksUrl) return null;
  return { aud, issuer, jwksUrl };
}

/**
 * Verify a Cloudflare Access JWT and return the judge identity.
 * Throws on any failure (expired, wrong audience, bad signature, etc.).
 */
export async function verifyCfAccessJwt(
  jwt: string,
  config: CfJwtConfig | null = loadCfJwtConfig(),
): Promise<JudgeIdentity> {
  if (!config) {
    throw new Error('cf_access_not_configured');
  }
  const jwks = getJwks(config.jwksUrl);
  const { payload } = await jwtVerify(jwt, jwks, {
    audience: config.aud,
    issuer: config.issuer,
  });
  return extractIdentity(payload);
}

export function extractIdentity(payload: JWTPayload): JudgeIdentity {
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) throw new Error('missing_sub');
  const email = typeof payload.email === 'string' ? payload.email : '';
  const rawGroups = (payload as { groups?: unknown }).groups;
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === 'string')
    : [];
  return { sub, email, groups };
}

export function judgeRoomAccess(groups: string[]): 'all' | string[] {
  if (groups.includes('judges-admin')) return 'all';
  return groups
    .filter((g) => g.startsWith('judges-'))
    .map((g) => g.slice('judges-'.length));
}

export function hasRoomAccess(groups: string[], roomId: string): boolean {
  const access = judgeRoomAccess(groups);
  return access === 'all' || access.includes(roomId);
}

// ---------------------------------------------------------------------------
// Ticket cache (§8.1): 30-second single-use WebSocket tickets.
// ---------------------------------------------------------------------------

export interface TicketRecord {
  sub: string;
  email: string;
  groups: string[];
  expiresAt: number;
}

export const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 4096;

class TicketCache {
  private readonly tickets = new Map<string, TicketRecord>();

  mint(identity: JudgeIdentity, now: number = Date.now()): string {
    this.prune(now);
    if (this.tickets.size >= MAX_TICKETS) {
      // Drop oldest; Map iterates in insertion order.
      const oldest = this.tickets.keys().next().value;
      if (oldest) this.tickets.delete(oldest);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      sub: identity.sub,
      email: identity.email,
      groups: identity.groups,
      expiresAt: now + TICKET_TTL_MS,
    });
    return ticket;
  }

  /** Single-use redemption: removes the ticket on success. */
  redeem(ticket: string, now: number = Date.now()): TicketRecord | null {
    const rec = this.tickets.get(ticket);
    if (!rec) return null;
    this.tickets.delete(ticket);
    if (rec.expiresAt < now) return null;
    return rec;
  }

  private prune(now: number): void {
    for (const [k, v] of this.tickets) {
      if (v.expiresAt < now) this.tickets.delete(k);
    }
  }
}

export const ticketCache = new TicketCache();
