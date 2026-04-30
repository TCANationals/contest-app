import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../api/client';
import { sortByRecency } from '../lib/rooms';

export function RoomsPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['rooms'],
    queryFn: () => api.listRooms(),
  });

  const ordered = useMemo(() => sortByRecency(query.data ?? []), [query.data]);

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Rooms</h1>
        <p className="text-sm text-slate-500">
          Recently-used rooms are listed first; the rest are sorted alphabetically.
        </p>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-600">
          Failed to load rooms: {(query.error as Error).message}
        </p>
      ) : ordered.length === 0 ? (
        <p className="text-sm text-slate-500">You don&apos;t have access to any rooms.</p>
      ) : (
        <ul className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {ordered.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                onClick={() => navigate(`/?room=${encodeURIComponent(room.id)}`)}
                className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50 min-h-[56px]"
              >
                <span className="flex-1">
                  <span className="font-medium block">{room.displayLabel}</span>
                  <span className="text-xs text-slate-500 font-mono">{room.id}</span>
                </span>
                <Link
                  to={`/projector?room=${encodeURIComponent(room.id)}`}
                  target="_blank"
                  rel="noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline"
                >
                  Projector ↗
                </Link>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
