/**
 * Distribution origin — where release metadata and artifacts are fetched from.
 *
 * YOS is installed on machines that regularly cannot reach GitHub at all.
 * Measured from a mainland-China host on 2026-08-05: raw.githubusercontent
 * 8/8 timeouts, `git clone` 2 of 3 attempts timing out at 45s, release assets
 * unusable, while our own domain answered in under two seconds every time.
 * An install that resolves versions or downloads code from GitHub is therefore
 * a coin flip, so every network read tries our distribution mirror first and
 * treats GitHub only as a fallback for artifacts we do not mirror.
 *
 * The mirror is plain static files (see scripts/build-dist.mjs), and its JSON
 * documents deliberately keep GitHub's response shape so callers parse one
 * format regardless of which origin answered.
 */

import { readEnvFile } from './env.js';

const DEFAULT_DIST_BASE = 'https://yoyooai.com/dist';

/** Owners whose repositories the mirror carries. `*` means "every owner". */
const DEFAULT_DIST_OWNERS = 'yoyooai';

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class DistOriginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DistOriginError';
  }
}

/**
 * Resolve the distribution base URL.
 *
 * A malformed value fails loudly instead of quietly reverting to GitHub: a
 * silent revert is exactly the coin flip this module exists to remove.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ enabled: boolean, base: string|null }}
 */
export function resolveDistBase(env = process.env, deps = {}) {
  let configured = env.YOS_DIST_BASE;

  // The installer records a non-default mirror in ~/yos/.env. Without this the
  // CLI is invoked from a plain shell that never loads that file, so a machine
  // installed from a private mirror would resolve the built-in default on its
  // very next upgrade and quietly leave the mirror it was installed from —
  // which, on a host that cannot reach the default, means it stops upgrading.
  //
  // Only the real process environment gets this fallback. Callers that pass an
  // explicit env object are stating the whole environment on purpose, and must
  // not have this machine's file read behind their back.
  if (configured === undefined && env === process.env) {
    try {
      // An unreadable ~/yos/.env means "no recorded value", not "the command
      // fails": every yos command resolves this, so throwing here would take the
      // whole CLI down over a file permission.
      const recorded = (deps.readEnvFile ?? readEnvFile)();
      if (recorded.has('YOS_DIST_BASE')) configured = recorded.get('YOS_DIST_BASE');
    } catch {
      configured = undefined;
    }
  }

  const raw = configured === undefined ? DEFAULT_DIST_BASE : String(configured).trim();
  if (!raw) return { enabled: false, base: null };
  return { enabled: true, base: normalizeDistBase(raw) };
}

/**
 * Validate a distribution base URL and strip its trailing slash.
 * Credentials, query strings and fragments are rejected because artifact URLs
 * must stay copy-pasteable and cacheable, and a credentialed URL would leak
 * into logs and error messages.
 */
