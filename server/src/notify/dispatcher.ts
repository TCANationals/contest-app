export interface NotificationDispatchInput {
  roomId: string;
  contestantId: string;
  requestedAtServerMs: number;
}

export async function scheduleNotificationDispatch(_input: NotificationDispatchInput): Promise<void> {
  // TODO(spec §7.4): add delayed dispatch worker, debounce, and cancellation checks.
}
