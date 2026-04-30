import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTimerCommand,
  initialTimerState,
  TimerTransitionError,
  type TimerState,
} from '../src/timer.js';

const JUDGE = { sub: 'cf-sub-1', email: 'j@example.com' };
const ROOM = 'nationals-2026';

function at(t: number, overrides: Partial<TimerState> = {}): TimerState {
  return { ...initialTimerState(ROOM, t), ...overrides };
}

describe('timer state machine (§6.5)', () => {
  it('idle -> running via TIMER_SET', () => {
    const s = at(1000);
    const next = applyTimerCommand(s, { type: 'TIMER_SET', durationMs: 60_000, message: 'go' }, JUDGE, 2000);
    assert.equal(next.status, 'running');
    assert.equal(next.endsAtServerMs, 62_000);
    assert.equal(next.remainingMs, null);
    assert.equal(next.message, 'go');
    assert.equal(next.setBySub, JUDGE.sub);
    assert.equal(next.version, s.version + 1);
  });

  it('idle -> ERROR on pause/resume/adjust', () => {
    const s = at(1000);
    assert.throws(() => applyTimerCommand(s, { type: 'TIMER_PAUSE' }, JUDGE, 2000), TimerTransitionError);
    assert.throws(() => applyTimerCommand(s, { type: 'TIMER_RESUME' }, JUDGE, 2000), TimerTransitionError);
    assert.throws(
      () => applyTimerCommand(s, { type: 'TIMER_ADJUST', deltaMs: 1000 }, JUDGE, 2000),
      TimerTransitionError,
    );
  });

  it('running -> paused via TIMER_PAUSE', () => {
    const s = at(1000, { status: 'running', endsAtServerMs: 10_000 });
    const next = applyTimerCommand(s, { type: 'TIMER_PAUSE' }, JUDGE, 2000);
    assert.equal(next.status, 'paused');
    assert.equal(next.remainingMs, 8000);
    assert.equal(next.endsAtServerMs, null);
  });

  it('running -> running via TIMER_ADJUST', () => {
    const s = at(1000, { status: 'running', endsAtServerMs: 10_000 });
    const next = applyTimerCommand(s, { type: 'TIMER_ADJUST', deltaMs: 5000 }, JUDGE, 2000);
    assert.equal(next.status, 'running');
    assert.equal(next.endsAtServerMs, 15_000);
  });

  it('running TIMER_ADJUST that subtracts cannot push endsAt below now', () => {
    const s = at(1000, { status: 'running', endsAtServerMs: 10_000 });
    const next = applyTimerCommand(s, { type: 'TIMER_ADJUST', deltaMs: -60_000 }, JUDGE, 5000);
    assert.equal(next.status, 'running');
    assert.equal(next.endsAtServerMs, 5000);
  });

  it('running TIMER_SET replaces endsAtServerMs', () => {
    const s = at(1000, { status: 'running', endsAtServerMs: 10_000, version: 3 });
    const next = applyTimerCommand(s, { type: 'TIMER_SET', durationMs: 30_000 }, JUDGE, 20_000);
    assert.equal(next.status, 'running');
    assert.equal(next.endsAtServerMs, 50_000);
    assert.equal(next.version, 4);
  });

  it('running -> idle via TIMER_RESET', () => {
    const s = at(1000, { status: 'running', endsAtServerMs: 10_000 });
    const next = applyTimerCommand(s, { type: 'TIMER_RESET' }, JUDGE, 2000);
    assert.equal(next.status, 'idle');
    assert.equal(next.endsAtServerMs, null);
    assert.equal(next.remainingMs, null);
  });

  it('paused -> running via TIMER_RESUME', () => {
    const s = at(1000, { status: 'paused', remainingMs: 7000 });
    const next = applyTimerCommand(s, { type: 'TIMER_RESUME' }, JUDGE, 5000);
    assert.equal(next.status, 'running');
    assert.equal(next.endsAtServerMs, 12_000);
    assert.equal(next.remainingMs, null);
  });

  it('paused -> paused via TIMER_ADJUST', () => {
    const s = at(1000, { status: 'paused', remainingMs: 7000 });
    const next = applyTimerCommand(s, { type: 'TIMER_ADJUST', deltaMs: -3000 }, JUDGE, 5000);
    assert.equal(next.status, 'paused');
    assert.equal(next.remainingMs, 4000);
  });

  it('paused TIMER_ADJUST floors remaining at zero', () => {
    const s = at(1000, { status: 'paused', remainingMs: 1000 });
    const next = applyTimerCommand(s, { type: 'TIMER_ADJUST', deltaMs: -5000 }, JUDGE, 5000);
    assert.equal(next.status, 'paused');
    assert.equal(next.remainingMs, 0);
  });

  it('paused -> running via TIMER_SET with new duration', () => {
    const s = at(1000, { status: 'paused', remainingMs: 7000 });
    const next = applyTimerCommand(s, { type: 'TIMER_SET', durationMs: 30_000 }, JUDGE, 10_000);
    assert.equal(next.status, 'running');
    assert.equal(next.endsAtServerMs, 40_000);
    assert.equal(next.remainingMs, null);
  });

  it('paused -> idle via TIMER_RESET', () => {
    const s = at(1000, { status: 'paused', remainingMs: 7000 });
    const next = applyTimerCommand(s, { type: 'TIMER_RESET' }, JUDGE, 2000);
    assert.equal(next.status, 'idle');
    assert.equal(next.remainingMs, null);
  });

  it('TIMER_SET rejects negative / non-finite duration', () => {
    const s = at(1000);
    assert.throws(
      () => applyTimerCommand(s, { type: 'TIMER_SET', durationMs: -1 }, JUDGE, 2000),
      TimerTransitionError,
    );
    assert.throws(
      () => applyTimerCommand(s, { type: 'TIMER_SET', durationMs: Infinity }, JUDGE, 2000),
      TimerTransitionError,
    );
  });
});
