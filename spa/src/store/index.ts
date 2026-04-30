import { create } from 'zustand';

import type {
  ConnectionStatus,
  HelpQueue,
  JudgeOutboundFrame,
  TimerState,
} from './types';

export type TransportSender = (frame: JudgeOutboundFrame) => boolean;

interface AppState {
  room: string | null;
  timer: TimerState | null;
  helpQueue: HelpQueue | null;
  activeOffsetMs: number;
  connection: ConnectionStatus;
  /** Most recent non-fatal server error, cleared on reconnect. */
  lastError: { code: string; message: string } | null;
  /** Transport send fn injected by the WS hook. */
  send: TransportSender;

  setRoom: (room: string | null) => void;
  setTimer: (timer: TimerState) => void;
  setHelpQueue: (queue: HelpQueue) => void;
  setOffset: (offsetMs: number) => void;
  setConnection: (status: ConnectionStatus) => void;
  setError: (err: { code: string; message: string } | null) => void;
  setSender: (send: TransportSender) => void;
}

const noopSender: TransportSender = () => false;

export const useAppStore = create<AppState>((set) => ({
  room: null,
  timer: null,
  helpQueue: null,
  activeOffsetMs: 0,
  connection: 'idle',
  lastError: null,
  send: noopSender,

  setRoom: (room) => set({ room }),
  setTimer: (timer) => set({ timer }),
  setHelpQueue: (helpQueue) => set({ helpQueue }),
  setOffset: (activeOffsetMs) => set({ activeOffsetMs }),
  setConnection: (connection) => set({ connection }),
  setError: (lastError) => set({ lastError }),
  setSender: (send) => set({ send }),
}));

/** Narrow selector for transport callers. */
export function sendFrame(frame: JudgeOutboundFrame): boolean {
  return useAppStore.getState().send(frame);
}
