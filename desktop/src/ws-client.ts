// §6.4 / §9.7 contestant WebSocket client — exponential backoff with
// full jitter, warm-up time-sync burst, 30 s PING cadence, offline help
// queueing.

import { computeSample, OffsetTracker } from './timesync';
import type { TimerState } from './types';

export interface ConnectionStatus {
  connected: boolean;
  attempt: number;
}

export interface WsClientOptions {
  url: string;
  onState: (state: TimerState) => void;
  onStatus: (status: ConnectionStatus) => void;
  onOffset: (offsetMs: number) => void;
  /**
   * Optional WebSocket implementation injection (for tests). Defaults to
   * the global `WebSocket`.
   */
  WebSocketImpl?: typeof WebSocket;
}

const WARMUP_BURST_SIZE = 4;
const WARMUP_INTERVAL_MS = 1_000;
const STEADY_INTERVAL_MS = 30_000;
const BACKOFF_BASE_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const BACKOFF_CAP_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private readonly tracker = new OffsetTracker();
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  /** Help-request sent locally while the socket was down; flushed on
   * connect (§9.6.2 `queued_offline`). */
  private pendingHelpRequest = false;
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: WsClientOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.pingTimer != null) clearTimeout(this.pingTimer);
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    if (this.ws != null) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  sendHelpRequest(): boolean {
    if (!this.sendFrame({ type: 'HELP_REQUEST' })) {
      this.pendingHelpRequest = true;
      return false;
    }
    return true;
  }

  sendHelpCancel(): boolean {
    this.pendingHelpRequest = false;
    return this.sendFrame({ type: 'HELP_CANCEL' });
  }

  private connect(): void {
    if (this.closed) return;
    try {
      this.ws = new this.WS(this.opts.url);
    } catch (err) {
      console.error('tca-timer: WebSocket constructor failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus({ connected: true, attempt: 0 });
      this.runWarmupBurst();
      if (this.pendingHelpRequest) {
        if (this.sendFrame({ type: 'HELP_REQUEST' })) {
          this.pendingHelpRequest = false;
        }
      }
    };

    this.ws.onmessage = (ev) => {
      this.handleMessage(ev.data);
    };

    this.ws.onclose = () => {
      this.opts.onStatus({ connected: false, attempt: this.attempt });
      if (this.pingTimer != null) clearTimeout(this.pingTimer);
      this.pingTimer = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // `onclose` will handle reconnect; we only need to avoid throwing.
    };
  }

  private runWarmupBurst(): void {
    let fired = 0;
    const tick = () => {
      if (this.ws?.readyState !== this.WS.OPEN) return;
      this.sendPing();
      fired += 1;
      if (fired < WARMUP_BURST_SIZE) {
        this.pingTimer = setTimeout(tick, WARMUP_INTERVAL_MS);
      } else {
        this.pingTimer = setTimeout(
          () => this.steadyPing(),
          STEADY_INTERVAL_MS,
        );
      }
    };
    tick();
  }

  private steadyPing(): void {
    if (this.ws?.readyState !== this.WS.OPEN) return;
    this.sendPing();
    this.pingTimer = setTimeout(
      () => this.steadyPing(),
      STEADY_INTERVAL_MS,
    );
  }

  private sendPing(): void {
    const t0 = Date.now();
    this.sendFrame({ type: 'PING', t0 });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let frame: { type: string } & Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    switch (frame.type) {
      case 'PONG': {
        const t0 = Number(frame.t0);
        const t1 = Number(frame.t1);
        const t2 = Number(frame.t2);
        if (
          !Number.isFinite(t0) ||
          !Number.isFinite(t1) ||
          !Number.isFinite(t2)
        )
          return;
        const sample = computeSample(t0, t1, t2, Date.now());
        this.tracker.push(sample);
        const active = this.tracker.activeOffsetMs();
        if (active != null) this.opts.onOffset(active);
        break;
      }
      case 'STATE': {
        this.opts.onState(frame as unknown as TimerState);
        break;
      }
      default:
        break;
    }
  }

  private sendFrame(obj: unknown): boolean {
    if (this.ws?.readyState !== this.WS.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      console.error('tca-timer: WS send failed:', err);
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const baseIdx = Math.min(
      this.attempt,
      BACKOFF_BASE_SCHEDULE_MS.length - 1,
    );
    const base = BACKOFF_BASE_SCHEDULE_MS[baseIdx] ?? BACKOFF_CAP_MS;
    const capped = Math.min(base, BACKOFF_CAP_MS);
    const jittered = Math.floor(Math.random() * capped);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), jittered);
  }
}
