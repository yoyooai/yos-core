/**
 * The release repository is recorded in the machine's ~/yos/.env by the
 * installer, but `yos` runs from a plain shell that never loads that file. Until
 * this was fixed, `yos upgrade --self` answered "YOS_RELEASE_REPO is not
 * configured" on a machine where it demonstrably was, and the periodic check
 * silently skipped core updates for the same reason.
 *
 * Both readers are exercised in child processes: YOS_DIR is resolved when the
 * module is first imported, so a fresh process is the honest way to test it.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const dirs = [];

after(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function machineWithEnvFile(contents) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-machine-'));
  dirs.push(home);
  const yosDir = path.join(home, 'yos');
  fs.mkdirSync(yosDir, { recursive: true });
  if (contents !== null) fs.writeFileSync(path.join(yosDir, '.env'), contents);
  return { home, yosDir };
}

function resolveInChild(yosDir, env = {}) {
  const script = `
    const { resolveReleaseRepo } = await import(${JSON.stringify(path.join(ROOT, 'cli/lib/release-source.js'))});
    console.log(JSON.stringify(resolveReleaseRepo()));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: path.dirname(yosDir), YOS_DIR: yosDir, ...env },
  });
  return JSON.parse(out);
}

describe('release source falls back to the machine configuration', () => {
  it('reads what the installer recorded', () => {
    const { yosDir } = machineWithEnvFile('TZ=Asia/Shanghai\n\n# YOS release source\nYOS_RELEASE_REPO=yoyooai/yos-core\n');
    assert.deepEqual(resolveInChild(yosDir), { success: true, repo: 'yoyooai/yos-core' });
  });

  it('accepts a quoted value', () => {
    const { yosDir } = machineWithEnvFile('YOS_RELEASE_REPO="someone/their-fork"\n');
    assert.deepEqual(resolveInChild(yosDir), { success: true, repo: 'someone/their-fork' });
  });

  it('lets the process environment win over the recorded value', () => {
    // A one-off `YOS_RELEASE_REPO=... yos upgrade --self` must still work.
    const { yosDir } = machineWithEnvFile('YOS_RELEASE_REPO=yoyooai/yos-core\n');
    assert.deepEqual(
      resolveInChild(yosDir, { YOS_RELEASE_REPO: 'other/repo' }),
      { success: true, repo: 'other/repo' },
    );
  });

  it('still fails closed when nothing configured it anywhere', () => {
    const { yosDir } = machineWithEnvFile(null);
    assert.equal(resolveInChild(yosDir).success, false);
    assert.equal(resolveInChild(yosDir).error, 'release_source_not_configured');
  });

  it('is read by the periodic check as well', () => {
    // That script is spawned by the activity monitor with whatever environment
    // PM2 passes, so it cannot rely on the shell either.
    const source = fs.readFileSync(
      path.join(ROOT, 'skills/activity-monitor/scripts/upgrade-check.js'), 'utf8',
    );
    assert.match(source, /function resolveCoreReleaseRepo\(\)/);
    assert.match(source, /YOS_DIR, '\.env'/);
    assert.match(source, /const CORE_RELEASE_REPO = resolveCoreReleaseRepo\(\)/);
  });
});
