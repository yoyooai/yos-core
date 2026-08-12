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
 * Two things it deliberately does NOT trust:
 *
 *   1. **The file list itself.** Hashing every entry in index.json proves only
 *      that the listed files are intact — not that the list is the right list.
 *      A shelf whose index.json simply omits a package that is sitting right
 *      there passed every hash check (2026-08-11 review). So the manifest is
 *      cross-checked against what it itself claims to contain (every mirrored
 *      tag's archive, every packed release, every published installer, every
 *      vendor source), and `--expect-index-sha256` pins the whole list to the
 *      build that was signed off.
 *   2. **Prose.** The core version used to be asserted with
 *      `VERSIONS.md.includes(version)`, which a history table satisfies: a shelf
 *      whose newest core was 0.1.15 passed a check for 0.1.14 because 0.1.14 was
 *      still listed further down (same review). Versions are now computed from
 *      the mirrored tag set — the same `newestReleaseTag()` the capability index
 *      uses — and from `releases/latest.json`, which is what the installer
 *      actually resolves.
 *
 * Usage:
 *   node scripts/verify-public-shelf.mjs [--base-url https://yoyooai.com/dist]
 *     [--full | --sample 40] [--concurrency 8] [--expect-build-id <id>]
 *     [--expect-index-sha256 <hex>]
 *     [--expect-versions yos=0.1.14,feishu=0.1.4,weixin=0.1.3]
 *     [--signoff] [--stall-ms 30000] [--max-file-seconds 600] [--retries 2] [--json]
 *     [--allow-legacy-0.1.13]
 *
 *   --signoff is for the two moments the answer gets quoted as a verdict —
 *   releasing and rolling back. Modern shelves require --full and all three
 *   credentials; the pinned pre-catalog 0.1.13 shelf has no buildId and uses its
 *   immutable index digest instead. It refuses once it can see the catalog unless
 *   --expect-versions names the core plus every provider the shelf serves,
 *   because a flag that is merely present covers nothing it does not mention.
 *   Everyday checks and backup self-audits need none of it.
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
import { fileURLToPath } from 'node:url';

import { newestReleaseTag, tagPrefixOf, tagVersion } from './lib/release-tags.mjs';

const ALWAYS = ['index.json', 'capabilities.json', 'VERSIONS.md', 'index.html', 'install.sh'];

/** The immutable index recorded before the 0.1.14 shelf replaced production. */
export const LEGACY_0_1_13_INDEX_SHA256 =
  'ea64d43821e814c12a7e83e90269dfc7b67e9ab6b1f8ef5d7dd838095b04f9c1';

/** The three credentials that make a run a sign-off rather than a look. */
const SIGNOFF_REQUIRED = [
  ['expectBuildId', '--expect-build-id'],
  ['expectIndexSha256', '--expect-index-sha256'],
  ['expectVersions', '--expect-versions'],
];

function parseArgs(argv) {
  const o = {
    baseUrl: 'https://yoyooai.com/dist', local: null, full: false, sample: 40, concurrency: 8,
    json: false, expectBuildId: null, expectIndexSha256: null, expectVersions: null,
    signoff: false, allowLegacy013: false,
    stallMs: 30_000, maxFileSeconds: 600, retries: 2,
  };
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
    else if (a === '--expect-index-sha256') o.expectIndexSha256 = val().trim().toLowerCase();
    else if (a === '--expect-versions') o.expectVersions = val();
    else if (a === '--signoff') o.signoff = true;
    else if (a === '--allow-legacy-0.1.13') {
      o.allowLegacy013 = true;
    }
    else if (a === '--stall-ms') o.stallMs = Number(val());
    else if (a === '--max-file-seconds') o.maxFileSeconds = Number(val());
    else if (a === '--retries') o.retries = Number(val());
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.sample) || o.sample < 1) throw new Error('--sample must be a positive integer');
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  if (!Number.isInteger(o.stallMs) || o.stallMs < 1) throw new Error('--stall-ms must be a positive integer');
  if (!Number.isInteger(o.maxFileSeconds) || o.maxFileSeconds < 1) throw new Error('--max-file-seconds must be a positive integer');
  if (!Number.isInteger(o.retries) || o.retries < 0) throw new Error('--retries must be a non-negative integer');
  if (o.expectIndexSha256 && !/^[0-9a-f]{64}$/.test(o.expectIndexSha256)) {
    throw new Error('--expect-index-sha256 must be a 64-character hex sha256');
  }

  // Sign-off is checked here, before a single byte is fetched: a run that is
  // going to be quoted as "the shelf is verified" must not be able to reach a
  // PASS with a credential missing. Prose asking people not to forget is what
  // this replaces — the runbook said "别省这个参数" and the rollback command in
  // that same file forgot two of them (2026-08-11 review).
  if (o.signoff) {
    const required = o.allowLegacy013
      ? SIGNOFF_REQUIRED.filter(([key]) => key !== 'expectBuildId')
      : SIGNOFF_REQUIRED;
    const missing = required.filter(([key]) => !o[key]).map(([, flag]) => flag);
    if (!o.full) missing.push('--full');
    if (missing.length > 0) {
      throw new Error(`--signoff requires ${missing.join(', ')} — a sign-off with a missing credential is not a sign-off`);
    }
  }
  if (o.allowLegacy013 && !o.full) {
    throw new Error('--allow-legacy-0.1.13 requires --full');
  }
  if (o.allowLegacy013 && !o.expectIndexSha256) {
    throw new Error('--allow-legacy-0.1.13 requires --expect-index-sha256');
  }
  if (o.allowLegacy013 && o.expectIndexSha256 !== LEGACY_0_1_13_INDEX_SHA256) {
    throw new Error(
      `--allow-legacy-0.1.13 requires the recorded index sha256 ${LEGACY_0_1_13_INDEX_SHA256}`,
    );
  }
  if (o.allowLegacy013 && !o.local && !o.signoff) {
    throw new Error(
      '--allow-legacy-0.1.13 is only valid with --local --full or --signoff --full',
    );
  }
  return o;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, bounded by progress rather than by total time.
 *
 * `fetch` without a signal has no timeout at all: one stalled connection left a
 * full-shelf run silent past 90 seconds with no exit, killed by hand
 * (2026-08-11). But a total-time limit is the wrong replacement — the shelf
 * carries 15MB vendor blobs, and on a slow link those legitimately take
 * minutes. A 30s then 60s total cap turned healthy large files red for the
 * reviewer, twice. "Slow" and "dead" are different conditions and need
 * different tests.
 *
 * So: the clock resets on every chunk that arrives. A transfer that is still
 * moving is never interrupted; one that stops moving for `stallMs` is failed.
 * `maxFileSeconds` is only a backstop against a trickle that never ends.
 *
 * Retries cover the transport (stall, reset, 5xx). A 4xx is not retried — a 404
 * stays a 404, and retrying it only makes the report slower to arrive.
 */
