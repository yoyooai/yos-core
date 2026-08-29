import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

import { makeTempDir } from './helpers/temp-dir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIST = path.join(ROOT, 'scripts', 'build-dist.mjs');
const VENDOR_SPEC = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'dist-vendor.json'), 'utf8'),
);

function expand(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}

function vendorUrls(spec = VENDOR_SPEC) {
  const caddy = spec.caddy.files.map((fileTemplate) => {
    const file = expand(fileTemplate, { version: spec.caddy.version });
    return expand(spec.caddy.source, { version: spec.caddy.version, file });
  });
  const prebuilds = spec.prebuilds.flatMap((prebuild) => (
    prebuild.abis.flatMap((abi) => prebuild.targets.map((target) => {
      const file = expand(prebuild.file, { version: prebuild.version, abi, ...target });
      return expand(prebuild.source, { version: prebuild.version, file });
    }))
  ));
  return [...caddy, ...prebuilds];
}

function buildVendorCache(spec = VENDOR_SPEC) {
  const cache = makeTempDir('yos-dist-vendor-cache-');
  for (const url of vendorUrls(spec)) {
    const key = `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}-${path.basename(url)}`;
    fs.writeFileSync(path.join(cache, key), `fixture for ${url}\n`);
  }
  return cache;
}

function buildScriptWithVendorSource(transform) {
  const root = makeTempDir('yos-dist-script-fixture-');
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'cli'), path.join(root, 'cli'), 'dir');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const specPath = path.join(root, 'scripts', 'dist-vendor.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  spec.caddy.source = transform(spec.caddy.source);
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return { buildDist: path.join(root, 'scripts', 'build-dist.mjs'), spec };
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function buildFixture(tagCount = 1) {
  const dir = makeTempDir('yos-dist-safety-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });

  for (let index = 0; index < tagCount; index += 1) {
    const version = `0.1.${index}`;
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: 'yos', version, private: false }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(dir, 'scripts', 'install.sh'), '#!/bin/sh\nexit 0\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', `release v${version}`]);
    git(dir, ['tag', `v${version}`]);
  }
  return dir;
}

function runBuild(args, { buildDist = BUILD_DIST } = {}) {
  return spawnSync(process.execPath, [buildDist, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function expectUnsafeVendorSourceRejected(transform) {
  const repo = buildFixture();
  const output = makeTempDir('yos-dist-unsafe-vendor-source-');
  const { buildDist, spec } = buildScriptWithVendorSource(transform);
  const result = runBuild([
    '--production',
    '--output', output,
    '--repo', `yoyooai/yos-core=${repo}`,
    '--vendor-cache', buildVendorCache(spec),
  ], { buildDist });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'vendor sources must be uncredentialed HTTPS URLs without query strings or fragments',
  );
}

describe('distribution publication safety', () => {
  test('production mode refuses to skip vendor artifacts before creating output', () => {
    const repo = buildFixture();
    const output = path.join(os.tmpdir(), `yos-dist-production-${Date.now()}`);
    const result = runBuild([
      '--production',
      '--output', output,
      '--repo', `yoyooai/yos-core=${repo}`,
      '--skip-vendor',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('production builds cannot skip vendor artifacts');
    expect(fs.existsSync(output)).toBe(false);
  });

  test('production mode refuses the missing-vendor escape hatch', () => {
    const repo = buildFixture();
    const output = path.join(os.tmpdir(), `yos-dist-missing-vendor-${Date.now()}`);
    const result = runBuild([
      '--production',
      '--output', output,
      '--repo', `yoyooai/yos-core=${repo}`,
      '--allow-missing-vendor',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('production builds cannot allow missing vendor artifacts');
    expect(fs.existsSync(output)).toBe(false);
  });

  test('every build mode refuses implicit tag eviction before creating output', () => {
    const repo = buildFixture(4);
    const output = path.join(os.tmpdir(), `yos-dist-retention-${Date.now()}`);
    const result = runBuild([
      '--test-only',
      '--output', output,
      '--repo', `yoyooai/yos-core=${repo}`,
      '--tags', '3',
      '--skip-vendor',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('would drop published tag(s)');
    expect(result.stderr).toContain('v0.1.0');
    expect(result.stderr).toContain('--allow-tag-drop');
    expect(fs.existsSync(output)).toBe(false);
  });

  test('test-only mode defaults to retaining fifty versions', () => {
    const repo = buildFixture();
    const output = makeTempDir('yos-dist-test-only-');
    const result = runBuild([
      '--test-only',
      '--output', output,
      '--repo', `yoyooai/yos-core=${repo}`,
      '--skip-vendor',
    ]);

    expect(result.status).toBe(0);
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    expect(index.publicationMode).toBe('test-only');
    expect(index.repos[0].tagRetention).toBe(50);
  });

  test('production index records the verifiable source of every downloaded vendor artifact', () => {
    const repo = buildFixture();
    const output = makeTempDir('yos-dist-vendor-provenance-');
    const cache = buildVendorCache();
    const result = runBuild([
      '--production',
      '--output', output,
      '--repo', `yoyooai/yos-core=${repo}`,
      '--vendor-cache', cache,
    ]);

    expect(result.status).toBe(0);
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    expect(index.vendor.sources).toHaveLength(vendorUrls().length);

    for (const source of index.vendor.sources) {
      expect(source).toEqual({
        path: expect.stringMatching(/^vendor\//),
        url: expect.stringMatching(/^https:\/\/[^?#]+$/),
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const artifact = path.join(output, source.path);
      expect(fs.statSync(artifact).size).toBe(source.bytes);
      expect(crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')).toBe(source.sha256);
    }
    expect(new Set(index.vendor.sources.map(({ url }) => url))).toEqual(new Set(vendorUrls()));
  }, 120000);

  test('production build rejects a plain HTTP vendor source', () => {
    expectUnsafeVendorSourceRejected((source) => source.replace('https://', 'http://'));
  }, 120000);

  test('production build rejects credentials embedded in a vendor source', () => {
    expectUnsafeVendorSourceRejected((source) => source.replace('https://', 'https://user:pass@'));
  }, 120000);

  test('production build rejects a vendor source with a query string', () => {
    expectUnsafeVendorSourceRejected((source) => `${source}?token=secret`);
  }, 120000);

  test('production build rejects a vendor source with a fragment', () => {
    expectUnsafeVendorSourceRejected((source) => `${source}#artifact`);
  }, 120000);
});
