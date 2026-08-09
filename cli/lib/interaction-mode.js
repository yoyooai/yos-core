/**
 * Deciding whether to ask a customer for a component's credentials — and,
 * when we do not ask, saying so.
 *
 * Why this is its own module: the decision used to be implicit. `yos add`
 * called prompt() unconditionally, and prompt() answers '' for itself when
 * there is no terminal. That produced three different behaviours from one
 * command with nothing on screen to distinguish them:
 *
 *   - in a terminal          → stops and asks, even with --yes ("skip prompts")
 *   - piped / ssh / CI       → silently asks nobody, installs a component that
 *                              cannot start, and never mentions the step existed
 *   - in a terminal, no idea → the customer sees a bare cursor after
 *                              `FEISHU_APP_ID (App ID ...):` with no hint that
 *                              Enter skips it
 *
 * The silent branch is the dangerous one, and it is also the branch every
 * automated acceptance run takes — which is exactly why a full-green gate
 * never caught this. Making the decision explicit and returning a reason lets
 * the caller print one honest line in all three cases, and lets a test assert
 * the decision without a terminal.
 */

/**
 * Extract the declared credential names from a component's `required` config.
 *
 * @param {Array<string|{name?: string}>|unknown} required
 * @returns {string[]}
 */
export function requiredConfigNames(required) {
  if (!Array.isArray(required)) return [];
  return required
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .filter((name) => typeof name === 'string' && name.length > 0);
}

/**
 * Decide whether to interactively collect credentials during `yos add`.
 *
 * @param {object} opts
 * @param {Array<string|{name?: string}>|unknown} opts.required - component's declared required config
 * @param {boolean} opts.isTTY - whether stdin is a terminal we can ask on
 * @param {boolean} opts.skipConfirm - whether --yes / -y was given
 * @returns {{ask: boolean, reason: 'none-required'|'yes-flag'|'no-tty'|'interactive', names: string[]}}
 */
export function decideCredentialPrompt({ required, isTTY, skipConfirm }) {
  const names = requiredConfigNames(required);
  if (names.length === 0) return { ask: false, reason: 'none-required', names };
  // --yes means "stop asking me things". A credential prompt is a thing being
  // asked. Honouring the flag here is what makes unattended installs finish.
  if (skipConfirm) return { ask: false, reason: 'yes-flag', names };
  if (!isTTY) return { ask: false, reason: 'no-tty', names };
  return { ask: true, reason: 'interactive', names };
}

/**
 * Environment a component's install hook must run under, so that "do not ask
 * me anything" survives the process boundary.
 *
 * `yos add -y` used to stop dead anyway: the OS honoured the flag, then handed
 * control to the component's post-install hook with stdio inherited, and the
 * hook — which only ever looked at `process.stdin.isTTY` — asked its own
 * question on the same terminal. The flag existed on one side of a fork() and
 * nowhere on the other. A hook cannot respect an intention it was never told.
 *
 * @param {object} opts
 * @param {boolean} opts.isTTY
 * @param {boolean} opts.skipConfirm
 * @returns {Record<string, string>} env vars to merge into the hook's environment
 */
export function hookInteractionEnv({ isTTY, skipConfirm }) {
  if (skipConfirm || !isTTY) return { YOS_ASSUME_YES: '1' };
  return {};
}

/**
 * The reason we did not ask, in words a customer can act on.
 *
 * Kept next to the decision so a new reason cannot be added without a phrase,
 * and returns null for the two cases that need no explanation.
 *
 * @param {'none-required'|'yes-flag'|'no-tty'|'interactive'} reason
 * @returns {string|null}
 */
export function explainSkippedPrompt(reason) {
  switch (reason) {
    case 'yes-flag':
      return 'Not asking for credentials because --yes was given.';
    case 'no-tty':
      return 'Not asking for credentials because there is no terminal to ask on.';
    default:
      return null;
  }
}
