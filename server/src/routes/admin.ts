// /api/admin/* REST routes (§11.2). Admin auth = `judges-admin` group.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';

import { verifyCfAccessJwt, type JudgeIdentity } from '../auth/cf-jwt.js';
import { hashRoomToken, ROOM_ID_REGEX } from '../auth/room-token.js';
import {
  insertRoom,
  updateRoomTokenHash,
  getRoom,
  insertAuditEvent,
} from '../db/dal.js';

async function requireAdmin(
  req: FastifyRequest & { judgeIdentity?: JudgeIdentity },
  reply: FastifyReply,
): Promise<JudgeIdentity | null> {
  if (!req.judgeIdentity) {
    const headerJwt = req.headers['cf-access-jwt-assertion'] as string | undefined;
    const cookie = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies
      ?.CF_Authorization;
    const jwt = headerJwt || cookie;
    if (!jwt) {
      void reply.code(401).send({ error: 'missing_jwt' });
      return null;
    }
    try {
      req.judgeIdentity = await verifyCfAccessJwt(jwt);
    } catch (err) {
      void reply.code(401).send({ error: 'bad_jwt', detail: (err as Error).message });
      return null;
    }
  }
  if (!req.judgeIdentity.groups.includes('judges-admin')) {
    void reply.code(403).send({ error: 'not_admin' });
    return null;
  }
  return req.judgeIdentity;
}

function newRoomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function registerAdminRoutes(app: FastifyInstance): void {
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
    const token = newRoomToken();
    const tokenHash = await hashRoomToken(token);
    try {
      await insertRoom(body.id, body.display_label, tokenHash);
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
    return { id: body.id, display_label: body.display_label, token };
  });

  app.post('/api/admin/rooms/:id/rotate-token', async (req, reply) => {
    const id = await requireAdmin(req, reply);
    if (!id) return;
    const params = req.params as { id: string };
    if (!ROOM_ID_REGEX.test(params.id)) {
      return reply.code(400).send({ error: 'bad_room_id' });
    }
    const existing = await getRoom(params.id);
    if (!existing) return reply.code(404).send({ error: 'unknown_room' });
    const token = newRoomToken();
    const tokenHash = await hashRoomToken(token);
    try {
      await updateRoomTokenHash(params.id, tokenHash);
    } catch (err) {
      return reply.code(500).send({ error: 'db_error', detail: (err as Error).message });
    }
    try {
      await insertAuditEvent({
        room: params.id,
        atServerMs: Date.now(),
        actorSub: id.sub,
        actorEmail: id.email,
        eventType: 'ROOM_TOKEN_ROTATED',
        payload: {},
      });
    } catch {}
    return { id: params.id, token };
  });
}
