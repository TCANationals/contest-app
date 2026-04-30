// `writeAudit` must snapshot the event before handing it to the async
// INSERT path. If the caller mutates the payload after `writeAudit`
// returns (or reuses the same event object), the persisted row must
// still reflect the values that were true at the time of the call.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { writeAudit } from '../src/rooms.js';
import {
  __testOverrides,
  enqueueRetry,
  flushRetries,
  _resetRing,
  type AuditEvent,
} from '../src/db/dal.js';

describe('writeAudit defensive copy', () => {
  const captured: AuditEvent[] = [];

  before(() => {
    captured.length = 0;
    _resetRing();
    __testOverrides.insertAuditEvent = async (ev) => {
      // Preserve a deep copy of what the DAL observed at the moment of
      // the call so post-test mutations on the original don't mask a bug.
      captured.push(JSON.parse(JSON.stringify(ev)));
    };
  });

  after(() => {
    delete __testOverrides.insertAuditEvent;
    _resetRing();
  });

  it('snapshots the payload on the happy path', async () => {
    captured.length = 0;
    const payload: Record<string, unknown> = { contestantId: 'alice', waitMs: 1234 };
    writeAudit({
      room: 'room-1',
      atServerMs: 1_000_000,
      actorSub: 'judge-1',
      actorEmail: 'j@example.com',
      eventType: 'HELP_ACK',
      payload,
    });

    // Mutate the caller's payload aggressively before the async INSERT
    // has a chance to touch it.
    (payload as Record<string, unknown>).contestantId = 'REWRITTEN';
    (payload as Record<string, unknown>).waitMs = -1;

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0]!.payload, { contestantId: 'alice', waitMs: 1234 });
  });

  it('snapshots the payload on the retry path too', async () => {
    captured.length = 0;
    _resetRing();
    // First call fails → job parks on the retry ring. We then mutate the
    // caller's payload. When the ring is drained, the retry MUST persist
    // the original values, not the mutated ones.
    let callCount = 0;
    __testOverrides.insertAuditEvent = async (ev) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('transient');
      }
      captured.push(JSON.parse(JSON.stringify(ev)));
    };

    const payload: Record<string, unknown> = { key: 'original' };
    writeAudit({
      room: 'room-1',
      atServerMs: 2_000_000,
      actorSub: 'judge-1',
      actorEmail: 'j@example.com',
      eventType: 'HELP_ACK',
      payload,
    });

    // Give the fire-and-forget async path a tick to hit the first failure.
    await new Promise((r) => setTimeout(r, 30));

    // Mutate AFTER the first call failed and the retry job is parked.
    (payload as Record<string, unknown>).key = 'POISONED';

    // Drain the ring — the retry runs here and should see the snapshot.
    await flushRetries();

    assert.equal(captured.length, 1, 'retry must have produced exactly one INSERT');
    assert.deepEqual(captured[0]!.payload, { key: 'original' });
  });

  it('handles nested-object payloads without aliasing', async () => {
    captured.length = 0;
    _resetRing();
    __testOverrides.insertAuditEvent = async (ev) => {
      captured.push(JSON.parse(JSON.stringify(ev)));
    };
    const payload = { nested: { counter: 1 } };
    writeAudit({
      room: 'room-1',
      atServerMs: 3_000_000,
      actorSub: 'judge-1',
      actorEmail: 'j@example.com',
      eventType: 'SMS_SENT',
      payload,
    });
    payload.nested.counter = 999;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((captured[0]!.payload as { nested: { counter: number } }).nested.counter, 1);
  });

  // Unused import guard so enqueueRetry import isn't flagged.
  void enqueueRetry;
});
