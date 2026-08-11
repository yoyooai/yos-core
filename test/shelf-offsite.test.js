/**
 * The off-site backup is the only copy that survives losing the shelf machine,
 * which makes "it reported success" the most dangerous thing it can do wrongly.
 * These tests run the real script against a fake COS on loopback, so each way a
 * backup can silently not be one is exercised rather than described.
 *
 * The first version of this uploader (python, 2026-08-11) skipped symlinks with
 * `if islink: continue`. Nothing about the run looked wrong — the file count it
 * printed was the count it had decided to walk. That is the shape of defect this
 * file exists to keep out: not a crash, but a smaller backup reported as whole.
 *
 * Note what is deliberately NOT asserted here: that the COS v5 signature is
 * accepted by COS. A fake server cannot prove that — only the real service can,
 * and it did on 2026-08-11 (924 objects uploaded, re-verified, and restored).
 * What these tests pin is everything the script decides for itself: what it
 * walks, what it compares, and when it refuses.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from '@jest/globals';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'shelf-offsite.mjs',
);

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let server = null;
let tmpDirs = [];

function tmpDir(prefix = 'offsite-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A fake COS. `store` is the object contents keyed by object key; the knobs let
 * a test make the service misbehave in the specific ways the script claims to
 * defend against (a wrong ETag, a multipart-style ETag, an object whose bytes
 * changed after it was listed).
 */
async function fakeCos({ store = new Map(), etagOverride = null, corruptOnGet = null } = {}) {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));

    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        store.set(key, body);
        res.setHeader('ETag', `"${etagOverride ?? md5(body)}"`);
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(
          ([k, v]) =>
            `<Contents><Key>${xmlEscape(k)}</Key><ETag>&quot;${md5(v)}&quot;</ETag>` +
            `<Size>${v.length}</Size></Contents>`,
        )
        .join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }

    if (req.method === 'GET') {
      if (!store.has(key)) {
        res.writeHead(404);
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      const body = key === corruptOnGet ? Buffer.from('corrupted-in-flight') : store.get(key);
      res.writeHead(200);
      res.end(body);
      return;
    }

    res.writeHead(405);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { store, port: server.address().port };
}

function run(args, { port, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          COS_ENDPOINT: `http://127.0.0.1:${port}`,
          COS_SECRET_ID: 'fake-id',
          COS_SECRET_KEY: 'fake-key',
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const BUCKET = ['--bucket', 'fake-bucket-1234567890', '--region', 'ap-test'];

/** A small shelf-shaped tree. */
function makeTree({ withSymlink = false, withEmptyDir = false } = {}) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), '{"files":[]}');
  fs.writeFileSync(path.join(dir, 'install.sh'), '#!/bin/sh\necho hi\n');
  fs.writeFileSync(path.join(dir, 'sub', 'pkg.tgz'), crypto.randomBytes(2048));
  if (withSymlink) fs.symlinkSync('install.sh', path.join(dir, 'install-latest.sh'));
  if (withEmptyDir) fs.mkdirSync(path.join(dir, 'emptydir'));
  return dir;
}

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('upload', () => {
  test('uploads every file and verifies each ETag', async () => {
    const { port, store } = await fakeCos();
    const dir = makeTree();
    const result = await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/', '--json'], { port });

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.pass).toBe(true);
    expect(report.filesWalked).toBe(3);
    expect(report.uploadedVerified).toBe(3);
    expect([...store.keys()].sort()).toEqual(['p/index.json', 'p/install.sh', 'p/sub/pkg.tgz']);
  });

  test('a symlink stops the run rather than being skipped', async () => {
    const { port, store } = await fakeCos();
    const dir = makeTree({ withSymlink: true });
    const result = await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/symlink/i);
    expect(result.stderr).toContain('install-latest.sh');
    // and nothing was uploaded — it refuses before writing a partial backup
    expect(store.size).toBe(0);
  });

  test('--follow-symlinks uploads the bytes the link points at', async () => {
    const { port, store } = await fakeCos();
    const dir = makeTree({ withSymlink: true });
    const result = await run(
      ['upload', '--root', dir, ...BUCKET, '--prefix', 'p/', '--follow-symlinks', '--json'],
      { port },
    );

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.uploadedVerified).toBe(4);
    expect(store.get('p/install-latest.sh').toString()).toBe('#!/bin/sh\necho hi\n');
  });

  test('an ETag that does not match the local MD5 fails the run', async () => {
    const { port } = await fakeCos({ etagOverride: 'f'.repeat(32) });
    const dir = makeTree();
    const result = await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/!= local md5/);
  });

  test('a multipart-style ETag fails rather than being parsed', async () => {
    const { port } = await fakeCos({ etagOverride: `${'a'.repeat(32)}-2` });
    const dir = makeTree();
    const result = await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not a single-PUT MD5/);
  });

  test('empty directories are named, because the store cannot hold them', async () => {
    const { port } = await fakeCos();
    const dir = makeTree({ withEmptyDir: true });
    const result = await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/', '--json'], { port });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).emptyDirs).toContain('emptydir');
  });
});

