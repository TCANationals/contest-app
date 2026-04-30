import type { ConnectionStatus } from '../store/types';

export interface ConnectionPillProps {
  status: ConnectionStatus;
  dbDegraded?: boolean;
}

const label: Record<ConnectionStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Error',
};

const tone: Record<ConnectionStatus, string> = {
  idle: 'bg-slate-100 text-slate-600',
  connecting: 'bg-sky-100 text-sky-800',
  connected: 'bg-emerald-100 text-emerald-800',
  reconnecting: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-800',
};

export function ConnectionPill({ status, dbDegraded }: ConnectionPillProps) {
  if (dbDegraded) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-900"
        title="Backend database writes are delayed; timer state is authoritative in memory."
      >
        <span className="h-2 w-2 rounded-full bg-yellow-500" aria-hidden="true" />
        DB degraded
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone[status]}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          status === 'connected'
            ? 'bg-emerald-500'
            : status === 'reconnecting' || status === 'connecting'
              ? 'bg-amber-500 animate-pulse'
              : status === 'error'
                ? 'bg-red-500'
                : 'bg-slate-400'
        }`}
        aria-hidden="true"
      />
      {label[status]}
    </span>
  );
}
