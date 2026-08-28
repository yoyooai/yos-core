/**
 * The public-shelf verifier is the last gate in docs/release.md: it is what
 * distinguishes "the shelf answers 200" from "the bytes on the public URL are
 * the bytes the build registered". These tests serve a fake shelf over
 * localhost so the failure modes are exercised for real rather than described:
 * a tampered file, a truncated file, an empty capability catalog, a dropped
 * tag, a buildId that does not match. Every one of them must exit non-zero —
 * a verifier that cannot fail is not a gate.
 *
 * The second block covers what a 2026-08-11 review found the verifier passing:
 * a shelf with a file present but missing from index.json, and a shelf whose
 * newest core was newer than the version being verified. Both were green. Both
 * are pinned red here, by reproducing the same mutations rather than by testing
 * the fix's implementation — a test written against the fix would have been
 * green against the bug too.
 *
 * The third block covers the transport: an unbounded `fetch` hung a real run
 * past 90 seconds, so a stall must end as a failure and a blip must be retried.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from '@jest/globals';

import {
  LEGACY_0_1_13_INDEX_SHA256,
  legacy013Problems,
  missingRegistrations,
} from '../scripts/verify-public-shelf.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'verify-public-shelf.mjs');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const versionOf = (tag) => tag.match(/(\d+\.\d+\.\d+)$/)[1];

const CORE = 'yoyooai/yos-core';
const COMPONENTS = 'yoyooai/yos-components';

/**
 * Build a minimal but structurally faithful shelf: index.json describes itself,
 * including the per-repo summaries the real build writes (mirrored tags, packed
 * releases, published installers, vendor sources). Those summaries are what the
 * verifier audits the file list against, so a fixture without them would leave
 * the registration checks untested.
 */
function makeShelf({
  tamper = null,
  truncate = null,
  providers = 1,
  droppedTags = [],
  publicationMode = 'production',
  coreTags = ['v0.1.14'],
  componentTags = ['feishu-v0.1.4'],
  providerTag = null,
  unregister = null,
  omitBody = null,
  omitPublicationMode = false,
  omitBuildId = false,
  omitCapabilities = false,
  withdrawn = [],
  pinExample = null,
} = {}) {
  const bodies = new Map();
  const put = (p, text) => bodies.set(p, Buffer.from(text, 'utf8'));

  const newestCore = coreTags[0];
  const newestComponent = componentTags[0];

  // The pin section is part of the fixture because the verifier reads it: a
  // withdrawn version must not be what the page tells people to install.
  const pinSection = pinExample
    ? `\n## 装指定的旧版本\n\n- **YOS OS 主体**：\`curl -fsSL https://x/install.sh | bash -s -- --branch ${pinExample}\`\n`
    : '';
  put('VERSIONS.md', `# YOS 版本目录\n\n${coreTags.map((t) => `| **YOS OS 主体** | \`${versionOf(t)}\` |`).join('\n')}\n${pinSection}`);
  put('index.html', '<h1>shelf</h1>');
  put('install.sh', '#!/usr/bin/env bash\necho install\n');

  const packages = [];
  const pinnedInstallers = [];
  for (const tag of coreTags) {
    put(`${CORE}/tarball/tags/${tag}.tar.gz`, `pretend-archive-${tag}`);
    put(`${CORE}/package/yos-${versionOf(tag)}.tgz`, `pretend-tarball-${tag}`);
    put(`${CORE}/raw/${tag}/VERSION`, `${versionOf(tag)}\n`);
    put(`install-${tag}.sh`, `#!/usr/bin/env bash\necho install ${tag}\n`);
    packages.push(`yos-${versionOf(tag)}.tgz`);
    pinnedInstallers.push(`install-${tag}.sh`);
  }
  put(`${CORE}/tags.json`, JSON.stringify(coreTags.map((name) => ({ name, commit: { sha: 'c'.repeat(40) } }))));
  put(`${CORE}/releases/latest.json`, JSON.stringify({ tag_name: newestCore, name: newestCore, prerelease: false }));

  for (const tag of componentTags) {
    put(`${COMPONENTS}/tarball/tags/${tag}.tar.gz`, `pretend-archive-${tag}`);
    put(`${COMPONENTS}/raw/${tag}/channels/001_feishu/package.json`, JSON.stringify({ version: versionOf(tag) }));
  }
  put(`${COMPONENTS}/tags.json`, JSON.stringify(componentTags.map((name) => ({ name, commit: { sha: 'd'.repeat(40) } }))));
  put(`${COMPONENTS}/releases/latest.json`, JSON.stringify({ tag_name: newestComponent, name: newestComponent, prerelease: false }));

  put('vendor/caddy/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz', 'pretend-caddy');

  const buildId = 'b'.repeat(64);
  const servedTag = providerTag ?? newestComponent;
  const capabilities = {
    schemaVersion: 1,
    buildId,
    capabilities: providers > 0
      ? [{
        id: 'communication.message',
        providers: Array.from({ length: providers }, (_, i) => ({
          id: `channel.c${i}`,
          registryName: i === 0 ? 'feishu' : `c${i}`,
          repo: COMPONENTS,
          tag: servedTag,
          version: versionOf(servedTag),
        })),
      }]
      : [],
  };
  if (!omitCapabilities) put('capabilities.json', JSON.stringify(capabilities));

  // index.json does not register itself — it cannot carry its own hash. The
  // real shelf behaves the same way, so the fixture must too, and the verifier
  // relies on --expect-build-id plus --expect-index-sha256 to cover the
  // manifest itself.
  let files = [...bodies.keys()].map((p) => ({ path: p, bytes: bodies.get(p).length, sha256: sha256(bodies.get(p)) }));
  if (unregister) files = files.filter((f) => f.path !== unregister);

  const vendorPath = 'vendor/caddy/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz';
  const index = {
    schemaVersion: 1,
    ...(omitPublicationMode ? {} : { publicationMode }),
    ...(omitBuildId ? {} : { buildId }),
    withdrawn,
    repos: [
      {
        repo: CORE,
        tags: coreTags,
        droppedTags,
        packages,
        installer: `install-${newestCore}.sh`,
        pinnedInstallers,
      },
      { repo: COMPONENTS, tags: componentTags, droppedTags: [] },
    ],
    vendor: {
      caddy: ['caddy_2.8.4_linux_amd64.tar.gz'],
      prebuilds: [],
      missing: [],
      sources: [{
        path: vendorPath,
        url: 'https://example.invalid/caddy.tar.gz',
        bytes: bodies.get(vendorPath).length,
        sha256: sha256(bodies.get(vendorPath)),
      }],
    },
    files,
  };
  const indexBuf = Buffer.from(JSON.stringify(index), 'utf8');
  bodies.set('index.json', indexBuf);

  if (tamper) bodies.set(tamper, Buffer.from('tampered bytes', 'utf8'));
  if (truncate) bodies.set(truncate, bodies.get(truncate).subarray(0, 3));
  if (omitBody) bodies.delete(omitBody);

  return { bodies, buildId, indexSha256: sha256(indexBuf) };
}

