import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  helpRequest,
  helpCancel,
  helpAck,
  initialHelpQueue,
} from '../src/help-queue.js';

describe('help-queue state machine (§7)', () => {
  it('helpRequest adds entry and bumps version', () => {
    const q0 = initialHelpQueue('room-1');
    const { queue: q1, changed } = helpRequest(q0, 'alice', null, 1000);
    assert.equal(changed, true);
    assert.equal(q1.version, 1);
    assert.equal(q1.entries.length, 1);
    assert.equal(q1.entries[0]?.contestantId, 'alice');
  });

  it('helpRequest is idempotent (no duplicate entry, no version bump)', () => {
    const q0 = initialHelpQueue('room-1');
    const { queue: q1 } = helpRequest(q0, 'alice', null, 1000);
    const { queue: q2, changed } = helpRequest(q1, 'alice', null, 2000);
    assert.equal(changed, false);
    assert.equal(q2.version, q1.version);
    assert.equal(q2.entries.length, 1);
  });

  it('entries are sorted oldest-first by requestedAtServerMs', () => {
    let q = initialHelpQueue('room-1');
    q = helpRequest(q, 'c', null, 3000).queue;
    q = helpRequest(q, 'a', null, 1000).queue;
    q = helpRequest(q, 'b', null, 2000).queue;
    assert.deepEqual(
      q.entries.map((e) => e.contestantId),
      ['a', 'b', 'c'],
    );
  });

  it('helpCancel removes entry; idempotent on missing', () => {
    const q0 = helpRequest(initialHelpQueue('room-1'), 'alice', null, 1000).queue;
    const { queue: q1, changed } = helpCancel(q0, 'alice');
    assert.equal(changed, true);
    assert.equal(q1.entries.length, 0);
    assert.equal(q1.version, 2);
    const { changed: changed2 } = helpCancel(q1, 'alice');
    assert.equal(changed2, false);
  });

  it('helpAck is a no-op when version does not match (first-wins)', () => {
    const q = helpRequest(initialHelpQueue('room-1'), 'alice', null, 1000).queue;
    const r = helpAck(q, 'alice', q.version + 1);
    assert.equal(r.changed, false);
    assert.equal(r.queue.entries.length, 1);
  });

  it('helpAck removes entry when version matches', () => {
    const q = helpRequest(initialHelpQueue('room-1'), 'alice', null, 1000).queue;
    const r = helpAck(q, 'alice', q.version);
    assert.equal(r.changed, true);
    assert.equal(r.queue.entries.length, 0);
  });

  it('helpAck waitMs uses the injected `now` for deterministic audit logging', () => {
    const q = helpRequest(initialHelpQueue('room-1'), 'alice', null, 1000).queue;
    const r = helpAck(q, 'alice', q.version, /* now */ 4500);
    assert.equal(r.changed, true);
    assert.equal(r.waitMs, 3500);
  });
});
