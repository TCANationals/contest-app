export type TimerStatus = 'idle' | 'running' | 'paused';

export interface TimerState {
  room: string;
  version: number;
  status: TimerStatus;
  endsAtServerMs: number | null;
  remainingMs: number | null;
  message: string;
  setBySub: string;
  setByEmail: string;
  setAtServerMs: number;
}

export type PositionCorner =
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight';

export interface Preferences {
  version: number;
  alarm: { enabled: boolean; volume: number };
  flash: { enabled: boolean; thresholdMinutes: number };
  position: { corner: PositionCorner };
  hidden: boolean;
}

export interface DesktopConfig {
  room: string;
  roomToken: string;
  serverHost: string;
}

export interface ConfigErrorPayload {
  missing: string[];
  message: string;
}

export interface ConfigSourceOutcome {
  source: string;
  available: boolean;
  found: string[];
  note: string | null;
}

export interface ConfigReport {
  sources: ConfigSourceOutcome[];
  defaultServerHost: string;
}

export interface BootstrapPayload {
  config: DesktopConfig | null;
  configError: ConfigErrorPayload | null;
  report: ConfigReport;
  preferences: Preferences;
  contestantId: string;
  defaultServerHost: string;
}
