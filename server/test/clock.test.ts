// Coverage for clock-drift sampling and warning fan-out (§11.6).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { __testOverrides } from '../src/db/dal.js';
import {
  logClockDriftWarning,
  isDriftSignificant,
  sampleClockDriftOnce,
  HTTP_DATE_QUANTIZATION_MS,
  CLOCK_DRIFT_THRESHOLD_MS,
} from '../src/clock.js';

describe('isDriftSignificant (§11.6)', () => {
  it('ignores drift below threshold + HTTP date quantization', () => {
    // A perfectly-synced host still sees quantization noise up to ~500 ms
    // because the HTTP Date header is second-precision. With a 200 ms
    // threshold and 500 ms quantization, anything within ±700 ms must be
    // treated as within tolerance, or the monitor will produce a steady
    // stream of false-positive SYSTEM_CLOCK_WARN rows.
    assert.equal(isDriftSignificant(0), false);
    assert.equal(isDriftSignificant(CLOCK_DRIFT_THRESHOLD_MS), false);
    assert.equal(
      isDriftSignificant(CLOCK_DRIFT_THRESHOLD_MS + HTTP_DATE_QUANTIZATION_MS),
      false,
    );
    assert.equal(
      isDriftSignificant(-(CLOCK_DRIFT_THRESHOLD_MS + HTTP_DATE_QUANTIZATION_MS)),
      false,
    );
  });

  it('fires for drift beyond threshold + quantization', () => {
    assert.equal(
      isDriftSignificant(
        CLOCK_DRIFT_THRESHOLD_MS + HTTP_DATE_QUANTIZATION_MS + 1,
      ),
      true,
    );
    assert.equal(
      isDriftSignificant(
        -(CLOCK_DRIFT_THRESHOLD_MS + HTTP_DATE_QUANTIZATION_MS + 1),
      ),
      true,
    );
  });
});

describe('sampleClockDriftOnce', () => {
  it('corrects for HTTP Date second-precision by centering on the midpoint', async () => {
    // Stub global fetch so the test runs without network. The fake `Date`
    // header is *the current second, truncated*, which is what a real,
    // perfectly-synced peer would return.
    const origFetch = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = async () => {
      const now = Date.now();
      const flooredSecond = Math.floor(now / 1000) * 1000;
      return new Response(null, {
        status: 200,
        headers: { date: new Date(flooredSecond).toUTCString() },
      });
    };

    try {
      // Average 10 samples to smooth out the residual ±quantization noise.
      let total = 0;
      const N = 10;
      for (let i = 0; i < N; i++) {
        const d = await sampleClockDriftOnce('https://example.test');
        assert.ok(d != null);
        total += d!;
      }
      const mean = total / N;
      // Without midpoint correction, the mean drift would be +500 ms (the
      // average truncation). With correction, it must be near zero — well
      // below the warning threshold so no false positives fire.
      assert.ok(
        Math.abs(mean) < CLOCK_DRIFT_THRESHOLD_MS,
        `mean drift ${mean.toFixed(1)}ms exceeds ${CLOCK_DRIFT_THRESHOLD_MS}ms threshold`,
      );
    } finally {
      (globalThis as { fetch?: unknown }).fetch = origFetch;
    }
  });
});

describe('logClockDriftWarning (§11.6)', () => {
  const writes: Array<{ room: string; payload: unknown }> = [];
  const logs: Array<{ msg: string; extra: unknown }> = [];

  before(() => {
    __testOverrides.listActiveRooms = async () => [];
    __testOverrides.insertAuditEvent = async (ev) => {
      writes.push({ room: ev.room, payload: ev.payload });
    };
  });

  after(() => {
    delete __testOverrides.listActiveRooms;
    delete __testOverrides.insertAuditEvent;
  });

  it('falls back to logger when there are no rooms (no silent drop)', async () => {
    writes.length = 0;
    logs.length = 0;
    const rows = await logClockDriftWarning(1200, (m, e) =>
      logs.push({ msg: m, extra: e }),
    );
    assert.equal(rows, 0);
    assert.equal(writes.length, 0);
    assert.ok(logs.some((l) => l.msg === 'system_clock_warn_no_rooms'));
  });

  it('writes one audit row per active room', async () => {
    writes.length = 0;
    logs.length = 0;
    __testOverrides.listActiveRooms = async () => [
      {
        id: 'room-a',
        display_label: 'A',
        token_hash: 'x',
        created_at: new Date(),
        archived_at: null,
      },
      {
        id: 'room-b',
        display_label: 'B',
        token_hash: 'x',
        created_at: new Date(),
        archived_at: null,
      },
    ];
    const rows = await logClockDriftWarning(-1500);
    assert.equal(rows, 2);
    assert.deepEqual(
      writes.map((w) => w.room).sort(),
      ['room-a', 'room-b'],
    );
    for (const w of writes) {
      assert.equal((w.payload as { driftMs: number }).driftMs, -1500);
    }
  });
});
