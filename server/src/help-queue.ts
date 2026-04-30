export interface HelpQueueEntry {
  contestantId: string;
  stationNumber: number | null;
  requestedAtServerMs: number;
}

export interface HelpQueueState {
  room: string;
  version: number;
  entries: HelpQueueEntry[];
}

export function requestHelp(_state: HelpQueueState, _contestantId: string): HelpQueueState {
  // TODO(spec §7): idempotent enqueue + queue version increments.
  throw new Error("Not implemented: requestHelp");
}

export function cancelHelp(_state: HelpQueueState, _contestantId: string): HelpQueueState {
  // TODO(spec §7): idempotent cancel from queue.
  throw new Error("Not implemented: cancelHelp");
}
