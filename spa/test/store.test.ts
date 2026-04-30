import { beforeEach, describe, expect, it } from 'vitest';

import { sendFrame, useAppStore } from '../src/store';

describe('app store', () => {
  beforeEach(() => {
    useAppStore.setState({
      room: null,
      timer: null,
      helpQueue: null,
      activeOffsetMs: 0,
      connection: 'idle',
      lastError: null,
      send: () => false,
    });
  });

  it('sendFrame returns false by default', () => {
    expect(sendFrame({ type: 'TIMER_PAUSE' })).toBe(false);
  });

  it('sendFrame delegates to installed sender', () => {
    const calls: unknown[] = [];
    useAppStore.getState().setSender((frame) => {
      calls.push(frame);
      return true;
    });
    expect(sendFrame({ type: 'TIMER_ADJUST', deltaMs: 1000 })).toBe(true);
    expect(calls).toEqual([{ type: 'TIMER_ADJUST', deltaMs: 1000 }]);
  });

  it('setters update state', () => {
    useAppStore.getState().setConnection('connected');
    useAppStore.getState().setOffset(42);
    expect(useAppStore.getState().connection).toBe('connected');
    expect(useAppStore.getState().activeOffsetMs).toBe(42);
  });
});
