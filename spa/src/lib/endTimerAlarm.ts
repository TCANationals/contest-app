import {
  alarmBaselineKey,
  computeRemainingMs,
  END_TIMER_ALARM_ASSET_PATH,
  shouldFireAlarm,
} from '@tca-timer/shared';

import { useAppStore } from '../store';

let installed = false;

/**
 * §9.5.1 end-of-timer ding for the judge SPA — same asset and crossing
 * logic as the contestant overlay. Installed once at startup (like
 * `installQueueChime`) so it survives route changes.
 */
export function installEndTimerAlarm(): void {
  if (installed) return;
  installed = true;

  const prevRemRef = { current: Number.POSITIVE_INFINITY };
  const lastAlarmRef = { current: null as number | null };
  const audioRef = { current: null as HTMLAudioElement | null };
  let baselineKey = '';

  window.setInterval(() => {
    const { timer, activeOffsetMs } = useAppStore.getState();
    if (!timer) {
      baselineKey = '';
      prevRemRef.current = Number.POSITIVE_INFINITY;
      return;
    }

    const key = alarmBaselineKey(timer);
    if (key !== baselineKey) {
      baselineKey = key;
      prevRemRef.current = computeRemainingMs(timer, activeOffsetMs);
    }

    const rem = computeRemainingMs(timer, activeOffsetMs);
    const now = Date.now();
    if (
      shouldFireAlarm({
        status: timer.status,
        remainingMs: rem,
        previousRemainingMs: prevRemRef.current,
        lastFiredAt: lastAlarmRef.current,
        now,
        enabled: true,
      })
    ) {
      lastAlarmRef.current = now;
      playEndTimerDing(audioRef);
    }
    prevRemRef.current = rem;
  }, 250);
}

function playEndTimerDing(
  ref: { current: HTMLAudioElement | null },
): void {
  try {
    if (!ref.current) {
      ref.current = new Audio();
    }
    const a = ref.current;
    a.volume = 1;
    a.src = END_TIMER_ALARM_ASSET_PATH;
    void a.play().catch(() => undefined);
    window.setTimeout(() => {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        // ignore
      }
    }, 4_000);
  } catch {
    // never crash the SPA shell on audio failures
  }
}
