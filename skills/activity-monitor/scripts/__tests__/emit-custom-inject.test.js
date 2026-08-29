import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { customInjectDir, emitCustomInject } from '../emit-custom-inject.js';

import { makeTempDir } from '../../../../test/helpers/temp-dir.js';

const tmpDirs = [];

function makeYOSDir() {
  const dir = makeTempDir('custom-inject-test-');
  tmpDirs.push(dir);
  return dir;
}

function writeCustomFile(yosDir, name, content) {
  const dir = path.join(yosDir, 'custom-hooks', 'session-start');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('customInjectDir', () => {
  it('resolves under YOS_DIR when set, else under ~/yos', () => {
    assert.equal(customInjectDir({ YOS_DIR: '/opt/zy' }), path.join('/opt/zy', 'custom-hooks', 'session-start'));
    assert.equal(customInjectDir({}), path.join(os.homedir(), 'yos', 'custom-hooks', 'session-start'));
  });
});

describe('emitCustomInject', () => {
  it('emits nothing when the directory does not exist (fresh install)', () => {
    const yosDir = makeYOSDir();
    assert.equal(emitCustomInject({ env: { YOS_DIR: yosDir } }), '');
  });

  it('emits nothing when the directory has no usable content', () => {
    const yosDir = makeYOSDir();
    fs.mkdirSync(path.join(yosDir, 'custom-hooks', 'session-start'), { recursive: true });
    assert.equal(emitCustomInject({ env: { YOS_DIR: yosDir } }), '');

    // Whitespace-only and empty files count as no content.
    writeCustomFile(yosDir, '10-empty.md', '');
    writeCustomFile(yosDir, '20-blank.md', '  \n\n\t\n');
    assert.equal(emitCustomInject({ env: { YOS_DIR: yosDir } }), '');
  });

  it('concatenates .md files in lexicographic order (conf.d-style prefixes)', () => {
    const yosDir = makeYOSDir();
    // Written out of order on purpose — filename order must win.
    writeCustomFile(yosDir, '20-platform.md', 'PLATFORM RULES');
    writeCustomFile(yosDir, '10-rules.md', 'HOUSE RULES\n');

    assert.equal(
      emitCustomInject({ env: { YOS_DIR: yosDir } }),
      'HOUSE RULES\n\nPLATFORM RULES'
    );
  });

  it('ignores dotfiles and non-md entries', () => {
    const yosDir = makeYOSDir();
    writeCustomFile(yosDir, '10-real.md', 'REAL');
    writeCustomFile(yosDir, '.05-hidden.md', 'HIDDEN');
    writeCustomFile(yosDir, 'notes.txt', 'TXT');
    writeCustomFile(yosDir, 'script.js', 'console.log("nope")');
    fs.mkdirSync(path.join(yosDir, 'custom-hooks', 'session-start', 'subdir.md'), { recursive: true });

    assert.equal(emitCustomInject({ env: { YOS_DIR: yosDir } }), 'REAL');
  });

  it('skips whitespace-only files but keeps the rest in order', () => {
    const yosDir = makeYOSDir();
    writeCustomFile(yosDir, '10-a.md', 'A');
    writeCustomFile(yosDir, '20-blank.md', '   \n');
    writeCustomFile(yosDir, '30-c.md', '\nC\n');

    assert.equal(emitCustomInject({ env: { YOS_DIR: yosDir } }), 'A\n\nC');
  });
});
