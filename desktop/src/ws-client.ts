// §6.4 / §9.7 contestant WebSocket client — exponential backoff with
// full jitter, warm-up time-sync burst, 30 s PING cadence, offline help
// queueing.

import {
  ContestantInboundFrameSchema,
  type ContestantOutboundFrame,
} from '@tca-timer/shared/api';

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
   * Called with `true` when a HELP_REQUEST frame successfully lands on
   * the wire (direct send or reconnect flush), `false` when a
   * HELP_CANCEL frame lands. Used by the overlay to keep the Rust-side
   * `AppState.help_pending` in sync via `overlay:help-pending-changed`.
   */
  onHelpPendingChanged?: (pending: boolean) => void;
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
  /** Help-request issued locally while the socket was down; flushed on
   * connect (§9.6.2 `queued_offline`). */
  private pendingHelpRequest = false;
  /** Set when the server has received a HELP_REQUEST that has not yet
   * been cancelled from this client. Used so a later HELP_CANCEL made
   * while the socket is down can be queued and flushed on reconnect
   * instead of silently dropped. */
  private helpOutstanding = false;
  /** A HELP_CANCEL the caller issued while the socket was down; flushed
   * on reconnect only if `helpOutstanding` is still true at that point. */
  private pendingHelpCancel = false;
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
    // Supersedes a queued-but-unsent HELP_CANCEL — the user asking for
    // help again while offline clearly means they want help.
    this.pendingHelpCancel = false;
    if (!this.sendFrame({ type: 'HELP_REQUEST' })) {
      this.pendingHelpRequest = true;
      return false;
    }
    this.helpOutstanding = true;
    this.opts.onHelpPendingChanged?.(true);
    return true;
  }

  sendHelpCancel(): boolean {
    const wasLocallyQueued = this.pendingHelpRequest;
    this.pendingHelpRequest = false;

    // Local-queue cancel: request never actually left this client, so
    // there's nothing to tell the server about. Fire the transition and
    // we're done.
    if (wasLocallyQueued && !this.helpOutstanding) {
      this.opts.onHelpPendingChanged?.(false);
      return true;
    }

    const sent = this.sendFrame({ type: 'HELP_CANCEL' });
    if (sent) {
      this.helpOutstanding = false;
      this.pendingHelpCancel = false;
      this.opts.onHelpPendingChanged?.(false);
      return true;
    }

    // WS is down but we have a live HELP_REQUEST on the server — queue
    // the cancel for flush on reconnect so it isn't silently dropped.
    if (this.helpOutstanding) {
      this.pendingHelpCancel = true;
    }
    return false;
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
      // §6.3: each new connection MUST start its offset window empty so
      // stale samples from a previous session (different server clock,
      // restarted host, etc.) cannot corrupt the median-of-6 result. The
      // warm-up burst below is responsible for seeding the new window.
      this.tracker.clear();
      this.opts.onStatus({ connected: true, attempt: 0 });
      this.runWarmupBurst();
      // Flush queued help-request / help-cancel in the order the user
      // issued them. If both are queued, the cancel means the user
      // changed their mind before we ever reached the server, so it's
      // enough to drop the queued request and fire the transition.
      if (this.pendingHelpCancel) {
        if (this.pendingHelpRequest) {
          this.pendingHelpRequest = false;
          this.pendingHelpCancel = false;
          this.opts.onHelpPendingChanged?.(false);
        } else if (
          this.helpOutstanding &&
          this.sendFrame({ type: 'HELP_CANCEL' })
        ) {
          this.pendingHelpCancel = false;
          this.helpOutstanding = false;
          this.opts.onHelpPendingChanged?.(false);
        }
      } else if (
        this.pendingHelpRequest &&
        this.sendFrame({ type: 'HELP_REQUEST' })
      ) {
        this.pendingHelpRequest = false;
        this.helpOutstanding = true;
        this.opts.onHelpPendingChanged?.(true);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // Validate the frame against the shared §5.2 contestant schema
    // before dispatching. A malformed frame from a misbehaving or
    // version-skewed server is silently dropped (with a console
    // warning) rather than crashing the overlay or seeding bogus
    // samples into the time-sync tracker. NaN/string `t0,t1,t2` and
    // missing TimerState fields are both rejected here.
    const result = ContestantInboundFrameSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(
        'tca-timer: discarding malformed WS frame',
        result.error.issues.slice(0, 3),
      );
      return;
    }
    const frame = result.data;
    switch (frame.type) {
      case 'PONG': {
        const sample = computeSample(frame.t0, frame.t1, frame.t2, Date.now());
        this.tracker.push(sample);
        const active = this.tracker.activeOffsetMs();
        if (active != null) this.opts.onOffset(active);
        break;
      }
      case 'STATE': {
        // `StateFrame` is `{ type: 'STATE' } & TimerState`, so a
        // shape-preserving copy minus the discriminator is the timer
        // state the overlay renders against.
        const { type: _t, ...timer } = frame;
        this.opts.onState(timer as TimerState);
        break;
      }
      case 'HELP_ACKED': {
        // §7.1: a judge acknowledged this contestant's help request.
        // Drain local-only queued state unconditionally — a stale
        // queued cancel or an offline-queued request both become
        // moot the moment the server confirms the request has been
        // ack'd through some other path.
        this.pendingHelpRequest = false;
        this.pendingHelpCancel = false;
        // Only emit `onHelpPendingChanged(false)` when a prior `true`
        // was observed externally (`helpOutstanding`), so the
        // transition stream stays balanced. A late ack arriving after
        // a self-cancel race must not fire a spurious second `false`.
        if (this.helpOutstanding) {
          this.helpOutstanding = false;
          this.opts.onHelpPendingChanged?.(false);
        }
        break;
      }
      case 'ERROR':
        // Contestants don't surface ERROR frames anywhere user-visible
        // today; close + reconnect is enough to recover from anything
        // the server reports here. Logged for diagnostics.
        console.warn('tca-timer: server ERROR frame', frame.code, frame.message);
        break;
    }
  }

  private sendFrame(obj: ContestantOutboundFrame): boolean {
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
    // §6.4: base delays 1, 2, 4, 8, 16 s, capped at 30 s thereafter.
    // Once the schedule is exhausted, clamp to the cap so sustained
    // outages don't stick at 16 s forever.
    const base =
      this.attempt < BACKOFF_BASE_SCHEDULE_MS.length
        ? BACKOFF_BASE_SCHEDULE_MS[this.attempt]!
        : BACKOFF_CAP_MS;
    const capped = Math.min(base, BACKOFF_CAP_MS);
    const jittered = Math.floor(Math.random() * capped);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), jittered);
  }
}
