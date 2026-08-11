/**
 * The public-shelf verifier is the last gate in docs/release.md: it is what
 * distinguishes "the shelf answers 200" from "the bytes on the public URL are
 * the bytes the build registered". These tests serve a fake shelf over
 * localhost so the failure modes are exercised for real rather than described:
 * a tampered file, a truncated file, an empty capability catalog, a dropped
 * tag, a buildId that does not match. Every one of them must exit non-zero —
 * a verifier that cannot fail is not a gate.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from '@jest/globals';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-public-shelf.mjs');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Build a minimal but structurally faithful shelf: index.json describes itself. */
function makeShelf({ tamper = null, truncate = null, providers = 1, droppedTags = [], publicationMode = 'production' } = {}) {
  const bodies = new Map();
  const put = (p, text) => bodies.set(p, Buffer.from(text, 'utf8'));

  put('VERSIONS.md', '# YOS 版本目录\n\n| **YOS OS 主体** | `0.1.14` |\n');
  put('index.html', '<h1>shelf</h1>');
  put('install.sh', '#!/usr/bin/env bash\necho install\n');
  put('yoyooai/yos-core/package/yos-0.1.14.tgz', 'pretend-tarball');
  put('yoyooai/yos-core/raw/v0.1.14/VERSION', '0.1.14\n');

  const buildId = 'b'.repeat(64);
  const capabilities = {
    schemaVersion: 1,
    buildId,
    capabilities: providers > 0
      ? [{
        id: 'communication.message',
        providers: Array.from({ length: providers }, (_, i) => ({
          id: `channel.c${i}`, registryName: i === 0 ? 'feishu' : `c${i}`, version: '0.1.4',
        })),
      }]
      : [],
  };
  put('capabilities.json', JSON.stringify(capabilities));

  // index.json does not register itself — it cannot carry its own hash. The
  // real shelf behaves the same way, so the fixture must too, and the verifier
  // relies on --expect-build-id to cover the manifest itself.
  const files = [...bodies.keys()].map((p) => ({ path: p, bytes: bodies.get(p).length, sha256: sha256(bodies.get(p)) }));
  const index = {
    schemaVersion: 1,
    publicationMode,
    buildId,
    repos: [{ repo: 'yoyooai/yos-core', tags: ['v0.1.14'], droppedTags }],
    files,
  };
  bodies.set('index.json', Buffer.from(JSON.stringify(index), 'utf8'));

  if (tamper) bodies.set(tamper, Buffer.from('tampered bytes', 'utf8'));
  if (truncate) bodies.set(truncate, bodies.get(truncate).subarray(0, 3));

  return { bodies, buildId };
}

let server = null;

async function serve(shelf) {
  server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\/+/, '').split('?')[0]);
    const body = shelf.bodies.get(key);
    if (!body) { res.writeHead(404); res.end('missing'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function runLocal(dir, extra = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '--local', dir, '--full', ...extra], { timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
  });
}

function run(baseUrl, extra = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, '--base-url', baseUrl, '--full', ...extra], { timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
  });
}

afterEach(async () => {
  if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
});

describe('public shelf verifier', () => {
  test('an intact shelf passes', async () => {
    const base = await serve(makeShelf());
    const { code, stdout } = await run(base);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });

  test('a tampered artifact fails', async () => {
    const base = await serve(makeShelf({ tamper: 'yoyooai/yos-core/package/yos-0.1.14.tgz' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/yos-0\.1\.14\.tgz/);
  });

  test('a truncated file fails on byte length', async () => {
    const base = await serve(makeShelf({ truncate: 'install.sh' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/install\.sh/);
  });

  test('an empty capability catalog fails', async () => {
    const base = await serve(makeShelf({ providers: 0 }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/no providers/);
  });

  test('a dropped tag fails', async () => {
    const base = await serve(makeShelf({ droppedTags: ['v0.1.13'] }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/dropped tags/);
  });

  test('a non-production shelf fails', async () => {
    const base = await serve(makeShelf({ publicationMode: 'test-only' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/publicationMode/);
  });

  test('a buildId that does not match the expectation fails', async () => {
    const base = await serve(makeShelf());
    const { code, stderr } = await run(base, ['--expect-build-id', 'a'.repeat(64)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/buildId/);
  });

  test('a component version that does not match the expectation fails', async () => {
    const base = await serve(makeShelf());
    const { code, stderr } = await run(base, ['--expect-versions', 'feishu=9.9.9']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/feishu/);
  });

  // --local is the restore drill in docs/release.md: an off-site archive that
  // extracts is not the same as one whose bytes are all still intact.
  test('a restored copy on disk passes when every byte survived', async () => {
    const shelf = makeShelf();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-restore-'));
    for (const [key, body] of shelf.bodies) {
      const target = path.join(dir, key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    const { code, stdout } = await runLocal(dir);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a restored copy with one corrupted file fails', async () => {
    const shelf = makeShelf();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-restore-'));
    for (const [key, body] of shelf.bodies) {
      const target = path.join(dir, key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    fs.writeFileSync(path.join(dir, 'install.sh'), 'corrupted');
    const { code, stderr } = await runLocal(dir);
    expect(code).toBe(1);
    expect(stderr).toMatch(/install\.sh/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an unreachable shelf fails instead of passing quietly', async () => {
    const base = await serve(makeShelf());
    await new Promise((resolve) => server.close(resolve));
    server = null;
    const { code } = await run(base);
    expect(code).toBe(1);
  });
});
