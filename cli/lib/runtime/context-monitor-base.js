/**
 * ContextMonitorBase — abstract base class for runtime context monitoring.
 *
 * Subclasses implement getUsage() to provide token counts for their runtime.
 * Shared logic handles threshold checking, cooldown, and polling.
 *
 * Two-stage design:
 *   1. Early threshold (default: 80% of session-switch threshold) — triggers
 *      a memory sync prompt so sync completes before session switch.
 *   2. Session-switch threshold — triggers the new-session handoff.
 *
 * This class is the only thing deciding that a session has to hand over before
 * it runs out of room, so its failure mode is silence: no handoff, no log line,
 * and a session that grows until the runtime hits its own wall. Three rules
 * follow from that, and each is pinned by __tests__/context-monitor-base.test.js:
 *
 *   - A cooldown is a reward for a handoff that actually happened. It is armed
 *     after the handler returns, and only when the handler did not report
 *     failure. (A handler may return false; enqueueContextRotationHandoff() does
 *     exactly that when all three C4 attempts fail.) The Claude-side twin in
 *     skills/activity-monitor/scripts/context-monitor.js has always worked this
 *     way — this copy had drifted.
 *   - A reading that cannot be trusted (NaN, a non-positive ceiling, a negative
 *     token count) is "no reading", never a ratio. NaN compares false against
 *     every threshold, which is a decision not to fire dressed up as arithmetic.
 *   - Being unable to read usage at all is reported. It is normal for a few
 *     checks — an idle box has no session — so it is only worth a line once it
 *     persists, and then with backoff.
 *
 * Usage:
 *   const monitor = adapter.getContextMonitor();
 *   monitor.startPolling({
 *     intervalMs: 30_000,
 *     onExceed: ({ ratio }) => ...,
 *     onEarlyThreshold: ({ ratio }) => ...,
 *   });
 */

export class ContextMonitorBase {
  /**
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.75]           Fraction of ceiling that triggers handoff (0.0–1.0)
   * @param {number} [opts.cooldownMs=300000]         Minimum ms between successive session-switch triggers (default 5 min)
   * @param {number} [opts.earlyThresholdRatio=0.80]  Fraction of threshold for early sync (default 80% of threshold)
   * @param {number} [opts.earlyCooldownMs=600000]    Minimum ms between early sync triggers (default 10 min)
   * @param {Function} [opts.log]                     Optional line logger; without it the monitor is mute
   * @param {Function} [opts.now]                     Clock injection point (tests)
   * @param {number} [opts.blindChecksBeforeReport=10] Consecutive unreadable checks before saying so
   */
  constructor({
    threshold = 0.75,
    cooldownMs = 300_000,
    earlyThresholdRatio = 0.80,
    earlyCooldownMs = 600_000,
    log = null,
    now = () => Date.now(),
    blindChecksBeforeReport = 10,
  } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.earlyThreshold = threshold * earlyThresholdRatio;
    this.earlyCooldownMs = earlyCooldownMs;
    this._lastTriggerAt = 0;
    this._lastEarlyTriggerAt = 0;
    this._intervalId = null;
    this._now = now;
    this._logFn = log;
    this._firing = false;
    this._blindChecksBeforeReport = blindChecksBeforeReport;
    this._blindStreak = 0;
    this._blindReportAt = blindChecksBeforeReport;
  }

  /**
   * Return current token usage for this runtime.
   * Must be implemented by subclasses.
   *
   * @returns {Promise<{used: number, ceiling: number} | null>}
   *   null when data is unavailable (e.g. no active session)
   */
  async getUsage() {
    throw new Error('ContextMonitorBase.getUsage() must be implemented by subclass');
  }

  /**
   * Check current usage and return structured result.
   *
   * Returns null whenever the reading cannot be trusted — that includes a
   * getUsage() that threw. Callers get "no data", never a NaN ratio.
   *
   * @returns {Promise<{used: number, ceiling: number, ratio: number} | null>}
   */
  async check() {
    const { result } = await this._read();
    return result;
  }

  /**
   * Check thresholds and fire callbacks. Two stages:
   *   1. Early threshold — fires onEarlyThreshold (memory sync injection)
   *   2. Session-switch threshold — fires onExceed (new-session handoff)
   *
   * Both respect independent cooldowns, and a cooldown is only armed once its
   * handler has reported success. A handler may report failure by returning
   * false or by throwing; either way the next check tries again rather than
   * waiting out a cooldown for work that never happened.
   *
   * @param {object} callbacks
   * @param {Function} [callbacks.onExceed]           Fired when session-switch threshold exceeded
   * @param {Function} [callbacks.onEarlyThreshold]   Fired when early threshold reached
   * @returns {Promise<void>}
   */
  async checkThreshold({ onExceed, onEarlyThreshold } = {}) {
    // The cooldown is armed after the handler returns, so without this guard a
    // check slower than the poll interval could enqueue the same handoff twice.
    // The guard covers the whole check, not just the handler: reading usage is
    // itself asynchronous, so two polls can both be past a handler-only guard
    // before either reaches the handler.
    if (this._firing) return;
    this._firing = true;
    try {
      await this._checkThreshold({ onExceed, onEarlyThreshold });
    } finally {
      this._firing = false;
    }
  }

