// /api/admin/* REST routes (§11.2). Admin auth = `judges-admin` group.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';

import { type JudgeIdentity } from '../auth/identity.js';
import { identityFromRequest } from '../auth/session.js';
import { ROOM_ID_REGEX } from '../auth/identifiers.js';
import {
  insertRoom,
  updateRoomKey,
  getRoom,
  insertAuditEvent,
  archiveRoom,
  unarchiveRoom,
  listAllRooms,
} from '../db/dal.js';

async function requireAdmin(
  req: FastifyRequest & { judgeIdentity?: JudgeIdentity },
  reply: FastifyReply,
): Promise<JudgeIdentity | null> {
  if (!req.judgeIdentity) {
    const id = identityFromRequest(req, reply);
    if (!id) {
      reply.header('www-authenticate', 'Session realm="tca-timer", login="/api/auth/login"');
      void reply.code(401).send({ error: 'no_session', login: '/api/auth/login' });
      return null;
    }
    req.judgeIdentity = id;
  }
  if (!req.judgeIdentity.groups.includes('judges-admin')) {
    void reply.code(403).send({ error: 'not_admin' });
    return null;
  }
  return req.judgeIdentity;
}

/**
 * Freshly-minted room key (§8.2). 32 random bytes → 43 URL-safe chars,
 * well inside the `ROOM_KEY_REGEX` bounds enforced at the contestant
 * upgrade. Stored plaintext: the only thing the key gates is "connect
 * a contestant overlay here", a leak is low-consequence, and admins
 * need to be able to retrieve it after creation.
 */
function newRoomKey(): string {
  return randomBytes(32).toString('base64url');
}

export function registerAdminRoutes(app: FastifyInstance): void {
  // Admin-scoped listing that includes archived rooms. The judge-side
  // `/api/judge/rooms` deliberately omits archived rooms so non-admin
  // judges never see them; the admin UI needs the full picture so it
  // can render the "Archived" section.
  app.get('/api/admin/rooms', async (req, reply) => {
    const id = await requireAdmin(req, reply);
    if (!id) return;
    const all = await listAllRooms();
    return {
      rooms: all.map((r) => ({
        id: r.id,
        display_label: r.display_label,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        archived_at:
          r.archived_at instanceof Date
            ? r.archived_at.toISOString()
            : r.archived_at,
      })),
    };
  });

  app.post('/api/admin/rooms', async (req, reply) => {
    const id = await requireAdmin(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as { id?: string; display_label?: string };
    if (!body.id || !ROOM_ID_REGEX.test(body.id)) {
      return reply.code(400).send({ error: 'bad_room_id' });
    }
    if (!body.display_label || typeof body.display_label !== 'string') {
      return reply.code(400).send({ error: 'bad_display_label' });
    }
    const existing = await getRoom(body.id);
    if (existing) {
      return reply.code(409).send({ error: 'room_exists' });
    }
    const roomKey = newRoomKey();
    try {
      await insertRoom(body.id, body.display_label, roomKey);
    } catch (err) {
      return reply.code(500).send({ error: 'db_error', detail: (err as Error).message });
    }
    try {
      await insertAuditEvent({
        room: body.id,
        atServerMs: Date.now(),
        actorSub: id.sub,
        actorEmail: id.email,
        eventType: 'ROOM_CREATED',
        payload: { display_label: body.display_label },
      });
    } catch {
      /* degraded ring handles */
    }
    reply.code(201);
    return { id: body.id, display_label: body.display_label, room_key: roomKey };
  });

  // Soft-delete a room. The row stays in `rooms` (so existing audit
  // entries, timer history, and contestant overlay keys keep
  // resolving) but `/api/judge/rooms` filters it out so it disappears
  // from the everyday list. Reverse with `/unarchive` below.
  app.post('/api/admin/rooms/:id/archive', async (req, reply) => {
    const id = await requireAdmin(req, reply);
    if (!id) return;
    const params = req.params as { id: string };
    if (!ROOM_ID_REGEX.test(params.id)) {
      return reply.code(400).send({ error: 'bad_room_id' });
    }
    const existing = await getRoom(params.id);
    if (!existing) return reply.code(404).send({ error: 'unknown_room' });
    // Already archived → 200 + the existing timestamp. Idempotent so a
    // double-tap on the UI button doesn't 409 or rewrite the original
    // archive time. The DAL `UPDATE … WHERE archived_at IS NULL`
    // guard preserves the original timestamp on the way through.
    if (existing.archived_at) {
      return {
        id: params.id,
        archived_at:
          existing.archived_at instanceof Date
            ? existing.archived_at.toISOString()
            : existing.archived_at,
      };
    }
    try {
      await archiveRoom(params.id);
    } catch (err) {
      return reply.code(500).send({ error: 'db_error', detail: (err as Error).message });
    }
    try {
      await insertAuditEvent({
        room: params.id,
        atServerMs: Date.now(),
        actorSub: id.sub,
        actorEmail: id.email,
        eventType: 'ROOM_ARCHIVED',
        payload: {},
      });
    } catch {}
    // Re-read so the response reflects the timestamp Postgres just
    // assigned via `now()`. Avoids the SPA having to round-trip a
    // listing call to learn the value.
    const after = await getRoom(params.id);
    return {
      id: params.id,
      archived_at:
        after?.archived_at instanceof Date
          ? after.archived_at.toISOString()
          : (after?.archived_at ?? null),
    };
  });

  app.post('/api/admin/rooms/:id/unarchive', async (req, reply) => {
    const id = await requireAdmin(req, reply);
    if (!id) return;
    const params = req.params as { id: string };
    if (!ROOM_ID_REGEX.test(params.id)) {
      return reply.code(400).send({ error: 'bad_room_id' });
    }
    const existing = await getRoom(params.id);
    if (!existing) return reply.code(404).send({ error: 'unknown_room' });
    if (!existing.archived_at) {
      return { id: params.id, archived_at: null };
    }
    try {
      await unarchiveRoom(params.id);
    } catch (err) {
      return reply.code(500).send({ error: 'db_error', detail: (err as Error).message });
    }
    try {
      await insertAuditEvent({
        room: params.id,
        atServerMs: Date.now(),
        actorSub: id.sub,
        actorEmail: id.email,
        eventType: 'ROOM_UNARCHIVED',
        payload: {},
      });
    } catch {}
    return { id: params.id, archived_at: null };
  });

  app.post('/api/admin/rooms/:id/rotate-key', async (req, reply) => {
    const id = await requireAdmin(req, reply);
    if (!id) return;
    const params = req.params as { id: string };
    if (!ROOM_ID_REGEX.test(params.id)) {
      return reply.code(400).send({ error: 'bad_room_id' });
    }
    const existing = await getRoom(params.id);
    if (!existing) return reply.code(404).send({ error: 'unknown_room' });
    const roomKey = newRoomKey();
    try {
      await updateRoomKey(params.id, roomKey);
    } catch (err) {
      return reply.code(500).send({ error: 'db_error', detail: (err as Error).message });
    }
    try {
      await insertAuditEvent({
        room: params.id,
        atServerMs: Date.now(),
        actorSub: id.sub,
        actorEmail: id.email,
        eventType: 'ROOM_KEY_ROTATED',
        payload: {},
      });
    } catch {}
    return { id: params.id, room_key: roomKey };
  });
}
