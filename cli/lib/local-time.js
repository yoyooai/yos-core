/**
 * Human-facing timestamps, in the machine's own timezone.
 *
 * Every one of these used to be `new Date().toISOString()` with the `T` swapped
 * for a space. That is always UTC — `toISOString` ignores TZ by definition — so
 * on any machine not running UTC, every timestamp a person reads was wrong by
 * the offset, and carried no zone label to say so. On an Asia/Shanghai install
 * `yos status` reported an agent's last check eight hours in the past; it reads
 * as "this agent died this morning" about an agent that answered a minute ago.
 * It cost us a real misdiagnosis on 2026-08-27 before being tracked down.
 *
 * The format is deliberately unchanged (`YYYY-MM-DD HH:mm:ss`) so anything
 * already reading these logs keeps working — only the value is now correct.
 *
 * This module is the source of truth. Skills are deployed to
 * ~/yos/.claude/skills/ as standalone units and cannot import from the CLI
 * package, so each carries a copy, exactly as RESTART_FLOOR does; the copies
 * are held to this behaviour by cli/lib/__tests__/local-time-parity.test.js.
 */

/**
 * Format a timestamp in local time as `YYYY-MM-DD HH:mm:ss`.
 * @param {Date|number|string} [when] Date, epoch ms, or anything Date accepts.
 *   Defaults to now.
 * @returns {string}
 */
export function formatLocalTimestamp(when = new Date()) {
  const date = when instanceof Date ? when : new Date(when);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
