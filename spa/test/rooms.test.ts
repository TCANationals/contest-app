import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRecentRooms, sortByRecency, touchRecentRoom } from '../src/lib/rooms';

describe('MRU room storage', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('starts empty', () => {
    expect(getRecentRooms()).toEqual([]);
  });

  it('persists touched rooms newest-first and de-duplicates', () => {
    touchRecentRoom('a');
    touchRecentRoom('b');
    touchRecentRoom('a');
    expect(getRecentRooms()).toEqual(['a', 'b']);
  });

  it('caps MRU list at 10 entries', () => {
    for (let i = 0; i < 15; i++) touchRecentRoom(`room-${i}`);
    const list = getRecentRooms();
    expect(list).toHaveLength(10);
    expect(list[0]).toBe('room-14');
  });

  it('sortByRecency: MRU first, rest alphabetical', () => {
    touchRecentRoom('nationals-2026');
    touchRecentRoom('practice');
    const sorted = sortByRecency([
      { id: 'zulu' },
      { id: 'practice' },
      { id: 'alpha' },
      { id: 'nationals-2026' },
    ]);
    expect(sorted.map((r) => r.id)).toEqual([
      'practice',
      'nationals-2026',
      'alpha',
      'zulu',
    ]);
  });
});