describe('verify', () => {
  async function uploadedTree(opts) {
    const { port, store } = await fakeCos();
    const dir = makeTree(opts);
    await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });
    return { port, store, dir };
  }

  test('a faithful backup passes', async () => {
    const { port, dir } = await uploadedTree();
    const result = await run(['verify', '--root', dir, ...BUCKET, '--prefix', 'p/', '--json'], { port });

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.matched).toBe(3);
    expect(report.objectsFound).toBe(3);
  });

  test('one changed byte on the shelf is caught', async () => {
    const { port, dir } = await uploadedTree();
    fs.appendFileSync(path.join(dir, 'install.sh'), 'x');
    const result = await run(['verify', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/install\.sh.*etag .* != local/);
  });

  test('a file missing from the backup is caught', async () => {
    const { port, store, dir } = await uploadedTree();
    store.delete('p/sub/pkg.tgz');
    const result = await run(['verify', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/missing from the backup/);
  });

  test('an object the shelf no longer has is caught — counting alone would miss it', async () => {
    const { port, store, dir } = await uploadedTree();
    store.delete('p/sub/pkg.tgz');
    store.set('p/stale-a.txt', Buffer.from('left over'));
    // counts now match (3 files, 3 objects); only a two-way compare sees the problem
    const result = await run(['verify', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/in the backup but not on the shelf/);
  });
});

describe('restore', () => {
  test('restores every object and hashes what it pulled', async () => {
    const { port } = await fakeCos();
    const dir = makeTree();
    await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    const dest = path.join(tmpDir(), 'restored');
    const result = await run(['restore', '--dest', dest, ...BUCKET, '--prefix', 'p/', '--json'], { port });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).restoredVerified).toBe(3);
    expect(fs.readFileSync(path.join(dest, 'sub', 'pkg.tgz'))).toEqual(
      fs.readFileSync(path.join(dir, 'sub', 'pkg.tgz')),
    );
  });

  test('an empty prefix is a failure, not a successful restore of nothing', async () => {
    const { port } = await fakeCos();
    const dest = path.join(tmpDir(), 'restored');
    const result = await run(['restore', '--dest', dest, ...BUCKET, '--prefix', 'nothing/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/nothing to restore/);
  });

  test('bytes that changed between listing and download are caught', async () => {
    const { port } = await fakeCos({ corruptOnGet: 'p/install.sh' });
    const dir = makeTree();
    await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], { port });

    const dest = path.join(tmpDir(), 'restored');
    const result = await run(['restore', '--dest', dest, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/downloaded md5 .* != stored etag/);
    expect(fs.existsSync(path.join(dest, 'install.sh'))).toBe(false);
  });

  test('a key that would escape --dest is refused', async () => {
    const store = new Map([['p/../../escaped.txt', Buffer.from('pwned')]]);
    const { port } = await fakeCos({ store });
    const dest = path.join(tmpDir(), 'restored');
    const result = await run(['restore', '--dest', dest, ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/escapes --dest/);
  });
});

describe('refusals', () => {
  test('missing credentials stop the run', async () => {
    const { port } = await fakeCos();
    const dir = makeTree();
    const result = await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], {
      port,
      env: { COS_SECRET_ID: '', COS_SECRET_KEY: '' },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/COS_SECRET_ID and COS_SECRET_KEY/);
  });

  test('the test-only endpoint hook refuses to point anywhere but loopback', async () => {
    const { port } = await fakeCos();
    const dir = makeTree();
    const result = await run(['upload', '--root', dir, ...BUCKET, '--prefix', 'p/'], {
      port,
      env: { COS_ENDPOINT: 'http://backup.example.com' },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/test-only hook/);
  });

  test('an unknown command does not silently do nothing', async () => {
    const { port } = await fakeCos();
    const result = await run(['sync', ...BUCKET, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown command/);
  });
});
