import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

import { makeTempDir } from './helpers/temp-dir.js';

import {
  countActiveTests,
  findDisabledTests,
  loadApprovedSkipAllowlist,
  listTrackedFiles,
  verifyCriticalTestFiles,
  verifyTempDirPolicy,
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
  const root = makeTempDir('yos-test-policy-');
  git(root, ['init', '--quiet']);
  return root;
}

describe('test policy', () => {
  test('counts active tests around division and quoted regular-expression classes', () => {
    const source = [
      "test('before', () => {});",
      'const quotient = total / divisor;',
      String.raw`const pattern = /x ['\"\\/]claude['\"]?/;`,
      "test('after-regex', () => pattern.exec('x'));",
      "test('after-division', () => quotient);",
    ].join('\n');

    expect(countActiveTests(source)).toBe(3);
  });

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
    const root = makeTempDir('yos-test-allowlist-');
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
    const root = makeTempDir('yos-test-no-git-');
    expect(() => listTrackedFiles(root)).toThrow(/Git worktree is required/);

    fs.writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere\n');
    expect(() => listTrackedFiles(root, { gitCommand: path.join(root, 'missing-git') }))
      .toThrow(/could not list tracked files/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects unapproved critical manifest changes, missing files, and files with no cases', () => {
    const root = makeTempDir('yos-critical-tests-');
    write(path.join(root, 'test', 'empty.test.js'), '// no tests here\n');
    write(path.join(root, 'test', 'protected.test.js'), "test('one', () => {});\ntest('two', () => {});\n");
    const approvedFiles = [{ path: 'test/protected.test.js', minimumTests: 2 }];
    const loweredManifest = {
      version: 1,
      files: [{ path: 'test/protected.test.js', minimumTests: 1 }],
      approvedDigest: digest(approvedFiles),
    };

    expect(() => verifyCriticalTestFiles(root, loweredManifest)).toThrow(/approval digest mismatch/);

    const files = [
      { path: 'test/empty.test.js', minimumTests: 1 },
      { path: 'test/missing.test.js', minimumTests: 1 },
    ];
    const manifest = {
      version: 1,
      files,
      approvedDigest: digest(files),
    };

    expect(() => verifyCriticalTestFiles(root, manifest)).toThrow(/empty\.test\.js: expected at least 1 test case/);
    write(path.join(root, 'test', 'empty.test.js'), "test('present', () => {});\n");
    expect(() => verifyCriticalTestFiles(root, manifest)).toThrow(/missing critical file: test\/missing\.test\.js/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects a removed, wrapped, late, or misplaced executed-test data gate', () => {
    const root = makeTempDir('yos-test-baseline-wiring-');
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
      'export function runVerification({',
      'let failed = false;',
      'return verifyExecutedTestsImpl(root, baselines);',
      'verifyTestPolicyImpl({ root });',
      'let counts = null;',
      'try {',
      'counts = executeTestGateImpl({',
      '} catch (error) {',
      'verifyExecutedTestCountsImpl(counts, approvedBaselines);',
      'verifyAuditsImpl(root);',
      'verifyReproduciblePackImpl(root);',
    ].join('\n');
    write(verifyPath, healthy);
    expect(() => verifyTestBaselineGuard(root)).not.toThrow();

    write(verifyPath, healthy.replace(
      'counts = executeTestGateImpl({',
      'try { executeTestGateImpl({',
    ));
    expect(() => verifyTestBaselineGuard(root)).toThrow(/executed-test gate is missing/);

    write(verifyPath, healthy.replace(
      'verifyExecutedTestCountsImpl(counts, approvedBaselines);',
      '',
    ));
    expect(() => verifyTestBaselineGuard(root)).toThrow(/executed-test count validator is missing/);

    write(verifyPath, healthy.replace(
      'verifyExecutedTestCountsImpl(counts, approvedBaselines);\nverifyAuditsImpl(root);\nverifyReproduciblePackImpl(root);',
      'verifyAuditsImpl(root);\nverifyReproduciblePackImpl(root);\nverifyExecutedTestCountsImpl(counts, approvedBaselines);',
    ));
    expect(() => verifyTestBaselineGuard(root)).toThrow(/must run before audits and packaging/);

    write(verifyPath, healthy.replace(
      'let failed = false;\nreturn verifyExecutedTestsImpl(root, baselines);\nverifyTestPolicyImpl({ root });\nlet counts = null;\ntry {',
      'let failed = false;\nreturn verifyExecutedTestsImpl(root, baselines);\nverifyTestPolicyImpl({ root });\ntry {\nlet counts = null;',
    ));
    expect(() => verifyTestBaselineGuard(root)).toThrow(/state must be declared before the verification try block/);

    write(verifyPath, healthy.replace(
      '} catch (error) {\nverifyExecutedTestCountsImpl(counts, approvedBaselines);',
      'verifyExecutedTestCountsImpl(counts, approvedBaselines);\n} catch (error) {',
    ));
    expect(() => verifyTestBaselineGuard(root)).toThrow(/must be enforced after the verification catch block/);
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

// On 2026-08-29 the suite was found to have left 19599 directories and 6.2G in
// /tmp, because eight test files created temp directories inline with no
// teardown. Deleting them was the easy half; these tests are the half that stops
// it coming back.
describe('temp directory policy', () => {
  // The forbidden call is assembled rather than written out. The check does not
  // strip strings or comments — deliberately, see verifyTempDirPolicy — so a
  // literal copy of it in this file would flag this file.
  const TMPDIR_CALL = `os.${'tmpdir'}()`;

  function makeRepositoryWithTest(source) {
    const root = makeRepository();
    write(path.join(root, 'test', 'helpers', 'temp-dir.js'), 'export function makeTempDir() {}\n');
    write(path.join(root, 'test', 'fixture.test.js'), source);
    git(root, ['add', '.']);
    return root;
  }

  test('rejects a test file that takes a temp directory straight off the system temp root', () => {
    const root = makeRepositoryWithTest(
      `const dir = fs.mkdtempSync(path.join(${TMPDIR_CALL}, 'leaky-'));\n`,
    );

    expect(() => verifyTempDirPolicy({ root })).toThrow(/must use makeTempDir/);
    expect(() => verifyTempDirPolicy({ root })).toThrow(/test\/fixture\.test\.js:1/);
  });

  test('accepts the same file once it goes through the helper', () => {
    const root = makeRepositoryWithTest(
      "import { makeTempDir } from './helpers/temp-dir.js';\nconst dir = makeTempDir('leaky-');\n",
    );

    expect(() => verifyTempDirPolicy({ root })).not.toThrow();
  });

  // Nesting inside a directory the test already owns is not a leak: the parent's
  // cleanup takes the child with it. Flagging this would push authors back to
  // os.tmpdir() to get around the check.
  test('allows a temp directory nested inside one the test already owns', () => {
    const root = makeRepositoryWithTest(
      "const child = fs.mkdtempSync(path.join(ownedRoot, 'child-'));\n",
    );

    expect(() => verifyTempDirPolicy({ root })).not.toThrow();
  });

  test('refuses to pass when the helper it points authors at is gone', () => {
    const root = makeRepository();
    write(path.join(root, 'test', 'fixture.test.js'), "test('ok', () => {});\n");
    git(root, ['add', '.']);

    expect(() => verifyTempDirPolicy({ root })).toThrow(/temp-dir helper is missing/);
  });

  test('the complete policy runs the temp directory check, so deleting the wiring goes red', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'test-policy.js'), 'utf8');
    expect(source).toMatch(/verifyTempDirPolicy\(\{ root, gitCommand \}\)/);
    expect(() => verifyTempDirPolicy({ root: ROOT })).not.toThrow();
  });

  // Using the helper only cleans up if something calls cleanupTempDirs. Under
  // node:test the helper installs its own exit handler, so it is self-contained;
  // under Jest the teardown lives in jest.config.js. Removing that one line
  // would put every Jest temp directory back in /tmp with nothing going red, so
  // the line is asserted here.
  test('the Jest teardown stays wired into jest.config.js', () => {
    const config = fs.readFileSync(path.join(ROOT, 'jest.config.js'), 'utf8');
    expect(config).toMatch(/setupFilesAfterEnv/);
    expect(config).toMatch(/test\/setup\/cleanup-temp-dirs\.js/);

    const setup = fs.readFileSync(path.join(ROOT, 'test', 'setup', 'cleanup-temp-dirs.js'), 'utf8');
    expect(setup).toMatch(/afterAll/);
    expect(setup).toMatch(/cleanupTempDirs\(\)/);
  });

  test('the helper cleans up what it handed out, and reports what it removed', async () => {
    const { makeTempDir: make, cleanupTempDirs, pendingTempDirs } = await import('./helpers/temp-dir.js');
    const first = make('yos-temp-dir-selftest-');
    const second = make('yos-temp-dir-selftest-');

    expect(fs.existsSync(first)).toBe(true);
    expect(pendingTempDirs()).toEqual(expect.arrayContaining([first, second]));

    const removed = cleanupTempDirs();

    expect(removed).toEqual(expect.arrayContaining([first, second]));
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(pendingTempDirs()).not.toEqual(expect.arrayContaining([first, second]));
  });

  test('cleanup never fails the suite over a directory that is already gone', async () => {
    const { makeTempDir: make, cleanupTempDirs } = await import('./helpers/temp-dir.js');
    const dir = make('yos-temp-dir-vanished-');
    fs.rmSync(dir, { recursive: true, force: true });

    expect(() => cleanupTempDirs()).not.toThrow();
  });

  test('a prefix that could escape the temp root is refused', async () => {
    const { makeTempDir: make } = await import('./helpers/temp-dir.js');

    expect(() => make('../escape-')).toThrow(/path separator/);
    expect(() => make('')).toThrow(/non-empty prefix/);
  });
});
