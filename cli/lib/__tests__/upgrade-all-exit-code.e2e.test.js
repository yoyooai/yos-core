import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const CLI = path.join(import.meta.dirname, '..', '..', 'yos.js');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = makeTempDir('yos-exit-code-e2e-');
  tmpDirs.push(root);
  const yosDir = path.join(root, 'yos-home');
  fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
  fs.writeFileSync(path.join(yosDir, '.yos', 'components.json'), '{}\n', 'utf8');
  return { root, yosDir };
}

function writeSkill(dir, { name, version = '1.0.0', repairHook = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const lifecycle = repairHook
    ? '\nlifecycle:\n  hooks:\n    repair: hooks/repair.js'
    : '';
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\nversion: ${version}\ndescription: Exit-code contract E2E fixture${lifecycle}\n---\n\n# Fixture\n`,
    'utf8'
  );
  if (repairHook) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'repair.js'), repairHook, 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'payload.txt'), `${name} payload\n`, 'utf8');
}

// Remote component registered as github-release; latest tag is served by the
// fake curl below, so `latestTag` controls whether an update is "available".
function installRemoteComponent(yosDir, { name, repairHook = null }) {
  writeSkill(path.join(yosDir, '.claude', 'skills', name), { name, repairHook });
  const componentsPath = path.join(yosDir, '.yos', 'components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components[name] = {
    version: '1.0.0',
    repo: `example/yos-${name}`,
    source: {
      type: 'github-release',
      repo: `example/yos-${name}`,
      ref: '1.0.0',
      refType: 'tag',
    },
  };
  fs.writeFileSync(componentsPath, `${JSON.stringify(components, null, 2)}\n`, 'utf8');
}

// Local-source component: `upgrade --all` check always fails for these
// (local_source_upgrade_unsupported), which is the failure scenario we pin.
function installLocalComponent(root, yosDir, { name }) {
  const sourceDir = path.join(root, `${name}-source`);
  writeSkill(sourceDir, { name });
  const result = spawnSync(process.execPath, [CLI, 'add', `./${name}-source`, '--json'], {
    cwd: root,
    env: { ...process.env, YOS_DIR: yosDir },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function installFakeCurl(root, { latestTag }) {
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, 'curl'),
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '[{"name":"${latestTag}"}]'\n`,
    { mode: 0o755 }
  );
  return fakeBin;
}

function runCheckAll(root, yosDir, { json }) {
  const fakeBin = path.join(root, 'bin');
  const args = ['upgrade', '--all', '--check'];
  if (json) args.push('--json');
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      YOS_DIR: yosDir,
      PATH: fs.existsSync(fakeBin) ? `${fakeBin}${path.delimiter}${process.env.PATH}` : process.env.PATH,
      GITHUB_TOKEN: 'test-token',
      GH_TOKEN: '',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function runUpgrade(root, yosDir, name) {
  const fakeBin = path.join(root, 'bin');
  return spawnSync(process.execPath, [CLI, 'upgrade', name, '--yes', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      YOS_DIR: yosDir,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      GITHUB_TOKEN: 'test-token',
      GH_TOKEN: '',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('upgrade --all exit-code contract (#706): JSON and non-JSON agree', () => {
  it('all checks pass → exit 0 in both modes', () => {
    const { root, yosDir } = makeFixture();
    installRemoteComponent(yosDir, { name: 'exit-code-pass-e2e' });
    installFakeCurl(root, { latestTag: 'v1.0.0' }); // no update available

    const json = runCheckAll(root, yosDir, { json: true });
    assert.equal(json.status, 0, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.success, true);
    assert.equal(output.failed, 0);

    const plain = runCheckAll(root, yosDir, { json: false });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /All components are up to date/);
  });

  it('partial failure (one check fails, one update available) → exit 1 in both modes', () => {
    const { root, yosDir } = makeFixture();
    installLocalComponent(root, yosDir, { name: 'exit-code-local-e2e' });
    installRemoteComponent(yosDir, { name: 'exit-code-remote-e2e' });
    installFakeCurl(root, { latestTag: 'v2.0.0' }); // update available for the remote one

    const json = runCheckAll(root, yosDir, { json: true });
    assert.equal(json.status, 1, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.success, false);
    assert.equal(output.failed, 1);
    assert.equal(output.updatable, 1);
    assert.equal(output.error, 'component_checks_failed');

    const plain = runCheckAll(root, yosDir, { json: false });
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stdout, /1.*component\(s\) have updates available/);
  });

  it('all checks fail → exit 1 in both modes', () => {
    const { root, yosDir } = makeFixture();
    installLocalComponent(root, yosDir, { name: 'exit-code-all-fail-e2e' });

    const json = runCheckAll(root, yosDir, { json: true });
    assert.equal(json.status, 1, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.success, false);
    assert.equal(output.failed, 1);
    assert.equal(output.error, 'component_checks_failed');

    const plain = runCheckAll(root, yosDir, { json: false });
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stdout, /No remotely updatable components found/);
  });
});

describe('same-version component integrity repair', () => {
  it('returns a stage-specific failure instead of claiming the component is up to date', () => {
    const { root, yosDir } = makeFixture();
    installRemoteComponent(yosDir, {
      name: 'repair-failure-e2e',
      repairHook: `console.error('[feishu_subskills_fetch_failed] GitHub assets are incomplete.');\nprocess.exit(1);\n`,
    });
    installFakeCurl(root, { latestTag: 'v1.0.0' });

    const result = runUpgrade(root, yosDir, 'repair-failure-e2e');
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, false);
    assert.equal(output.error, 'feishu_subskills_fetch_failed');
    assert.doesNotMatch(output.reply, /up to date/i);
  });
});
