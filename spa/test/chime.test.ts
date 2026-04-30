import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installQueueChime } from '../src/lib/chime';
import { useAppStore } from '../src/store';
import type { HelpQueue } from '../src/store/types';

function makeQueue(room: string, count: number, version = 1): HelpQueue {
  return {
    room,
    version,
    entries: Array.from({ length: count }, (_, i) => ({
      contestantId: `contestant-${i}`,
      stationNumber: null,
      requestedAtServerMs: 1_000_000 + i,
    })),
  };
}

describe('queue chime subscription', () => {
  let oscillatorStart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    oscillatorStart = vi.fn();
    // Stub WebAudio so playChime() doesn't blow up in jsdom and we can
    // detect whether it was invoked.
    class FakeOsc {
      frequency = { value: 0 };
      type = '';
      connect(next: unknown) { return next; }
      start = oscillatorStart;
      stop = vi.fn();
    }
    class FakeGain {
      gain = {
        value: 0,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      };
      connect(next: unknown) { return next; }
    }
    class FakeCtx {
      currentTime = 0;
      destination = {};
      createOscillator() { return new FakeOsc(); }
      createGain() { return new FakeGain(); }
      close = vi.fn();
    }
    (globalThis as unknown as { AudioContext: typeof FakeCtx }).AudioContext = FakeCtx;
    // Reset store to a known state.
    useAppStore.setState({
      room: 'demo',
      timer: null,
      helpQueue: null,
      activeOffsetMs: 0,
      connection: 'idle',
      lastError: null,
      send: () => false,
    });
    installQueueChime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not chime when the queue is unchanged', () => {
    useAppStore.setState({ helpQueue: makeQueue('demo', 0) });
    expect(oscillatorStart).not.toHaveBeenCalled();
  });

  it('chimes on real empty→non-empty transition', () => {
    useAppStore.setState({ helpQueue: makeQueue('demo', 0) });
    useAppStore.setState({ helpQueue: makeQueue('demo', 1, 2) });
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
  });

  it('does not re-chime on subsequent additions to a non-empty queue', () => {
    useAppStore.setState({ helpQueue: makeQueue('demo', 0) });
    useAppStore.setState({ helpQueue: makeQueue('demo', 1, 2) });
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
    useAppStore.setState({ helpQueue: makeQueue('demo', 3, 3) });
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
  });

  it('does not chime on the very first non-empty queue snapshot for a room (baseline)', () => {
    // No earlier null→queue or 0→0 step. The judge connects and the first
    // HELP_QUEUE frame already has entries — this is the baseline, not a
    // transition we observed, so no chime.
    useAppStore.setState({ helpQueue: makeQueue('demo', 3) });
    expect(oscillatorStart).not.toHaveBeenCalled();
    // A subsequent add should also not chime (still non-empty).
    useAppStore.setState({ helpQueue: makeQueue('demo', 4, 2) });
    expect(oscillatorStart).not.toHaveBeenCalled();
  });

  it('does not chime when entering a different room with an already non-empty queue', () => {
    // Seed: demo room with 0 entries, then 2 entries (one chime).
    useAppStore.setState({ helpQueue: makeQueue('demo', 0) });
    useAppStore.setState({ helpQueue: makeQueue('demo', 2, 2) });
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
    // Switch room → tracker resets to the new room's count, so even though
    // the new room is already non-empty, no second chime fires.
    useAppStore.setState({
      room: 'other',
      helpQueue: makeQueue('other', 1),
    });
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
  });
});
