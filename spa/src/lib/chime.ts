import { useAppStore } from '../store';
import type { HelpQueue } from '../store/types';

/**
 * Empty→non-empty queue chime (§7.2).
 *
 * We intentionally synthesize the tone with the WebAudio API instead of
 * shipping a binary asset: it keeps the SPA dependency-free, avoids a 404
 * when the asset is missing, and gives a short, pleasant blip on any device
 * whose audio context we have the user-gesture permission to resume.
 */
export function playChime(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = 'sine';
    // Per the Web Audio spec, `linearRampToValueAtTime` requires a preceding
    // automation event to anchor the ramp's start. Setting `.value` only
    // changes the intrinsic value, it does NOT enqueue an event — Safari /
    // WebKit will produce silence or undefined behavior without this anchor.
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.15, t0 + 0.02);
    gain.gain.linearRampToValueAtTime(0, t0 + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(t0 + 0.5);
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio blocked until user gesture — skip silently. */
  }
}

let installed = false;
let prevRoom: string | null = null;
let prevCount: number | null = null;

/**
 * Subscribe (once) to store updates and play the chime on every actual
 * empty→non-empty transition of the help queue. The transition tracker lives
 * here — outside any component — so it survives page navigation; if it lived
 * inside a component, every remount would reset the counter and the chime
 * would re-fire whenever the user re-enters /help with an already-non-empty
 * queue (incorrect per §7.2: only true transitions chime).
 *
 * Subtleties:
 *  • `prevCount` starts at `null` and stays null until we have observed the
 *    *first* HELP_QUEUE frame for the current room. The first frame is a
 *    baseline (it tells us what the queue already looks like when this
 *    judge connected) and MUST NOT chime, even if the queue is non-empty.
 *  • A room switch resets the tracker to null so the next room's first
 *    frame is also treated as a fresh baseline.
 */
export function installQueueChime(): void {
  if (installed) return;
  installed = true;
  const initial = useAppStore.getState();
  prevRoom = initial.room;
  prevCount = initial.helpQueue ? countOf(initial.helpQueue) : null;

  useAppStore.subscribe((state, prevState) => {
    const queueChanged = state.helpQueue !== prevState.helpQueue;
    const roomChanged = state.room !== prevRoom;
    if (!queueChanged && !roomChanged) return;

    if (roomChanged) {
      prevRoom = state.room;
      // Re-baseline. The next HELP_QUEUE frame for the new room will set
      // prevCount; that frame itself will not chime.
      prevCount = state.helpQueue ? countOf(state.helpQueue) : null;
      return;
    }

    if (state.helpQueue == null) {
      prevCount = null;
      return;
    }
    const count = countOf(state.helpQueue);
    // First observed queue for the current room is the baseline — no chime.
    if (prevCount !== null && prevCount === 0 && count > 0) {
      playChime();
    }
    prevCount = count;
  });
}

function countOf(q: HelpQueue): number {
  return q.entries.length;
}
