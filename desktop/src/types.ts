// `TimerState` and `TimerStatus` are the wire shape of the §5.2 STATE
// frame and are shared with the judge SPA. They live in
// `@tca-timer/shared` so the two consumers cannot drift in their
// understanding of the payload; re-export here to keep existing
// `import type { TimerState } from './types'` callsites compiling.
export type { TimerState, TimerStatus } from '@tca-timer/shared';

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
  roomKey: string;
  serverHost: string;
  // Windows-only: optional argv to invoke whenever the display
  // configuration changes. Mirrors the BgInfo refresh hook from the
  // legacy Electron app. Omitted from the payload when the config does
  // not specify one (the Rust side serializes with skip_serializing_if).
  displayChangeCommand?: string[];
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
