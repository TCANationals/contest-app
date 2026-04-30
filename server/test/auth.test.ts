import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeRoomAccess,
  ticketCache,
  hasRoomAccess,
  TICKET_TTL_MS,
} from '../src/auth/cf-jwt.js';
import {
  CONTESTANT_ID_REGEX,
  ROOM_ID_REGEX,
  hashRoomToken,
  verifyRoomTokenHash,
} from '../src/auth/room-token.js';

describe('judgeRoomAccess', () => {
  it('returns all for admin group', () => {
    assert.equal(judgeRoomAccess(['judges-admin', 'judges-nationals-2026']), 'all');
  });

  it('maps room-prefixed groups to room ids', () => {
    assert.deepEqual(judgeRoomAccess(['judges-nationals-2026', 'judges-region-3']), [
      'nationals-2026',
      'region-3',
    ]);
  });

  it('ignores unrelated groups', () => {
    assert.deepEqual(judgeRoomAccess(['something-else']), []);
  });

  it('hasRoomAccess respects admin wildcard', () => {
    assert.equal(hasRoomAccess(['judges-admin'], 'nationals-2026'), true);
    assert.equal(hasRoomAccess(['judges-region-3'], 'region-3'), true);
    assert.equal(hasRoomAccess(['judges-region-3'], 'nationals-2026'), false);
  });
});

describe('identifier regexes', () => {
  it('accepts valid contestant ids', () => {
    for (const id of ['contestant-07', 'abc.def_ghi', 'ab']) {
      assert.ok(CONTESTANT_ID_REGEX.test(id), `${id} should match`);
    }
  });

  it('rejects invalid contestant ids', () => {
    for (const id of ['', 'UPPER', 'has space', 'a'.repeat(33)]) {
      assert.ok(!CONTESTANT_ID_REGEX.test(id), `${id} should not match`);
    }
  });

  it('accepts valid room ids', () => {
    for (const id of ['nationals-2026', 'region-3-spring', 'ab']) {
      assert.ok(ROOM_ID_REGEX.test(id), `${id} should match`);
    }
  });

  it('rejects invalid room ids', () => {
    for (const id of ['', '-leading', 'a', 'UPPER']) {
      assert.ok(!ROOM_ID_REGEX.test(id), `${id} should not match`);
    }
  });
});

describe('room token hashing', () => {
  it('hash + verify round-trip', async () => {
    const token = 'supersecrettoken-1234';
    const hash = await hashRoomToken(token);
    assert.equal(await verifyRoomTokenHash(token, hash), true);
    assert.equal(await verifyRoomTokenHash('wrongtoken', hash), false);
    assert.equal(await verifyRoomTokenHash(token, ''), false);
  });
});

describe('ticket cache (§8.1)', () => {
  it('mints single-use tickets that expire', () => {
    const now = 1_000_000;
    const ticket = ticketCache.mint(
      { sub: 'u1', email: 'j@x', groups: ['judges-admin'] },
      now,
    );
    const rec1 = ticketCache.redeem(ticket, now + 1);
    assert.ok(rec1);
    assert.equal(rec1?.sub, 'u1');
    // Second redeem returns null (single-use).
    assert.equal(ticketCache.redeem(ticket, now + 2), null);

    const expired = ticketCache.mint({ sub: 'u2', email: '', groups: [] }, now);
    assert.equal(ticketCache.redeem(expired, now + TICKET_TTL_MS + 1), null);
  });
});
