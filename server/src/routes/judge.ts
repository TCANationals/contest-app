// /api/judge/* REST routes (§11.2).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import type {
  AuditLogEntry,
  WirePrefs,
  WireRoom,
  WireTicket,
  WireVerifyEmail,
  WireVerifyPhone,
} from '@tca-timer/shared/api';

import {
  verifyCfAccessJwt,
  ticketCache,
  judgeRoomAccess,
  hasRoomAccess,
  loadCfJwtConfig,
  isDevAuthBypassEnabled,
  devAuthBypassIdentity,
  type JudgeIdentity,
} from '../auth/cf-jwt.js';
import {
  listActiveRooms,
  getJudgePrefs,
  upsertJudgePrefs,
  queryAuditLog,
  setPhoneStatus,
  setEmailStatus,
  insertAuditEvent,
  type JudgePrefsRow,
} from '../db/dal.js';
import { ROOM_ID_REGEX } from '../auth/room-token.js';
import { isE164 } from '../notify/twilio.js';
import { isEmailAddress } from '../notify/ses.js';

type MaybeWithAuth = FastifyRequest & { judgeIdentity?: JudgeIdentity };

async function requireJudge(
  req: MaybeWithAuth,
  reply: FastifyReply,
): Promise<JudgeIdentity | null> {
  if (req.judgeIdentity) return req.judgeIdentity;

  // Dev-only escape hatch (see `auth/cf-jwt.ts`). Disabled when
  // NODE_ENV=production so a misconfigured prod env can't drop auth.
  if (isDevAuthBypassEnabled()) {
    const id = devAuthBypassIdentity();
    req.judgeIdentity = id;
    return id;
  }

  const headerJwt =
    (req.headers['cf-access-jwt-assertion'] as string | undefined) ??
    (req.headers['Cf-Access-Jwt-Assertion'] as string | undefined);
  const cookie = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies
    ?.CF_Authorization;
  const jwt = headerJwt || cookie;

  if (!jwt) {
    void reply.code(401).send({ error: 'missing_jwt' });
    return null;
  }

  try {
    const id = await verifyCfAccessJwt(jwt);
    req.judgeIdentity = id;
    return id;
  } catch (err) {
    void reply.code(401).send({ error: 'bad_jwt', detail: (err as Error).message });
    return null;
  }
}

