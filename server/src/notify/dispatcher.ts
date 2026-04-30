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
/**
 * When `fireDispatch` finds no qualifying judges (all in quiet hours,
 * all recently acked, all opted out), we re-arm another dispatch later
 * rather than silently dropping the notification. Quiet-hours windows
 * flip on minute boundaries, so a 60 s retry cadence is plenty, and we
 * cap the total wait so a contestant who's been forgotten doesn't
 * accumulate pending timers forever.
 */
export const NO_JUDGES_RETRY_DELAY_MS = 60_000;
export const NO_JUDGES_MAX_ELAPSED_MS = 30 * 60_000;

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
  let currentTimer: NodeJS.Timeout | null = null;
  let cancelled = false;

  const arm = (delayMs: number): void => {
    if (cancelled) return;
    currentTimer = setTimeout(() => {
      if (cancelled) return;
      void fireDispatch(ctx, (retryDelayMs) => {
        if (cancelled) return;
        arm(retryDelayMs);
      }).catch(() => {
        // swallow; individual send errors are logged to audit_log inside
      });
    }, delayMs);
    currentTimer.unref?.();
  };

  arm(DISPATCH_DELAY_MS);

  return {
    cancel: () => {
      cancelled = true;
      if (currentTimer) clearTimeout(currentTimer);
    },
  };
}

async function fireDispatch(
  ctx: DispatchContext,
  rearm?: (delayMs: number) => void,
): Promise<void> {
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
  if (qualifying.length === 0) {
    // No judges are reachable right now — every candidate is either
    // in quiet hours, recently acked, or opted out. Record a
    // NOTIFY_DEFERRED breadcrumb and, if we're still within the
    // re-arm window, schedule another pass for 60s from now so the
    // notification will actually fire once someone becomes reachable
    // (e.g., quiet hours end).
    const elapsedMs = Date.now() - ctx.requestedAtServerMs;
    const willRearm = rearm != null && elapsedMs < NO_JUDGES_MAX_ELAPSED_MS;
    await safeAudit({
      room: ctx.room,
      atServerMs: Date.now(),
      actorSub: 'system',
      actorEmail: null,
      eventType: willRearm ? 'NOTIFY_DEFERRED' : 'NOTIFY_ABANDONED',
      payload: {
        contestantId: ctx.contestantId,
        candidateJudges: judges.length,
        elapsedMs,
      },
    });
    if (willRearm) rearm!(NO_JUDGES_RETRY_DELAY_MS);
    return;
  }

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
  await sendWithRetry({
    send: () => sendSms(payload),
    successEvent: 'SMS_SENT',
    failureEvent: 'SMS_FAILED',
    successPayload: (res) => ({ judgeSub: j.sub, twilioSid: res.sid }),
    failurePayload: (err) => ({
      judgeSub: j.sub,
      errorCode: (err as { code?: string })?.code ?? 'unknown',
    }),
    room,
  });
}

async function sendEmailWithRetry(
  j: JudgePrefsRow,
  room: string,
  payload: { to: string; subject: string; body: string },
): Promise<void> {
  await sendWithRetry({
    send: () => sendEmail(payload),
    successEvent: 'EMAIL_SENT',
    failureEvent: 'EMAIL_FAILED',
    successPayload: (res) => ({ judgeSub: j.sub, sesMessageId: res.messageId }),
    failurePayload: (err) => ({
      judgeSub: j.sub,
      errorCode: (err as { name?: string })?.name ?? 'unknown',
    }),
    room,
  });
}

interface RetryParams<R> {
  send: () => Promise<R>;
  successEvent: string;
  failureEvent: string;
  successPayload: (result: R) => Record<string, unknown>;
  failurePayload: (err: unknown) => Record<string, unknown>;
  room: string;
}

/**
 * try → sleep → retry-once → audit. Shared between SMS and email so both
 * adapters stay in lockstep on retry semantics.
 */
async function sendWithRetry<R>(params: RetryParams<R>): Promise<void> {
  try {
    const res = await params.send();
    await safeAudit({
      room: params.room,
      atServerMs: Date.now(),
      actorSub: 'system',
      actorEmail: null,
      eventType: params.successEvent,
      payload: params.successPayload(res),
    });
    return;
  } catch (firstErr) {
    await sleep(RETRY_DELAY_MS);
    try {
      const res = await params.send();
      await safeAudit({
        room: params.room,
        atServerMs: Date.now(),
        actorSub: 'system',
        actorEmail: null,
        eventType: params.successEvent,
        payload: { ...params.successPayload(res), retried: true },
      });
    } catch (secondErr) {
      await safeAudit({
        room: params.room,
        atServerMs: Date.now(),
        actorSub: 'system',
        actorEmail: null,
        eventType: params.failureEvent,
        payload: params.failurePayload(secondErr ?? firstErr),
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
