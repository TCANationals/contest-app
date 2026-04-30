// Notification dispatcher coverage (§7.4).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { __testOverrides } from '../src/db/dal.js';
import {
  scheduleNotification,
  DISPATCH_DELAY_MS,
} from '../src/notify/dispatcher.js';
import { initialHelpQueue, helpRequest, helpCancel } from '../src/help-queue.js';

interface AuditLite {
  eventType: string;
  payload: Record<string, unknown>;
}

describe('notification dispatcher (§7.4)', () => {
  const captured: AuditLite[] = [];

  before(() => {
    __testOverrides.insertAuditEvent = async (ev) => {
      captured.push({
        eventType: ev.eventType,
        payload: ev.payload as Record<string, unknown>,
      });
    };
    __testOverrides.findJudgesForRoom = async () => [];
  });

  after(() => {
    delete __testOverrides.insertAuditEvent;
    delete __testOverrides.findJudgesForRoom;
  });

  it('logs NOTIFY_DROPPED when the requester cancels before dispatch fires', async () => {
    captured.length = 0;
    let queue = initialHelpQueue('room-1');
    queue = helpRequest(queue, 'alice', null, Date.now()).queue;

    const handle = scheduleNotification({
      room: 'room-1',
      displayLabel: 'Room One',
      contestantId: 'alice',
      requestedAtServerMs: Date.now(),
      getQueue: () => queue,
      judgeAckedAt: new Map(),
      publicOrigin: 'https://spa.example.com',
    });

    queue = helpCancel(queue, 'alice').queue;
    await new Promise((r) => setTimeout(r, DISPATCH_DELAY_MS + 500));

    handle.cancel();

    const drop = captured.find((c) => c.eventType === 'NOTIFY_DROPPED');
    assert.ok(drop, 'expected NOTIFY_DROPPED audit row');
    assert.equal((drop?.payload as { contestantId: string }).contestantId, 'alice');
  });

  it('logs NOTIFY_DEFERRED when no judges qualify but rearm window is still open', async () => {
    captured.length = 0;
    const queue = helpRequest(initialHelpQueue('room-1'), 'alice', null, Date.now()).queue;

    const handle = scheduleNotification({
      room: 'room-1',
      displayLabel: 'Room One',
      contestantId: 'alice',
      // Fresh request → within the re-arm window.
      requestedAtServerMs: Date.now(),
      getQueue: () => queue,
      judgeAckedAt: new Map(),
      publicOrigin: 'https://spa.example.com',
    });

    await new Promise((r) => setTimeout(r, DISPATCH_DELAY_MS + 500));
    handle.cancel();

    const deferred = captured.find((c) => c.eventType === 'NOTIFY_DEFERRED');
    assert.ok(
      deferred,
      'expected NOTIFY_DEFERRED audit breadcrumb when every judge is unreachable',
    );
    assert.equal(
      (deferred?.payload as { contestantId: string }).contestantId,
      'alice',
    );
  });

  it('logs NOTIFY_ABANDONED once the max rearm window has elapsed', async () => {
    captured.length = 0;
    const queue = helpRequest(initialHelpQueue('room-1'), 'alice', null, 0).queue;

    const handle = scheduleNotification({
      room: 'room-1',
      displayLabel: 'Room One',
      contestantId: 'alice',
      // requestedAtServerMs at epoch → well past the 30-minute max window,
      // so the helper audits NOTIFY_ABANDONED instead of deferring again.
      requestedAtServerMs: 0,
      getQueue: () => queue,
      judgeAckedAt: new Map(),
      publicOrigin: 'https://spa.example.com',
    });

    await new Promise((r) => setTimeout(r, DISPATCH_DELAY_MS + 500));
    handle.cancel();

    const abandoned = captured.find((c) => c.eventType === 'NOTIFY_ABANDONED');
    assert.ok(
      abandoned,
      'expected NOTIFY_ABANDONED audit row after max rearm window',
    );
    assert.equal(captured.find((c) => c.eventType === 'NOTIFY_DEFERRED'), undefined);
  });
});
