import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api, type AuditLogEntry } from '../api/client';

export function LogPage() {
  const [params] = useSearchParams();
  const room = params.get('room');
  const [since, setSince] = useState<number | undefined>(undefined);
  const [filter, setFilter] = useState<string>('');

  const query = useQuery({
    enabled: !!room,
    queryKey: ['log', room, since],
    queryFn: async () => (room ? api.getLog(room, { since, limit: 200 }) : []),
    refetchInterval: 10_000,
  });

  const rows = useMemo(() => {
    const list = query.data ?? [];
    if (!filter) return list;
    const f = filter.toLowerCase();
    return list.filter((r) =>
      r.eventType.toLowerCase().includes(f) ||
      r.actorEmail?.toLowerCase().includes(f) ||
      r.actorSub.toLowerCase().includes(f) ||
      JSON.stringify(r.payload).toLowerCase().includes(f),
    );
  }, [query.data, filter]);

  if (!room) {
    return (
      <section>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="text-sm text-slate-600">Select a room first.</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Audit log</h1>
          <p className="text-sm text-slate-500">
            Room <span className="font-mono">{room}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={api.csvLogUrl(room, since)}
            className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-medium"
            download
          >
            Export CSV
          </a>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter events"
          className="flex-1 min-w-[10rem] px-3 py-2 border border-slate-300 rounded"
        />
        <select
          value={since ?? ''}
          onChange={(e) =>
            setSince(e.target.value ? Number(e.target.value) : undefined)
          }
          className="px-3 py-2 border border-slate-300 rounded"
        >
          <option value="">All time</option>
          <option value={String(Date.now() - 60 * 60_000)}>Last hour</option>
          <option value={String(Date.now() - 6 * 60 * 60_000)}>Last 6h</option>
          <option value={String(Date.now() - 24 * 60 * 60_000)}>Last 24h</option>
        </select>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {query.isLoading ? (
          <div className="p-6 text-slate-500 text-sm">Loading…</div>
        ) : query.isError ? (
          <div className="p-6 text-red-600 text-sm">
            Failed to load log: {(query.error as Error).message}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-slate-500 text-sm">No events.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <LogRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function LogRow({ row }: { row: AuditLogEntry }) {
  const when = new Date(row.atServerMs);
  return (
    <li className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:gap-4">
      <span className="text-xs text-slate-500 w-44 tabular-nums">
        {when.toLocaleString()}
      </span>
      <span className="font-mono text-xs bg-slate-100 text-slate-700 rounded px-2 py-0.5 inline-block w-fit">
        {row.eventType}
      </span>
      <span className="text-sm text-slate-700 flex-1 truncate">
        {row.actorEmail ?? row.actorSub}
        {Object.keys(row.payload ?? {}).length > 0 && (
          <>
            {' · '}
            <code className="text-xs text-slate-500">{JSON.stringify(row.payload)}</code>
          </>
        )}
      </span>
    </li>
  );
}
