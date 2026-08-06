/**
 * boot-autostart.js — bringing the services back after a reboot, without root.
 *
 * The systemd route needs sudo. On a machine where the customer is not an
 * administrator that route simply fails, and until now the install said the
 * quiet part out loud in the wrong direction: "optional — YOS works fine
 * without it". It does not. After a reboot every service is down and the bot is
 * silent until someone runs a command they were never told to keep.
 *
 * A user crontab is the one boot hook a non-root account reliably owns: cron
 * runs as a system service and executes `@reboot` for each user regardless of
 * whether that user is logged in, so it needs no linger and no polkit prompt.
 *
 * Everything here is pure except installRebootCrontab(), so the line we write
 * and the idempotency rule can be tested without touching a real crontab.
 */

import { execFileSync, spawnSync } from 'node:child_process';

/** Marks our line so re-running init replaces it instead of stacking copies. */
export const CRONTAB_MARKER = '# yos: bring services back after a reboot';

/**
 * The `@reboot` line to install.
 *
 * cron gives a job almost no environment — no PATH to speak of, no HOME — so
 * everything the command needs is spelled out. `pm2 resurrect` replays the dump
 * written by `pm2 save`, which init already does.
 *
 * @param {{ pm2Path: string, home: string, pm2Home?: string, pathEnv?: string, logPath?: string }} opts
 * @returns {string}
 */
export function buildRebootCrontabLine(opts) {
  const { pm2Path, home, pm2Home = `${home}/.pm2`, pathEnv, logPath } = opts;
  if (!pm2Path || !home) throw new Error('buildRebootCrontabLine needs pm2Path and home');
  const env = [
    `HOME=${home}`,
    `PM2_HOME=${pm2Home}`,
    `PATH=${pathEnv || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
  ].join(' ');
  const log = logPath || `${home}/yos/pm2/reboot.log`;
  // Redirect both streams: a cron job that writes anything triggers mail on
  // some systems, and a customer does not need mail to learn PM2 started.
  return `@reboot ${env} ${pm2Path} resurrect >> ${log} 2>&1`;
}

/**
 * Merge our line into an existing crontab, replacing any previous copy of it.
 *
 * Other people's entries are preserved exactly — this runs on machines that may
 * already have crontabs we know nothing about.
 *
 * @param {string} existing - Current crontab content ('' when there is none)
 * @param {string} line - Line from buildRebootCrontabLine()
 * @returns {string} The crontab content to install
 */
export function mergeCrontab(existing, line) {
  const kept = [];
  const lines = String(existing || '').split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === CRONTAB_MARKER) {
      // Drop the marker and the entry it introduces, wherever it sits.
      if ((lines[i + 1] || '').startsWith('@reboot')) i += 1;
      continue;
    }
    // A previous install's entry whose marker was removed by hand.
    if (lines[i].startsWith('@reboot') && lines[i].includes('pm2') && lines[i].includes('resurrect')) continue;
    kept.push(lines[i]);
  }

  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const body = kept.length ? `${kept.join('\n')}\n` : '';
  return `${body}${CRONTAB_MARKER}\n${line}\n`;
}

/**
 * Whether a usable `crontab` command exists. Absent in slim containers and on
 * hosts where cron was never installed.
 * @returns {boolean}
 */
export function crontabAvailable() {
  const result = spawnSync('crontab', ['-l'], { stdio: 'pipe', encoding: 'utf8', timeout: 10000 });
  // Exit 1 with "no crontab for <user>" is a usable crontab that is empty.
  if (result.error) return false;
  if (result.status === 0) return true;
  return /no crontab for/i.test((result.stderr || '') + (result.stdout || ''));
}

/**
 * Read the current user's crontab, treating "no crontab" as empty.
 * @returns {string}
 */
export function readCrontab() {
  const result = spawnSync('crontab', ['-l'], { stdio: 'pipe', encoding: 'utf8', timeout: 10000 });
  if (result.status === 0) return result.stdout || '';
  return '';
}

/**
 * Install the `@reboot` entry for the current user.
 *
 * @param {{ pm2Path: string, home: string, pm2Home?: string, pathEnv?: string, logPath?: string }} opts
 * @returns {{ ok: boolean, line: string|null, reason: string|null }}
 */
export function installRebootCrontab(opts) {
  if (!crontabAvailable()) {
    return { ok: false, line: null, reason: 'no usable crontab command on this machine' };
  }
  let line;
  try {
    line = buildRebootCrontabLine(opts);
  } catch (err) {
    return { ok: false, line: null, reason: err.message };
  }
  const merged = mergeCrontab(readCrontab(), line);
  try {
    execFileSync('crontab', ['-'], { input: merged, stdio: 'pipe', timeout: 15000 });
  } catch (err) {
    return { ok: false, line, reason: (err.stderr?.toString() || err.message || 'crontab rejected the entry').trim().split('\n')[0] };
  }
  // Trust the machine, not the exit code: read it back.
  if (!readCrontab().includes('resurrect')) {
    return { ok: false, line, reason: 'crontab accepted the entry but it is not there on re-read' };
  }
  return { ok: true, line, reason: null };
}
