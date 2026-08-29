import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

import {
  PROGRESS_LOG_PATH,
  compareVersions,
  parseProgressLog,
  verifyProgressLog,
} from '../scripts/progress-log.js';
import { runVerification } from '../scripts/verify.js';

import { makeTempDir } from './helpers/temp-dir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(rows, { start = true, end = true } = {}) {
  const body = [
    '| 版本 | 日期 | 提交 | 这一版解决了什么 |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
  return [
    '# YOS 开发进度',
    '',
    start ? '<!-- progress-log:start -->' : '',
    body,
    end ? '<!-- progress-log:end -->' : '',
    '',
  ].join('\n');
}

const ROW_13 = '| `0.1.13` | 2026-08-09 | `181e1d3` | 卸载时把我们写进客户配置的钥匙收回来 |';
const ROW_12 = '| `0.1.12` | 2026-08-09 | `82598c0` | `--yes` 一路传到底，说了不问就真的不问 |';

function fixture(logSource, version = '0.1.13') {
  const root = makeTempDir('yos-progress-');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  if (logSource !== null) {
    fs.writeFileSync(path.join(root, PROGRESS_LOG_PATH), logSource);
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'yos', version }));
  return root;
}

describe('development progress log', () => {

  // ── Why this gate exists ──
  //
  // "Whoever develops next should keep the progress log up to date" is a rule
  // that lives or dies on people remembering it. Every rule we left in a
  // document decayed; the ones that survived are the ones that fail a build.
  // So the released version must be the newest row, mechanically.

  test('the repository’s own progress log is current with package.json', () => {
    const result = verifyProgressLog(ROOT);
    const released = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    expect(result.version).toBe(released);
    expect(result.entries).toBeGreaterThan(0);
  });

  test('rejects a release the progress log never mentions', () => {
    const root = fixture(log([ROW_12]), '0.1.13');
    expect(() => verifyProgressLog(root)).toThrow(/behind the release/);
  });

  test('rejects a log whose newest row is not the released version', () => {
    const root = fixture(log([ROW_12, ROW_13]), '0.1.13');
    expect(() => verifyProgressLog(root)).toThrow(/newest to oldest/);
  });

  test('rejects a missing progress log outright', () => {
    const root = fixture(null);
    expect(() => verifyProgressLog(root)).toThrow(/missing docs[/\\]progress\.md/);
  });

  test('rejects a log with the node table markers removed', () => {
    const root = fixture(log([ROW_13], { start: false }));
    expect(() => verifyProgressLog(root)).toThrow(/could not find the node table/);
  });

  test('rejects an empty node table', () => {
    const root = fixture(log([]));
    expect(() => verifyProgressLog(root)).toThrow(/no entries/);
  });

  test('rejects a placeholder summary, because an empty row is the same as no row', () => {
    for (const summary of ['TBD', '待填', '-', 'todo']) {
      const root = fixture(log([`| \`0.1.13\` | 2026-08-09 | \`181e1d3\` | ${summary} |`]));
      expect(() => verifyProgressLog(root)).toThrow(/placeholder/);
    }
  });

  test('rejects a malformed row instead of silently skipping it', () => {
    const root = fixture(log(['| 0.1.13 | 2026-08-09 | 181e1d3 | no backticks anywhere |']));
    expect(() => verifyProgressLog(root)).toThrow(/malformed node table row/);
  });

  test('rejects an unusable date or commit id', () => {
    expect(() => verifyProgressLog(fixture(log([
      '| `0.1.13` | 昨天 | `181e1d3` | 日期不是日期 |',
    ])))).toThrow(/not a YYYY-MM-DD date/);
    expect(() => verifyProgressLog(fixture(log([
      '| `0.1.13` | 2026-08-09 | `zzzzzzz` | 提交号不是提交号 |',
    ])))).toThrow(/not a commit id/);
  });

  test('rejects the same version listed twice', () => {
    const root = fixture(log([ROW_13, ROW_13]));
    expect(() => verifyProgressLog(root)).toThrow(/appears twice/);
  });

  test('orders prereleases below the release they lead to', () => {
    expect(compareVersions('0.1.0', '0.1.0-alpha.6')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-alpha.6', '0.1.0-alpha.5')).toBeGreaterThan(0);
    expect(compareVersions('0.1.13', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0);
  });

  test('preserves hyphens inside prerelease identifiers when ordering versions', () => {
    expect(compareVersions('0.1.0-alpha-2', '0.1.0-alpha-1')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-beta-1', '0.1.0-beta-2')).toBeLessThan(0);
  });

  test('parses every row of a well-formed table, newest first', () => {
    const rows = parseProgressLog(log([ROW_13, ROW_12]));
    expect(rows.map((row) => row.version)).toEqual(['0.1.13', '0.1.12']);
    expect(rows[0].commit).toBe('181e1d3');
    expect(rows[0].date).toBe('2026-08-09');
  });

  // ── The gate has to actually run ──
  //
  // A check nothing calls is a check that does not exist. Verification must
  // invoke it, and must fail closed when it throws — before spending anything
  // on tests, audits or packaging.

  test('verification runs the progress-log gate before tests, audits and packaging', () => {
    const calls = [];
    const common = {
      root: '/unused',
      runPrerequisites: true,
      gitStatusImpl: () => '',
      verifyTestPolicyImpl: () => calls.push('policy'),
      verifyVersionsImpl: () => calls.push('version'),
      verifyExecutedTestsImpl: () => {
        calls.push('tests');
        return { jest: 1, node: 1 };
      },
      verifyExecutedTestCountsImpl: (counts) => {
        calls.push('counts');
        return counts;
      },
      testBaselines: { jest: { minimumPassed: 1 }, node: { minimumPassed: 1 } },
      verifyAuditsImpl: () => calls.push('audit'),
      verifyReproduciblePackImpl: () => calls.push('pack'),
    };

    expect(runVerification({
      ...common,
      verifyProgressLogImpl: () => calls.push('progress'),
    })).toBe(true);
    expect(calls).toEqual(['policy', 'progress', 'version', 'tests', 'counts', 'audit', 'pack']);

    calls.length = 0;
    expect(runVerification({
      ...common,
      verifyProgressLogImpl: () => {
        calls.push('progress');
        throw new Error('progress log is behind the release');
      },
    })).toBe(false);
    expect(calls).toEqual(['policy', 'progress']);
  });

  test('the gate is wired into verification by name, not just injectable', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'verify.js'), 'utf8');
    expect(source).toMatch(/import \{ verifyProgressLog \} from '\.\/progress-log\.js';/);
    expect(source).toMatch(/verifyProgressLogImpl = verifyProgressLog,/);
    expect(source).toMatch(/^\s*verifyProgressLogImpl\(root\);$/m);
  });
});
