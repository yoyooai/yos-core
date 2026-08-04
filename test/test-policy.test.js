import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

import {
  findDisabledTests,
  loadApprovedSkipAllowlist,
  listTrackedFiles,
  verifyCriticalTestFiles,
  verifyTestBaselineGuard,
  verifyTestPolicy,
} from '../scripts/test-policy.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function digest(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-test-policy-'));
  git(root, ['init', '--quiet']);
  return root;
}

describe('test policy', () => {
  test('finds every disabled or focused test declaration with file and line', () => {
    const source = [
      "it.skip('one', () => {});",
      "test.todo('two');",
      "describe.skip('three', () => {});",
      "xit('four', () => {});",
      "xdescribe('five', () => {});",
      "it.only('six', () => {});",
      "describe.only('seven', () => {});",
      "const example = \"it.skip('inside a string')\";",
      "// test.only('inside a comment', () => {});",
    ].join('\n');

    expect(findDisabledTests([{ path: 'test/example.test.js', source }])).toEqual([
      expect.objectContaining({ path: 'test/example.test.js', line: 1, kind: 'it.skip' }),
      expect.objectContaining({ path: 'test/example.test.js', line: 2, kind: 'test.todo' }),
      expect.objectContaining({ path: 'test/example.test.js', line: 3, kind: 'describe.skip' }),
      expect.objectContaining({ path: 'test/example.test.js', line: 4, kind: 'xit' }),
      expect.objectContaining({ path: 'test/example.test.js', line: 5, kind: 'xdescribe' }),
      expect.objectContaining({ path: 'test/example.test.js', line: 6, kind: 'it.only' }),
      expect.objectContaining({ path: 'test/example.test.js', line: 7, kind: 'describe.only' }),
    ]);
  });

  test('finds Jest path ignores in configuration and CLI surfaces', () => {
    const findings = findDisabledTests([
      { path: 'jest.config.js', source: "export default { testPathIgnorePatterns: ['/critical/'] };\n" },
      { path: 'package.json', source: JSON.stringify({
        jest: { testPathIgnorePatterns: ['/hidden/'] },
        scripts: { test: 'jest --testPathIgnorePatterns critical' },
      }) },
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ path: 'jest.config.js', kind: 'testPathIgnorePatterns' }),
      expect.objectContaining({ path: 'package.json', kind: 'testPathIgnorePatterns' }),
      expect.objectContaining({ path: 'package.json', kind: '--testPathIgnorePatterns' }),
    ]);
  });

  test('rejects an allowlist change until its approval digest is updated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-test-allowlist-'));
    const policyPath = path.join(root, 'allowlist.json');
    const entries = [{
      path: 'test/legacy.test.js',
      line: 3,
      kind: 'test.skip',
      reason: 'requires unavailable hardware',
      proposer: 'release-owner',
    }];
    write(policyPath, JSON.stringify({ version: 1, entries, approvedDigest: digest([]) }));

    expect(() => loadApprovedSkipAllowlist(policyPath)).toThrow(/approval digest mismatch/);
    write(policyPath, JSON.stringify({ version: 1, entries, approvedDigest: digest(entries) }));
    expect(loadApprovedSkipAllowlist(policyPath)).toEqual(entries);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('fails closed without a Git worktree or an available Git command', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-test-no-git-'));
    expect(() => listTrackedFiles(root)).toThrow(/Git worktree is required/);

    fs.writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere\n');
    expect(() => listTrackedFiles(root, { gitCommand: path.join(root, 'missing-git') }))
      .toThrow(/could not list tracked files/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects missing critical files and test files with no cases', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-critical-tests-'));
    write(path.join(root, 'test', 'empty.test.js'), '// no tests here\n');
    const manifest = {
      version: 1,
      files: [
        { path: 'test/empty.test.js', minimumTests: 1 },
        { path: 'test/missing.test.js', minimumTests: 1 },
      ],
    };

    expect(() => verifyCriticalTestFiles(root, manifest)).toThrow(/empty\.test\.js: expected at least 1 test case/);
    write(path.join(root, 'test', 'empty.test.js'), "test('present', () => {});\n");
    expect(() => verifyCriticalTestFiles(root, manifest)).toThrow(/missing critical file: test\/missing\.test\.js/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects a removed, warning-only, or late executed-test gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-test-baseline-wiring-'));
    const baselines = {
      jest: { minimumPassed: 186 },
      node: { minimumPassed: 1063 },
    };
    write(path.join(root, 'scripts', 'test-baselines.json'), JSON.stringify({
      version: 1,
      baselines,
      approvedDigest: digest(baselines),
    }));
    const verifyPath = path.join(root, 'scripts', 'verify.js');
    const healthy = [
      'verifyTestPolicyImpl({ root });',
      'const executedTestCounts = verifyExecutedTestsImpl(root, baselines);',
      'verifyExecutedTestCountsImpl(executedTestCounts, baselines);',
      'verifyAuditsImpl(root);',
      'verifyReproduciblePackImpl(root);',
    ].join('\n');
    write(verifyPath, healthy);
    expect(() => verifyTestBaselineGuard(root)).not.toThrow();

    write(verifyPath, healthy.replace(
      'const executedTestCounts = verifyExecutedTestsImpl(root, baselines);\nverifyExecutedTestCountsImpl(executedTestCounts, baselines);',
      'try { verifyExecutedTestsImpl(root, baselines); } catch { console.warn("test counts skipped"); }',
    ));
    expect(() => verifyTestBaselineGuard(root)).toThrow(/executed-test gate is missing/);

    write(verifyPath, [
      'verifyTestPolicyImpl({ root });',
      'verifyAuditsImpl(root);',
      'verifyReproduciblePackImpl(root);',
      'const executedTestCounts = verifyExecutedTestsImpl(root, baselines);',
      'verifyExecutedTestCountsImpl(executedTestCounts, baselines);',
    ].join('\n'));
    expect(() => verifyTestBaselineGuard(root)).toThrow(/must run before audits and packaging/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the repository policy lists its own guard and release safety tests', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'critical-test-files.json'), 'utf8'));
    const paths = manifest.files.map((entry) => entry.path);

    expect(paths).toEqual(expect.arrayContaining([
      'cli/lib/__tests__/self-upgrade.test.js',
      'cli/lib/__tests__/component-self-upgrade.test.js',
      'cli/lib/__tests__/self-upgrade-rollback-test-guard.test.js',
      'test/release-pack.test.js',
      'test/test-policy.test.js',
      'test/test-baseline-policy.test.js',
      'test/verify-test-policy-wiring.test.js',
      'scripts/test-policy.js',
      'scripts/test-baseline-policy.js',
      'scripts/test-baselines.json',
      'scripts/critical-test-files.json',
    ]));
  });

  test('the checked-in repository satisfies the complete policy', () => {
    expect(() => verifyTestPolicy({ root: ROOT })).not.toThrow();
  });
});
