/**
 * PM2 service management for components
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Register and start a PM2 service for a component.
 *
 * @param {object} opts
 * @param {string} opts.name - Service name (will be prefixed with "yos-")
 * @param {string} opts.entry - Entry script path (relative to skillDir)
 * @param {string} opts.skillDir - Component's skill directory
 * @param {'pm2'} opts.type - Service type (only pm2 supported for now)
 * @returns {{ success: boolean, error?: string }}
 */
export function registerService({ name, entry, skillDir, type, exec = execSync }) {
  if (type !== 'pm2') {
    return { success: false, error: `Unsupported service type: ${type}. Only "pm2" is supported.` };
  }

  const serviceName = `yos-${name}`;
  const scriptPath = path.resolve(skillDir, entry);

  if (!fs.existsSync(scriptPath)) {
    return { success: false, error: `Entry script not found: ${scriptPath}` };
  }

  try {
    // Stop existing service if running (ignore errors)
    try {
      exec(`pm2 delete "${serviceName}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Not running — fine
    }

    // Start service — prefer ecosystem.config.cjs if available
    const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
    if (fs.existsSync(ecosystemPath)) {
      exec(`pm2 start "${ecosystemPath}"`, {
        stdio: 'pipe',
        timeout: 30000,
      });
    } else {
      exec(`pm2 start "${scriptPath}" --name "${serviceName}"`, {
        stdio: 'pipe',
        timeout: 30000,
      });
    }

    // Save PM2 process list
    exec('pm2 save 2>/dev/null', { stdio: 'pipe' });

    // pm2 accepting the start says nothing about the process surviving it. A
    // component that exits immediately — missing credentials being the common
    // case — is restarted over and over while the caller has already been told
    // it started. Report what the process is actually doing.
    return settleService(serviceName, exec);
  } catch (err) {
    return { success: false, error: `Failed to start service: ${err.message}` };
  }
}

/** How long a freshly started service is watched before it counts as running. */
const SETTLE_MS = Number(process.env.YOS_SERVICE_SETTLE_MS) || 6000;

/**
 * Read a pm2 process's state and restart count.
 *
 * @param {string} serviceName
 * @returns {{ status: string, restarts: number } | null} null when pm2 does not know it
 */
export function readServiceState(serviceName, exec = execSync) {
  try {
    const raw = exec('pm2 jlist', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).toString();
    const entry = JSON.parse(raw).find((proc) => proc.name === serviceName);
    if (!entry) return null;
    return {
      status: entry.pm2_env?.status ?? 'unknown',
      restarts: Number(entry.pm2_env?.restart_time ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether a service that pm2 started is actually running.
 *
 * Restarts accumulating during the settle window is the signal that matters: a
 * crash-looping process is `online` about half the time it is sampled, so
 * status alone would call it healthy.
 */
export function judgeSettle(before, after) {
  if (!after) {
    return { success: false, error: 'pm2 does not report the service after starting it' };
  }
  const restartsGained = after.restarts - (before?.restarts ?? 0);
  if (restartsGained > 0) {
    return {
      success: false,
      crashLooping: true,
      error: `the service restarted ${restartsGained} time(s) right after starting, so it is not staying up`,
    };
  }
  if (after.status !== 'online') {
    return { success: false, error: `the service is ${after.status}, not online` };
  }
  return { success: true };
}

function settleService(serviceName, exec = execSync) {
  const before = readServiceState(serviceName, exec);
  // Deliberately synchronous: `yos add` is a sequential script, and the caller
  // must not print "started" before this answer exists.
  exec(`sleep ${Math.max(1, Math.round(SETTLE_MS / 1000))}`, { stdio: 'pipe' });
  return judgeSettle(before, readServiceState(serviceName, exec));
}
