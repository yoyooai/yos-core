import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { assertCommandDirectory, inspectYosDirectory } from '../install-directory.js';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tmpDir() {
  const dir = makeTempDir('yos-dir-identity-');
  tmpDirs.push(dir);
  return dir;
}

describe('YOS install directory identity', () => {
  it('distinguishes a complete install from an unrelated existing directory', () => {
    const unrelated = tmpDir();
    assert.equal(inspectYosDirectory(unrelated).state, 'unrelated');

    const install = tmpDir();
    fs.mkdirSync(path.join(install, '.yos'), { recursive: true });
    fs.mkdirSync(path.join(install, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(install, '.yos', 'components.json'), '{}\n');
    assert.equal(inspectYosDirectory(install).state, 'complete');
  });

  it('rejects a normal command before it can write into an unrelated directory', () => {
    const unrelated = tmpDir();
    fs.writeFileSync(path.join(unrelated, 'customer.txt'), 'keep me\n');
    const result = spawnSync(process.execPath, ['cli/yos.js', 'status'], {
      cwd: ROOT,
      env: { ...process.env, YOS_DIR: unrelated },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a YOS installation/i);
    assert.match(result.stderr, /unset YOS_DIR|choose another directory/i);
    assert.equal(fs.readFileSync(path.join(unrelated, 'customer.txt'), 'utf8'), 'keep me\n');
    assert.deepEqual(fs.readdirSync(unrelated), ['customer.txt']);
  });

  it('does not block the init entrypoint while the install directory is new', () => {
    const unrelated = tmpDir();
    const result = spawnSync(process.execPath, ['cli/yos.js', 'init', '--help'], {
      cwd: ROOT,
      env: { ...process.env, YOS_DIR: unrelated },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /yos init/i);
  });

  it('allows an install-in-progress marker instead of breaking add-before-init', () => {
    const inProgress = tmpDir();
    fs.mkdirSync(path.join(inProgress, '.claude', 'skills'), { recursive: true });

    assert.equal(inspectYosDirectory(inProgress).state, 'incomplete');
    assert.doesNotThrow(() => assertCommandDirectory('add', { yosDir: inProgress }));
  });
});