let server = null;
let githubServer = null;

/**
 * A stand-in for api.github.com, because the check under test is a check about
 * the network: install.sh falls back to GitHub when the mirror does not answer,
 * so a fake that is merely a stubbed function would not exercise the request
 * the installer actually makes. `tag` null serves a release-less repository
 * (404), which is the shape the real 0.1.25 gap had.
 */
async function serveGithub({ tag = null, status = 200, body = null } = {}) {
  const hits = [];
  githubServer = http.createServer((req, res) => {
    hits.push(req.url);
    if (status !== 200) { res.writeHead(status); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body ?? JSON.stringify({ tag_name: tag, name: tag }));
  });
  await new Promise((resolve) => githubServer.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${githubServer.address().port}`, hits };
}

/**
 * @param {object} shelf
 * @param {{stall?: string[], failTimes?: Record<string, number>}} behaviour
 *   `stall` never answers (the hang that had to be killed by hand);
 *   `failTimes` answers 503 that many times before serving normally.
 */
async function serve(shelf, { stall = [], failTimes = {}, dribble = {} } = {}) {
  const hits = new Map();
  const remaining = new Map(Object.entries(failTimes));
  const timers = new Set();
  server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\/+/, '').split('?')[0]);
    hits.set(key, (hits.get(key) ?? 0) + 1);
    if (stall.includes(key)) return; // socket left open on purpose
    const left = remaining.get(key) ?? 0;
    if (left > 0) { remaining.set(key, left - 1); res.writeHead(503); res.end('later'); return; }
    const body = shelf.bodies.get(key);
    if (!body) { res.writeHead(404); res.end('missing'); return; }
    const gapMs = dribble[key];
    if (gapMs !== undefined) {
      // Slow but never stopped: one byte at a time, each gap shorter than the
      // stall window. This is what a big vendor blob on a thin link looks like,
      // and it must not be mistaken for a dead connection.
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let sent = 0;
      const push = () => {
        if (sent >= body.length) { res.end(); return; }
        res.write(body.subarray(sent, sent + 1));
        sent += 1;
        const timer = setTimeout(push, gapMs);
        timers.add(timer);
      };
      push();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  server.on('close', () => { for (const timer of timers) clearTimeout(timer); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
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

function restoreDir(shelf, { remove = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-restore-'));
  for (const [key, body] of shelf.bodies) {
    if (key === remove) continue;
    const target = path.join(dir, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

afterEach(async () => {
  if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
  if (githubServer) { await new Promise((resolve) => githubServer.close(resolve)); githubServer = null; }
});

describe('public shelf verifier', () => {
  test('an intact shelf passes', async () => {
    const { base } = await serve(makeShelf());
    const { code, stdout } = await run(base);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });

  test('a tampered artifact fails', async () => {
    const { base } = await serve(makeShelf({ tamper: `${CORE}/package/yos-0.1.14.tgz` }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/yos-0\.1\.14\.tgz/);
  });

  test('running the verifier through a symlink still executes the gate', async () => {
    const { base } = await serve(makeShelf({ tamper: 'install.sh' }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-verifier-link-'));
    const linkedScript = path.join(dir, 'verify-shelf.mjs');
    fs.symlinkSync(SCRIPT, linkedScript);

    const { code, stderr } = await new Promise((resolve) => {
      execFile(process.execPath, [linkedScript, '--base-url', base, '--full'], { timeout: 30_000 },
        (error, stdout, childStderr) => resolve({
          code: error ? error.code ?? 1 : 0,
          stdout,
          stderr: childStderr,
        }));
    });

    expect(code).toBe(1);
    expect(stderr).toMatch(/install\.sh/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a truncated file fails on byte length', async () => {
    const { base } = await serve(makeShelf({ truncate: 'install.sh' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/install\.sh/);
  });

  test('an empty capability catalog fails', async () => {
    const { base } = await serve(makeShelf({ providers: 0 }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/no providers/);
  });

  test('a dropped tag fails', async () => {
    const { base } = await serve(makeShelf({ droppedTags: ['v0.1.13'] }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/dropped tags/);
  });

  test('a non-production shelf fails', async () => {
    const { base } = await serve(makeShelf({ publicationMode: 'test-only' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/publicationMode/);
  });

  test('a buildId that does not match the expectation fails', async () => {
    const { base } = await serve(makeShelf());
    const { code, stderr } = await run(base, ['--expect-build-id', 'a'.repeat(64)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/buildId/);
  });

  test('a component version that does not match the expectation fails', async () => {
    const { base } = await serve(makeShelf());
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
    const { base } = await serve(makeShelf());
    await new Promise((resolve) => server.close(resolve));
    server = null;
    const { code } = await run(base, ['--retries', '0']);
    expect(code).toBe(1);
  });
});

/**
 * Hashing what the manifest lists cannot prove the manifest lists the right
 * things. Each case below is a file that is really on the shelf and really
 * missing from index.json — the 2026-08-11 review's first finding.
 */
describe('public shelf verifier: the file list itself', () => {
  test('a package present on the shelf but missing from index.json fails', async () => {
    const { base } = await serve(makeShelf({ unregister: `${CORE}/package/yos-0.1.14.tgz` }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/yos-0\.1\.14\.tgz is a packed release .* not registered/);
  });

  test('an always-present file missing from index.json fails', async () => {
    const { base } = await serve(makeShelf({ unregister: 'install.sh' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/install\.sh is part of every shelf but not registered/);
  });

  test('a capability catalog present on the shelf but missing from index.json fails', async () => {
    const { base } = await serve(makeShelf({ unregister: 'capabilities.json' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/capabilities\.json is part of every shelf but not registered/);
  });

  test('a mirrored source archive missing from index.json fails', async () => {
    const { base } = await serve(makeShelf({ unregister: `${CORE}/tarball/tags/v0.1.14.tar.gz` }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/tarball\/tags\/v0\.1\.14\.tar\.gz is the source archive/);
  });

  test('a mirrored vendor artifact missing from index.json fails', async () => {
    const { base } = await serve(makeShelf({ unregister: 'vendor/caddy/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz' }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/vendor source but not registered/);
  });

  test('a swapped index.json fails against the expected digest', async () => {
    const { base } = await serve(makeShelf());
    const { code, stderr } = await run(base, ['--expect-index-sha256', 'f'.repeat(64)]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/index\.json sha256 .* does not match expected/);
  });

  test('the expected index digest passes when the manifest is the signed-off one', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const { code, stdout } = await run(base, ['--expect-index-sha256', shelf.indexSha256]);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });
});

/**
 * "Is 0.1.14 on the shelf" is not the question a release asks; "is 0.1.14 what
 * a customer gets" is. The old check read the expected version out of
 * VERSIONS.md prose, which a history row satisfies — the review's second
 * finding.
 */
describe('public shelf verifier: which version a customer gets', () => {
  test('a newer core on the shelf fails a check for the older version', async () => {
    // The exact mutation from the review: newest is 0.1.15, 0.1.14 is still
    // listed in VERSIONS.md history, and 0.1.14 is what we ask to verify.
    const { base } = await serve(makeShelf({ coreTags: ['v0.1.15', 'v0.1.14'] }));
    const { code, stderr } = await run(base, ['--expect-versions', 'yos=0.1.14']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/newest core on the shelf is 0\.1\.15/);
  });

  test('the expected core version passes when it is the newest one', async () => {
    const { base } = await serve(makeShelf());
    const { code, stdout } = await run(base, ['--expect-versions', 'yos=0.1.14,feishu=0.1.4']);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });

  test('a component served from a tag the shelf does not mirror fails', async () => {
    const { base } = await serve(makeShelf({ providerTag: 'feishu-v0.9.9' }));
    const { code, stderr } = await run(base, ['--expect-versions', 'feishu=0.9.9']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/does not mirror/);
  });

  test('a component shadowed by a newer mirrored tag fails', async () => {
    const { base } = await serve(makeShelf({
      componentTags: ['feishu-v0.1.5', 'feishu-v0.1.4'],
      providerTag: 'feishu-v0.1.4',
    }));
    const { code, stderr } = await run(base, ['--expect-versions', 'feishu=0.1.4']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/mirrors a newer feishu-v0\.1\.5/);
  });
});

/**
 * A verifier that can hang is a verifier people stop running. One stalled
 * connection during the 2026-08-11 review left a full run silent past 90
 * seconds with no exit.
 */
describe('public shelf verifier: transport', () => {
  test('a stalled file fails instead of hanging', async () => {
    const { base } = await serve(makeShelf(), { stall: ['install.sh'] });
    const started = process.hrtime.bigint();
    const { code, stderr } = await run(base, ['--stall-ms', '300', '--retries', '1']);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(code).toBe(1);
    expect(stderr).toMatch(/no bytes for 300ms/);
    expect(elapsedMs).toBeLessThan(20_000);
  }, 30_000);

  /**
   * The reviewer hit this twice with total-time limits of 30s and then 60s: the
   * 15MB vendor blobs are slow, not broken, and both caps turned a healthy shelf
   * red. Progress — not elapsed time — is the signal.
   */
  test('a slow but progressing transfer is not mistaken for a stall', async () => {
    const shelf = makeShelf();
    const slowFile = `${CORE}/package/yos-0.1.14.tgz`;
    const bytes = shelf.bodies.get(slowFile).length;
    // Each byte arrives 40ms apart, so the whole file takes several times the
    // stall window it is being judged against.
    const { base } = await serve(shelf, { dribble: { [slowFile]: 40 } });
    const { code, stdout } = await run(base, ['--stall-ms', '200']);
    expect(bytes * 40).toBeGreaterThan(200 * 3);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  }, 30_000);

  test('an endless trickle still ends, via the absolute backstop', async () => {
    const shelf = makeShelf();
    const slowFile = `${CORE}/package/yos-0.1.14.tgz`;
    const { base } = await serve(shelf, { dribble: { [slowFile]: 400 } });
    const { code, stderr } = await run(base, ['--stall-ms', '5000', '--max-file-seconds', '1', '--retries', '0']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/max-file-seconds 1/);
  }, 30_000);

  test('a transient 503 is retried and the run still passes', async () => {
    const { base } = await serve(makeShelf(), { failTimes: { 'install.sh': 1 } });
    const { code, stdout, stderr } = await run(base, ['--retries', '2']);
    expect(code).toBe(0);
    expect(stdout).toContain('[shelf] PASS');
    expect(stderr).toMatch(/retry 1/);
  });

  test('a 404 is not retried — it is reported once', async () => {
    const { base, hits } = await serve(makeShelf({ omitBody: `${CORE}/raw/v0.1.14/VERSION` }));
    const { code } = await run(base, ['--retries', '5']);
    expect(code).toBe(1);
    expect(hits.get(`${CORE}/raw/v0.1.14/VERSION`)).toBe(1);
  });
});

/**
 * The runbook told operators not to omit the credentials, and then the rollback
 * command in that same file omitted two of them (2026-08-11 review). A rule that
 * only exists as prose gets forgotten exactly where it matters most, so the two
 * moments whose answer gets quoted as a verdict — releasing, rolling back — now
 * refuse to run under-credentialled.
 */
describe('public shelf verifier: sign-off mode', () => {
  test('sign-off without the credentials refuses to run at all', async () => {
    const { base, hits } = await serve(makeShelf());
    const { code, stderr } = await run(base, ['--signoff']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--expect-build-id/);
    expect(stderr).toMatch(/--expect-index-sha256/);
    expect(stderr).toMatch(/--expect-versions/);
    // It must fail before touching the shelf: a missing credential is not
    // something to discover after 923 downloads.
    expect(hits.size).toBe(0);
  });

  test('sign-off names the one credential that is missing', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const { code, stderr } = await run(base, [
      '--signoff',
      '--expect-build-id', shelf.buildId,
      '--expect-versions', 'yos=0.1.14',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--expect-index-sha256/);
    expect(stderr).not.toMatch(/--expect-build-id/);
  });

  test('sample mode cannot be signed off', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const { code, stderr } = await new Promise((resolve) => {
      execFile(process.execPath, [
        SCRIPT, '--base-url', base, '--sample', '5', '--signoff',
        '--expect-build-id', shelf.buildId,
        '--expect-index-sha256', shelf.indexSha256,
        '--expect-versions', 'yos=0.1.14',
      ], { timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/--full/);
  });

  test('a fully credentialled sign-off passes', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.14' });
    const { code, stdout, stderr } = await run(base, [
      '--signoff',
      '--expect-build-id', shelf.buildId,
      '--expect-index-sha256', shelf.indexSha256,
      '--expect-versions', 'yos=0.1.14,feishu=0.1.4',
      '--github-api-base', github.base,
    ]);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });

  /**
   * Present is not the same as complete. A two-provider shelf signed off while
   * --expect-versions named only one of them (2026-08-11 review): the flag was
   * satisfied and the second channel was covered by nothing.
   */
  test('sign-off fails when a provider is not named in the expectation', async () => {
    const shelf = makeShelf({ providers: 2 });
    const { base, hits } = await serve(shelf);
    const { code, stderr } = await run(base, [
      '--signoff',
      '--expect-build-id', shelf.buildId,
      '--expect-index-sha256', shelf.indexSha256,
      '--expect-versions', 'yos=0.1.14,feishu=0.1.4',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/provider c1 is on the shelf but not named/);
    // And it stops before the bulk download: index.json and capabilities.json
    // are enough to know the expectation is incomplete.
    expect(hits.get(`${CORE}/package/yos-0.1.14.tgz`)).toBeUndefined();
  });

  test('sign-off fails when the core version is not named', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const { code, stderr } = await run(base, [
      '--signoff',
      '--expect-build-id', shelf.buildId,
      '--expect-index-sha256', shelf.indexSha256,
      '--expect-versions', 'feishu=0.1.4',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/yos \(the core version\) is not named/);
  });

  test('sign-off passes when every provider is named', async () => {
    const shelf = makeShelf({ providers: 2 });
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.14' });
    const { code, stdout } = await run(base, [
      '--signoff',
      '--expect-build-id', shelf.buildId,
      '--expect-index-sha256', shelf.indexSha256,
      '--expect-versions', 'yos=0.1.14,feishu=0.1.4,c1=0.1.4',
      '--github-api-base', github.base,
    ]);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });

  test('an everyday check is still allowed to name only what it cares about', async () => {
    // The coverage rule belongs to sign-off alone. Making it universal would
    // turn every quick "is feishu 0.1.4 up" into a chore, and chores get skipped.
    const shelf = makeShelf({ providers: 2 });
    const { base } = await serve(shelf);
    const { code, stdout } = await run(base, ['--expect-versions', 'feishu=0.1.4']);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });
});

/**
 * The production shelf immediately before 0.1.14 predates all three modern
 * release markers: buildId, publicationMode, and capabilities.json. Compatibility
 * therefore has to recognise that exact shape and pin its complete index bytes;
 * treating any missing field as production would weaken every future release.
 */
/**
 * The shelf agreeing with itself is not the whole story. `install.sh` resolves
 * the newest release from the mirror first and falls back to
 * `api.github.com/.../releases/latest`, so every check that reads the shelf can
 * be green while the machine that cannot reach the shelf installs something
 * else. That is not hypothetical: 0.1.25 was tagged, mirrored and signed off
 * with no GitHub release object created at all, and the fallback answered
 * 0.1.24 — older than the catalog advertised — until a person noticed by eye
 * (2026-08-28). These tests pin both shapes of that failure red.
 */
describe('public shelf verifier: the installer fallback', () => {
  const credentials = (shelf) => [
    '--signoff',
    '--expect-build-id', shelf.buildId,
    '--expect-index-sha256', shelf.indexSha256,
    '--expect-versions', 'yos=0.1.14,feishu=0.1.4',
  ];

  test('sign-off fails when the tag is pushed but no release was ever created', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    // 404 is what api.github.com answers for a repository with no releases —
    // the exact shape of the 0.1.25 gap.
    const github = await serveGithub({ status: 404 });
    const { code, stderr } = await run(base, [...credentials(shelf), '--github-api-base', github.base]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/sign-off could not confirm the installer's fallback/);
    expect(stderr).toMatch(/--skip-github-latest/);
  });

  test('sign-off fails when GitHub names an older release than the shelf serves', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.13' });
    const { code, stderr } = await run(base, [...credentials(shelf), '--github-api-base', github.base]);

    expect(code).toBe(1);
    // The message has to name the consequence, not just the mismatch: what
    // matters is which version a customer ends up with.
    expect(stderr).toMatch(/GitHub's latest release is v0\.1\.13, expected v0\.1\.14/);
    expect(stderr).toMatch(/cannot reach the mirror installs v0\.1\.13/);
  });

  test('sign-off fails when the release body names no tag at all', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ body: JSON.stringify({ name: 'untagged' }) });
    const { code, stderr } = await run(base, [...credentials(shelf), '--github-api-base', github.base]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/GitHub publishes no latest release, expected v0\.1\.14/);
  });

  test('an unreachable GitHub is a failed sign-off, not a quiet pass', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    // A port with nothing listening: the request cannot be made at all.
    const { code, stdout, stderr } = await run(base, [
      ...credentials(shelf), '--github-api-base', 'http://127.0.0.1:1', '--retries', '0',
    ]);

    expect(code).toBe(1);
    expect(stdout).not.toContain('[shelf] PASS');
    expect(stderr).toMatch(/sign-off could not confirm the installer's fallback/);
  });

  test('sign-off passes and reports the tag when the two agree', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.14' });
    const { code, stdout } = await run(base, [...credentials(shelf), '--github-api-base', github.base]);

    expect(stdout).toContain('[shelf] GitHub latest release v0.1.14');
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
    expect(github.hits).toEqual([`/repos/${CORE}/releases/latest`]);
  });

  /**
   * A rollback legitimately leaves the two disagreeing: the mirror goes back to
   * the older version while GitHub still points at the newer one. That is a
   * decision, so it is stated on the command line and ends up in the ledger
   * entry that quotes the run — not switched off.
   */
  test('--expect-github-latest states a deliberate disagreement', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.15' });
    const { code, stdout } = await run(base, [
      ...credentials(shelf), '--github-api-base', github.base, '--expect-github-latest', 'v0.1.15',
    ]);

    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });

  test('--expect-github-latest is not a blanket bypass', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.13' });
    const { code, stderr } = await run(base, [
      ...credentials(shelf), '--github-api-base', github.base, '--expect-github-latest', 'v0.1.15',
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/GitHub's latest release is v0\.1\.13, expected v0\.1\.15/);
  });

  test('stating a tag and skipping the check at once is refused', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const { code, stderr } = await run(base, [
      ...credentials(shelf), '--expect-github-latest', 'v0.1.15', '--skip-github-latest',
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/contradict each other/);
  });

  test('--skip-github-latest passes but says so out loud', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const { code, stdout } = await run(base, [...credentials(shelf), '--skip-github-latest']);

    expect(code).toBe(0);
    expect(stdout).toContain('[shelf] PASS');
    expect(stdout).toMatch(/SKIPPED: GitHub's latest release was not checked/);
  });

  test('the skip is recorded in the machine-readable summary too', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const { code, stdout } = await new Promise((resolve) => {
      execFile(process.execPath, [
        SCRIPT, '--base-url', base, '--full', '--json',
        ...credentials(shelf), '--skip-github-latest',
      ], { timeout: 30_000 }, (error, out, err) => resolve({ code: error ? error.code ?? 1 : 0, stdout: out, stderr: err }));
    });

    expect(code).toBe(0);
    const summary = JSON.parse(stdout);
    // A run that skipped must not be quotable as one that checked.
    expect(summary.githubLatestSkipped).toBe(true);
    expect(summary.githubLatestChecked).toBe(false);
    expect(summary.pass).toBe(true);
  });

  test('a passing sign-off records the tag it confirmed', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.14' });
    const { stdout } = await new Promise((resolve) => {
      execFile(process.execPath, [
        SCRIPT, '--base-url', base, '--full', '--json',
        ...credentials(shelf), '--github-api-base', github.base,
      ], { timeout: 30_000 }, (error, out, err) => resolve({ code: error ? error.code ?? 1 : 0, stdout: out, stderr: err }));
    });

    const summary = JSON.parse(stdout);
    expect(summary.githubLatestChecked).toBe(true);
    expect(summary.githubLatestSkipped).toBe(false);
    expect(summary.githubLatestTag).toBe('v0.1.14');
  });

  /**
   * The check belongs to sign-off. An everyday "is the shelf still intact" run
   * must not start depending on GitHub being reachable, or the quick check
   * becomes a chore and chores get skipped.
   */
  test('an everyday check does not ask GitHub', async () => {
    const shelf = makeShelf();
    const { base } = await serve(shelf);
    const github = await serveGithub({ tag: 'v0.1.13' });
    const { code, stdout } = await run(base, [
      '--expect-versions', 'yos=0.1.14', '--github-api-base', github.base,
    ]);

    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
    expect(github.hits).toEqual([]);
  });

  /**
   * A restored off-site backup is an old shelf on purpose — auditing it says
   * nothing about what GitHub should currently call latest.
   */
  test('a local backup audit does not ask GitHub', async () => {
    const shelf = makeShelf();
    const github = await serveGithub({ tag: 'v0.1.13' });
    const { code, stdout } = await runLocal(restoreDir(shelf), [
      ...credentials(shelf), '--github-api-base', github.base,
    ]);

    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
    expect(github.hits).toEqual([]);
  });
});

describe('public shelf verifier: 0.1.13 rollback compatibility', () => {
  test('the legacy shelf still fails closed without the explicit compatibility flag', async () => {
    const { base } = await serve(makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitBuildId: true,
      omitCapabilities: true,
    }));
    const { code, stderr } = await run(base, ['--expect-versions', 'yos=0.1.13']);

    expect(code).toBe(1);
    expect(stderr).toMatch(/publicationMode|capabilities\.json/);
  });

  test('a full local audit verifies the pinned three-field-absent 0.1.13 shelf', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitBuildId: true,
      omitCapabilities: true,
    });
    const index = JSON.parse(shelf.bodies.get('index.json').toString('utf8'));

    expect(legacy013Problems(index, shelf.indexSha256, { acceptedDigest: shelf.indexSha256 })).toEqual([]);
    expect(missingRegistrations(index, { legacy013: true })).toEqual([]);
  });

  test('rollback sign-off uses the index digest instead of a nonexistent buildId', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitBuildId: true,
      omitCapabilities: true,
    });
    const { base } = await serve(shelf);
    const { code, stdout, stderr } = await run(base, [
      '--allow-legacy-0.1.13',
      '--signoff',
      '--expect-index-sha256', LEGACY_0_1_13_INDEX_SHA256,
      '--expect-versions', 'yos=0.1.13',
    ]);

    expect(code).toBe(1);
    expect(stdout).not.toContain('[shelf] PASS');
    expect(stderr).not.toContain('--expect-build-id');
  });

  test('legacy mode itself requires a full audit', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitBuildId: true,
      omitCapabilities: true,
    });
    const dir = restoreDir(shelf);
    const { code, stderr } = await new Promise((resolve) => {
      execFile(process.execPath, [
        SCRIPT,
        '--local', dir,
        '--allow-legacy-0.1.13',
        '--expect-index-sha256', LEGACY_0_1_13_INDEX_SHA256,
      ], { timeout: 30_000 }, (error, stdout, err) => resolve({
        code: error ? error.code ?? 1 : 0,
        stdout,
        stderr: err,
      }));
    });

    expect(code).toBe(1);
    expect(stderr).toMatch(/--allow-legacy-0\.1\.13 requires --full/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('legacy mode requires an externally pinned index digest', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitBuildId: true,
      omitCapabilities: true,
    });
    const dir = restoreDir(shelf);
    const { code, stderr } = await runLocal(dir, ['--allow-legacy-0.1.13']);

    expect(code).toBe(1);
    expect(stderr).toMatch(/--allow-legacy-0\.1\.13 requires --expect-index-sha256/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('legacy mode rejects an index digest other than the pinned one', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitBuildId: true,
      omitCapabilities: true,
    });
    const dir = restoreDir(shelf);
    const { code, stderr } = await runLocal(dir, [
      '--allow-legacy-0.1.13',
      '--expect-index-sha256', 'f'.repeat(64),
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/--allow-legacy-0\.1\.13 requires the recorded index sha256/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('legacy mode cannot excuse a newer three-field-absent shelf', async () => {
    const shelf = makeShelf({ omitPublicationMode: true, omitBuildId: true, omitCapabilities: true });
    const dir = restoreDir(shelf);
    const { code, stderr } = await runLocal(dir, [
      '--allow-legacy-0.1.13',
      '--expect-index-sha256', LEGACY_0_1_13_INDEX_SHA256,
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/only valid through core 0\.1\.13/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the compatibility flag cannot excuse an explicit non-production mode', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      publicationMode: 'test-only',
      omitBuildId: true,
      omitCapabilities: true,
    });
    const dir = restoreDir(shelf);
    const { code, stderr } = await runLocal(dir, [
      '--allow-legacy-0.1.13',
      '--expect-index-sha256', LEGACY_0_1_13_INDEX_SHA256,
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/publicationMode is test-only, expected production/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('legacy mode rejects a shelf that already has buildId', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitCapabilities: true,
    });
    const dir = restoreDir(shelf);
    const { code, stderr } = await runLocal(dir, [
      '--allow-legacy-0.1.13',
      '--expect-index-sha256', LEGACY_0_1_13_INDEX_SHA256,
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/legacy compatibility requires buildId to be absent/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('legacy mode rejects a shelf that already registers capabilities.json', async () => {
    const shelf = makeShelf({ coreTags: ['v0.1.13'], omitPublicationMode: true, omitBuildId: true });
    const dir = restoreDir(shelf);
    const { code, stderr } = await runLocal(dir, [
      '--allow-legacy-0.1.13',
      '--expect-index-sha256', LEGACY_0_1_13_INDEX_SHA256,
    ]);

    expect(code).toBe(1);
    expect(stderr).toMatch(/legacy compatibility requires capabilities\.json to be absent/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the compatibility flag is rejected outside local audit or sign-off', async () => {
    const shelf = makeShelf({
      coreTags: ['v0.1.13'],
      omitPublicationMode: true,
      omitBuildId: true,
      omitCapabilities: true,
    });
    const { base, hits } = await serve(shelf);
    const { code, stderr } = await new Promise((resolve) => {
      execFile(process.execPath, [
        SCRIPT,
        '--base-url', base,
        '--full',
        '--allow-legacy-0.1.13',
        '--expect-index-sha256', LEGACY_0_1_13_INDEX_SHA256,
      ], { timeout: 30_000 }, (error, stdout, err) => resolve({
        code: error ? error.code ?? 1 : 0,
        stdout,
        stderr: err,
      }));
    });

    expect(code).toBe(1);
    expect(stderr).toMatch(/only valid with --local --full or --signoff --full/);
    expect(hits.size).toBe(0);
  });
});

/**
 * The backup credential step in docs/release.md claimed to prove the copy was
 * complete while running --sample 1. A 906-file production-shaped copy with one
 * ordinary file deleted passed it: 68 files checked, exit 0 (2026-08-11 review).
 * The two tests below are the same shape — one plain file removed, nothing
 * tampered — and they pin the difference between the two modes rather than
 * trusting a sentence about it.
 */
describe('public shelf verifier: sample mode is not proof', () => {
  const plainFile = `${CORE}/raw/v0.1.14/VERSION`;

  test('--full catches an ordinary missing file in a restored copy', async () => {
    const dir = restoreDir(makeShelf(), { remove: plainFile });
    const { code, stderr } = await runLocal(dir);
    expect(code).toBe(1);
    expect(stderr).toMatch(/VERSION: missing on disk/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Why the step above must be --full, stated as a property rather than as an
   * exit code: sample mode checks strictly fewer files than are registered, so
   * whether it happens to notice a given missing file depends on the shelf's
   * size and the file's position. On the real shelf it did not notice: 906
   * registered, 68 checked, exit 0 with one ordinary file deleted. On this
   * fixture — two dozen files — the same file falls inside the sample and is
   * caught. That difference is exactly why a sampled run can never be the
   * evidence, and why --signoff rejects it outright (see the sign-off block).
   */
  test('sample mode checks only part of the shelf and says so', async () => {
    const dir = restoreDir(makeShelf());
    const { stdout } = await new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, '--local', dir, '--sample', '1'], { timeout: 30_000 },
        (error, out, err) => resolve({ code: error ? error.code ?? 1 : 0, stdout: out, stderr: err }));
    });
    const [, registered, checked] = stdout.match(/(\d+) registered, checking (\d+)/);
    expect(Number(checked)).toBeLessThan(Number(registered));
    expect(stdout).toContain('not proof of the whole shelf');
    expect(stdout).toContain('Release sign-off requires --full');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Withdrawn versions.
 *
 * Every integrity check above passes on a shelf that still carries a version we
 * pulled — and it should, because the artifacts are genuinely there and are
 * meant to stay there so pinned addresses keep working. What must not survive
 * is the page telling people to install it. That is what happened after 0.1.22
 * was rolled back: the catalog kept printing it as the worked example of
 * installing an older version.
 *
 * Checked against the page the public shelf actually serves, not against the
 * build that produced it — the build already has its own check, and two checks
 * reading the same source would only ever agree with each other.
 */
describe('public shelf verifier: withdrawn versions', () => {
  const WITHDRAWN = [{
    repo: CORE,
    tag: 'v0.1.13',
    date: '2026-08-28',
    replacedBy: 'v0.1.14',
    reason: 'pulled during acceptance',
  }];

  test('fails when the page offers a withdrawn version as the way to pin', async () => {
    const { base } = await serve(makeShelf({
      coreTags: ['v0.1.14', 'v0.1.13'],
      withdrawn: WITHDRAWN,
      pinExample: 'v0.1.13',
    }));
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toMatch(/offers withdrawn .* v0\.1\.13 as the way to pin/);
  });

  test('passes when the page pins something we still stand behind', async () => {
    const { base } = await serve(makeShelf({
      coreTags: ['v0.1.14', 'v0.1.13', 'v0.1.12'],
      withdrawn: WITHDRAWN,
      pinExample: 'v0.1.12',
    }));
    const { code, stdout } = await run(base);
    expect(stdout).toContain('[shelf] PASS');
    expect(code).toBe(0);
  });

  test('the withdrawn version itself stays on the shelf and stays verifiable', async () => {
    // Withdrawn is not deleted. If this ever starts failing because the
    // artifacts went missing, the fix is not to relax this test.
    const { base } = await serve(makeShelf({
      coreTags: ['v0.1.14', 'v0.1.13', 'v0.1.12'],
      withdrawn: WITHDRAWN,
      pinExample: 'v0.1.12',
    }));
    const { code, stdout } = await run(base);
    expect(code).toBe(0);
    expect(stdout).toMatch(/hashes matched/);
  });

  test('a shelf with nothing withdrawn is unaffected', async () => {
    const { base } = await serve(makeShelf({ coreTags: ['v0.1.14', 'v0.1.13'], pinExample: 'v0.1.13' }));
    const { code } = await run(base);
    expect(code).toBe(0);
  });
});
