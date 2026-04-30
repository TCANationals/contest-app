// Twilio and SES webhook handlers (§7.4.2, §7.4.3).

import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  findJudgeByPhone,
  findJudgeByEmail,
  setEmailStatus,
  setPhoneStatus,
  insertAuditEvent,
} from '../db/dal.js';

export function registerWebhookRoutes(app: FastifyInstance): void {
  // Twilio status callback. Validates the X-Twilio-Signature header per
  // https://www.twilio.com/docs/usage/webhooks/webhooks-security.
  app.post('/api/webhooks/twilio', async (req, reply) => {
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!token) return reply.code(503).send({ error: 'twilio_not_configured' });

    const signature = req.headers['x-twilio-signature'] as string | undefined;
    if (!signature) return reply.code(401).send({ error: 'missing_signature' });

    const url = `${req.protocol}://${req.headers.host}${req.url}`;
    const body = (req.body ?? {}) as Record<string, string>;
    const expected = computeTwilioSignature(token, url, body);
    if (!safeEq(signature, expected)) {
      return reply.code(401).send({ error: 'bad_signature' });
    }

    const smsStatus = body.SmsStatus || body.MessageStatus;
    const fromNumber = body.From;
    // Unsubscribe / STOP notifications arrive with OptOutType / SmsStatus === 'received'
    // and Body like 'STOP'. The simpler signal is the OptOut* Messaging Service
    // webhook but keep the generic STOP path for portability.
    const inbound = (body.Body || '').trim().toUpperCase();
    if (inbound === 'STOP' || inbound === 'UNSUBSCRIBE' || inbound === 'CANCEL' || inbound === 'END' || inbound === 'QUIT') {
      if (fromNumber) {
        const judge = await findJudgeByPhone(fromNumber);
        if (judge) {
          await setPhoneStatus(judge.sub, 'opted_out');
          await insertAuditEvent({
            room: judge.enabled_rooms[0] ?? '_global_',
            atServerMs: Date.now(),
            actorSub: 'system',
            actorEmail: null,
            eventType: 'SMS_OPTED_OUT',
            payload: { judgeSub: judge.sub },
          }).catch(() => {});
        }
      }
    }
    return { ok: true, smsStatus };
  });

  // SES → SNS → HTTPS endpoint. Handles subscription confirmation and
  // bounce/complaint notifications. Uses the `sns-validator` library.
  app.post('/api/webhooks/ses', async (req, reply) => {
    const raw = req.body as Record<string, unknown>;
    const snsModule = (await import('sns-validator')) as unknown as {
      default: new () => { validate: (m: unknown, cb: (err?: Error | null) => void) => void };
    };
    const MessageValidator = snsModule.default;
    const validator = new MessageValidator();

    try {
      await new Promise<void>((resolve, reject) => {
        validator.validate(raw, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      return reply.code(401).send({ error: 'bad_signature', detail: (err as Error).message });
    }

    const type = raw.Type as string | undefined;
    if (type === 'SubscriptionConfirmation') {
      // Visiting the SubscribeURL confirms the subscription.
      const url = raw.SubscribeURL as string | undefined;
      if (url) {
        try {
          await fetch(url);
        } catch (err) {
          app.log.warn({ err }, 'sns subscription confirmation failed');
        }
      }
      return { ok: true, confirmed: true };
    }

    if (type === 'Notification') {
      const message = typeof raw.Message === 'string' ? JSON.parse(raw.Message) : raw.Message;
      const notification = message as {
        notificationType?: string;
        bounce?: { bouncedRecipients?: Array<{ emailAddress: string }>; bounceType?: string };
        complaint?: { complainedRecipients?: Array<{ emailAddress: string }> };
      };

      const kind =
        notification.notificationType === 'Bounce'
          ? 'bounce'
          : notification.notificationType === 'Complaint'
            ? 'complaint'
            : null;
      if (!kind) return { ok: true, ignored: true };

      const recipients =
        kind === 'bounce'
          ? notification.bounce?.bouncedRecipients ?? []
          : notification.complaint?.complainedRecipients ?? [];

      // Per spec §7.4.3: hard bounces and complaints -> opted_out.
      for (const r of recipients) {
        const judge = await findJudgeByEmail(r.emailAddress);
        if (judge) {
          await setEmailStatus(judge.sub, 'opted_out');
          await insertAuditEvent({
            room: judge.enabled_rooms[0] ?? '_global_',
            atServerMs: Date.now(),
            actorSub: 'system',
            actorEmail: null,
            eventType: 'EMAIL_OPTED_OUT',
            payload: { judgeSub: judge.sub, kind },
          }).catch(() => {});
        }
      }
      return { ok: true };
    }

    return { ok: true, ignored: true };
  });
}

function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, k) => acc + k + (params[k] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
