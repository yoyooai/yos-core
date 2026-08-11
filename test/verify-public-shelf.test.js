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
} = {}) {
  const bodies = new Map();
  const put = (p, text) => bodies.set(p, Buffer.from(text, 'utf8'));

  const newestCore = coreTags[0];
  const newestComponent = componentTags[0];

  put('VERSIONS.md', `# YOS 版本目录\n\n${coreTags.map((t) => `| **YOS OS 主体** | \`${versionOf(t)}\` |`).join('\n')}\n`);
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
  put('capabilities.json', JSON.stringify(capabilities));

  // index.json does not register itself — it cannot carry its own hash. The
  // real shelf behaves the same way, so the fixture must too, and the verifier
  // relies on --expect-build-id plus --expect-index-sha256 to cover the
  // manifest itself.
  let files = [...bodies.keys()].map((p) => ({ path: p, bytes: bodies.get(p).length, sha256: sha256(bodies.get(p)) }));
  if (unregister) files = files.filter((f) => f.path !== unregister);

  const vendorPath = 'vendor/caddy/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz';
  const index = {
    schemaVersion: 1,
    publicationMode,
    buildId,
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

/**
 * @param {object} shelf
 * @param {{stall?: string[], failTimes?: Record<string, number>}} behaviour
 *   `stall` never answers (the hang that had to be killed by hand);
 *   `failTimes` answers 503 that many times before serving normally.
 */
async function serve(shelf, { stall = [], failTimes = {} } = {}) {
  const hits = new Map();
  const remaining = new Map(Object.entries(failTimes));
  server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\/+/, '').split('?')[0]);
    hits.set(key, (hits.get(key) ?? 0) + 1);
    if (stall.includes(key)) return; // socket left open on purpose
    const left = remaining.get(key) ?? 0;
    if (left > 0) { remaining.set(key, left - 1); res.writeHead(503); res.end('later'); return; }
    const body = shelf.bodies.get(key);
    if (!body) { res.writeHead(404); res.end('missing'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  });
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

afterEach(async () => {
  if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
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
  test('a stalled file times out and fails instead of hanging', async () => {
    const { base } = await serve(makeShelf(), { stall: ['install.sh'] });
    const started = process.hrtime.bigint();
    const { code, stderr } = await run(base, ['--timeout-ms', '300', '--retries', '1']);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(code).toBe(1);
    expect(stderr).toMatch(/timed out after 300ms/);
    expect(elapsedMs).toBeLessThan(20_000);
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
