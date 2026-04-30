export type TimerStatus = 'idle' | 'running' | 'paused';

export interface TimerState {
  room: string;
  version: number;
  status: TimerStatus;
  endsAtServerMs: number | null;
  remainingMs: number | null;
  message: string;
  setBySub: string;
  setByEmail: string;
  setAtServerMs: number;
  /** SPA-only field (§10.4): contestant overlays currently connected. */
  connectedContestants?: number;
  /** SPA-only field (§11.5): true when DB writes are degraded. */
  dbDegraded?: boolean;
}

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

export interface OffsetSample {
  roundTrip: number;
  offset: number;
}

/** §5.2 inbound frames. */
export type ServerFrame =
  | { type: 'PONG'; t0: number; t1: number; t2: number }
  | { type: 'STATE'; state: TimerState }
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
