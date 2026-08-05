/**
 * Environment for `npm install` runs that build native dependencies.
 *
 * better-sqlite3 — used by comm-bridge, scheduler and web-console, i.e. by the
 * parts of YOS that make it YOS — ships no compiled binary in its npm tarball.
 * Its install script asks prebuild-install to fetch one, and prebuild-install's
 * default host is GitHub releases. Measured on 2026-08-05 in a container with
 * GitHub blackholed: the fetch is refused, prebuild-install falls through to
 * `node-gyp rebuild`, and node-gyp dies for want of Python — so the install
 * fails outright rather than degrading. Pointing prebuild-install at a mirror
 * we serve ourselves takes GitHub out of that path.
 *
 * prebuild-install expands the host into
 *   <host>/v<version>/<name>-v<version>-node-v<abi>-<platform>-<arch>.tar.gz
 * so the mirror only has to be a static directory tree (see
 * scripts/build-dist.mjs, which populates it).
 */

import { resolveVendorBase } from './dist-origin.js';

/** Packages whose prebuilt binaries we mirror, and their prebuild-install env var. */
const MIRRORED_NATIVE_PACKAGES = [
  { package: 'better-sqlite3', envVar: 'npm_config_better_sqlite3_binary_host' },
];

/**
 * Resolve the base URL that holds mirrored prebuilt binaries.
 * `YOS_PREBUILD_BASE` overrides it; setting it empty restores plain npm
 * behavior (straight to GitHub) for anyone who wants exactly that.
 *
 * @returns {string|null}
 */
export function resolvePrebuildBase(env = process.env) {
  const configured = env.YOS_PREBUILD_BASE;
  if (configured !== undefined) {
    const trimmed = String(configured).trim().replace(/\/+$/, '');
    return trimmed || null;
  }
  return resolveVendorBase(env);
}

/**
 * Build the environment for an `npm install` that may compile native modules.
 * An explicitly set binary host always wins — this adds a default, it does not
 * seize control of a machine whose operator already made a choice.
 *
 * @param {Record<string, string|undefined>} [env] - Environment to extend
 * @returns {Record<string, string|undefined>} Environment for the child process
 */
export function npmInstallEnv(env = process.env) {
  const base = resolvePrebuildBase(env);
  if (!base) return { ...env };

  const result = { ...env };
  for (const { package: name, envVar } of MIRRORED_NATIVE_PACKAGES) {
    if (result[envVar]) continue;
    result[envVar] = `${base}/${name}`;
  }
  return result;
}

export { MIRRORED_NATIVE_PACKAGES };
