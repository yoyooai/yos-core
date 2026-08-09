import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import * as componentEngines from '../component-engines.js';

const {
  checkNodeEngine,
  describeEngineMismatch,
  readDeclaredNodeRange,
} = componentEngines;

/**
 * The installer accepts Node 20 and up, and the WeChat channel cannot run below
 * 22.18 (it loads `.ts` entrypoints directly — measured 2026-08-06: 20.20.0 and
 * 22.17.1 die with ERR_UNKNOWN_FILE_EXTENSION, 22.18.0 works). Nothing compared
 * the two, so the install succeeded and left a service that could never start.
 */

const CLI = path.join(import.meta.dirname, '..', '..', 'yos.js');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('checking a component against the running node', () => {
  it('accepts the version range the WeChat channel actually needs', () => {
    for (const version of ['22.18.0', '22.22.3', '24.18.0', 'v25.1.0']) {
      assert.equal(checkNodeEngine('>=22.18.0', version).satisfied, true, version);
    }
    for (const version of ['20.20.0', '22.17.1', '18.19.0']) {
      const verdict = checkNodeEngine('>=22.18.0', version);
      assert.equal(verdict.checked, true, version);
      assert.equal(verdict.satisfied, false, version);
    }
  });

  it('honours an upper bound when one is declared', () => {
    assert.equal(checkNodeEngine('>=24.18.0 <25.0.0', '24.19.0').satisfied, true);
    assert.equal(checkNodeEngine('>=24.18.0 <25.0.0', '25.0.0').satisfied, false);
    assert.equal(checkNodeEngine('>=24.18.0 <25.0.0', '22.22.3').satisfied, false);
  });

  it('accepts any alternative in an || range', () => {
    assert.equal(checkNodeEngine('>=20.20.0 <21 || >=22.18.0', '20.20.1').satisfied, true);
    assert.equal(checkNodeEngine('>=20.20.0 <21 || >=22.18.0', '22.18.0').satisfied, true);
    assert.equal(checkNodeEngine('>=20.20.0 <21 || >=22.18.0', '21.5.0').satisfied, false);
  });

  it('treats a bare major or minor as that whole line', () => {
    assert.equal(checkNodeEngine('22', '22.9.0').satisfied, true);
    assert.equal(checkNodeEngine('22', '24.0.0').satisfied, false);
    assert.equal(checkNodeEngine('22.18', '22.18.7').satisfied, true);
    assert.equal(checkNodeEngine('22.18', '22.19.0').satisfied, false);
  });

  it('reports a range it cannot read as unchecked rather than blocking on a guess', () => {
    // Refusing an install because we misread the range would be its own
    // dishonesty, so an unfamiliar syntax lets the install proceed and says why.
    for (const range of ['^22.18.0', '~20.20.0', 'lts/*', '>=nonsense']) {
      const verdict = checkNodeEngine(range, '22.22.3');
      assert.equal(verdict.checked, false, range);
      assert.equal(verdict.satisfied, true, range);
      assert.ok(verdict.reason, range);
    }
  });

  it('does not block a component that declares nothing, or declares everything', () => {
    assert.equal(checkNodeEngine(null, '20.20.0').checked, false);
    assert.equal(checkNodeEngine('*', '20.20.0').satisfied, true);
  });

  it('reads the declared range from the component on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-engines-read-'));
    tmpDirs.push(dir);
    assert.equal(readDeclaredNodeRange(dir), null, 'no package.json at all');

    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    assert.equal(readDeclaredNodeRange(dir), null, 'unreadable package.json');

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=22.18.0' } }));
    assert.equal(readDeclaredNodeRange(dir), '>=22.18.0');
  });

  it('tells the person both numbers and both ways out', () => {
    const lines = describeEngineMismatch({ range: '>=22.18.0', running: '20.20.0' }, 'wechat');
    const text = lines.join('\n');
    assert.match(text, />=22\.18\.0/);
    assert.match(text, /20\.20\.0/);
    assert.match(text, /nothing was installed/i);
    assert.match(text, /yos add wechat/);
    assert.match(text, /widen its engines range/);
  });
});

