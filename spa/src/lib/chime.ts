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
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio blocked until user gesture — skip silently. */
  }
}

let installed = false;
let prevRoom: string | null = null;
let prevCount = 0;

/**
 * Subscribe (once) to store updates and play the chime on every actual
 * empty→non-empty transition of the help queue. The transition tracker lives
 * here — outside any component — so it survives page navigation; if it lived
 * inside a component, every remount would reset the counter and the chime
 * would re-fire whenever the user re-enters /help with an already-non-empty
 * queue (incorrect per §7.2: only true transitions chime).
 *
 * Room changes reset the tracker so a switch from a non-empty room to a
 * different non-empty room also chimes (each room is its own queue).
 */
export function installQueueChime(): void {
  if (installed) return;
  installed = true;
  // Seed from current store state so the very first STATE/HELP_QUEUE frame
  // received from the WS doesn't false-fire after page load.
  const initial = useAppStore.getState();
  prevRoom = initial.room;
  prevCount = countOf(initial.helpQueue);

  useAppStore.subscribe((state, prevState) => {
    const queueChanged = state.helpQueue !== prevState.helpQueue;
    const roomChanged = state.room !== prevRoom;
    if (!queueChanged && !roomChanged) return;

    const count = countOf(state.helpQueue);
    if (roomChanged) {
      prevRoom = state.room;
      prevCount = count;
      return;
    }
    if (prevCount === 0 && count > 0) {
      playChime();
    }
    prevCount = count;
  });
}

function countOf(q: HelpQueue | null | undefined): number {
  return q?.entries.length ?? 0;
}
