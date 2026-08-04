import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const REQUIRED_TESTS = [
  ['self-upgrade.test.js', 'rejects a future finalizer state schema before running post-install steps'],
  ['self-upgrade.test.js', 'treats a legacy finalizer state as unable to restore the previous core'],
  ['self-upgrade.test.js', 'treats an unversioned finalizer state as legacy'],
  ['self-upgrade.test.js', 'fails rollback verification when the installed core version did not return to the previous version'],
  ['self-upgrade.test.js', 'keeps a core version mismatch from being reported as a completed rollback'],
  ['self-upgrade.test.js', 'fails restore_core_skills when the restored tree does not match its backup'],
  ['component-self-upgrade.test.js', 'reports an incomplete rollback with version, skill, backup, and recovery details'],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('self-upgrade rollback safety test guard', () => {
  it('keeps every rollback safety regression test enabled', () => {
    for (const [file, title] of REQUIRED_TESTS) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
      const escaped = escapeRegExp(title);
      assert.match(source, new RegExp(`\\bit\\(['\"]${escaped}['\"]`));
      assert.doesNotMatch(source, new RegExp(`\\bit\\.(?:skip|todo)\\(['\"]${escaped}['\"]`));
    }
  });
});
