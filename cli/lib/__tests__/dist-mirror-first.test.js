/**
 * Behavioral guardrails: metadata and artifacts must actually come from the
 * distribution mirror, not from GitHub.
 *
 * Each test serves a value that exists *only* on the local mirror, so a version
 * or a file that shows up in the result proves which origin answered. Remove
 * the mirror-first branch from github.js or download.js and these go red.
 *
 * The mirror runs in a child process on purpose: the code under test shells out
 * to curl synchronously, which blocks this process's event loop, so an
 * in-process HTTP server could never answer.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { fetchLatestTag, fetchInstallVersion, fetchRawFile } from '../github.js';
import { downloadArchive } from '../download.js';
import { resetMirrorFallbackNotices } from '../dist-origin.js';

const MIRROR_ONLY_TAG = 'v9.9.9';
const SENTINEL = 'SENTINEL-FROM-MIRROR';

const SERVER_SOURCE = `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const [root, portFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  const target = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200).end(fs.readFileSync(target));
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
`;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const cleanups = [];

/** Serve `files` ({ "url/path": string|Buffer }) from a child process. */
function startMirror(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-mirror-'));
  for (const [urlPath, contents] of Object.entries(files)) {
    const target = path.join(dir, urlPath.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  const scriptPath = path.join(dir, '__server.mjs');
  const portFile = path.join(dir, '__port');
  fs.writeFileSync(scriptPath, SERVER_SOURCE);

  const child = spawn(process.execPath, [scriptPath, dir, portFile], { stdio: 'ignore' });
  const stop = () => {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(stop);

  for (let waited = 0; waited < 10000; waited += 25) {
    if (fs.existsSync(portFile)) {
      const port = fs.readFileSync(portFile, 'utf8').trim();
      if (port) return { base: `http://127.0.0.1:${port}`, stop };
    }
    sleepSync(25);
  }
  stop();
  throw new Error('mirror server did not start');
}

function sentinelTarball() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-mirror-tarball-'));
  const inner = path.join(dir, 'yos-core-9.9.9');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, SENTINEL), 'from the mirror\n');
  const tarball = path.join(dir, 'archive.tar.gz');
  execFileSync('tar', ['czf', tarball, '-C', dir, 'yos-core-9.9.9'], { stdio: 'pipe' });
  const contents = fs.readFileSync(tarball);
  fs.rmSync(dir, { recursive: true, force: true });
  return contents;
}

function withEnv(values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanups.push(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

after(() => {
  for (const undo of cleanups.reverse()) undo();
  resetMirrorFallbackNotices();
});

describe('mirror-first metadata reads', () => {
  it('resolves component versions from the mirror', () => {
    const mirror = startMirror({
      '/yoyooai/yos-core/tags.json': JSON.stringify([{ name: MIRROR_ONLY_TAG }, { name: 'v0.0.1' }]),
    });
    withEnv({ YOS_DIST_BASE: mirror.base, YOS_DIST_ONLY: '1' });
    assert.equal(fetchLatestTag('yoyooai/yos-core'), '9.9.9');
    assert.deepEqual(fetchInstallVersion('yoyooai/yos-core'), { version: '9.9.9', prerelease: false });
    mirror.stop();
  });

  it('reads raw metadata files from the mirror', () => {
    const mirror = startMirror({
      '/yoyooai/yos-core/raw/main/registry.json': `{"${SENTINEL}":true}`,
    });
    withEnv({ YOS_DIST_BASE: mirror.base, YOS_DIST_ONLY: '1' });
    assert.match(fetchRawFile('yoyooai/yos-core', 'registry.json'), new RegExp(SENTINEL));
    mirror.stop();
  });

  it('surfaces the mirror URL when the mirror is the only allowed origin', () => {
    // Port 1 is closed: this proves the failure is reported against the mirror
    // rather than silently retried against GitHub.
    withEnv({ YOS_DIST_BASE: 'http://127.0.0.1:1', YOS_DIST_ONLY: '1', YOS_GH_RETRY_DELAY_MS: '' });
    assert.throws(() => fetchLatestTag('yoyooai/yos-core'), /YOS_DIST_ONLY/);
    assert.throws(() => fetchLatestTag('yoyooai/yos-core'), /127\.0\.0\.1:1/);
  });
});

describe('mirror-first artifact downloads', () => {
  it('downloads and extracts a component archive from the mirror', () => {
    const mirror = startMirror({
      [`/yoyooai/yos-core/tarball/tags/${MIRROR_ONLY_TAG}.tar.gz`]: sentinelTarball(),
    });
    withEnv({ YOS_DIST_BASE: mirror.base, YOS_DIST_ONLY: '1' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-mirror-dest-'));
    try {
      const result = downloadArchive('yoyooai/yos-core', '9.9.9', dest);
      assert.equal(result.success, true, result.error);
      assert.ok(fs.existsSync(path.join(dest, SENTINEL)), 'archive came from the mirror');
    } finally {
      mirror.stop();
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('reports the mirror URL when a dist-only download fails', () => {
    withEnv({ YOS_DIST_BASE: 'http://127.0.0.1:1', YOS_DIST_ONLY: '1', YOS_GH_RETRY_DELAY_MS: '' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-mirror-dest-'));
    try {
      const result = downloadArchive('yoyooai/yos-core', '9.9.9', dest);
      assert.equal(result.success, false);
      assert.match(result.error, /YOS_DIST_ONLY/);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
