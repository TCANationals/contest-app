import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { isAdmin, ROOM_ID_PATTERN, type CreateRoomResult } from '@tca-timer/shared/api';

import { ApiError, api } from '../api/client';
import { sortByRecency } from '../lib/rooms';

export function RoomsPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['rooms'],
    queryFn: () => api.listRooms(),
  });
  // Reuses the cached `['me']` entry populated by `AppLayout` so the
  // admin gate doesn't trigger a second `/api/auth/me` round-trip on
  // mount. `staleTime` matches AppLayout's so the cache hit ratio
  // stays predictable.
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api.me(),
    staleTime: 60_000,
    retry: false,
  });

  const ordered = useMemo(() => sortByRecency(query.data ?? []), [query.data]);
  const userIsAdmin = !!meQuery.data && isAdmin(meQuery.data);

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Rooms</h1>
        <p className="text-sm text-slate-500">
          Recently-used rooms are listed first; the rest are sorted alphabetically.
        </p>
      </div>

      {userIsAdmin && <CreateRoomCard />}

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
          {ordered.map((room) => {
            // The whole row navigates to /?room=<id>, but it must also host a
            // separate "Projector ↗" link that opens in a new tab. A real
            // <button> wrapping a <Link> (= <a>) would nest interactive
            // content, which is invalid HTML and breaks screen readers — so
            // we use a div[role=\"button\"] for the row surface and let the
            // inner <Link> remain a top-level interactive element.
            const goToRoom = () =>
              navigate(`/?room=${encodeURIComponent(room.id)}`);
            const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                goToRoom();
              }
            };
            return (
              <li key={room.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={goToRoom}
                  onKeyDown={onKeyDown}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50 min-h-[56px] cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
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
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Best-effort label → id derivation. Lower-cases, swaps non-`[a-z0-9]`
 * runs for `-`, and trims leading/trailing dashes plus any leading
 * digit segment that would violate `ROOM_ID_PATTERN` (which requires a
 * leading alphanumeric — *not* a leading dash). The result might still
 * fail validation (e.g. labels of all whitespace), in which case the
 * user types the id by hand — the field never auto-overwrites a value
 * the admin has already touched.
 */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function CreateRoomCard() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  // Track whether the admin has manually edited the id field; once
  // they have, the auto-slug stops overwriting it. Without this, a
  // hand-typed id would be clobbered on the next keystroke in the
  // label field, which is hostile.
  const [idDirty, setIdDirty] = useState(false);
  const [created, setCreated] = useState<CreateRoomResult | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  const effectiveId = idDirty ? id : slugify(label);
  const idLooksValid = effectiveId === '' || ROOM_ID_PATTERN.test(effectiveId);

  const mutation = useMutation({
    mutationFn: api.createRoom,
    onSuccess: async (room) => {
      setCreated(room);
      setKeyCopied(false);
      setLabel('');
      setId('');
      setIdDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['rooms'] });
    },
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mutation.isPending) return;
    const trimmedLabel = label.trim();
    if (!trimmedLabel || !ROOM_ID_PATTERN.test(effectiveId)) return;
    mutation.mutate({ id: effectiveId, displayLabel: trimmedLabel });
  };

  const errorMessage = mutation.error ? describeCreateError(mutation.error) : null;
  const submitDisabled =
    mutation.isPending ||
    label.trim().length === 0 ||
    !ROOM_ID_PATTERN.test(effectiveId);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Create a room</h2>
        <p className="text-xs text-slate-500">
          Admin only. The server mints a one-time room key for the contestant overlay; you&apos;ll only see it once below.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <label className="block text-sm">
          <span className="block text-slate-700 mb-1">Display name</span>
          <input
            type="text"
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Practice 2026"
            maxLength={200}
            autoComplete="off"
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </label>

        <label className="block text-sm">
          <span className="block text-slate-700 mb-1">Room id</span>
          <input
            type="text"
            required
            value={effectiveId}
            onChange={(e) => {
              setIdDirty(true);
              setId(e.target.value);
            }}
            placeholder="practice-2026"
            maxLength={63}
            autoComplete="off"
            inputMode="text"
            spellCheck={false}
            className={`w-full rounded border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-900 ${
              idLooksValid ? 'border-slate-300' : 'border-red-400'
            }`}
            aria-invalid={idLooksValid ? undefined : true}
            aria-describedby="room-id-hint"
          />
          <span id="room-id-hint" className="block mt-1 text-xs text-slate-500">
            Lowercase letters, numbers and dashes. Must start with a letter or number. 2–63 chars.
          </span>
        </label>

        {errorMessage && (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitDisabled}
            className="rounded bg-slate-900 text-white text-sm font-medium px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? 'Creating…' : 'Create room'}
          </button>
        </div>
      </form>

      {created && (
        <div className="rounded border border-emerald-300 bg-emerald-50 p-3 space-y-2">
          <p className="text-sm font-medium text-emerald-900">
            Created <span className="font-mono">{created.id}</span>
          </p>
          <p className="text-xs text-emerald-900">
            Room key (shown once — copy it now; you can rotate it later if lost):
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-white border border-emerald-200 rounded px-2 py-1 break-all">
              {created.roomKey}
            </code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.roomKey);
                  setKeyCopied(true);
                } catch {
                  setKeyCopied(false);
                }
              }}
              className="rounded border border-emerald-300 bg-white text-xs px-2 py-1 hover:bg-emerald-100"
            >
              {keyCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="text-xs text-emerald-900 underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function describeCreateError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'A room with that id already exists.';
    if (err.status === 403) return 'You need admin access to create rooms.';
    if (err.status === 400) {
      // The server distinguishes `bad_room_id` from `bad_display_label`
      // in the JSON body, but `req()` flattens the body into the error
      // message, so we surface that string verbatim — it's already
      // human-readable enough to act on.
      return `Invalid input: ${err.message}`;
    }
    return err.message || `Request failed (${err.status})`;
  }
  return (err as Error)?.message ?? 'Unknown error';
}
