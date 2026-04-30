// `TimerState` and `TimerStatus` are the wire shape of the §5.2 STATE
// frame, shared with the contestant overlay (`desktop/`). They live
// in `@tca-timer/shared` (which already includes the optional
// `connectedContestants` / `dbDegraded` SPA-side fields) so the two
// consumers cannot drift in their understanding of the payload.
import type { TimerState as SharedTimerState } from '@tca-timer/shared';
export type { TimerState, TimerStatus } from '@tca-timer/shared';

export interface HelpQueueEntry {
  contestantId: string;
  stationNumber: number | null;
  requestedAtServerMs: number;
}

export interface HelpQueue {
  room: string;
  version: number;
  entries: HelpQueueEntry[];
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

// One PING/PONG sample for the §6.3 sliding-median offset tracker.
// Re-exported from shared so the OffsetTracker storage type matches.
export type { OffsetSample } from '@tca-timer/shared';

/** §5.2 inbound frames. */
export type ServerFrame =
  | { type: 'PONG'; t0: number; t1: number; t2: number }
  | { type: 'STATE'; state: SharedTimerState }
  | { type: 'HELP_QUEUE'; queue: HelpQueue }
  | { type: 'ERROR'; code: string; message: string };

/** §5.2 outbound frames from a judge. */
export type JudgeOutboundFrame =
  | { type: 'PING'; t0: number }
  | { type: 'TIMER_SET'; durationMs: number; message?: string }
  | { type: 'TIMER_PAUSE' }
  | { type: 'TIMER_RESUME' }
  | { type: 'TIMER_ADJUST'; deltaMs: number }
  | { type: 'TIMER_RESET' }
  | { type: 'HELP_ACK'; contestantId: string };
