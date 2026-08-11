#!/usr/bin/env node
/**
 * Verify a published shelf from the outside, the way a customer reaches it.
 *
 * The build already hashes every file it emits (index.json carries path/bytes/
 * sha256 per entry). What this script adds is the only thing the build cannot
 * prove: that the bytes now answering on the public URL are those same bytes.
 * A pre-switch local check plus an HTTP 200 does not establish that — a partial
 * rsync, a stale cache, a wrong root, or a half-finished switch all still
 * return 200.
 *
 * Usage:
 *   node scripts/verify-public-shelf.mjs [--base-url https://yoyooai.com/dist]
 *     [--full | --sample 40] [--concurrency 8] [--expect-build-id <id>]
 *     [--expect-versions yos=0.1.14,feishu=0.1.4,weixin=0.1.3]
 *     [--json]
 *
 *   --local <dir> reads the same index.json from a directory instead of a URL,
 *   which is how a restored off-site backup gets checked: an archive that
 *   extracts is not the same as an archive whose bytes are all intact.
 *
 * --sample N checks the always-list (index.json, capabilities.json, VERSIONS.md,
 * index.html, install.sh) plus every package/archive plus N of the remaining
 * entries spread evenly — so the count checked is normally well above N, and N
 * is a floor on the spread, not a cap on the total. --full downloads and hashes
 * every registered file; release sign-off uses --full.
 *
 * Exit code is 0 only when every checked file matched. Anything else is 1 —
 * there is no partial pass.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALWAYS = ['index.json', 'capabilities.json', 'VERSIONS.md', 'index.html', 'install.sh'];

function parseArgs(argv) {
  const o = { baseUrl: 'https://yoyooai.com/dist', local: null, full: false, sample: 40, concurrency: 8, json: false, expectBuildId: null, expectVersions: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--base-url') o.baseUrl = val().replace(/\/+$/, '');
    else if (a === '--local') o.local = path.resolve(val());
    else if (a === '--full') o.full = true;
    else if (a === '--sample') o.sample = Number(val());
    else if (a === '--concurrency') o.concurrency = Number(val());
    else if (a === '--expect-build-id') o.expectBuildId = val();
    else if (a === '--expect-versions') o.expectVersions = val();
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.sample) || o.sample < 1) throw new Error('--sample must be a positive integer');
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return o;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** One reader for both origins so a restored backup is judged by the same rules. */
function makeReader({ local, baseUrl }) {
  if (!local) return { label: baseUrl, read: (p) => fetchBuffer(`${baseUrl}/${p}`) };
  return {
    label: local,
    read: async (p) => {
      const target = path.resolve(local, p);
      if (!target.startsWith(local + path.sep) && target !== local) throw new Error('path escapes the directory');
      if (!fs.existsSync(target)) throw new Error('missing on disk');
      return fs.readFileSync(target);
    },
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * The always-list and every artifact are unconditional; `sample` only sets how
 * many of the remaining entries get spread in on top. Callers therefore see a
 * checked count above `sample`, which is why the summary reports the breakdown
 * rather than a single number.
 */
export function pickEntries(files, { full = false, sample = 40 } = {}) {
  if (full) return { entries: files, always: files.length, artifacts: 0, spread: 0 };
  const always = files.filter((f) => ALWAYS.includes(f.path));
  const artifacts = files.filter((f) => !ALWAYS.includes(f.path) && /\.(tgz|tar\.gz)$/.test(f.path));
  const rest = files.filter((f) => !ALWAYS.includes(f.path) && !/\.(tgz|tar\.gz)$/.test(f.path));
  const spread = [];
  if (sample > 0 && rest.length > 0) {
    const step = Math.max(1, Math.floor(rest.length / sample));
    for (let i = 0; i < rest.length && spread.length < sample; i += step) spread.push(rest[i]);
  }
  return { entries: [...always, ...artifacts, ...spread], always: always.length, artifacts: artifacts.length, spread: spread.length };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const problems = [];
  const note = (msg) => { problems.push(msg); if (!options.json) console.error(`  ✗ ${msg}`); };

  const reader = makeReader(options);
  if (!options.json) console.log(`[shelf] ${options.local ? 'dir' : 'base'} ${reader.label}`);

  const indexBuf = await reader.read('index.json');
  const index = JSON.parse(indexBuf.toString('utf8'));

  if (index.publicationMode !== 'production') note(`publicationMode is ${index.publicationMode}, expected production`);
  if (options.expectBuildId && index.buildId !== options.expectBuildId) {
    note(`buildId ${index.buildId} does not match expected ${options.expectBuildId}`);
  }
  for (const repo of index.repos ?? []) {
    if ((repo.droppedTags ?? []).length > 0) note(`${repo.repo} dropped tags: ${repo.droppedTags.join(', ')}`);
  }

  // capabilities.json must not be empty: an empty catalog is the exact failure
  // a shelf built before the tags existed produces, and it still serves 200.
  const capsBuf = await reader.read('capabilities.json');
  const caps = JSON.parse(capsBuf.toString('utf8'));
  const providers = (caps.capabilities ?? []).flatMap((c) => c.providers ?? []);
  if (providers.length === 0) note('capabilities.json has no providers');
  if (caps.buildId !== index.buildId) note(`capabilities.json buildId ${caps.buildId} != index.json buildId ${index.buildId}`);

  if (options.expectVersions) {
    const wanted = new Map(options.expectVersions.split(',').map((pair) => {
      const [name, version] = pair.split('=');
      return [name.trim(), (version ?? '').trim()];
    }));
    const seen = new Map(providers.map((p) => [p.registryName, p.version]));
    for (const [name, version] of wanted) {
      if (name === 'yos') continue; // core version is asserted through VERSIONS.md below
      if (seen.get(name) !== version) note(`component ${name} is ${seen.get(name) ?? 'absent'} on the shelf, expected ${version}`);
    }
    const coreWanted = wanted.get('yos');
    if (coreWanted) {
      const versionsMd = (await reader.read('VERSIONS.md')).toString('utf8');
      if (!versionsMd.includes(`\`${coreWanted}\``)) note(`VERSIONS.md does not name core ${coreWanted}`);
    }
  }

  const files = Array.isArray(index.files) ? index.files : [];
  if (files.length === 0) note('index.json registers no files');
  const picked = pickEntries(files, options);
  const entries = picked.entries;
  if (!options.json) {
    const how = options.full
      ? '(full)'
      : `(always ${picked.always} + artifacts ${picked.artifacts} + spread ${picked.spread} — not proof of the whole shelf)`;
    console.log(`[shelf] ${files.length} registered, checking ${entries.length} ${how}`);
  }

  let checked = 0;
  const results = await mapLimit(entries, options.concurrency, async (entry) => {
    try {
      const buf = await reader.read(entry.path);
      if (entry.bytes !== undefined && buf.length !== entry.bytes) {
        note(`${entry.path}: ${buf.length} bytes, index says ${entry.bytes}`);
        return false;
      }
      const got = sha256(buf);
      if (got !== entry.sha256) {
        note(`${entry.path}: sha256 ${got} != ${entry.sha256}`);
        return false;
      }
      checked += 1;
      return true;
    } catch (error) {
      note(`${entry.path}: ${error.message}`);
      return false;
    }
  });

  const matched = results.filter(Boolean).length;
  const summary = {
    source: reader.label,
    origin: options.local ? 'local' : 'public',
    buildId: index.buildId,
    publicationMode: index.publicationMode,
    registeredFiles: files.length,
    checkedFiles: entries.length,
    matchedFiles: matched,
    providers: providers.length,
    mode: options.full ? 'full' : 'sample',
    problems,
    pass: problems.length === 0,
  };

  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[shelf] hashes matched ${matched}/${entries.length}`);
    console.log(`[shelf] providers ${providers.length}, buildId ${index.buildId}`);
    console.log(problems.length === 0 ? '[shelf] PASS' : `[shelf] FAILED with ${problems.length} problem(s)`);
    if (!options.full && problems.length === 0) {
      console.log('[shelf] NOTE: sample mode. Release sign-off requires --full.');
    }
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[shelf] FAILED: ${error.message}`);
  process.exit(1);
});
