/**
 * Is this copy of YOS an installed package, or a source checkout?
 *
 * npm runs `postinstall` for both, and the two need opposite behaviour. An
 * installed copy SHOULD sync Core Skills and settings into ~/yos — that is how
 * an install finishes. A source checkout MUST NOT: `npm ci` in a clone is a
 * pure development action, and on 2026-08-01 one such run silently replaced
 * five live skill directories and rewrote two Codex configs on a machine whose
 * services kept running the old code from memory. Nothing warned anyone; the
 * machine simply became half-new.
 *
 * The distinguishing fact is where the package sits. npm always unpacks an
 * installed package into a `node_modules` directory — `npm install -g yos`
 * lands in <prefix>/lib/node_modules/yos, and self-upgrade installs a tarball
 * the same way. A checkout never lives there, and it carries a `.git`
 * directory the installed copy does not (npm excludes it from the tarball).
 *
 * The default answer is "not an install", so an unrecognised layout declines to
 * touch live files rather than guessing. Guessing wrong writes to ~/yos; being
 * careful only costs a printed line telling the reader how to proceed.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Env var that forces the install path in a layout we would otherwise decline. */
export const FORCE_ENV = 'YOS_POSTINSTALL_FORCE';

/**
 * @typedef {object} InstallContext
 * @property {boolean} isInstall  whether this copy may write to ~/yos
 * @property {'installed-package'|'forced'|'source-checkout'|'unrecognised-layout'} kind
 * @property {string} reason      one sentence, safe to print
 */

/**
 * @param {object} options
 * @param {string} options.packageRoot  directory holding the package's package.json
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof fs} [options.fsApi]
 * @returns {InstallContext}
 */
export function classifyInstallContext({ packageRoot, env = process.env, fsApi = fs }) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0) {
    throw new TypeError('classifyInstallContext requires a packageRoot path');
  }

  const insideNodeModules = path.resolve(packageRoot)
    .split(path.sep)
    .includes('node_modules');

  if (insideNodeModules) {
    return {
      isInstall: true,
      kind: 'installed-package',
      reason: 'this copy is an installed package (it lives under node_modules)',
    };
  }

  // Forced only matters outside node_modules: an installed copy needs no force.
  if (env[FORCE_ENV]) {
    return {
      isInstall: true,
      kind: 'forced',
      reason: `${FORCE_ENV} is set, so this copy is treated as an install`,
    };
  }

  const hasGitDir = fsApi.existsSync(path.join(packageRoot, '.git'));
  if (hasGitDir) {
    return {
      isInstall: false,
      kind: 'source-checkout',
      reason: 'this is a source checkout, not an install — live files in ~/yos are left alone',
    };
  }

  return {
    isInstall: false,
    kind: 'unrecognised-layout',
    reason: 'this copy is neither under node_modules nor a checkout — declining to write to ~/yos',
  };
}

/** The line postinstall prints when it declines. Kept here so tests can assert it. */
export function formatDeclinedMessage(context) {
  return [
    `Skipping Core Skills and settings sync: ${context.reason}.`,
    `  Nothing in ~/yos was modified.`,
    `  If this really is an install, re-run with ${FORCE_ENV}=1.`,
  ].join('\n');
}
