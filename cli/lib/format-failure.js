/**
 * Rendering of an uncaught command failure for a human reader.
 *
 * Lives apart from cli/yos.js on purpose: importing that file runs the CLI, so
 * anything that wants to test this behaviour has to be able to load it alone.
 */

/**
 * Turn a thrown value into the line a user should read.
 *
 * Printing the error object dumps a stack for every failure, which buries the
 * one sentence that matters — the ENOENT that hid "the config directory does not
 * exist" behind twelve frames of node internals is the case that prompted this.
 * The stack is still what you want while debugging, so YOS_DEBUG brings it back.
 *
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function formatFailure(err, env = process.env) {
  if (env.YOS_DEBUG) return err instanceof Error ? (err.stack ?? String(err)) : String(err);

  if (!(err instanceof Error)) return `Error: ${String(err)}`;

  const detail = err.code && !err.message.includes(err.code) ? ` (${err.code})` : '';
  const hint = err.path ? `\n  path: ${err.path}` : '';
  return `Error: ${err.message}${detail}${hint}\n  Run again with YOS_DEBUG=1 for the full stack.`;
}