  /** @see checkThreshold — this is its body, run under the in-flight guard. */
  async _checkThreshold({ onExceed, onEarlyThreshold } = {}) {
    const { result, reason } = await this._read();
    if (!result) {
      this._noteUnreadable(reason);
      return;
    }
    this._noteReadable();

    const { used, ceiling, ratio } = result;
    const now = this._now();
    const payload = { used, ceiling, ratio };

    // Session-switch threshold (higher priority — check first)
    if (ratio >= this.threshold) {
      if (now - this._lastTriggerAt >= this.cooldownMs) {
        if (await this._fire(onExceed, payload, 'session-switch handoff')) {
          this._lastTriggerAt = this._now();
        }
      }
      return;
    }

    // Early threshold (memory sync injection)
    if (ratio >= this.earlyThreshold && onEarlyThreshold) {
      if (now - this._lastEarlyTriggerAt >= this.earlyCooldownMs) {
        if (await this._fire(onEarlyThreshold, payload, 'early memory sync')) {
          this._lastEarlyTriggerAt = this._now();
        }
      }
    }
  }

  /**
   * Start periodic polling. Calls checkThreshold() at each interval.
   * No-op if already started.
   *
   * @param {object} [opts]
   * @param {number}   [opts.intervalMs=30000]       Poll interval in ms
   * @param {Function} [opts.onExceed]               Callback fired when session-switch threshold exceeded
   * @param {Function} [opts.onEarlyThreshold]       Callback fired when early threshold reached
   */
  startPolling({ intervalMs = 30_000, onExceed, onEarlyThreshold } = {}) {
    if (this._intervalId) return;
    this._intervalId = setInterval(() => {
      this.checkThreshold({ onExceed, onEarlyThreshold })
        .catch((err) => this._log(`Context check failed: ${_describe(err)}`));
    }, intervalMs);
  }

  /**
   * Stop periodic polling.
   */
  stopPolling() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Read usage and say why it is unusable when it is.
   *
   * @returns {Promise<{result: {used: number, ceiling: number, ratio: number} | null, reason: string | null}>}
   */
  async _read() {
    let usage;
    try {
      usage = await this.getUsage();
    } catch (err) {
      return { result: null, reason: `getUsage() threw: ${_describe(err)}` };
    }

    if (usage == null) return { result: null, reason: 'no usage data' };

    const { used, ceiling } = usage;
    if (!Number.isFinite(ceiling) || ceiling <= 0) {
      return { result: null, reason: `unusable ceiling: ${_show(ceiling)}` };
    }
    if (!Number.isFinite(used) || used < 0) {
      return { result: null, reason: `unusable token count: ${_show(used)}` };
    }

    return { result: { used, ceiling, ratio: used / ceiling }, reason: null };
  }

  /**
   * Run a threshold handler. Failure — reported or thrown — leaves the cooldown
   * unarmed so the next check retries.
   *
   * @returns {Promise<boolean>} whether the cooldown may be armed
   */
  async _fire(handler, payload, label) {
    if (!handler) return true;
    const pct = Math.round(payload.ratio * 100);
    try {
      const outcome = await handler(payload);
      if (outcome === false) {
        this._log(`${label} at ${pct}% did not go through — retrying on the next check`);
        return false;
      }
      return true;
    } catch (err) {
      this._log(`${label} at ${pct}% failed: ${_describe(err)} — retrying on the next check`);
      return false;
    }
  }

  /**
   * A check that produced no usable reading. Silence here is the dangerous
   * case, but so is a line every 30 seconds on a machine that is simply idle —
   * hence: nothing for the first few, then one line, then 4× backoff.
   */
  _noteUnreadable(reason) {
    this._blindStreak += 1;
    if (this._blindStreak < this._blindReportAt) return;
    this._log(
      `Context usage unavailable for ${this._blindStreak} consecutive checks (${reason}) — ` +
      'no session-rotation decision can be made until it returns'
    );
    this._blindReportAt = this._blindStreak * 4;
  }

  /** A usable reading. Only announce the recovery if the outage was announced. */
  _noteReadable() {
    if (this._blindStreak >= this._blindChecksBeforeReport) {
      this._log(`Context usage readable again after ${this._blindStreak} unavailable checks`);
    }
    this._blindStreak = 0;
    this._blindReportAt = this._blindChecksBeforeReport;
  }

  _log(msg) {
    try {
      if (this._logFn) this._logFn(msg);
    } catch { /* a broken logger must not stop the monitor */ }
  }
}

/** Error → one line, whatever was thrown. */
function _describe(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Value → something safe to put in a log line. */
function _show(value) {
  if (typeof value === 'number') return String(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
