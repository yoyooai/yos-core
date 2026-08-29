import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const dir = makeTempDir('yos-record-dir-test-');
  tmpDirs.push(dir);
  return dir;
}

/**
 * config.js reads YOS_DIR when it is first imported, so each case needs its own
 * module instance pointed at a fresh directory. The cache-busting query keeps
 * the imports independent.
 */
async function loadAgainst(yosDir, tag) {
  const previous = process.env.YOS_DIR;
  process.env.YOS_DIR = yosDir;
  try {
    return {
      components: await import(`../components.js?record-dir-${tag}`),
      config: await import(`../config.js?record-dir-${tag}`),
    };
  } finally {
    if (previous === undefined) delete process.env.YOS_DIR;
    else process.env.YOS_DIR = previous;
  }
}

describe('recording an installed component', () => {
  it('creates the config directory instead of failing on a machine that never ran init', async () => {
    // An install with --no-init, or an init that did not finish, leaves ~/yos
    // without its .yos directory. `yos add` used to copy the component into
    // place and only then fail writing the record — leaving the component
    // installed but untracked, and the retry blocked by the existing directory.
    const yosDir = path.join(makeTmpDir(), 'yos');
    const { components, config } = await loadAgainst(yosDir, 'missing');

    assert.equal(fs.existsSync(config.CONFIG_DIR), false, 'fixture must start without .yos');

    components.saveComponents({ feishu: { version: '0.1.0-alpha.1' } });

    assert.equal(fs.existsSync(config.COMPONENTS_FILE), true);
    assert.deepEqual(components.loadComponents(), { feishu: { version: '0.1.0-alpha.1' } });
  });

  it('leaves an existing record intact when the directory is already there', async () => {
    const yosDir = path.join(makeTmpDir(), 'yos');
    const { components, config } = await loadAgainst(yosDir, 'present');

    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    components.saveComponents({ feishu: { version: '0.1.0-alpha.1' } });
    components.saveComponents({
      feishu: { version: '0.1.0-alpha.1' },
      weixin: { version: '0.1.0-alpha.1' },
    });

    assert.deepEqual(Object.keys(components.loadComponents()).sort(), ['feishu', 'weixin']);
  });
});
