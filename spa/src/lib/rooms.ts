/** §10.2 MRU rooms persisted in localStorage (key `tca-timer.recentRooms`). */

const KEY = 'tca-timer.recentRooms';
const MAX = 10;

export function getRecentRooms(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX);
  } catch {
    return [];
  }
}

export function touchRecentRoom(id: string): void {
  try {
    const list = getRecentRooms().filter((r) => r !== id);
    list.unshift(id);
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* noop (private mode, quota, etc) */
  }
}

/**
 * Sort candidate rooms so MRU rooms come first (in MRU order), then the
 * remainder alphabetically by id.
 */
export function sortByRecency<T extends { id: string }>(rooms: T[]): T[] {
  const mru = getRecentRooms();
  const rank = new Map<string, number>();
  mru.forEach((id, i) => rank.set(id, i));

  const seen = new Set(mru);
  const ranked: T[] = [];
  const rest: T[] = [];
  for (const room of rooms) {
    if (seen.has(room.id)) ranked.push(room);
    else rest.push(room);
  }
  ranked.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  rest.sort((a, b) => a.id.localeCompare(b.id));
  return [...ranked, ...rest];
}
