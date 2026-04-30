// §6.3 time-sync re-exports. The implementation lives in
// `@tca-timer/shared` so the contestant overlay and the judge SPA
// share one offset tracker; keeping this thin re-export keeps every
// existing `import { ... } from './timesync'` callsite working
// without churn.

export {
  OffsetTracker,
  computeSample,
  median,
} from '@tca-timer/shared';
export type { OffsetSample as PingSample } from '@tca-timer/shared';
