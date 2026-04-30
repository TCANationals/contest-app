import { create } from 'zustand';

import type { HelpQueue, TimerState } from './types';

interface AppState {
  timer: TimerState | null;
  helpQueue: HelpQueue | null;
  setTimer: (t: TimerState) => void;
  setHelpQueue: (q: HelpQueue) => void;
}

export const useAppStore = create<AppState>((set) => ({
  timer: null,
  helpQueue: null,
  setTimer: (timer) => set({ timer }),
  setHelpQueue: (helpQueue) => set({ helpQueue }),
}));
