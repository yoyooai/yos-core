/**
 * PM2 service management for components
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getCoreEcosystemPath } from './pm2.js';
import { RESTART_FLOOR } from './restart-policy.js';

/**
 * Register and start a PM2 service for a component.
 *
 * @param {object} opts
 * @param {string} opts.name - Component name
 * @param {string} opts.entry - Entry script path (relative to skillDir)
 * @param {string} opts.skillDir - Component's skill directory
 * @param {'pm2'} opts.type - Service type (only pm2 supported for now)
 * @param {string} [opts.serviceName] - PM2 process name; defaults to "yos-<name>"
 * @returns {{ success: boolean, error?: string, crashLooping?: boolean, stopped?: boolean }}
 */
export function registerService({
  name,
  entry,
  skillDir,
  type,
  serviceName: serviceNameOpt,
  exec = execSync,
  coreEcosystemPath = getCoreEcosystemPath(),
  exists = fs.existsSync,
}) {
  if (type !== 'pm2') {
    return { success: false, error: `Unsupported service type: ${type}. Only "pm2" is supported.` };
  }

  // The component declares its own PM2 process name (SKILL.md `service.name`);
  // assuming "yos-<name>" made every check below look at a process that may not
  // be the one that was started.
  const serviceName = serviceNameOpt || `yos-${name}`;
  const scriptPath = path.resolve(skillDir, entry);

  if (!exists(scriptPath)) {
    return { success: false, error: `Entry script not found: ${scriptPath}` };
  }

  try {
    // Stop existing service if running (ignore errors)
    try {
      exec(`pm2 delete "${serviceName}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Not running — fine
    }

    // Start through the core ecosystem file whenever it exists. It is the same
    // path a reboot takes, so the service runs under one restart policy instead
    // of one at install time and a different one afterwards — and it is the only
    // path that can apply a restart floor, since `pm2 start <script>` has no
    // --min-uptime flag to pass (only --max-restarts, which alone does nothing).
    let startedFromCoreEcosystem = false;
    if (coreEcosystemPath && exists(coreEcosystemPath)) {
      try {
        exec(`pm2 start "${coreEcosystemPath}" --only "${serviceName}" --update-env`, {
          stdio: 'pipe',
          timeout: 30000,
        });
        // `--only` matching nothing is not an error to pm2: it exits 0 having
        // started no process. Only treat this as the start if pm2 now knows it.
        startedFromCoreEcosystem = Boolean(readServiceState(serviceName, exec));
      } catch {
        startedFromCoreEcosystem = false;
      }
    }

    if (!startedFromCoreEcosystem) {
      const ecosystemPath = path.join(skillDir, 'ecosystem.config.cjs');
      if (exists(ecosystemPath)) {
        exec(`pm2 start "${ecosystemPath}"`, {
          stdio: 'pipe',
          timeout: 30000,
        });
      } else {
        exec(
          `pm2 start "${scriptPath}" --name "${serviceName}" --max-restarts ${RESTART_FLOOR.max_restarts}`,
          { stdio: 'pipe', timeout: 30000 },
        );
      }
    }

    // Save PM2 process list
    exec('pm2 save 2>/dev/null', { stdio: 'pipe' });

    // pm2 accepting the start says nothing about the process surviving it. A
    // component that exits immediately — missing credentials being the common
    // case — is restarted over and over while the caller has already been told
    // it started. Report what the process is actually doing.
    const settled = settleService(serviceName, exec);
    if (settled.crashLooping) {
      return { ...settled, ...endCrashLoop(serviceName, exec) };
    }
    return settled;
  } catch (err) {
    return { success: false, error: `Failed to start service: ${err.message}` };
  }
}

/**
 * Take a crash-looping service out of the restart cycle.
 *
 * The restart floor makes the loop finite; it does not make it short. Ten
 * restarts with a 5s delay is still a minute of CPU burn and log noise, and
 * `pm2 save` above has already recorded the process — so a reboot would start
 * the loop over. Neither belongs on a customer's machine after we have already
 * decided the service cannot run.
 *
 * @returns {{ stopped: boolean }}
 */
function endCrashLoop(serviceName, exec = execSync) {
  try {
    exec(`pm2 stop "${serviceName}" 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    return { stopped: false };
  }
  try {
    exec('pm2 save 2>/dev/null', { stdio: 'pipe' });
  } catch {
    // The process is stopped either way; a failed save only risks it coming
    // back on reboot, which the restart floor now bounds.
  }
  return { stopped: true };
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
