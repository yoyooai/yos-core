import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatLocalTimestamp } from '../local-time.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Run an expression in a child process pinned to a timezone. The parent cannot
// change its own zone after start, and a UTC-vs-local bug is invisible when the
// test host happens to run UTC — which CI usually does.
function evalInZone(tz, expression) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', expression],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8', cwd: REPO_ROOT }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const MODULE = JSON.stringify(
  path.join(REPO_ROOT, 'cli', 'lib', 'local-time.js')
);

describe('formatLocalTimestamp', () => {
  it('keeps the established YYYY-MM-DD HH:mm:ss shape', () => {
    assert.match(formatLocalTimestamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  // The whole point. Same instant, two zones, eight hours apart — the exact
  // discrepancy observed on WorkTest (monitor said 03:41:37, machine said
  // 11:41:37 in the same second).
  it('renders the same instant differently in different zones', () => {
    const expr = (tz) => `
      import { formatLocalTimestamp } from ${MODULE};
      process.stdout.write(formatLocalTimestamp(1787802097000));
    `;
    const utc = evalInZone('UTC', expr('UTC'));
    const shanghai = evalInZone('Asia/Shanghai', expr('Asia/Shanghai'));

    assert.notEqual(
      utc, shanghai,
      'a timestamp that ignores the zone is the bug this module exists to fix'
    );
    const hours = (s) => Number(s.slice(11, 13));
    assert.equal((hours(shanghai) - hours(utc) + 24) % 24, 8);
  });

  it('is not toISOString in disguise', () => {
    const out = evalInZone('Asia/Shanghai', `
      import { formatLocalTimestamp } from ${MODULE};
      const when = 1787802097000;
      const iso = new Date(when).toISOString().replace('T', ' ').substring(0, 19);
      process.stdout.write(JSON.stringify({ ours: formatLocalTimestamp(when), iso }));
    `);
    const { ours, iso } = JSON.parse(out);
    assert.notEqual(ours, iso, 'must differ from the UTC rendering it replaces');
  });

  it('accepts a Date, epoch millis, and defaults to now', () => {
    const when = 1787802097000;
    assert.equal(formatLocalTimestamp(new Date(when)), formatLocalTimestamp(when));
    assert.match(formatLocalTimestamp(), /^\d{4}-\d{2}-\d{2} /);
  });

  it('zero-pads every field', () => {
    // 2026-01-02 03:04:05 local, constructed in local time on purpose.
    const padded = formatLocalTimestamp(new Date(2026, 0, 2, 3, 4, 5));
    assert.equal(padded, '2026-01-02 03:04:05');
  });
});
