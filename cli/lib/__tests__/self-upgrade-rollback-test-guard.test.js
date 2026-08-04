import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const REQUIRED_TESTS = [
  'rejects a future finalizer state schema before running post-install steps',
  'treats a legacy finalizer state as unable to restore the previous core',
  'treats an unversioned finalizer state as legacy',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('self-upgrade rollback safety test guard', () => {
  it('keeps every rollback safety regression test enabled', () => {
    const testPath = path.join(import.meta.dirname, 'self-upgrade.test.js');
    const source = fs.readFileSync(testPath, 'utf8');

    for (const title of REQUIRED_TESTS) {
      const escaped = escapeRegExp(title);
      assert.match(source, new RegExp(`\\bit\\(['\"]${escaped}['\"]`));
      assert.doesNotMatch(source, new RegExp(`\\bit\\.(?:skip|todo)\\(['\"]${escaped}['\"]`));
    }
  });
});
