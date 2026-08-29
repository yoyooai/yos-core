import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from '@jest/globals';

import { makeTempDir } from './helpers/temp-dir.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build-release.mjs');

describe('official release pack', () => {
  test('keeps the full release gate off ordinary npm pack lifecycle', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    const npmignore = fs.readFileSync(path.join(ROOT, '.npmignore'), 'utf8');
    expect(pkg.scripts.prepack).toBeUndefined();
    expect(pkg.scripts.prepublishOnly).toBe('npm run verify');
    expect(pkg.scripts['release:pack']).toBe('node scripts/build-release.mjs');
    expect(gitignore).toMatch(/^publication\/$/m);
    expect(npmignore).toMatch(/^publication\/$/m);
  });

  test('runs verification before creating an archive', () => {
    const tmpDir = makeTempDir('yos-release-pack-');
    const binDir = path.join(tmpDir, 'bin');
    const outputDir = path.join(tmpDir, 'output');
    const callsFile = path.join(tmpDir, 'calls.log');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callsFile}"\nif [ "$1" = "pack" ]; then\n  mkdir -p "${outputDir}"\n  : > "${outputDir}/yos-test.tgz"\n  printf 'yos-test.tgz\\n'\nfi\n`, { mode: 0o755 });

    const result = spawnSync(process.execPath, [BUILD_SCRIPT, '--output', outputDir], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(callsFile, 'utf8').trim().split('\n')).toEqual([
      'run verify',
      `pack --ignore-scripts --pack-destination ${outputDir}`,
    ]);
    expect(fs.existsSync(path.join(outputDir, 'yos-test.tgz'))).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('does not pack when verification fails', () => {
    const tmpDir = makeTempDir('yos-release-pack-fail-');
    const binDir = path.join(tmpDir, 'bin');
    const callsFile = path.join(tmpDir, 'calls.log');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callsFile}"\n[ "$1 $2" = "run verify" ] && exit 9\nexit 0\n`, { mode: 0o755 });

    const result = spawnSync(process.execPath, [BUILD_SCRIPT, '--output', path.join(tmpDir, 'output')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(callsFile, 'utf8').trim()).toBe('run verify');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
