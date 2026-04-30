import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { judgeRoomAccess } from '../src/auth/cf-jwt.js';
import {
  CONTESTANT_ID_REGEX,
  ROOM_ID_REGEX,
} from '../src/auth/room-token.js';

describe('judgeRoomAccess', () => {
  it('returns all for admin group', () => {
    assert.equal(
      judgeRoomAccess(['judges-admin', 'judges-nationals-2026']),
      'all',
    );
  });

  it('maps room-prefixed groups to room ids', () => {
    assert.deepEqual(
      judgeRoomAccess(['judges-nationals-2026', 'judges-region-3']),
      ['nationals-2026', 'region-3'],
    );
  });

  it('ignores unrelated groups', () => {
    assert.deepEqual(judgeRoomAccess(['something-else']), []);
  });
});

describe('identifier regexes', () => {
  it('accepts valid contestant ids', () => {
    for (const id of ['contestant-07', 'abc.def_ghi', 'a']) {
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
