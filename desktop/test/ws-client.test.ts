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

  // Runtime validation of inbound frames via the shared zod contract
  // (`ContestantInboundFrameSchema`). These tests lock in the rejection
  // behavior so a future schema change or a misbehaving server can't
  // silently corrupt the overlay. For each case the client MUST NOT
  // invoke `onState`/`onOffset`, and MUST emit a single `console.warn`
  // describing the rejection so the bug is visible from the debug log
  // without crashing the overlay.
  describe('rejects malformed frames', () => {
    // Helper: drive one bad frame through the client and assert the
    // contract — no state callback, no offset callback, one warn call.
    const runMalformed = (payload: unknown) => {
      const states: TimerState[] = [];
      const offsets: number[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const c = new WsClient({
        url: 'wss://h',
        onState: (s) => states.push(s),
        onStatus: () => undefined,
        onOffset: (o) => offsets.push(o),
        WebSocketImpl: asWSImpl(),
      });
      c.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();
      // Drain the warm-up PING send.
      ws.sent.length = 0;

      ws.simulateMessage(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      );

      expect(states).toHaveLength(0);
      expect(offsets).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      // The first warn argument is our prefix; the rest is the issues
      // list. Assert both to catch a future regression where we stop
      // prefixing warnings or lose the issues for debugging.
      expect(warn.mock.calls[0]![0]).toBe('tca-timer: discarding malformed WS frame');

      warn.mockRestore();
      c.stop();
    };

    it('drops a frame with an unknown `type` discriminator', () => {
      runMalformed({ type: 'NOT_A_FRAME', t0: 1, t1: 2, t2: 3 });
    });

    it('drops a frame missing the `type` discriminator', () => {
      runMalformed({ t0: 1, t1: 2, t2: 3 });
    });

    it('drops a PONG frame with non-numeric timestamps', () => {
      // This is the historical regression: the previous client coerced
      // fields with `Number(...)` and would seed the offset tracker
      // with NaN samples if the server misbehaved. The zod schema
      // rejects strings up front.
      runMalformed({ type: 'PONG', t0: '1', t1: '2', t2: '3' });
    });

    it('drops a STATE frame missing a required TimerState field', () => {
      // Missing `status` — the overlay would otherwise forward a half-
      // built TimerState into render state and freeze at "--:--".
      runMalformed({
        type: 'STATE',
        room: 'r',
        version: 1,
        endsAtServerMs: null,
        remainingMs: null,
        message: '',
        setBySub: 's',
        setByEmail: 'e',
        setAtServerMs: 0,
      });
    });

    it('drops a STATE frame with a bad `status` enum value', () => {
      runMalformed({
        type: 'STATE',
        room: 'r',
        version: 1,
        status: 'frozen', // not a TimerStatus
        endsAtServerMs: null,
        remainingMs: null,
        message: '',
        setBySub: 's',
        setByEmail: 'e',
        setAtServerMs: 0,
      });
    });

    it('drops a payload that is valid JSON but not an object', () => {
      // `[]` and primitives parse as JSON but can't match any of the
      // discriminated-union branches. Exercising this prevents a
      // regression where we accept `null`/`[]` and choke downstream.
      runMalformed(JSON.stringify([]));
    });

    it('ignores non-string message payloads entirely (no warn)', () => {
      // The overlay's WS client rejects non-string data *before*
      // attempting to parse JSON — the browser WebSocket API never
      // delivers a non-string here, but guard anyway. Because we never
      // reach the zod parse, no warn is emitted.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const c = new WsClient({
        url: 'wss://h',
        onState: () => undefined,
        onStatus: () => undefined,
        onOffset: () => undefined,
        WebSocketImpl: asWSImpl(),
      });
      c.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();
      ws.simulateMessage(new ArrayBuffer(0));
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
      c.stop();
    });
  });

  it('clears stale offset samples when a new connection opens', () => {
    // §6.3: a reconnect must start with an empty offset window so a
    // server clock change between sessions doesn't leave corrupt
    // samples in the sliding median. We assert this by feeding a
    // large server-ahead offset on the first session, then showing
    // that a single fresh sample on the second session reports an
    // offset close to 0 (which it could not if 7 stale samples were
    // still in the median).
    vi.setSystemTime(new Date(10_000));
    const offsets: number[] = [];
    const c = new WsClient({
      url: 'wss://h',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: (o) => offsets.push(o),
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.simulateOpen();
    // Craft t0/t1/t2 such that the computed offset is ~1_000_000 ms:
    //   offset = ((t1 - t0) + (t2 - t3)) / 2
    //   with t0 = 0 and t3 = Date.now() = 10_000, and t1 = t2,
    //   pick t1 = 1_010_000 → offset = (1_010_000 + 1_000_000) / 2
    //                                = 1_005_000.
    for (let i = 0; i < 8; i += 1) {
      ws1.simulateMessage(
        JSON.stringify({ type: 'PONG', t0: 0, t1: 1_010_000, t2: 1_010_000 }),
      );
    }
    const staleOffset = offsets[offsets.length - 1]!;
    expect(staleOffset).toBeGreaterThan(500_000);

    // Drop the connection, force jitter to 0 so the reconnect timer
    // fires immediately, and send a clean PONG on the new session.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    ws1.simulateServerClose();
    vi.advanceTimersByTime(1);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws2.simulateOpen();
    // Build t0/t1/t2 in terms of the current wall clock (t3) so the
    // sample's computed offset is close to zero regardless of how many
    // ms the warm-up burst advanced the fake clock by.
    const now = Date.now();
    ws2.simulateMessage(
      JSON.stringify({ type: 'PONG', t0: now - 10, t1: now - 5, t2: now - 4 }),
    );

    const freshOffset = offsets[offsets.length - 1]!;
    expect(Math.abs(freshOffset)).toBeLessThan(100);
    c.stop();
  });

  it('queues HELP_CANCEL for reconnect when WS drops after request landed', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const pendingTransitions: boolean[] = [];
    const c = new WsClient({
      url: 'wss://h',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      onHelpPendingChanged: (p) => pendingTransitions.push(p),
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.simulateOpen();

    // Request lands on the wire, then server connection drops.
    expect(c.sendHelpRequest()).toBe(true);
    expect(pendingTransitions).toEqual([true]);
    ws1.simulateServerClose();

    // User cancels while offline — not locally queued (it was already
    // sent), so the cancel must be queued for reconnect flush rather
    // than silently dropped.
    expect(c.sendHelpCancel()).toBe(false);
    expect(pendingTransitions).toEqual([true]);

    vi.advanceTimersByTime(1);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws2.simulateOpen();

    // The queued cancel hits the wire and fires the transition.
    expect(ws2.sent.map((s) => JSON.parse(s).type)).toContain('HELP_CANCEL');
    expect(pendingTransitions).toEqual([true, false]);

    c.stop();
  });

  describe('HELP_ACKED handling (§7.1)', () => {
    // §7.1: a judge clicks Acknowledge → server sends a targeted
    // HELP_ACKED frame to the affected contestant → overlay clears
    // help_pending. These tests lock in that the inbound frame
    // produces the right `onHelpPendingChanged(false)` transition
    // and is properly idempotent against ack-races (e.g. self-cancel
    // and judge-ack landing within the same tick).
    const sampleAckPayload = (overrides: Record<string, unknown> = {}) => ({
      type: 'HELP_ACKED',
      room: 'r',
      contestantId: 'alice',
      version: 7,
      waitMs: 1234,
      ackedAtServerMs: 1_700_000_000_000,
      ...overrides,
    });

    it('clears outstanding help and fires onHelpPendingChanged(false)', () => {
      const transitions: boolean[] = [];
      const c = new WsClient({
        url: 'wss://h',
        onState: () => undefined,
        onStatus: () => undefined,
        onOffset: () => undefined,
        onHelpPendingChanged: (p) => transitions.push(p),
        WebSocketImpl: asWSImpl(),
      });
      c.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();

      expect(c.sendHelpRequest()).toBe(true);
      expect(transitions).toEqual([true]);

      ws.simulateMessage(JSON.stringify(sampleAckPayload()));
      expect(transitions).toEqual([true, false]);

      // A second HELP_ACKED is idempotent — overlay state is already
      // cleared so no extra transition fires.
      ws.simulateMessage(JSON.stringify(sampleAckPayload()));
      expect(transitions).toEqual([true, false]);

      c.stop();
    });

    it('is a no-op when no help request is pending (late ack race)', () => {
      // Race scenario: contestant self-cancels a heartbeat before the
      // judge's ack lands. The HELP_ACKED frame is now stale relative
      // to local state. The client must not flip `help_pending` back
      // (it's already false) and must not double-fire the transition.
      const transitions: boolean[] = [];
      const c = new WsClient({
        url: 'wss://h',
        onState: () => undefined,
        onStatus: () => undefined,
        onOffset: () => undefined,
        onHelpPendingChanged: (p) => transitions.push(p),
        WebSocketImpl: asWSImpl(),
      });
      c.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();

      ws.simulateMessage(JSON.stringify(sampleAckPayload()));
      expect(transitions).toEqual([]);

      c.stop();
    });

    it('arriving during a reconnect-flush race produces balanced true/false transitions', () => {
      // Contestant goes offline with a help request still queued
      // locally (never sent). On reconnect, the queued request
      // flushes and fires `true`. The judge then acks — `false`.
      // Sanity-check the balanced [true, false] sequence and that no
      // duplicate request remains queued for any future reconnect.
      const transitions: boolean[] = [];
      const c = new WsClient({
        url: 'wss://h',
        onState: () => undefined,
        onStatus: () => undefined,
        onOffset: () => undefined,
        onHelpPendingChanged: (p) => transitions.push(p),
        WebSocketImpl: asWSImpl(),
      });
      c.start();
      const ws = FakeWebSocket.instances[0]!;

      // Socket is CONNECTING — sendHelpRequest queues locally.
      expect(c.sendHelpRequest()).toBe(false);
      expect(transitions).toEqual([]);

      ws.simulateOpen();
      // The queued request flushed on open and fired `true`.
      expect(transitions).toEqual([true]);
      expect(ws.sent.map((s) => JSON.parse(s).type)).toContain('HELP_REQUEST');

      ws.simulateMessage(JSON.stringify(sampleAckPayload()));
      expect(transitions).toEqual([true, false]);

      c.stop();
    });
  });

  it('reports help-pending transitions via onHelpPendingChanged', () => {
    const pendingTransitions: boolean[] = [];
    const c = new WsClient({
      url: 'wss://h',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      onHelpPendingChanged: (p) => pendingTransitions.push(p),
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();

    // Direct send while online: fires `true`.
    expect(c.sendHelpRequest()).toBe(true);
    expect(pendingTransitions).toEqual([true]);

    // Cancel fires `false`.
    expect(c.sendHelpCancel()).toBe(true);
    expect(pendingTransitions).toEqual([true, false]);

    c.stop();
  });

  it('onHelpPendingChanged fires on reconnect flush of offline queue', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const pendingTransitions: boolean[] = [];
    const c = new WsClient({
      url: 'wss://h',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      onHelpPendingChanged: (p) => pendingTransitions.push(p),
      WebSocketImpl: asWSImpl(),
    });
    c.start();
    const ws1 = FakeWebSocket.instances[0]!;

    // Socket is CONNECTING — send fails and queues locally. No
    // transition emitted because the frame isn't on the wire yet.
    expect(c.sendHelpRequest()).toBe(false);
    expect(pendingTransitions).toEqual([]);

    ws1.simulateServerClose();
    vi.advanceTimersByTime(1);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws2.simulateOpen();
    // Now the queued request is flushed on the wire; transition = true.
    expect(pendingTransitions).toEqual([true]);
    expect(ws2.sent.map((s) => JSON.parse(s).type)).toContain('HELP_REQUEST');

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

  it('backoff climbs to the 30s cap once the base schedule is exhausted', () => {
    // §6.4: base delays 1, 2, 4, 8, 16 s, capped at 30 s thereafter.
    // Pin `Math.random()` to 0.5 so jittered = base / 2 exactly; step
    // through reconnect attempts and check that once the base schedule
    // is exhausted the delay grows to the 30 s cap (not stuck at 16 s).
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const c = new WsClient({
      url: 'wss://h',
      onState: () => undefined,
      onStatus: () => undefined,
      onOffset: () => undefined,
      WebSocketImpl: asWSImpl(),
    });
    c.start();

    // Expected base delays; jittered = base * 0.5. The last two
    // entries would be 16_000 if the bug were present; they must be
    // 30_000 for the cap to apply.
    const expectedBases = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const base of expectedBases) {
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
      ws.simulateServerClose();
      const before = FakeWebSocket.instances.length;
      const jittered = base * 0.5;
      vi.advanceTimersByTime(jittered - 1);
      expect(FakeWebSocket.instances.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances.length).toBe(before + 1);
    }

    c.stop();
  });
});
