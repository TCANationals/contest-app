// Coverage for clock-drift warning fan-out behavior (§11.6).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { __testOverrides } from '../src/db/dal.js';
import { logClockDriftWarning } from '../src/clock.js';

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
    const rows = await logClockDriftWarning(250, (m, e) =>
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
    const rows = await logClockDriftWarning(-275);
    assert.equal(rows, 2);
    assert.deepEqual(
      writes.map((w) => w.room).sort(),
      ['room-a', 'room-b'],
    );
    for (const w of writes) {
      assert.equal((w.payload as { driftMs: number }).driftMs, -275);
    }
  });
});
