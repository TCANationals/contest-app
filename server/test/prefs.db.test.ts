// Live Postgres coverage for `upsertJudgePrefs` partial-update semantics.
//
// Skipped unless DATABASE_URL is set (and ideally points to a freshly
// migrated test database). The harness creates a unique `sub` per run so
// multiple invocations don't collide.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { upsertJudgePrefs, getJudgePrefs, setPhoneStatus } from '../src/db/dal.js';
import { getPool, closePool, hasDatabase } from '../src/db/pool.js';

const HAS_DB = hasDatabase();

describe('upsertJudgePrefs partial-update semantics (§7.4.4)', { skip: !HAS_DB }, () => {
  const sub = `test-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  before(async () => {
    if (!HAS_DB) return;
    // Clean up any leftover row with this sub (shouldn't happen, but safe).
    await getPool().query(`DELETE FROM judge_prefs WHERE sub = $1`, [sub]);
  });

  after(async () => {
    if (!HAS_DB) return;
    await getPool().query(`DELETE FROM judge_prefs WHERE sub = $1`, [sub]);
    await closePool();
  });

  it('initial insert populates defaults from the DDL', async () => {
    await upsertJudgePrefs({ sub, lastSeenEmail: 'j@example.com' });
    const row = await getJudgePrefs(sub);
    assert.ok(row);
    assert.equal(row?.phone_status, 'none');
    assert.equal(row?.email_status, 'none');
    assert.deepEqual(row?.enabled_rooms, []);
    assert.equal(row?.timezone, 'UTC');
    assert.equal(row?.quiet_hours_weekdays, 0);
  });

  it('verifying a phone then updating unrelated fields preserves phone_status=verified', async () => {
    // Set phone and verify it.
    await upsertJudgePrefs({
      sub,
      lastSeenEmail: 'j@example.com',
      phoneE164: '+15555550123',
      phoneStatus: 'pending',
      pendingPhoneCodeHash: 'abc',
    });
    await setPhoneStatus(sub, 'verified');
    let row = await getJudgePrefs(sub);
    assert.equal(row?.phone_status, 'verified');

    // Now update only quiet hours. Must NOT reset phone_status to 'none'.
    await upsertJudgePrefs({
      sub,
      lastSeenEmail: 'j@example.com',
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
      quietHoursWeekdays: 127,
      timezone: 'America/Chicago',
    });
    row = await getJudgePrefs(sub);
    assert.equal(row?.phone_status, 'verified', 'phone_status must survive partial update');
    assert.equal(row?.phone_e164, '+15555550123');
    assert.equal(row?.quiet_hours_start, '22:00:00');
    assert.equal(row?.timezone, 'America/Chicago');
  });

  it('explicit null on a nullable field clears it', async () => {
    await upsertJudgePrefs({
      sub,
      lastSeenEmail: 'j@example.com',
      phoneE164: null,
      phoneStatus: 'none',
    });
    const row = await getJudgePrefs(sub);
    assert.equal(row?.phone_e164, null);
    assert.equal(row?.phone_status, 'none');
  });

  it('updating enabled_rooms does not reset phone_status or timezone', async () => {
    // Re-verify phone first.
    await upsertJudgePrefs({
      sub,
      lastSeenEmail: 'j@example.com',
      phoneE164: '+15555550123',
      phoneStatus: 'verified',
    });

    await upsertJudgePrefs({
      sub,
      lastSeenEmail: 'j@example.com',
      enabledRooms: ['nationals-2026', 'region-3'],
    });
    const row = await getJudgePrefs(sub);
    assert.equal(row?.phone_status, 'verified');
    assert.equal(row?.timezone, 'America/Chicago'); // from the earlier update
    assert.deepEqual(row?.enabled_rooms, ['nationals-2026', 'region-3']);
  });
});
