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

    // Before dispatch fires, cancel.
    queue = helpCancel(queue, 'alice').queue;

    // Wait for the 5-second timer to fire. The test harness sets
    // DISPATCH_DELAY_MS, so we wait a bit longer to be safe.
    await new Promise((r) => setTimeout(r, DISPATCH_DELAY_MS + 500));

    handle.cancel(); // idempotent

    const drop = captured.find((c) => c.eventType === 'NOTIFY_DROPPED');
    assert.ok(drop, 'expected NOTIFY_DROPPED audit row');
    assert.equal((drop?.payload as { contestantId: string }).contestantId, 'alice');
  });
});
