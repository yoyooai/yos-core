/**
 * What `yos add` is allowed to claim when it finishes.
 *
 * This exists because the closing line is the only thing most people read. An
 * install whose post-install hook fetched none of its sub-skills used to end on
 * "installed successfully!" with exit code 0 — the error scrolled past, the
 * verdict said success, and the customer walked away with a component that was
 * only partly there.
 *
 * Keeping the decision here — instead of inline in the console output — means
 * the rule is one named thing that can be asserted against, so restoring the
 * old "always congratulate" behaviour breaks a test instead of shipping.
 */

/** Installed, running, nothing degraded. The only state allowed to celebrate. */
export const INSTALL_OK = 'installed';

/** Installed, but the service will not stay up (usually missing credentials). */
export const INSTALL_NOT_RUNNING = 'not-running';

/** Installed and running, but a setup hook failed — part of it is unavailable. */
export const INSTALL_DEGRADED = 'degraded';

/**
 * Decide what an install may report.
 *
 * @param {object} outcome
 * @param {boolean|null} outcome.serviceRunning
 *   `false` when a declared service could not be kept alive; `null` when the
 *   component declares no service at all (which is not a failure).
 * @param {boolean} outcome.postInstallDegraded
 *   `true` when the post-install hook ended non-zero.
 * @returns {typeof INSTALL_OK | typeof INSTALL_NOT_RUNNING | typeof INSTALL_DEGRADED}
 */
export function classifyInstallOutcome({ serviceRunning = null, postInstallDegraded = false } = {}) {
  // A service that will not run is the most actionable thing to say, so it wins
  // over a degraded add-on when both are true.
  if (serviceRunning === false) return INSTALL_NOT_RUNNING;
  if (postInstallDegraded) return INSTALL_DEGRADED;
  return INSTALL_OK;
}
