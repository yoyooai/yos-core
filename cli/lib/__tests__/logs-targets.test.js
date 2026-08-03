import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const { resolveLogTarget, LOG_TYPES } = await import('../../commands/service.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const YOS_DIR = '/tmp/yos-logs-fixture';

// `yos logs` used to point `activity` and `scheduler` at YOS_DIR/activity-log.txt
// and YOS_DIR/scheduler-log.txt. Nothing in the product ever writes those two
// paths, so the default `yos logs` always failed with "Log file not found".
// These tests pin each type to a target the product actually produces.
describe('yos logs targets', () => {
  it('reads the activity log the monitor actually writes', () => {
    assert.deepEqual(resolveLogTarget('activity', { yosDir: YOS_DIR }), {
      kind: 'file',
      path: path.join(YOS_DIR, 'activity-monitor', 'activity.log'),
    });
  });

  it('never points a file target at a path nothing writes', () => {
    for (const type of LOG_TYPES) {
      const target = resolveLogTarget(type, { yosDir: YOS_DIR });
      if (target.kind !== 'file') continue;
      const relative = path.relative(YOS_DIR, target.path);
      assert.ok(
        !['activity-log.txt', 'scheduler-log.txt'].includes(relative),
        `${type} points at ${relative}, which no service writes`,
      );
    }
  });

  it('resolves the caddy log to the path the Caddyfile template declares', () => {
    // Cross-check against the actual source of truth rather than restating it:
    // if the template moves the access log, this test fails.
    const template = fs.readFileSync(
      path.join(ROOT, 'skills', 'http', 'Caddyfile.template'),
      'utf8',
    );
    const match = template.match(/output file \{YOS_DIR\}\/(\S+)/);
    assert.ok(match, 'Caddyfile.template no longer declares an access log path');

    assert.deepEqual(resolveLogTarget('caddy', { yosDir: YOS_DIR }), {
      kind: 'file',
      path: path.join(YOS_DIR, match[1]),
    });
  });

  it('reads core service output through pm2, which owns it', () => {
    // ecosystem.config.cjs declares no out_file for the core services, so their
    // stdout only exists inside PM2's own log directory.
    assert.deepEqual(resolveLogTarget('scheduler', { yosDir: YOS_DIR }), {
      kind: 'pm2',
      services: ['scheduler'],
    });
    assert.deepEqual(resolveLogTarget('pm2', { yosDir: YOS_DIR }), {
      kind: 'pm2',
      services: [],
    });
  });

  it('rejects unknown log types', () => {
    assert.equal(resolveLogTarget('nope', { yosDir: YOS_DIR }), null);
  });

  it('keeps the advertised type list in sync with what resolves', () => {
    for (const type of LOG_TYPES) {
      assert.notEqual(resolveLogTarget(type, { yosDir: YOS_DIR }), null, `${type} does not resolve`);
    }
  });
});
