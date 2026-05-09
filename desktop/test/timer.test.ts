// `computeRemainingMs` and §9.5.1 alarm helpers are covered in
// `shared/test/`. Flash (§9.5.2) stays desktop-only.

import { describe, it, expect } from 'vitest';

import { shouldFlash } from '../src/timer';

describe('shouldFlash', () => {
  it('flashes while running under the threshold', () => {
    expect(shouldFlash('running', 60_000, true, 60)).toBe(true);
  });

  it('does not flash when disabled', () => {
    expect(shouldFlash('running', 60_000, false, 60)).toBe(false);
  });

  it('stops flashing above the threshold', () => {
    expect(shouldFlash('running', 60_000 + 1, true, 60)).toBe(false);
  });

  it('does not flash when paused or idle', () => {
    expect(shouldFlash('paused', 10_000, true, 60)).toBe(false);
    expect(shouldFlash('idle', 10_000, true, 60)).toBe(false);
  });

  it('does not flash when remaining time is zero', () => {
    expect(shouldFlash('running', 0, true, 60)).toBe(false);
  });
});
