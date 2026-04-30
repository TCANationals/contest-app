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
