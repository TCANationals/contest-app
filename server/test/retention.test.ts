// Audit-log retention coverage (§11.4).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { __testOverrides } from '../src/db/dal.js';
import { runPruneOnce, AUDIT_RETENTION_MS } from '../src/retention.js';

describe('audit-log retention (§11.4)', () => {
  let capturedCutoff = 0;

  before(() => {
    __testOverrides.pruneAuditLog = async (olderThanMs: number) => {
      capturedCutoff = olderThanMs;
      return 42;
    };
  });

  after(() => {
    delete __testOverrides.pruneAuditLog;
  });

  it('passes now - 90days as the cutoff', async () => {
    const now = 10_000_000_000;
    const res = await runPruneOnce(now);
    assert.equal(res, 42);
    assert.equal(capturedCutoff, now - AUDIT_RETENTION_MS);
  });
});
