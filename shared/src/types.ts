/**
 * Wire shape of a TCA Timer STATE frame (§5.2).
 *
 * The same shape is broadcast to both the contestant overlay and the
 * judge SPA. Consumers may extend it locally with optional fields
 * that don't change the shared rendering math (the SPA, for example,
 * decorates this with `connectedContestants` / `dbDegraded`).
 */
export type TimerStatus = 'idle' | 'running' | 'paused';

export interface TimerState {
  /** Room id this state belongs to. */
  room: string;
  /** Monotonic version per room (§6.5). */
  version: number;
  status: TimerStatus;
  /**
   * Server wall-clock at which the running timer reaches zero. The
   * server streams *this*, never "current remaining", so each client
   * computes remaining locally against its time-sync offset (§6.3).
   * `null` while idle.
   */
  endsAtServerMs: number | null;
  /**
   * Set when the timer is paused: snapshot of remaining ms at the
   * pause. Resumed timers translate this back into a fresh
   * `endsAtServerMs`.
   */
  remainingMs: number | null;
  message: string;
  /** Cloudflare Access `sub` of the judge who last set the state. */
  setBySub: string;
  /** Email of the same judge (display only). */
  setByEmail: string;
  /** Server wall-clock at the time of the last set. */
  setAtServerMs: number;
  /**
   * SPA-only field (§10.4) — number of contestant overlays currently
   * connected to this room. Optional in the shared shape; the
   * overlay simply ignores it.
   */
  connectedContestants?: number;
  /**
   * SPA-only field (§11.5) — true when DB writes to this room are
   * being deferred to the in-process retry buffer. Optional; the
   * overlay ignores it.
   */
  dbDegraded?: boolean;
}

/**
 * One PING/PONG sample for the §6.3 sliding-median offset tracker.
 */
export interface OffsetSample {
  roundTrip: number;
  offset: number;
}
