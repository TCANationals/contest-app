// Help-queue state machine (§7). Stubbed; business logic to be filled in.

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

export function initialHelpQueue(room: string): HelpQueue {
  return { room, version: 0, entries: [] };
}

// TODO: idempotent add (no-op if already queued) per §7.1.
export function helpRequest(
  _queue: HelpQueue,
  _contestantId: string,
  _now: number = Date.now(),
): HelpQueue {
  throw new Error('helpRequest: not implemented');
}

// TODO: idempotent remove per §7.1.
export function helpCancel(
  _queue: HelpQueue,
  _contestantId: string,
): HelpQueue {
  throw new Error('helpCancel: not implemented');
}

// TODO: first-judge-wins via version check per §7.2.
export function helpAck(
  _queue: HelpQueue,
  _contestantId: string,
  _expectedVersion: number,
): HelpQueue {
  throw new Error('helpAck: not implemented');
}