export function registerJudgeRoutes(app: FastifyInstance): void {
  app.post('/api/judge/ticket', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const ticket = ticketCache.mint(id);
    const out: WireTicket = { ticket, expiresInMs: 30_000 };
    return out;
  });

  app.get('/api/judge/rooms', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const all = await listActiveRooms();
    const access = judgeRoomAccess(id.groups);
    const visible = access === 'all' ? all : all.filter((r) => access.includes(r.id));
    const rooms: WireRoom[] = visible.map((r) => ({
      id: r.id,
      display_label: r.display_label,
      // `created_at` is a Date in the row; serialize to an ISO string
      // so the wire shape is stable JSON.
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }));
    return { rooms };
  });

  app.get('/api/judge/log', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const q = req.query as { room?: string; since?: string; limit?: string; all?: string };
    const allRooms = q.all === '1' && hasRoomAccess(id.groups, '__admin__internal__');
    const isAdmin = judgeRoomAccess(id.groups) === 'all';
    const room = q.room;
    if (!room && !(isAdmin && allRooms)) {
      return reply.code(400).send({ error: 'room_required' });
    }
    if (room && !hasRoomAccess(id.groups, room)) {
      return reply.code(403).send({ error: 'forbidden_room' });
    }
    const since = q.since ? Number(q.since) : undefined;
    const limit = q.limit ? Math.min(Number(q.limit), 10_000) : 1000;
    const rows = await queryAuditLog({ room, since, limit });
    // The DAL types `id` as optional (it's only populated on read, not
    // on insert). Every row coming out of `queryAuditLog` does carry
    // an id from the `BIGSERIAL` column, so the cast is a contract
    // narrowing — the wire schema requires `id`.
    const entries = rows as AuditLogEntry[];
    return { entries };
  });

  app.get('/api/judge/log.csv', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const q = req.query as { room?: string; since?: string };
    if (!q.room || !hasRoomAccess(id.groups, q.room)) {
      return reply.code(403).send({ error: 'forbidden_room' });
    }
    const since = q.since ? Number(q.since) : undefined;
    const rows = await queryAuditLog({ room: q.room, since, limit: 10_000 });
    const header = ['id', 'room', 'at_server_ms', 'actor_sub', 'actor_email', 'event_type', 'payload'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          '',
          r.room,
          r.atServerMs,
          r.actorSub,
          r.actorEmail ?? '',
          r.eventType,
          JSON.stringify(r.payload),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="audit-${q.room}.csv"`);
    return lines.join('\n');
  });

  app.get('/api/judge/prefs', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const row = await getJudgePrefs(id.sub);
    return { prefs: prefsToWire(row, id) };
  });

  app.put('/api/judge/prefs', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as Partial<{
      phoneE164: string | null;
      emailAddress: string | null;
      enabledRooms: string[];
      quietHoursStart: string | null;
      quietHoursEnd: string | null;
      quietHoursWeekdays: number;
      timezone: string;
    }>;

    const existing = await getJudgePrefs(id.sub);
    const updates: Parameters<typeof upsertJudgePrefs>[0] = {
      sub: id.sub,
      lastSeenEmail: id.email,
      enabledRooms: Array.isArray(body.enabledRooms)
        ? body.enabledRooms.filter((r) => typeof r === 'string' && ROOM_ID_REGEX.test(r))
        : existing?.enabled_rooms ?? [],
      quietHoursStart: body.quietHoursStart ?? existing?.quiet_hours_start ?? null,
      quietHoursEnd: body.quietHoursEnd ?? existing?.quiet_hours_end ?? null,
      quietHoursWeekdays:
        typeof body.quietHoursWeekdays === 'number'
          ? Math.max(0, Math.min(127, body.quietHoursWeekdays | 0))
          : existing?.quiet_hours_weekdays ?? 0,
      timezone: typeof body.timezone === 'string' ? body.timezone : existing?.timezone ?? 'UTC',
    };

    if ('phoneE164' in body) {
      if (body.phoneE164 == null) {
        updates.phoneE164 = null;
        updates.phoneStatus = 'none';
        updates.pendingPhoneCodeHash = null;
        updates.pendingPhoneExpiresAt = null;
      } else if (isE164(body.phoneE164)) {
        const code = sixDigitCode();
        updates.phoneE164 = body.phoneE164;
        updates.phoneStatus = 'pending';
        updates.pendingPhoneCodeHash = sha256(code);
        updates.pendingPhoneExpiresAt = new Date(Date.now() + 10 * 60_000);
        req.log.info({ sub: id.sub }, 'phone verification code generated');
        // Fire-and-forget verification SMS; implementation-specific delivery
        // happens out-of-band (Twilio).
        void (async () => {
          try {
            const { sendSms } = await import('../notify/twilio.js');
            await sendSms({
              to: body.phoneE164!,
              body: `TCA Timer verification code: ${code}`,
            });
          } catch {
            /* logged separately if configured */
          }
        })();
      } else {
        return reply.code(400).send({ error: 'bad_phone' });
      }
    }

    if ('emailAddress' in body) {
      if (body.emailAddress == null) {
        updates.emailAddress = null;
        updates.emailStatus = 'none';
        updates.pendingEmailCodeHash = null;
        updates.pendingEmailExpiresAt = null;
      } else if (isEmailAddress(body.emailAddress)) {
        const code = sixDigitCode();
        updates.emailAddress = body.emailAddress;
        updates.emailStatus = 'pending';
        updates.pendingEmailCodeHash = sha256(code);
        updates.pendingEmailExpiresAt = new Date(Date.now() + 10 * 60_000);
        req.log.info({ sub: id.sub }, 'email verification code generated');
        void (async () => {
          try {
            const { sendEmail } = await import('../notify/ses.js');
            await sendEmail({
              to: body.emailAddress!,
              subject: 'TCA Timer — verify your email',
              body: `Verification code: ${code}\n\nThis code expires in 10 minutes.`,
            });
          } catch {
            /* logged separately */
          }
        })();
      } else {
        return reply.code(400).send({ error: 'bad_email' });
      }
    }

    await upsertJudgePrefs(updates);
    const row = await getJudgePrefs(id.sub);
    return { prefs: prefsToWire(row, id) };
  });

  app.post('/api/judge/prefs/verify-phone', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code || typeof code !== 'string') return reply.code(400).send({ error: 'bad_code' });
    const row = await getJudgePrefs(id.sub);
    if (!row || !row.pending_phone_code_hash || !row.pending_phone_expires_at) {
      return reply.code(400).send({ error: 'no_pending' });
    }
    if (row.pending_phone_expires_at.getTime() < Date.now()) {
      return reply.code(400).send({ error: 'expired' });
    }
    if (!constantTimeEquals(sha256(code), row.pending_phone_code_hash)) {
      return reply.code(400).send({ error: 'bad_code' });
    }
    await setPhoneStatus(id.sub, 'verified');
    const out: WireVerifyPhone = { phoneStatus: 'verified' };
    return out;
  });

  app.post('/api/judge/prefs/verify-email', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code || typeof code !== 'string') return reply.code(400).send({ error: 'bad_code' });
    const row = await getJudgePrefs(id.sub);
    if (!row || !row.pending_email_code_hash || !row.pending_email_expires_at) {
      return reply.code(400).send({ error: 'no_pending' });
    }
    if (row.pending_email_expires_at.getTime() < Date.now()) {
      return reply.code(400).send({ error: 'expired' });
    }
    if (!constantTimeEquals(sha256(code), row.pending_email_code_hash)) {
      return reply.code(400).send({ error: 'bad_code' });
    }
    await setEmailStatus(id.sub, 'verified');
    const out: WireVerifyEmail = { emailStatus: 'verified' };
    return out;
  });

  // Diagnostic / health info about CF Access configuration.
  app.get('/api/judge/whoami', async (req, reply) => {
    const id = await requireJudge(req, reply);
    if (!id) return;
    return { sub: id.sub, email: id.email, groups: id.groups, access: judgeRoomAccess(id.groups) };
  });

  app.addHook('onReady', async () => {
    if (isDevAuthBypassEnabled()) {
      const id = devAuthBypassIdentity();
      app.log.warn(
        { sub: id.sub, email: id.email, groups: id.groups },
        'DEV_AUTH_BYPASS active — JWT verification disabled, all requests run as the synthetic dev judge. Never enable in production.',
      );
    } else if (!loadCfJwtConfig()) {
      app.log.warn('CF Access config not set; /api/judge/* will reject all requests');
    }
  });

  // Satisfy unused-function lint until the admin surface pulls it in.
  void insertAuditEvent;
}

// Annotated with the shared `WirePrefs` so any drift between the
// server's response and the contract in `@tca-timer/shared/api` (which
// the SPA also consumes) becomes a TypeScript error here.
function prefsToWire(row: JudgePrefsRow | null, id: JudgeIdentity): WirePrefs {
  if (!row) {
    return {
      sub: id.sub,
      email: id.email,
      phoneE164: null,
      phoneStatus: 'none',
      emailAddress: null,
      emailStatus: 'none',
      enabledRooms: [],
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursWeekdays: 0,
      timezone: 'UTC',
    };
  }
  return {
    sub: row.sub,
    email: id.email,
    phoneE164: row.phone_e164,
    phoneStatus: row.phone_status,
    emailAddress: row.email_address,
    emailStatus: row.email_status,
    enabledRooms: row.enabled_rooms,
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    quietHoursWeekdays: row.quiet_hours_weekdays,
    timezone: row.timezone,
  };
}

function sixDigitCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function csvCell(v: unknown): string {
  const s = typeof v === 'string' ? v : String(v ?? '');
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