export function normalizeDistBase(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new DistOriginError(
      `YOS_DIST_BASE must be a URL (got "${value}"). Repair: export YOS_DIST_BASE=${DEFAULT_DIST_BASE}`
    );
  }
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new DistOriginError(
      `YOS_DIST_BASE must use https (got "${value}"). Repair: export YOS_DIST_BASE=${DEFAULT_DIST_BASE}`
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DistOriginError(
      `YOS_DIST_BASE must not carry credentials, a query string or a fragment (got "${value}").`
    );
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Whether GitHub fallback is disabled. Set YOS_DIST_ONLY=1 to prove — in tests
 * and in acceptance runs — that an operation needs nothing but our own mirror.
 */
export function isDistOnly(env = process.env) {
  const value = String(env.YOS_DIST_ONLY ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function mirroredOwners(env) {
  const raw = env.YOS_DIST_OWNERS === undefined ? DEFAULT_DIST_OWNERS : String(env.YOS_DIST_OWNERS);
  return raw.split(',').map(owner => owner.trim()).filter(Boolean);
}

/**
 * Whether the mirror is expected to carry a repository. Third-party components
 * installed straight from GitHub must not pay for a guaranteed-404 round trip.
 */
export function isMirroredRepo(repo, env = process.env) {
  if (!REPO_PATTERN.test(String(repo || ''))) return false;
  const owners = mirroredOwners(env);
  if (owners.includes('*')) return true;
  const owner = String(repo).split('/')[0].toLowerCase();
  return owners.some(candidate => candidate.toLowerCase() === owner);
}

function assertSafeRef(ref) {
  const value = String(ref || '');
  if (!value) throw new DistOriginError('A git ref is required');
  if (/[?#\s\\]/.test(value) || CONTROL_CHARS.test(value)) {
    throw new DistOriginError(`Unsafe git ref: ${ref}`);
  }
  if (value.split('/').some(part => part === '..' || part === '.' || part === '')) {
    throw new DistOriginError(`Unsafe git ref: ${ref}`);
  }
  return value;
}

function assertSafePath(filePath) {
  const value = String(filePath || '').replace(/^\/+/, '');
  if (!value) throw new DistOriginError('A file path is required');
  if (/[?#\s\\]/.test(value) || CONTROL_CHARS.test(value)) {
    throw new DistOriginError(`Unsafe file path: ${filePath}`);
  }
  if (value.split('/').some(part => part === '..' || part === '.')) {
    throw new DistOriginError(`Unsafe file path: ${filePath}`);
  }
  return value;
}

/**
 * Build the mirror URL for one read, or null when the mirror does not apply.
 *
 * @param {'tags'|'latest-release'|'raw'|'tarball'|'package'} kind
 * @param {{ repo: string, ref?: string, refType?: 'tag'|'branch', filePath?: string, branch?: string, version?: string, packageName?: string }} target
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function distMirrorUrl(kind, target, env = process.env) {
  const { enabled, base } = resolveDistBase(env);
  if (!enabled) return null;
  const repo = String(target?.repo || '');
  if (!isMirroredRepo(repo, env)) return null;

  switch (kind) {
    case 'tags':
      return `${base}/${repo}/tags.json`;
    case 'latest-release':
      return `${base}/${repo}/releases/latest.json`;
    case 'raw':
      return `${base}/${repo}/raw/${assertSafeRef(target.branch || 'main')}/${assertSafePath(target.filePath)}`;
    case 'tarball': {
      const ref = assertSafeRef(target.ref);
      const scope = target.refType === 'branch' ? 'heads' : 'tags';
      return `${base}/${repo}/tarball/${scope}/${ref}.tar.gz`;
    }
    case 'package': {
      // `npm pack` names the file after the package version, so a tag's leading
      // "v" is dropped here — the same rule scripts/install.sh applies.
      const version = assertSafeRef(target.version).replace(/^v/, '');
      const name = assertSafePath(target.packageName || 'yos');
      return `${base}/${repo}/package/${name}-${version}.tgz`;
    }
    default:
      throw new DistOriginError(`Unknown distribution read: ${kind}`);
  }
}

/**
 * Base URL for third-party artifacts we re-host — Caddy binaries, prebuilt
 * native modules — so an install never reaches GitHub for them either.
 *
 * @returns {string|null} null when the mirror is disabled
 */
export function resolveVendorBase(env = process.env) {
  const { enabled, base } = resolveDistBase(env);
  return enabled ? `${base}/vendor` : null;
}

/**
 * URL for one re-hosted third-party artifact, or null when disabled.
 *
 * @param {string} relativePath - e.g. "caddy/v2.10.2/caddy_2.10.2_linux_amd64.tar.gz"
 */
export function distVendorUrl(relativePath, env = process.env) {
  const base = resolveVendorBase(env);
  if (!base) return null;
  return `${base}/${assertSafePath(relativePath)}`;
}

const reportedFallbacks = new Set();

/**
 * Report that the mirror missed and GitHub is being tried instead.
 *
 * Silence here would let a broken mirror look like a working one for as long
 * as GitHub happens to answer — the failure would only surface later on a
 * customer machine where GitHub does not. Reported once per (kind, label) so a
 * multi-component upgrade does not bury the rest of its output.
 */
export function noteMirrorFallback(kind, label, error, { write = message => process.stderr.write(message) } = {}) {
  const key = `${kind}:${label}`;
  if (reportedFallbacks.has(key)) return false;
  reportedFallbacks.add(key);
  const detail = String(error?.message || error || 'unknown error').split('\n')[0];
  write(`[yos] distribution mirror miss (${kind} ${label}): ${detail} — falling back to GitHub\n`);
  return true;
}

/** Test seam: forget which fallbacks were already reported. */
export function resetMirrorFallbackNotices() {
  reportedFallbacks.clear();
}

export { DEFAULT_DIST_BASE, DEFAULT_DIST_OWNERS };
