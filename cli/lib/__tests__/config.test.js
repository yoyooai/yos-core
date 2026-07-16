import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runConfigProbe({ home, yosDir }) {
  const script = `
    import {
      YOS_DIR,
      CONFIG_DIR,
      getYosConfig,
      updateYosConfig,
    } from ${JSON.stringify(new URL('../config.js', import.meta.url).href)};
    updateYosConfig({ runtime: 'codex' });
    console.log(JSON.stringify({ YOS_DIR, CONFIG_DIR, config: getYosConfig() }));
  `;
  const env = { ...process.env, HOME: home };
  delete env.YOS_DIR;
  if (yosDir) env.YOS_DIR = yosDir;
  else delete env.YOS_DIR;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

describe('YOS configuration namespace', () => {
  it('defaults to ~/yos and stores product metadata in .yos', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-config-home-'));
    tempRoots.push(home);

    const result = runConfigProbe({ home });
    assert.equal(result.YOS_DIR, path.join(home, 'yos'));
    assert.equal(result.CONFIG_DIR, path.join(home, 'yos', '.yos'));
    assert.deepEqual(result.config, { runtime: 'codex' });
  });

  it('honors an explicit YOS_DIR override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-config-home-'));
    const yosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-config-root-'));
    tempRoots.push(home, yosDir);

    const result = runConfigProbe({ home, yosDir });
    assert.equal(result.YOS_DIR, yosDir);
    assert.equal(result.CONFIG_DIR, path.join(yosDir, '.yos'));
    assert.deepEqual(result.config, { runtime: 'codex' });
  });
});
