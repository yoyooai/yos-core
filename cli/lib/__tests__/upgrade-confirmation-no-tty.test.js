import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { confirmInteractive } from '../prompts.js';

const CLI = path.join(import.meta.dirname, '..', '..', 'yos.js');
const COMPONENT_CMD = path.join(import.meta.dirname, '..', '..', 'commands', 'component.js');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

// TD-119: an upgrade confirmation that nobody could answer used to be recorded
// as "the user chose to cancel" and reported success. A script upgrading a fleet
// saw a wall of zero exit codes with not one machine upgraded. The rule pinned
// here: with no terminal and no --yes, an upgrade must say why and exit non-zero.

describe('confirmInteractive', () => {
  const realIsTTY = process.stdin.isTTY;
  afterEach(() => { process.stdin.isTTY = realIsTTY; });

  it('reports no-tty rather than answering "no" on behalf of an absent user', async () => {
    process.stdin.isTTY = false;
    assert.equal(await confirmInteractive('Proceed? [y/N]: '), 'no-tty');
  });
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-notty-confirm-'));
  tmpDirs.push(root);
  const yosDir = path.join(root, 'yos-home');
  fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
  fs.writeFileSync(path.join(yosDir, '.yos', 'components.json'), '{}\n', 'utf8');
  return { root, yosDir };
}

// A remote component whose latest tag (served by the fake curl) is ahead of the
// installed version, so `upgrade --all` finds something to upgrade and reaches
// the confirmation — which is the step under test.
function installUpgradableComponent(yosDir, name) {
  const skillDir = path.join(yosDir, '.claude', 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\nversion: 1.0.0\ndescription: no-tty confirmation fixture\n---\n\n# Fixture\n`,
    'utf8'
  );
  const componentsPath = path.join(yosDir, '.yos', 'components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components[name] = {
    version: '1.0.0',
    repo: `example/yos-${name}`,
    source: { type: 'github-release', repo: `example/yos-${name}`, ref: '1.0.0', refType: 'tag' },
  };
  fs.writeFileSync(componentsPath, `${JSON.stringify(components, null, 2)}\n`, 'utf8');
}

function installFakeCurl(root, latestTag) {
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, 'curl'),
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '[{"name":"${latestTag}"}]'\n`,
    { mode: 0o755 }
  );
  return fakeBin;
}

describe('yos upgrade --all with no terminal and no --yes', () => {
  it('refuses with a non-zero exit instead of reporting a cancelled upgrade as success', () => {
    const { root, yosDir } = makeFixture();
    installUpgradableComponent(yosDir, 'fixture');
    const fakeBin = installFakeCurl(root, '2.0.0');

    // spawnSync gives the child no controlling terminal — the exact condition
    // a cron job, a CI step, or `ssh host 'yos upgrade --all'` runs under.
    const result = spawnSync(process.execPath, [CLI, 'upgrade', '--all'], {
      cwd: root,
      env: {
        ...process.env,
        YOS_DIR: yosDir,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        GITHUB_TOKEN: 'test-token',
      },
      encoding: 'utf8',
      timeout: 60000,
    });

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}\n${output}`);
    assert.match(output, /not a terminal/i);
    assert.match(output, /--yes/);
    assert.match(output, /Nothing was upgraded/i);
  });
});

// Reverting any single call site would restore the defect on that path while the
// other two stayed correct, so the count is pinned rather than any one site.
describe('upgrade confirmation call sites', () => {
  it('keeps all three upgrade confirmations on the three-state helper', () => {
    const source = fs.readFileSync(COMPONENT_CMD, 'utf8');
    const uses = source.match(/confirmInteractive\(/g) || [];
    assert.equal(
      uses.length,
      3,
      'each of `upgrade <name>`, `upgrade --all` and `upgrade --self` must confirm through confirmInteractive()'
    );
    assert.doesNotMatch(
      source,
      /promptYesNo\('(?:Proceed with upgrade|Upgrade all components|Proceed with yos-core upgrade)/,
      'an upgrade confirmation went back to promptYesNo(), which answers for an absent user'
    );
  });
});