describe('checking a component against the running YOS core', () => {
  it('reads the existing package.json.yos contract instead of leaving it dead metadata', () => {
    assert.equal(typeof componentEngines.readDeclaredYosContract, 'function');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-component-contract-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      yos: {
        id: 'channel.feishu',
        core: '>=0.1.0-alpha.1 <0.2.0',
        upstreamVersion: '0.3.5',
      },
    }));

    assert.deepEqual(componentEngines.readDeclaredYosContract(dir), {
      id: 'channel.feishu',
      core: '>=0.1.0-alpha.1 <0.2.0',
      upstreamVersion: '0.3.5',
    });
  });

  it('uses real semver semantics for prerelease core ranges and fails closed on invalid ranges', () => {
    assert.equal(typeof componentEngines.checkYosCoreCompatibility, 'function');
    const check = componentEngines.checkYosCoreCompatibility;
    const range = '>=0.1.0-alpha.1 <0.2.0';

    assert.equal(check(range, '0.1.0-alpha.1').satisfied, true);
    assert.equal(check(range, '0.1.0-alpha.0').satisfied, false);
    assert.equal(check(range, '0.1.13').satisfied, true);
    assert.equal(check(range, '0.2.0').satisfied, false);
    assert.deepEqual(check('not-a-range', '0.1.13'), {
      checked: true,
      satisfied: false,
      range: 'not-a-range',
      running: '0.1.13',
      error: 'invalid_core_range',
    });
  });
});

describe('yos add refuses a component this machine cannot run', () => {
  function makeFixture(engines) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-engines-e2e-'));
    tmpDirs.push(root);
    const yosDir = path.join(root, 'yos-home');
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    fs.writeFileSync(path.join(yosDir, '.yos', 'components.json'), '{}\n');

    const source = path.join(root, 'fixture-component');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(
      path.join(source, 'SKILL.md'),
      '---\nname: engines-fixture\nversion: 1.0.0\ndescription: engine gate fixture\n---\n\n# Fixture\n',
    );
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'engines-fixture', version: '1.0.0', engines: { node: engines } }, null, 2),
    );
    return { root, yosDir, source };
  }

  function runAdd({ root, yosDir }) {
    return spawnSync(process.execPath, [CLI, 'add', './fixture-component', '--json'], {
      cwd: root,
      env: { ...process.env, YOS_DIR: yosDir },
      encoding: 'utf8',
      timeout: 60000,
    });
  }

  it('exits non-zero, names both versions, and installs nothing', () => {
    const { root, yosDir } = makeFixture('>=99.0.0');
    const result = runAdd({ root, yosDir });

    assert.notEqual(result.status, 0, `add should have refused\n${result.stdout}\n${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error, 'node_engine_mismatch');
    assert.equal(output.requiredNode, '>=99.0.0');
    assert.equal(output.runningNode, process.version.replace(/^v/, ''));

    // Nothing recorded, nothing left on disk: the machine is where it started.
    const components = JSON.parse(fs.readFileSync(path.join(yosDir, '.yos', 'components.json'), 'utf8'));
    assert.deepEqual(components, {});
    assert.equal(fs.existsSync(path.join(yosDir, '.claude', 'skills', 'engines-fixture')), false);
  });

  it('installs normally when the running node satisfies the range', () => {
    const { root, yosDir } = makeFixture('>=20.20.0');
    const result = runAdd({ root, yosDir });

    assert.equal(result.status, 0, `add should have succeeded\n${result.stdout}\n${result.stderr}`);
    const components = JSON.parse(fs.readFileSync(path.join(yosDir, '.yos', 'components.json'), 'utf8'));
    assert.ok(components['engines-fixture'], 'the component was not recorded');
  });

  it('checks the engine before anything is written to the machine', () => {
    // Order matters: a refusal after npm install or after the registry write
    // leaves half an install behind, which is the failure mode this replaces.
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'commands', 'add.js'), 'utf8');
    const checkAt = source.indexOf('checkNodeEngine(readDeclaredNodeRange(skillDir))');
    const npmAt = source.indexOf('// Step 1: npm install');
    const registryAt = source.indexOf('// Step 3: Update components.json');
    assert.ok(checkAt > 0, 'yos add no longer checks the declared node range');
    assert.ok(npmAt > checkAt, 'the engine check runs after npm install');
    assert.ok(registryAt > checkAt, 'the engine check runs after the component is recorded');
  });
});
