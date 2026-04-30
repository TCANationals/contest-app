// Help-queue state machine (§7).

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

/**
 * Add a contestant to the queue. Idempotent: if the contestant is already
 * queued, returns the same queue object with no version bump.
 */
export function helpRequest(
  queue: HelpQueue,
  contestantId: string,
  stationNumber: number | null,
  now: number = Date.now(),
): { queue: HelpQueue; changed: boolean } {
  if (queue.entries.some((e) => e.contestantId === contestantId)) {
    return { queue, changed: false };
  }
  const entry: HelpQueueEntry = {
    contestantId,
    stationNumber,
    requestedAtServerMs: now,
  };
  const entries = [...queue.entries, entry];
  entries.sort((a, b) => a.requestedAtServerMs - b.requestedAtServerMs);
  return {
    queue: {
      room: queue.room,
      version: queue.version + 1,
      entries,
    },
    changed: true,
  };
}

/**
 * Remove a contestant from the queue. Idempotent: no-op if not queued.
 */
export function helpCancel(
  queue: HelpQueue,
  contestantId: string,
): { queue: HelpQueue; changed: boolean } {
  const next = queue.entries.filter((e) => e.contestantId !== contestantId);
  if (next.length === queue.entries.length) {
    return { queue, changed: false };
  }
  return {
    queue: {
      room: queue.room,
      version: queue.version + 1,
      entries: next,
    },
    changed: true,
  };
}

/**
 * Judge acknowledges a contestant's request. First-judge-wins via version
 * check: if the expected version does not match, the ack is a no-op.
 */
export function helpAck(
  queue: HelpQueue,
  contestantId: string,
  expectedVersion: number,
  now: number = Date.now(),
): { queue: HelpQueue; changed: boolean; waitMs: number | null } {
  if (expectedVersion !== queue.version) {
    return { queue, changed: false, waitMs: null };
  }
  const match = queue.entries.find((e) => e.contestantId === contestantId);
  if (!match) {
    return { queue, changed: false, waitMs: null };
  }
  const waitMs = now - match.requestedAtServerMs;
  const entries = queue.entries.filter((e) => e.contestantId !== contestantId);
  return {
    queue: {
      room: queue.room,
      version: queue.version + 1,
      entries,
    },
    changed: true,
    waitMs,
  };
}

export function isInQueue(queue: HelpQueue, contestantId: string): boolean {
  return queue.entries.some((e) => e.contestantId === contestantId);
}
