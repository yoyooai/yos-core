import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { jest } from '@jest/globals';
import { runVerification } from '../scripts/verify.js';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

function makeFixture({ untrackedFile, blockedTrackedFile } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-verify-wiring-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'yos-policy-fixture', version: '1.0.0' }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');

  if (blockedTrackedFile) {
    const blockedPath = path.join(root, blockedTrackedFile);
    fs.mkdirSync(path.dirname(blockedPath), { recursive: true });
    fs.writeFileSync(blockedPath, 'internal\n');
  }

  run('git', ['init', '--quiet'], root);
  run('git', ['add', 'package.json', 'README.md'], root);
  if (blockedTrackedFile) run('git', ['add', blockedTrackedFile], root);

  if (untrackedFile) {
    fs.writeFileSync(path.join(root, untrackedFile), 'local-only\n');
  }
  return root;
}

function runPackageVerification(root) {
  return runVerification({
    root,
    runPrerequisites: false,
    verifyTestPolicyImpl: () => {},
    verifyProgressLogImpl: () => {},
  });
}

describe('verify package-policy wiring', () => {
  const fixtures = [];
  let logs;
  let errors;

  beforeEach(() => {
    logs = [];
    errors = [];
    jest.spyOn(console, 'log').mockImplementation(message => logs.push(String(message)));
    jest.spyOn(console, 'error').mockImplementation(message => errors.push(String(message)));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const fixture of fixtures.splice(0)) {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('allows a package containing only tracked, public files', () => {
    const fixture = makeFixture();
    fixtures.push(fixture);

    const passed = runPackageVerification(fixture);

    expect(passed).toBe(true);
    expect(logs).toContain('\n[verify] PASS');
  });

  test('rejects an untracked file that npm would package', () => {
    const fixture = makeFixture({ untrackedFile: 'local-secret.txt' });
    fixtures.push(fixture);

    const passed = runPackageVerification(fixture);

    expect(passed).toBe(false);
    expect(errors.join('\n')).toContain('local-secret.txt');
  });

  test('rejects a tracked file under a blocked package path', () => {
    const fixture = makeFixture({ blockedTrackedFile: 'docs/internal.md' });
    fixtures.push(fixture);

    const passed = runPackageVerification(fixture);

    expect(passed).toBe(false);
    expect(errors.join('\n')).toContain('docs/internal.md');
  });
});
