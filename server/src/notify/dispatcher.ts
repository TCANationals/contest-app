// Notification dispatcher (§7.4). Debounce + auto-cancel logic.
//
// TODO: on qualifying queue transition, enqueue a 5-second job; at fire time,
// re-check the queue. If still queued, fan out to Twilio (§7.4.2) and SES
// (§7.4.3). Respect quiet hours, enabled_rooms, per-judge 30s debounce.

export interface DispatchContext {
  room: string;
  contestantId: string;
  requestedAtServerMs: number;
}

export function scheduleNotification(_ctx: DispatchContext): void {
  // no-op placeholder
}

export function cancelNotification(_ctx: DispatchContext): void {
  // no-op placeholder
}
