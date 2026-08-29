/**
 * A pinned install address must keep working, and a dropped version must be said out loud.
 *
 * `install-<tag>.sh` was published for the newest release only, while publishing
 * uses `rsync --delete`. So a pinned address died at the very next release:
 * measured against production on 2026-08-06, install-v0.1.0.sh and
 * install-v0.1.1.sh were 404 while install-v0.1.2.sh answered. The file name
 * promises "this is the address you can pin", and it did not survive one release.
 *
 * Two properties are covered here, and the second is the one that was silent:
 *   1. every mirrored tag gets a pinned installer, taken from THAT tag — a
 *      pinned address serving another version's installer is worse than none;
 *   2. tags that fall outside retention are reported. Retention is still a real
 *      limit; what is not acceptable is discovering it as a 404.
 *
 * The fixture is a synthetic repository whose install.sh differs per tag, so
 * "each comes from its own tag" is actually observable. In the real repo the
 * file happened to be identical across v0.1.0–v0.1.2, which would let a build
 * that copies the newest file everywhere pass while being wrong.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from '@jest/globals';

import { makeTempDir } from './helpers/temp-dir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIST = path.join(ROOT, 'scripts', 'build-dist.mjs');

const TAGS = ['v0.1.0', 'v0.1.1', 'v0.1.2', 'v0.1.3'];
let fixture;
let output;
let buildLog;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/** A repo with one commit and one tag per version, each with its own install.sh. */
function buildFixture() {
  const dir = makeTempDir('yos-dist-fixture-');
  git(dir, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });

  for (const tag of TAGS) {
    const version = tag.slice(1);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: 'yos', version, private: false }, null, 2)}\n`
    );
    // The marker is what makes provenance checkable.
    fs.writeFileSync(
      path.join(dir, 'scripts', 'install.sh'),
      `#!/usr/bin/env bash\necho "installer for ${tag}"\n`
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `release ${tag}`]);
    git(dir, ['tag', tag]);
  }
  return dir;
}

beforeAll(() => {
  fixture = buildFixture();
  output = makeTempDir('yos-dist-out-test-');
  // Retention 3 of 4 tags, so exactly one tag must be reported as dropped.
  buildLog = execFileSync(process.execPath, [
    BUILD_DIST,
    '--test-only',
    '--output', output,
    '--repo', `yoyooai/yos-core=${fixture}`,
    '--tags', '3',
    '--allow-tag-drop',
    '--skip-vendor',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}, 120000);

describe('pinned installers', () => {
  test('every mirrored tag has one', () => {
    for (const tag of ['v0.1.3', 'v0.1.2', 'v0.1.1']) {
      expect(fs.existsSync(path.join(output, `install-${tag}.sh`))).toBe(true);
    }
  });

  test('each one is the installer from its own tag, not a copy of the newest', () => {
    for (const tag of ['v0.1.3', 'v0.1.2', 'v0.1.1']) {
      const contents = fs.readFileSync(path.join(output, `install-${tag}.sh`), 'utf8');
      expect(contents).toContain(`installer for ${tag}`);
    }
  });

  test('the unpinned install.sh is the newest release', () => {
    const contents = fs.readFileSync(path.join(output, 'install.sh'), 'utf8');
    expect(contents).toContain('installer for v0.1.3');
  });

  test('a tag outside retention gets no pinned installer — and is not silently missing', () => {
    expect(fs.existsSync(path.join(output, 'install-v0.1.0.sh'))).toBe(false);
    expect(buildLog).toMatch(/NOT mirrored \(retention 3\)/);
    expect(buildLog).toMatch(/v0\.1\.0/);
  });

  test('index.json states the retention and what fell outside it', () => {
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    const core = index.repos.find(r => r.repo === 'yoyooai/yos-core');
    expect(core.tagRetention).toBe(3);
    expect(core.droppedTags).toContain('v0.1.0');
    expect(core.pinnedInstallers).toEqual(
      expect.arrayContaining(['install-v0.1.3.sh', 'install-v0.1.2.sh', 'install-v0.1.1.sh'])
    );
  });

  // The deeper half of the same defect, found while accepting 0.1.3: the
  // installer prefers the npm package and only falls back to git, which needs
  // GitHub. Mirroring a package for the newest tag alone meant only the newest
  // version could be installed without GitHub. Measured with GitHub blackholed,
  // `install.sh --branch v0.1.2` printed "No release package for v0.1.2 on the
  // distribution mirror — installing from git" and died on ssh to github.com.
  // Pinning an older version was impossible for exactly the machines the mirror
  // exists for.
  test('every mirrored tag has its own npm package, not just the newest', () => {
    const packageDir = path.join(output, 'yoyooai', 'yos-core', 'package');
    const packed = fs.readdirSync(packageDir).sort();
    expect(packed).toEqual(['yos-0.1.1.tgz', 'yos-0.1.2.tgz', 'yos-0.1.3.tgz']);
  });

  test('index.json lists a package per mirrored tag', () => {
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    const core = index.repos.find(r => r.repo === 'yoyooai/yos-core');
    expect(core.packages).toEqual(
      expect.arrayContaining(['yos-0.1.3.tgz', 'yos-0.1.2.tgz', 'yos-0.1.1.tgz'])
    );
    expect(core.packages).not.toContain('yos-0.1.0.tgz'); // outside retention
  });

  test('every published installer carries a digest, like every other mirrored file', () => {
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    const installers = index.files.filter(f => f.path.startsWith('install'));
    expect(installers.length).toBe(4); // install.sh + three pinned
    for (const file of installers) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
