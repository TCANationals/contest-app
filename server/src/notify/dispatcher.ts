// Notification dispatcher (§7.4). Debounce + auto-cancel + fan-out.
//
// When a HELP_REQUEST transitions the queue from empty to non-empty, the
// dispatcher schedules a job for 5 seconds later. At fire time the worker
// re-checks the queue; if the original requester is gone (cancelled or
// acknowledged) the job is dropped (NOTIFY_DROPPED). Otherwise it fans out
// SMS (Twilio) and email (SES) to every qualifying judge in parallel with a
// single retry on transient failure.

import {
  findJudgesForRoom,
  insertAuditEvent,
  enqueueRetry,
  type JudgePrefsRow,
} from '../db/dal.js';
import { isInQueue } from '../help-queue.js';
import type { HelpQueue } from '../help-queue.js';
import { sendSms, loadTwilioConfig } from './twilio.js';
import { sendEmail, loadSesConfig } from './ses.js';
import { isInQuietHours } from './quiet-hours.js';

export const DISPATCH_DELAY_MS = 5_000;
export const JUDGE_DEBOUNCE_MS = 30_000;
const RETRY_DELAY_MS = 10_000;

export interface DispatchContext {
  room: string;
  displayLabel: string;
  contestantId: string;
  requestedAtServerMs: number;
  getQueue: () => HelpQueue;
  judgeAckedAt: Map<string, number>;
  publicOrigin: string;
}

export interface DispatchHandle {
  cancel: () => void;
}

export function scheduleNotification(ctx: DispatchContext): DispatchHandle {
  const timer = setTimeout(() => {
    void fireDispatch(ctx).catch(() => {
      // swallow; individual send errors are logged to audit_log inside
    });
  }, DISPATCH_DELAY_MS);
  timer.unref?.();
  return {
    cancel: () => clearTimeout(timer),
  };
}

async function fireDispatch(ctx: DispatchContext): Promise<void> {
  const queueNow = ctx.getQueue();
  if (!isInQueue(queueNow, ctx.contestantId)) {
    await safeAudit({
      room: ctx.room,
      atServerMs: Date.now(),
      actorSub: 'system',
      actorEmail: null,
      eventType: 'NOTIFY_DROPPED',
      payload: { contestantId: ctx.contestantId, judgesPrepared: 0 },
    });
    return;
  }

  let judges: JudgePrefsRow[] = [];
  try {
    judges = await findJudgesForRoom(ctx.room);
  } catch {
    judges = [];
  }

  const now = new Date();
  const qualifying = judges.filter((j) => qualifies(j, ctx, now));
  if (qualifying.length === 0) return;

  await Promise.all(
    qualifying.map((judge) => sendToJudge(judge, ctx).catch(() => undefined)),
  );
}

function qualifies(j: JudgePrefsRow, ctx: DispatchContext, now: Date): boolean {
  if (!j.enabled_rooms.includes(ctx.room)) return false;

  const lastAcked = ctx.judgeAckedAt.get(j.sub);
  if (lastAcked != null && Date.now() - lastAcked < JUDGE_DEBOUNCE_MS) return false;

  if (
    isInQuietHours(
      {
        start: j.quiet_hours_start,
        end: j.quiet_hours_end,
        weekdays: j.quiet_hours_weekdays,
        timezone: j.timezone,
      },
      now,
    )
  ) {
    return false;
  }

  const hasSms = j.phone_status === 'verified' && !!j.phone_e164;
  const hasEmail = j.email_status === 'verified' && !!j.email_address;
  return hasSms || hasEmail;
}

async function sendToJudge(j: JudgePrefsRow, ctx: DispatchContext): Promise<void> {
  const smsBody = `Help requested in ${ctx.displayLabel} by contestant ${ctx.contestantId}`.slice(0, 160);
  const emailSubject = `Help request in ${ctx.displayLabel}`;
  const localTime = new Date().toLocaleString('en-US', {
    timeZone: j.timezone || 'UTC',
  });
  const emailBody = `Contestant ${ctx.contestantId} requested help in ${ctx.displayLabel} at ${localTime}. Open the dashboard: ${ctx.publicOrigin}?room=${ctx.room}`;

  if (j.phone_status === 'verified' && j.phone_e164 && loadTwilioConfig()) {
    await sendSmsWithRetry(j, ctx.room, { to: j.phone_e164, body: smsBody });
  }

  if (j.email_status === 'verified' && j.email_address && loadSesConfig()) {
    await sendEmailWithRetry(j, ctx.room, {
      to: j.email_address,
      subject: emailSubject,
      body: emailBody,
    });
  }
}

async function sendSmsWithRetry(
  j: JudgePrefsRow,
  room: string,
  payload: { to: string; body: string },
): Promise<void> {
  try {
    const res = await sendSms(payload);
    await safeAudit({
      room,
      atServerMs: Date.now(),
      actorSub: 'system',
      actorEmail: null,
      eventType: 'SMS_SENT',
      payload: { judgeSub: j.sub, twilioSid: res.sid },
    });
    return;
  } catch (err) {
    await sleep(RETRY_DELAY_MS);
    try {
      const res = await sendSms(payload);
      await safeAudit({
        room,
        atServerMs: Date.now(),
        actorSub: 'system',
        actorEmail: null,
        eventType: 'SMS_SENT',
        payload: { judgeSub: j.sub, twilioSid: res.sid, retried: true },
      });
    } catch (err2) {
      await safeAudit({
        room,
        atServerMs: Date.now(),
        actorSub: 'system',
        actorEmail: null,
        eventType: 'SMS_FAILED',
        payload: {
          judgeSub: j.sub,
          errorCode: (err2 as { code?: string })?.code ?? (err as { code?: string })?.code ?? 'unknown',
        },
      });
    }
  }
}

async function sendEmailWithRetry(
  j: JudgePrefsRow,
  room: string,
  payload: { to: string; subject: string; body: string },
): Promise<void> {
  try {
    const res = await sendEmail(payload);
    await safeAudit({
      room,
      atServerMs: Date.now(),
      actorSub: 'system',
      actorEmail: null,
      eventType: 'EMAIL_SENT',
      payload: { judgeSub: j.sub, sesMessageId: res.messageId },
    });
    return;
  } catch (err) {
    await sleep(RETRY_DELAY_MS);
    try {
      const res = await sendEmail(payload);
      await safeAudit({
        room,
        atServerMs: Date.now(),
        actorSub: 'system',
        actorEmail: null,
        eventType: 'EMAIL_SENT',
        payload: { judgeSub: j.sub, sesMessageId: res.messageId, retried: true },
      });
    } catch (err2) {
      await safeAudit({
        room,
        atServerMs: Date.now(),
        actorSub: 'system',
        actorEmail: null,
        eventType: 'EMAIL_FAILED',
        payload: {
          judgeSub: j.sub,
          errorCode: (err2 as { name?: string })?.name ?? (err as { name?: string })?.name ?? 'unknown',
        },
      });
    }
  }
}

async function safeAudit(ev: Parameters<typeof insertAuditEvent>[0]): Promise<void> {
  try {
    await insertAuditEvent(ev);
  } catch {
    enqueueRetry(() => insertAuditEvent(ev));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