async function fetchOnce(url, { stallMs, maxFileSeconds }) {
  const controller = new AbortController();
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error(`no bytes for ${stallMs}ms`)), stallMs);
  };
  const capTimer = setTimeout(
    () => controller.abort(new Error(`exceeded --max-file-seconds ${maxFileSeconds}`)),
    maxFileSeconds * 1000,
  );
  armStall();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500) error.final = true;
      throw error;
    }
    const reader = res.body.getReader();
    const chunks = [];
    while (true) {
      armStall();
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(capTimer);
  }
}

async function fetchBuffer(url, { stallMs, maxFileSeconds, retries, onRetry }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchOnce(url, { stallMs, maxFileSeconds });
    } catch (error) {
      if (error.final) throw error;
      // An aborted fetch surfaces the reason we passed to abort(); older shapes
      // surface a bare AbortError, so both are normalised to something readable.
      lastError = error.name === 'AbortError' ? new Error(error.message || 'aborted') : error;
      if (attempt < retries) {
        onRetry?.(url, attempt + 1, lastError);
        await sleep(250 * (attempt + 1));
      }
    }
  }
  throw new Error(`${lastError.message} (${retries + 1} attempt(s))`);
}

/** One reader for both origins so a restored backup is judged by the same rules. */
function makeReader({ local, baseUrl, stallMs, maxFileSeconds, retries }, onRetry) {
  if (!local) {
    return {
      label: baseUrl,
      read: (p) => fetchBuffer(`${baseUrl}/${p}`, { stallMs, maxFileSeconds, retries, onRetry }),
    };
  }
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

/**
 * What index.json says the shelf contains, checked against what index.json
 * registers — the manifest audited against itself.
 *
 * Hashing entries can only ever vouch for entries that are present. Everything
 * below is named by the manifest's own summaries (mirrored tags, packed
 * releases, published installers, vendor sources), so a file that dropped out of
 * `files` while still being advertised is a contradiction inside one document,
 * detectable without any external input.
 *
 * @returns {string[]} human-readable problems, empty when the manifest agrees
 *   with itself
 */
export function missingRegistrations(index, { legacy013 = false } = {}) {
  const registered = new Map((index.files ?? []).map((f) => [f.path, f]));
  const problems = [];
  const require_ = (p, why) => {
    if (!registered.has(p)) problems.push(`${p} is ${why} but not registered in index.json`);
  };

  // index.json cannot register itself; that gap is what --expect-index-sha256
  // exists for. Everything else on the always-list must be listed.
  for (const p of ALWAYS) {
    if (p === 'index.json') continue;
    if (legacy013 && p === 'capabilities.json') continue;
    require_(p, 'part of every shelf');
  }

  for (const repo of index.repos ?? []) {
    const name = repo.repo;
    require_(`${name}/tags.json`, `${name}'s tag mirror`);
    require_(`${name}/releases/latest.json`, `what the installer resolves for ${name}`);
    for (const tag of repo.tags ?? []) require_(`${name}/tarball/tags/${tag}.tar.gz`, `the source archive for ${tag}`);
    for (const pkg of repo.packages ?? []) require_(`${name}/package/${pkg}`, `a packed release of ${name}`);
    for (const installer of [repo.installer, ...(repo.pinnedInstallers ?? [])]) {
      if (installer) require_(installer, `a published installer for ${name}`);
    }
  }

  // vendor.sources is a second manifest of the same files, with its own hashes.
  // Both must agree: a mirrored third-party artifact that is present but
  // unregistered is exactly the shape of the miss above.
  for (const source of index.vendor?.sources ?? []) {
    const entry = registered.get(source.path);
    if (!entry) {
      problems.push(`${source.path} is a mirrored vendor source but not registered in index.json`);
      continue;
    }
    if (source.sha256 && entry.sha256 && source.sha256 !== entry.sha256) {
      problems.push(`${source.path}: vendor sha256 ${source.sha256} != registered ${entry.sha256}`);
    }
  }

  return problems;
}

/**
 * The version a customer gets, computed rather than read out of prose.
 *
 * `tags` is the mirrored tag set, so this answers "newest thing on the shelf",
 * which is the only version claim worth checking: a release is not "0.1.14 is
 * present somewhere", it is "0.1.14 is what install.sh gives you".
 */
export function newestVersionOnShelf(index, { repoSuffix = '/yos-core', prefix = '' } = {}) {
  const repo = (index.repos ?? []).find((entry) => String(entry.repo).endsWith(repoSuffix));
  if (!repo) return { error: `index.json has no repo entry ending in ${repoSuffix}` };
  const tag = newestReleaseTag(repo.tags, prefix);
  if (!tag) return { error: `${repo.repo} mirrors no ${prefix || 'core'} release tag` };
  return { repo: repo.repo, tag, version: tagVersion(tag) };
}

/**
 * The one legacy manifest shape the rollback path is allowed to accept.
 *
 * The production shelf immediately before 0.1.14 predates buildId,
 * publicationMode, and capabilities.json. A global "missing means production"
 * rule would let any future shelf drop those fields and pass. Compatibility
 * therefore needs an explicit operator flag and the immutable index digest
 * recorded before the production switch.
 */
export function legacy013Problems(
  index,
  indexDigest,
  { acceptedDigest = LEGACY_0_1_13_INDEX_SHA256 } = {},
) {
  const problems = [];
  if (index.publicationMode !== undefined) {
    problems.push(
      `legacy compatibility only applies when publicationMode is absent, got ${index.publicationMode}`,
    );
  }
  if (index.buildId !== undefined) {
    problems.push('legacy compatibility requires buildId to be absent');
  }
  if ((index.files ?? []).some((entry) => entry.path === 'capabilities.json')) {
    problems.push('legacy compatibility requires capabilities.json to be absent');
  }
  if (indexDigest !== acceptedDigest) {
    problems.push(`legacy compatibility requires index.json sha256 ${acceptedDigest}, got ${indexDigest}`);
  }
  const newest = newestVersionOnShelf(index);
  if (newest.error) problems.push(newest.error);
  else if (newest.version !== '0.1.13') {
    problems.push(`legacy compatibility is only valid through core 0.1.13, got ${newest.version}`);
  }
  return problems;
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

/**
 * Assert the expected versions against the shelf's own tag data.
 *
 * Core is asserted three ways because the three can disagree and each
 * disagreement is a different accident: the newest mirrored tag (what the
 * catalog derives from), `releases/latest.json` (what install.sh resolves), and
 * VERSIONS.md (what a human reads). Components are asserted from the capability
 * catalog, then their tag is confirmed to be mirrored and to be the newest of
 * its line — a provider pinned to a tag that a newer tag has superseded means
 * the catalog and the shelf disagree about what is current.
 */
export function parseExpectedVersions(spec) {
  return new Map(String(spec).split(',').map((pair) => {
    const [name, version] = pair.split('=');
    return [name.trim(), (version ?? '').trim()];
  }));
}

/**
 * Under sign-off, the expectation has to name everything the shelf serves.
 *
 * Requiring `--expect-versions` to be *present* was not enough: a shelf with two
 * providers signed off while the flag named only one of them (2026-08-11
 * review). The unnamed provider was then covered by nothing at all — the flag
 * was satisfied, and the second channel could have been any version.
 *
 * @returns {string[]} what the expectation fails to cover
 */
export function versionCoverageGaps(wanted, providers) {
  const gaps = [];
  if (!wanted.has('yos')) gaps.push('yos (the core version) is not named in --expect-versions');
  const named = new Set(wanted.keys());
  for (const registryName of new Set(providers.map((p) => p.registryName))) {
    if (!named.has(registryName)) {
      gaps.push(`provider ${registryName} is on the shelf but not named in --expect-versions`);
    }
  }
  return gaps;
}

async function checkVersions(options, { index, providers, reader, note }) {
  const wanted = parseExpectedVersions(options.expectVersions);

  const coreWanted = wanted.get('yos');
  if (coreWanted) {
    const newest = newestVersionOnShelf(index);
    if (newest.error) note(newest.error);
    else if (newest.version !== coreWanted) {
      note(`newest core on the shelf is ${newest.version} (${newest.tag}), expected ${coreWanted}`);
    }

    if (!newest.error) {
      // What install.sh resolves when no --branch is given. If this disagrees
      // with the tag set, customers and the catalog are looking at two shelves.
      try {
        const latest = JSON.parse((await reader.read(`${newest.repo}/releases/latest.json`)).toString('utf8'));
        const resolved = tagVersion(latest.tag_name);
        if (resolved !== coreWanted) {
          note(`releases/latest.json resolves core ${latest.tag_name ?? '(absent)'}, expected ${coreWanted}`);
        }
      } catch (error) {
        note(`${newest.repo}/releases/latest.json: ${error.message}`);
      }
    }

    // VERSIONS.md is prose for humans, so it is checked last and only for
    // agreement — never as the source of the version.
    const versionsMd = (await reader.read('VERSIONS.md')).toString('utf8');
    if (!versionsMd.includes(`\`${coreWanted}\``)) note(`VERSIONS.md does not name core ${coreWanted}`);
  }

  const seen = new Map(providers.map((p) => [p.registryName, p]));
  const tagsByRepo = new Map((index.repos ?? []).map((entry) => [entry.repo, entry.tags ?? []]));
  for (const [name, version] of wanted) {
    if (name === 'yos') continue;
    const provider = seen.get(name);
    if (!provider) { note(`component ${name} is absent from capabilities.json, expected ${version}`); continue; }
    if (provider.version !== version) {
      note(`component ${name} is ${provider.version} on the shelf, expected ${version}`);
      continue;
    }
    if (!provider.tag) { note(`component ${name} has no tag in capabilities.json`); continue; }
    if (tagVersion(provider.tag) !== version) {
      note(`component ${name} version ${version} does not match its tag ${provider.tag}`);
    }
    const mirrored = tagsByRepo.get(provider.repo);
    if (!mirrored) { note(`component ${name} names repo ${provider.repo}, absent from index.json`); continue; }
    if (!mirrored.includes(provider.tag)) {
      note(`component ${name} is served from ${provider.tag}, which the shelf does not mirror`);
      continue;
    }
    const newestForLine = newestReleaseTag(mirrored, tagPrefixOf(provider.tag));
    if (newestForLine !== provider.tag) {
      note(`component ${name} serves ${provider.tag} but the shelf mirrors a newer ${newestForLine}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const problems = [];
  const note = (msg) => { problems.push(msg); if (!options.json) console.error(`  ✗ ${msg}`); };
  let retried = 0;
  const onRetry = (url, attempt, error) => {
    retried += 1;
    if (!options.json) console.error(`  … retry ${attempt}: ${url.split('/').pop()} (${error.message})`);
  };

  const reader = makeReader(options, onRetry);
  if (!options.json) console.log(`[shelf] ${options.local ? 'dir' : 'base'} ${reader.label}`);

  const indexBuf = await reader.read('index.json');
  const index = JSON.parse(indexBuf.toString('utf8'));

  // The manifest's own bytes. buildId does not cover them: it is computed from
  // the repos' commits and tags, so an index.json with entries removed carries
  // the same buildId as the honest one it replaced.
  const indexDigest = sha256(indexBuf);
  if (options.expectIndexSha256 && indexDigest !== options.expectIndexSha256) {
    note(`index.json sha256 ${indexDigest} does not match expected ${options.expectIndexSha256}`);
  }

  let legacy013Accepted = false;
  if (options.allowLegacy013) {
    const legacyProblems = legacy013Problems(index, indexDigest);
    for (const problem of legacyProblems) note(problem);
    legacy013Accepted = legacyProblems.length === 0;
  }
  if (index.publicationMode !== 'production' && !legacy013Accepted) {
    note(`publicationMode is ${index.publicationMode}, expected production`);
  }
  if (legacy013Accepted && !options.json) {
    console.log('[shelf] LEGACY: accepting the pinned pre-catalog core 0.1.13 shelf');
  }
  if (options.expectBuildId && index.buildId !== options.expectBuildId) {
    note(`buildId ${index.buildId} does not match expected ${options.expectBuildId}`);
  }
  for (const repo of index.repos ?? []) {
    if ((repo.droppedTags ?? []).length > 0) note(`${repo.repo} dropped tags: ${repo.droppedTags.join(', ')}`);
  }
  for (const problem of missingRegistrations(index, { legacy013: legacy013Accepted })) note(problem);

  let providers = [];
  if (!legacy013Accepted) {
    // Modern shelves must publish a non-empty capability catalog. The pinned
    // 0.1.13 shelf predates the file and is identified by its complete index.
    const capsBuf = await reader.read('capabilities.json');
    const caps = JSON.parse(capsBuf.toString('utf8'));
    providers = (caps.capabilities ?? []).flatMap((c) => c.providers ?? []);
    if (providers.length === 0) note('capabilities.json has no providers');
    if (caps.buildId !== index.buildId) note(`capabilities.json buildId ${caps.buildId} != index.json buildId ${index.buildId}`);
  }

  // Sign-off preconditions, checked on the three small files fetched so far and
  // before the bulk download: an expectation that does not name everything the
  // shelf serves is not worth 900 downloads to discover.
  if (options.signoff) {
    const gaps = versionCoverageGaps(parseExpectedVersions(options.expectVersions), providers);
    if (gaps.length > 0) {
      for (const gap of gaps) note(`--signoff: ${gap}`);
      if (options.json) console.log(JSON.stringify({ source: reader.label, signoff: true, problems, pass: false }, null, 2));
      else console.error('[shelf] FAILED before downloading anything else: the expectation does not cover this shelf');
      process.exit(1);
    }
  }

  if (options.expectVersions) await checkVersions(options, { index, providers, reader, note });

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
    indexSha256: indexDigest,
    publicationMode: index.publicationMode,
    legacy013Accepted,
    registeredFiles: files.length,
    checkedFiles: entries.length,
    matchedFiles: matched,
    providers: providers.length,
    mode: options.full ? 'full' : 'sample',
    signoff: options.signoff,
    retries: retried,
    problems,
    pass: problems.length === 0,
  };

  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[shelf] hashes matched ${matched}/${entries.length}`);
    console.log(`[shelf] providers ${providers.length}, buildId ${index.buildId}`);
    console.log(`[shelf] index.json sha256 ${indexDigest}`);
    if (retried > 0) console.log(`[shelf] ${retried} transport retry/retries`);
    console.log(problems.length === 0 ? '[shelf] PASS' : `[shelf] FAILED with ${problems.length} problem(s)`);
    if (!options.full && problems.length === 0) {
      console.log('[shelf] NOTE: sample mode. Release sign-off requires --full.');
    }
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

const invokedScript = process.argv[1]
  ? fs.realpathSync(process.argv[1])
  : null;
if (invokedScript === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[shelf] FAILED: ${error.message}`);
    process.exit(1);
  });
}
