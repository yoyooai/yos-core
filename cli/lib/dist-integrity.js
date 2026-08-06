/**
 * Check that a file downloaded from our distribution mirror arrived intact.
 *
 * The mirror already publishes a sha256 for every file it carries, in
 * index.json (see scripts/build-dist.mjs). Nothing was reading it: a self
 * upgrade unpacked whatever bytes arrived and ran them.
 *
 * ⚠️ Be precise about what this buys. The obvious story — "it stops corrupted
 * downloads" — is mostly already true without it: gzip carries a CRC32 and tar
 * checks its own headers, so a truncated or bit-rotted archive fails at
 * extraction with or without this check.
 *
 * What a digest adds is the case those cannot see: an archive that is perfectly
 * well-formed and simply is not the one being asked for.
 *
 *   · A mirror caught mid-publish. The build writes the tree and publishes with
 *     `rsync --delete`, so there is a window where index.json and the artifacts
 *     disagree. Both halves extract fine; one of them is the wrong version.
 *   · A stale copy served by something in between — a proxy or CDN node holding
 *     the previous release's bytes at the current release's URL.
 *
 * It does NOT protect against a compromised mirror: the digest and the file come
 * from the same origin over the same connection, so whoever can replace one can
 * replace the other. That would need an anchor the mirror does not control — a
 * signature, or the GitHub release when it happens to be reachable — and that
 * is separate work, not pretended to here.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveDistBase } from './dist-origin.js';

/** Cache per process: one index.json fetch, however many files get checked. */
let cachedIndex;

export function resetMirrorIndexCache() {
  cachedIndex = undefined;
}

function defaultFetchIndex(url) {
  return execFileSync('curl', ['-fsSL', url], {
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * The mirror's file listing, or null when it cannot be read.
 * A mirror without a readable index is a mirror we cannot check — that is
 * reported, never treated as "nothing to check".
 */
export function fetchMirrorIndex({ env = process.env, fetchIndex = defaultFetchIndex } = {}) {
  if (cachedIndex !== undefined) return cachedIndex;

  const { enabled, base } = resolveDistBase(env);
  if (!enabled) {
    cachedIndex = null;
    return cachedIndex;
  }

  try {
    const parsed = JSON.parse(fetchIndex(`${base}/index.json`));
    const digests = new Map();
    for (const entry of Array.isArray(parsed?.files) ? parsed.files : []) {
      if (typeof entry?.path === 'string' && typeof entry?.sha256 === 'string') {
        digests.set(entry.path, { sha256: entry.sha256, bytes: entry.bytes });
      }
    }
    cachedIndex = digests.size > 0 ? { base, digests } : null;
  } catch {
    cachedIndex = null;
  }
  return cachedIndex;
}

/** The path a mirror URL occupies inside index.json, or null if it is not ours. */
export function mirrorRelativePath(url, base) {
  if (typeof url !== 'string' || typeof base !== 'string') return null;
  const prefix = `${base.replace(/\/+$/, '')}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

export function sha256File(filePath, fsApi = fs) {
  return crypto.createHash('sha256').update(fsApi.readFileSync(filePath)).digest('hex');
}

/**
 * @typedef {object} IntegrityResult
 * @property {'match'|'mismatch'|'unknown-file'|'no-index'} status
 * @property {string} [expected]
 * @property {string} [actual]
 * @property {string} message  one line, safe to show a user
 */

/**
 * Compare a downloaded file against the digest the mirror published for it.
 *
 * @param {object} options
 * @param {string} options.filePath      the local file just written
 * @param {string} options.url           the URL it was fetched from
 * @returns {IntegrityResult}
 */
export function verifyMirrorDownload({
  filePath,
  url,
  env = process.env,
  fetchIndex = defaultFetchIndex,
  fsApi = fs,
} = {}) {
  const index = fetchMirrorIndex({ env, fetchIndex });
  if (!index) {
    return {
      status: 'no-index',
      message: 'mirror index.json unavailable — download not checked against a digest',
    };
  }

  const relative = mirrorRelativePath(url, index.base);
  const published = relative ? index.digests.get(relative) : undefined;
  if (!published) {
    return {
      status: 'unknown-file',
      message: `${relative ?? url} is not listed in the mirror index — download not checked`,
    };
  }

  const actual = sha256File(filePath, fsApi);
  if (actual === published.sha256) {
    return { status: 'match', expected: published.sha256, actual, message: 'digest matches the mirror index' };
  }

  return {
    status: 'mismatch',
    expected: published.sha256,
    actual,
    message: `${relative} does not match the digest the mirror published for it `
      + `(expected ${published.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…). `
      + 'The transfer was corrupted or the mirror is mid-publish.',
  };
}
