// Judge identity, group/role mapping, and the WebSocket ticket cache.
//
// Identity itself is now produced by the OIDC callback (`auth/oidc.ts`)
// and persisted in the encrypted session cookie (`auth/session.ts`),
// rather than re-verified from a Cloudflare Access JWT on every
// request as in the original §8.1 design. The downstream group model
// (`judges-admin`, `judges-<roomId>`) is unchanged so all of the
// authz code in `routes/*` and `ws/*` still goes through
// `judgeRoomAccess` / `hasRoomAccess` exactly as before.

import { randomBytes } from 'node:crypto';

export interface JudgeIdentity {
  sub: string;
  email: string;
  groups: string[];
}

// ---------------------------------------------------------------------------
// Dev-only auth bypass.
//
// `docker compose up` and host-side `npm run dev` both run without a
// real OIDC provider in front of the server, so every `/api/judge/*`
// call would otherwise redirect to login and the SPA can't be exercised
// end to end. Setting `DEV_AUTH_BYPASS=1` (the docker-compose dev
// profile sets this by default) makes `requireJudge` / `requireAdmin`
// return a synthetic identity instead of looking at the session
// cookie or initiating an OIDC redirect.
//
// Hard guard: this never activates when `NODE_ENV=production`, even if
// the flag is somehow set, so a misconfigured deploy can't accidentally
// drop auth. The Railway deploy template uses `NODE_ENV=production`.
//
// Customization (all optional):
//   * `DEV_AUTH_SUB`    — `sub` claim. Default: `dev-judge`.
//   * `DEV_AUTH_EMAIL`  — `email` claim. Default: `dev@local.test`.
//   * `DEV_AUTH_GROUPS` — comma-separated group list. Default:
//                         `judges-admin` so dev sessions can hit
//                         `/api/admin/*` routes too.
// ---------------------------------------------------------------------------

export function isDevAuthBypassEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const flag = process.env.DEV_AUTH_BYPASS;
  return flag === '1' || flag === 'true';
}

export function devAuthBypassIdentity(): JudgeIdentity {
  const sub = process.env.DEV_AUTH_SUB || 'dev-judge';
  const email = process.env.DEV_AUTH_EMAIL || 'dev@local.test';
  const rawGroups = process.env.DEV_AUTH_GROUPS;
  const groups = rawGroups
    ? rawGroups
        .split(',')
        .map((g) => g.trim())
        .filter((g) => g.length > 0)
    : ['judges-admin'];
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
// Ticket cache (§8.1): 30-second single-use WebSocket tickets. The
// session cookie can't ride the WebSocket upgrade in every browser
// (Safari historically), and we don't want to expose the long-lived
// session secret over the WS query string anyway, so the SPA mints a
// short-lived ticket via the authenticated REST surface and trades it
// for a `/judge` upgrade.
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
