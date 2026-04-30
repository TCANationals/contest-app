// All wire-shape types live in `@tca-timer/shared/api` so the server,
// SPA, and contestant overlay cannot drift on the §5.2 frame format.
// This module just re-exports under their historical SPA names so
// existing imports keep compiling.

export type {
  TimerState,
  TimerStatus,
  OffsetSample,
} from '@tca-timer/shared';

export type {
  HelpQueue,
  HelpQueueEntry,
  // The SPA historically called the server-→-judge union `ServerFrame`;
  // alias to the shared name so callers don't have to be touched.
  JudgeInboundFrame as ServerFrame,
  JudgeOutboundFrame,
} from '@tca-timer/shared/api';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
