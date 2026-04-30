// §5.2 outbound-frame contract check.
//
// The frame builders in `rooms.ts` parse every frame against the
// shared `JudgeInboundFrameSchema` before JSON.stringify in dev/test
// builds. These tests lock in that behavior so a future refactor
// can't silently strip the validation (which is how we'd miss drift
// between the server's wire shape and what the SPA / contestant
// overlay parse with).
//
// The production-skip branch (`NODE_ENV=production`) is exercised by
// the integration tests in `ws.integration.test.ts` — they run with
// NODE_ENV unset and every STATE/PONG/HELP_QUEUE frame would throw
// here if the schema disagreed with reality.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  stateFrame,
  helpQueueFrame,
  pongFrame,
  errorFrame,
} from '../src/rooms.js';
import { initialTimerState, type TimerState } from '../src/timer.js';
import { initialHelpQueue } from '../src/help-queue.js';

const ROOM = 'nationals-2026';

describe('outbound frame contract (§5.2)', () => {
  it('stateFrame accepts a valid initial TimerState', () => {
    const frame = stateFrame(initialTimerState(ROOM, 0), 0);
    const parsed = JSON.parse(frame);
    assert.equal(parsed.type, 'STATE');
    assert.equal(parsed.room, ROOM);
    assert.equal(parsed.status, 'idle');
    assert.equal(parsed.connectedContestants, 0);
  });

  it('stateFrame throws in dev when TimerState is malformed', () => {
    // Simulate a server bug: a future refactor forgets to set
    // `setAtServerMs` or pushes a garbage `status` value onto the
    // state. The §5.2 contract check must catch it before the bad
    // frame reaches the wire.
    const bad: TimerState = {
      ...initialTimerState(ROOM, 0),
      // @ts-expect-error deliberately breaking the contract
      status: 'frozen',
    };
    assert.throws(
      () => stateFrame(bad, 0),
      /outbound WS frame violates §5.2 contract.*status/,
    );
  });

  it('helpQueueFrame accepts a valid empty queue', () => {
    const frame = helpQueueFrame(initialHelpQueue(ROOM));
    const parsed = JSON.parse(frame);
    assert.equal(parsed.type, 'HELP_QUEUE');
    assert.equal(parsed.room, ROOM);
    assert.deepEqual(parsed.entries, []);
  });

  it('pongFrame accepts finite timestamps and rejects NaN', () => {
    const ok = pongFrame(1, 2, 3);
    assert.equal(JSON.parse(ok).type, 'PONG');

    // NaN passes TypeScript's `number` type but the schema catches
    // it — this is exactly the contestant-overlay regression the
    // shared schema was introduced to prevent on the receive side,
    // now enforced on the send side too.
    assert.throws(
      () => pongFrame(Number.NaN, 2, 3),
      /outbound WS frame violates §5.2 contract/,
    );
  });

  it('errorFrame accepts string code/message', () => {
    const f = errorFrame('rate_limit', 'too many PINGs');
    assert.deepEqual(JSON.parse(f), {
      type: 'ERROR',
      code: 'rate_limit',
      message: 'too many PINGs',
    });
  });
});
