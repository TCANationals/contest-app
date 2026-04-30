import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { WsClient } from '../src/ws-client';
import type { TimerState } from '../src/types';

type OpenHandler = () => void;
type MsgHandler = (ev: { data: unknown }) => void;
type CloseHandler = () => void;

class FakeWebSocket {
  static OPEN = 1 as const;
  static CONNECTING = 0 as const;
  static CLOSED = 3 as const;
  static CLOSING = 2 as const;

  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: OpenHandler | null = null;
  onclose: CloseHandler | null = null;
  onmessage: MsgHandler | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  simulateServerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function asWSImpl(): typeof WebSocket {
  return FakeWebSocket as unknown as typeof WebSocket;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WsClient', () => {
  it('builds the connection URL from the provided string verbatim', () => {
    const c = new WsClient({
      url: 'wss://timer.tcanationals.com/contestant?room=a&id=b&token=c',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    expect(FakeWebSocket.instances[0]!.url).toBe(
      'wss://timer.tcanationals.com/contestant?room=a&id=b&token=c',
    );
    c.stop();
  });

  it('fires a 4-ping warm-up burst on open and switches to 30s cadence', () => {
    const c = new WsClient({
      url: 'wss://h/contestant',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!).type).toBe('PING');

    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(ws.sent).toHaveLength(4);

    // Nothing during the next 29s.
    vi.advanceTimersByTime(29_000);
    expect(ws.sent).toHaveLength(4);
    // Fifth ping lands at the 30s steady-state cadence.
    vi.advanceTimersByTime(1_000);
    expect(ws.sent).toHaveLength(5);

    c.stop();
  });

  it('forwards STATE frames and offsets updates on PONG', () => {
    const states: TimerState[] = [];
    let offset = Number.NaN;
    const c = new WsClient({
      url: 'wss://h',
      onState: (s) => states.push(s),
      onStatus: () => undefined,
      onOffset: (o) => {
        offset = o;
      },
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage(
      JSON.stringify({
        type: 'STATE',
        room: 'r',
        version: 1,
        status: 'running',
        endsAtServerMs: 100_000,
        remainingMs: null,
        message: '',
        setBySub: 's',
        setByEmail: 'e',
        setAtServerMs: 0,
      }),
    );
    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe('running');

    ws.simulateMessage(
      JSON.stringify({ type: 'PONG', t0: 1_000, t1: 2_000, t2: 2_100 }),
    );
    expect(Number.isFinite(offset)).toBe(true);

    c.stop();
  });

  it('queues help-request while offline and flushes on reconnect', () => {
    const c = new WsClient({
      url: 'wss://h',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      WebSocketImpl: asWSImpl(),
    });
    c.start();

    // Not yet open — sendHelpRequest should return false and queue.
    expect(c.sendHelpRequest()).toBe(false);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.sent).toHaveLength(0);

    ws.simulateOpen();
    // Warm-up burst first ping, plus flushed help-request.
    const types = ws.sent.map((s) => JSON.parse(s).type);
    expect(types).toContain('HELP_REQUEST');

    c.stop();
  });

  it('reconnects with jitter after close', () => {
    // Random jitter spans 0..min(base, cap); force random = 0 so the
    // scheduler fires immediately and we can observe the new socket.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const c = new WsClient({
      url: 'wss://h',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateServerClose();

    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    c.stop();
  });
});
