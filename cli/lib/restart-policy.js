/**
 * Restart policy floor for PM2-managed component services.
 *
 * `max_restarts` on its own does nothing. PM2 only counts a restart against the
 * cap when the process died sooner than `min_uptime` (default: 1 second); a
 * process that survives longer than that has its counter reset on every
 * attempt. A component that takes a couple of seconds to fail — missing
 * credentials being by far the most common case — therefore restarts forever
 * even though a cap is configured.
 *
 * Measured on a clean machine (pm2 6.x, two apps, identical crashing script):
 *   max_restarts: 10, no min_uptime  → 57 restarts and still climbing
 *   max_restarts: 10, min_uptime 30s → stopped spawning after 9
 *
 * The two values only work as a pair, so the platform applies them as a pair to
 * every component service it starts. Components — third-party ones especially —
 * are not trusted to cap themselves: an uncapped loop burns CPU and fills the
 * log disk on the customer's machine for as long as the machine is up.
 *
 * Values match the core services in `templates/pm2/ecosystem.config.cjs`.
 */
export const RESTART_FLOOR = Object.freeze({
  max_restarts: 10,
  min_uptime: '10s',
  min_uptime_ms: 10_000,
});

/**
 * Parse a PM2 uptime value (`10000`, `'10000'`, `'10s'`, `'2m'`) into ms.
 *
 * @param {unknown} value
 * @returns {number|null} null when the value is absent or not understood
 */
export function parseUptimeMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = (match[2] || 'ms').toLowerCase();
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  return amount * scale;
}

/**
 * Enforce the restart floor on a PM2 app config.
 *
 * Stricter settings are left alone — the floor is a ceiling on how much
 * restarting is allowed, not a target. A component that opts out of restarting
 * entirely (`autorestart: false`) cannot loop, so it is returned untouched.
 *
 * @param {object} app - PM2 app config
 * @returns {object} a copy with the floor applied
 */
export function applyRestartFloor(app) {
  if (!app || typeof app !== 'object') return app;

  const floored = { ...app };
  if (floored.autorestart === false) return floored;

  const cap = Number(floored.max_restarts);
  if (!Number.isInteger(cap) || cap < 0 || cap > RESTART_FLOOR.max_restarts) {
    floored.max_restarts = RESTART_FLOOR.max_restarts;
  }

  const uptimeMs = parseUptimeMs(floored.min_uptime);
  if (uptimeMs === null || uptimeMs < RESTART_FLOOR.min_uptime_ms) {
    floored.min_uptime = RESTART_FLOOR.min_uptime;
  }

  return floored;
}
