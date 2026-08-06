import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

import {
  formatFailureReport,
  summarizeTapFailures,
} from '../scripts/node-test-failure-report.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-node-tests.js');

/**
 * A red suite must always name the test that went red. These tests exist
 * because a one-in-1200 failure once went by unidentified: the runner streamed
 * TAP straight to the terminal, the `not ok` line scrolled away, and nothing
 * was left on disk. If that reporting path is ever removed, this file goes red.
 */

function makeFixtureRoot(testBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-node-test-evidence-'));
  const dir = path.join(root, 'cli', 'lib', '__tests__');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture.test.js'), testBody);
  return root;
}

function runRunner(root) {
  return spawnSync(process.execPath, [RUNNER, '--test-reporter=tap'], {
    cwd: root,
    encoding: 'utf8',
  });
}

const FAILING_FIXTURE = `
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('fixture suite', () => {
  it('fixture test that fails on purpose', () => {
    assert.equal(1, 2, 'fixture failure marker');
  });
});
`;

const PASSING_FIXTURE = `
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('fixture suite', () => {
  it('fixture test that passes', () => {
    assert.equal(1, 1);
  });
});
`;

describe('node test failure evidence', () => {
  test('a red run names the failing test on stderr and keeps the full TAP on disk', () => {
    const root = makeFixtureRoot(FAILING_FIXTURE);
    try {
      const result = runRunner(root);
      expect(result.status).not.toBe(0);

      // The failing test is named, located, and its assertion message shown.
      expect(result.stderr).toContain('fixture test that fails on purpose');
      expect(result.stderr).toContain('cli/lib/__tests__/fixture.test.js');
      expect(result.stderr).toContain('fixture failure marker');

      // stdout stays pure TAP — callers parse it for pass/fail counts.
      expect(result.stdout).toContain('# fail 1');
      expect(result.stdout).not.toContain('node tests: FAILED');

      // The kept log survives the run, so the red is still diagnosable later.
      const keptLogs = fs
        .readdirSync(path.join(root, '.test-logs'))
        .filter((name) => name.startsWith('node-tests-failed-'));
      expect(keptLogs).toHaveLength(1);
      const keptTap = fs.readFileSync(path.join(root, '.test-logs', keptLogs[0]), 'utf8');
      expect(keptTap).toContain('not ok');
      expect(keptTap).toContain('fixture test that fails on purpose');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a green run keeps no failure log and prints no failure report', () => {
    const root = makeFixtureRoot(PASSING_FIXTURE);
    try {
      const result = runRunner(root);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('node tests: FAILED');

      const kept = fs
        .readdirSync(path.join(root, '.test-logs'))
        .filter((name) => name.startsWith('node-tests-failed-'));
      expect(kept).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the kept log directory is ignored by git and by the published package', () => {
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    const npmignore = fs.readFileSync(path.join(ROOT, '.npmignore'), 'utf8');
    // Otherwise a red run dirties the tree and leaks into the release tarball.
    expect(gitignore).toMatch(/^\.test-logs\/$/m);
    expect(npmignore).toMatch(/^\.test-logs\/$/m);
  });
});

describe('TAP failure summary', () => {
  test('names the leaf test, not the suite wrapper that merely inherited the failure', () => {
    const tap = [
      '# Subtest: cli/lib/__tests__/thing.test.js',
      '    # Subtest: outer suite',
      '        # Subtest: the real failing test',
      '        not ok 1 - the real failing test',
      '          ---',
      "          location: '/repo/cli/lib/__tests__/thing.test.js:12:3'",
      '          error: |-',
      '            expected 1 to equal 2',
      '          ...',
      '    not ok 1 - outer suite',
      'not ok 1 - cli/lib/__tests__/thing.test.js',
      '# fail 1',
    ].join('\n');

    const summary = summarizeTapFailures(tap);
    expect(summary.reportedFailCount).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].name).toBe('the real failing test');
    expect(summary.failures[0].location).toBe('/repo/cli/lib/__tests__/thing.test.js:12:3');
    expect(summary.failures[0].error).toBe('expected 1 to equal 2');

    const report = formatFailureReport(summary, { root: '/repo' });
    expect(report).toContain('the real failing test');
    expect(report).toContain('cli/lib/__tests__/thing.test.js:12:3');
  });

  test('reports every failing test when more than one goes red', () => {
    const tap = [
      '    not ok 1 - first failure',
      '    not ok 2 - second failure',
      '# fail 2',
    ].join('\n');

    const summary = summarizeTapFailures(tap);
    expect(summary.failures.map((entry) => entry.name)).toEqual(['first failure', 'second failure']);
    expect(formatFailureReport(summary)).toContain('2 test(s) failed');
  });

  test('does not count todo or skipped results as failures', () => {
    const tap = [
      '    not ok 1 - pending work # TODO not written yet',
      '    not ok 2 - platform specific # SKIP linux only',
      '# fail 0',
    ].join('\n');

    expect(summarizeTapFailures(tap).failures).toEqual([]);
  });

  test('says so plainly when the runner died without reporting any test', () => {
    const report = formatFailureReport(summarizeTapFailures(''));
    expect(report).toContain('reported no failing test');
  });
});
