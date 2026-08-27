/**
 * ClaudeContextMonitor — ContextMonitor implementation for Claude Code.
 *
 * Reads token usage from ~/yos/activity-monitor/statusline.json, which is
 * written after every turn by the context-monitor.js statusLine hook.
 *
 * Fields used:
 *   context_window.used_percentage    — percent of context used (0–100)
 *   context_window.context_window_size — ceiling in tokens (e.g. 200000)
 *
 * ⚠️ Not wired into production. ClaudeRuntime.getContextMonitor() returns null
 * on purpose: on Claude the statusLine hook
 * (skills/activity-monitor/scripts/context-monitor.js) already reacts after
 * every turn and enqueues the handoff itself. Arming this polling monitor as
 * well would mean two mechanisms racing to rotate the same session.
 * __tests__/claude-context-monitor.test.js pins that, so nothing can quietly
 * turn both on. The class is kept — and kept correct — because the statusLine
 * hook is a Claude Code feature we do not control, and this is the fallback if
 * it ever goes away.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextMonitorBase } from './context-monitor-base.js';

const YOS_DIR = process.env.YOS_DIR || path.join(os.homedir(), 'yos');
const STATUSLINE_FILE = path.join(YOS_DIR, 'activity-monitor', 'statusline.json');

export class ClaudeContextMonitor extends ContextMonitorBase {
  /**
   * @param {object} [opts] - Passed to ContextMonitorBase
   * @param {string} [opts.statuslineFile] - Status file path (tests)
   * @param {object} [opts.fsImpl] - fs module (tests)
   */
  constructor(opts = {}) {
    super(opts);
    this._fs = opts.fsImpl ?? fs;
    this._statuslineFile = opts.statuslineFile ?? STATUSLINE_FILE;
  }

  /**
   * Read context usage from Claude Code's statusLine JSON file.
   *
   * Returns null rather than a half-derived number: a percentage that is not a
   * number between 0 and 100 would come back out of the base class as a NaN
   * ratio, which compares false against every threshold and so reads as
   * "plenty of room left".
   *
   * @returns {Promise<{used: number, ceiling: number} | null>}
   */
  async getUsage() {
    try {
      const raw = this._fs.readFileSync(this._statuslineFile, 'utf8');
      const status = JSON.parse(raw);
      const cw = status?.context_window;
      if (!cw) return null;

      const pct = cw.used_percentage;
      const ceiling = cw.context_window_size;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
      if (!Number.isFinite(ceiling) || ceiling <= 0) return null;

      const used = Math.round((pct / 100) * ceiling);
      return { used, ceiling };
    } catch {
      return null;
    }
  }
}
