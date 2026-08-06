/**
 * pm2-leftovers.js — noticing the previous install's PM2 processes before this
 * one starts fighting them.
 *
 * The failure this exists for (TD-21, observed 2026-07-31): a machine was
 * reinstalled by wiping the home directory, but PM2 is a daemon — wiping a home
 * does not stop it. Three God Daemons were left running, still holding the Web
 * Console port, so the new install could not bind it. `yos init` had no idea any
 * of that was true: nothing in it looked for a PM2 daemon it did not start.
 *
 * What this module deliberately does NOT do is kill anything. The processes
 * belong to the account, not to us; some of them may be things the operator
 * runs on purpose, and a reinstall is exactly the moment when someone is least
 * able to recover from a wrong guess. So we sort them into three piles, and the
 * pile that cannot possibly still work is named as such:
 *
 *   stale   — the script it runs is gone from disk. A wiped home leaves these,
 *             and they can never come back to life; they only hold ports.
 *   live    — under this YOS directory with its script still present, i.e. a
 *             previous install of ours that is genuinely running.
 *   foreign — outside this YOS directory. Never ours to touch, and listed only
 *             so the count adds up and nobody thinks we hid something.
 *
 * Pure: the caller supplies the process list and an `exists` predicate.
 */

/**
 * Parse `pm2 jlist` output without letting a bad line take init down.
 *
 * jlist prints JSON on stdout, but PM2 has been known to prefix it with
 * warnings, and an absent PM2 gives an empty string. Neither is a reason to
 * fail an install, so anything unparseable is reported as "no information",
 * which callers must not present as "no leftovers".
 *
 * @param {string} stdout
 * @returns {{ ok: boolean, processes: Array<object> }}
 */
export function parseJlist(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return { ok: false, processes: [] };

  const attempt = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const whole = attempt(text);
  if (whole) return { ok: true, processes: whole };

  // Skip whatever PM2 printed first. Note the trap this walked into on the way
  // in: a warning line reads `[PM2][WARN] ...`, so "find the first [" lands on
  // the warning itself and the parse fails. Candidate starts are therefore
  // whole lines, each tried in turn.
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith('[')) continue;
    const parsed = attempt(lines.slice(i).join('\n').trim());
    if (parsed) return { ok: true, processes: parsed };
  }
  return { ok: false, processes: [] };
}

const scriptPathOf = (proc) => proc?.pm2_env?.pm_exec_path || proc?.pm_exec_path || '';
const statusOf = (proc) => proc?.pm2_env?.status || proc?.status || 'unknown';

/**
 * Sort the account's PM2 processes into what a reinstall needs to know.
 *
 * @param {{
 *   processes: Array<object>,
 *   yosDir: string,
 *   exists?: (p: string) => boolean,
 * }} opts
 * @returns {{ stale: Array<object>, live: Array<object>, foreign: Array<object>, total: number }}
 */
export function classifyLeftovers({ processes, yosDir, exists = () => true }) {
  const list = Array.isArray(processes) ? processes : [];
  const dir = String(yosDir || '');
  const under = (p) => dir.length > 0 && typeof p === 'string' && p.length > 0
    && (p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`));

  const stale = [];
  const live = [];
  const foreign = [];

  for (const proc of list) {
    const script = scriptPathOf(proc);
    const entry = { name: proc?.name ?? '(unnamed)', pid: proc?.pid ?? null, script, status: statusOf(proc) };
    if (!under(script)) {
      foreign.push(entry);
      continue;
    }
    // Ours by path. Whether it can still work is a question about the disk.
    if (script && !exists(script)) stale.push(entry);
    else live.push(entry);
  }

  return { stale, live, foreign, total: list.length };
}

/**
 * The lines to show someone whose machine has leftovers, or null when there is
 * nothing worth interrupting them about.
 *
 * Foreign processes alone are not worth a word: on a shared account they are
 * normal and none of our business.
 *
 * @param {{ stale: Array<object>, live: Array<object>, foreign: Array<object> }} classified
 * @returns {{ headline: string, details: string[], command: string }|null}
 */
export function describeLeftovers({ stale = [], live = [], foreign = [] } = {}) {
  if (stale.length === 0 && live.length === 0) return null;

  const details = [];
  for (const proc of stale) {
    details.push(`${proc.name} (${proc.status}) — its script is gone: ${proc.script}`);
  }
  for (const proc of live) {
    details.push(`${proc.name} (${proc.status}) — from a previous install: ${proc.script}`);
  }
  if (foreign.length > 0) {
    details.push(`plus ${foreign.length} process(es) outside this YOS directory, which this install will not touch`);
  }

  const headline = stale.length > 0
    // Named bluntly: this is the state a wiped home leaves behind, and it is the
    // reason a fresh install fails to bind its own port.
    ? `PM2 is still running ${stale.length + live.length} process(es) from a previous install, `
      + `${stale.length} of which can no longer start — their files are gone.`
    : `PM2 is already running ${live.length} process(es) from a previous install.`;

  const names = [...stale, ...live].map((p) => p.name).filter((n) => n && n !== '(unnamed)');
  const command = names.length > 0 ? `pm2 delete ${names.join(' ')}` : 'pm2 kill';

  return { headline, details, command };
}
