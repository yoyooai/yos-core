/**
 * pm2-unit-guard.js — deciding whether it is safe to write the machine's
 * PM2 boot unit.
 *
 * The failure this exists for (TD-10, 2026-07-18, found during a self-upgrade
 * rollback re-verification and still true when re-read on 2026-08-06):
 * `yos init` wrote `/etc/systemd/system/pm2-<user>.service` unconditionally.
 * On a shared machine, running an init-flavoured test under an isolated HOME
 * meant the unit we installed carried the sandbox's HOME and PM2_HOME — so the
 * machine-level `pm2 resurrect` was now pointed at a directory that would be
 * deleted, and a reboot would bring up none of the real services. It was found
 * on our own build host, whose production PM2 ran the dashboard and its tunnel.
 * Nothing warned, nothing was backed up, and the unit's original content could
 * not be reconstructed afterwards.
 *
 * Two rules follow, and they are separate on purpose:
 *
 *   1. A run that is not managing this machine's real PM2 must not touch the
 *      machine's unit at all. That is what looksIsolated() detects — an
 *      overridden HOME or PM2_HOME, or a pm2 binary living in a temp
 *      directory. Refusing is not a degradation here: a sandbox has no
 *      business owning a machine-level boot hook.
 *
 *   2. When we do write, an existing unit is never destroyed silently. If it is
 *      byte-identical there is nothing to do (and no sudo to ask for); if it
 *      differs it gets backed up first and the caller is told exactly which
 *      lines change, because "the original content is not recoverable" is the
 *      part of TD-10 that actually cost us.
 *
 * Everything here is pure — no fs, no sudo, no systemctl — so the decision can
 * be tested without a machine to break.
 */

/** The lines whose change actually matters to someone reading a diff. */
const SIGNIFICANT_KEYS = ['ExecStart', 'User', 'Environment=PM2_HOME', 'Environment=HOME', 'Environment=PATH'];

/**
 * Whether this run is managing the machine's real PM2, or an isolated copy.
 *
 * @param {{ home: string, env?: Record<string,string|undefined>, pm2Path?: string, tmpDir?: string }} opts
 * @returns {{ isolated: boolean, reason: string|null }}
 */
export function looksIsolated({ home, env = {}, pm2Path = '', tmpDir = '/tmp' }) {
  const under = (p, dir) => typeof p === 'string' && p.length > 0 && dir.length > 0
    && (p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`));

  if (under(home, tmpDir)) {
    return { isolated: true, reason: `HOME is inside ${tmpDir} (${home}) — this is not the machine's real account` };
  }
  const declaredPm2Home = env.PM2_HOME?.trim();
  if (declaredPm2Home && declaredPm2Home !== `${home}/.pm2`) {
    return {
      isolated: true,
      reason: `PM2_HOME is overridden (${declaredPm2Home}, not ${home}/.pm2) — this run manages an isolated PM2`,
    };
  }
  if (under(pm2Path, tmpDir)) {
    return { isolated: true, reason: `the pm2 binary is inside ${tmpDir} (${pm2Path}) — it would not exist after a reboot` };
  }
  return { isolated: false, reason: null };
}

/**
 * Which significant lines differ between the unit on disk and the one we want.
 *
 * @param {string} existing
 * @param {string} next
 * @returns {Array<{ key: string, from: string|null, to: string|null }>}
 */
export function describeUnitDiff(existing, next) {
  const pick = (content, key) => {
    const prefix = key.includes('=') ? `${key}=` : `${key}=`;
    const line = String(content || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : null;
  };

  const changes = [];
  for (const key of SIGNIFICANT_KEYS) {
    const from = pick(existing, key);
    const to = pick(next, key);
    if (from !== to) changes.push({ key, from, to });
  }
  return changes;
}

/**
 * What to do about the machine's PM2 boot unit.
 *
 * @param {{
 *   existing: string|null,        // current unit content, null when absent
 *   next: string,                 // unit content we would install
 *   isolation?: { isolated: boolean, reason: string|null },
 *   skipRequested?: boolean,      // YOS_SKIP_SYSTEMD — an explicit opt out
 * }} opts
 * @returns {{ action: 'write'|'skip-identical'|'skip-isolated'|'skip-requested'|'backup-then-write',
 *            reason: string|null, changes: Array<{key:string,from:string|null,to:string|null}> }}
 */
export function classifyUnitWrite({ existing, next, isolation = { isolated: false, reason: null }, skipRequested = false }) {
  // An explicit opt out is checked first: someone who set it has said they own
  // the boot hook themselves, and we do not argue with that.
  if (skipRequested) {
    return { action: 'skip-requested', reason: 'YOS_SKIP_SYSTEMD is set', changes: [] };
  }
  if (isolation.isolated) {
    return { action: 'skip-isolated', reason: isolation.reason, changes: [] };
  }
  if (existing === null || existing === undefined) {
    return { action: 'write', reason: 'no unit installed yet', changes: [] };
  }
  if (String(existing) === String(next)) {
    // Nothing to do, and worth short-circuiting: the write path costs three
    // sudo calls, and asking for a password to install a byte-identical file is
    // how people learn to stop reading our prompts.
    return { action: 'skip-identical', reason: 'the installed unit is already exactly this', changes: [] };
  }
  return {
    action: 'backup-then-write',
    reason: 'a different unit is already installed',
    changes: describeUnitDiff(existing, next),
  };
}

/**
 * Where to put the copy. Timestamped so repeated runs never overwrite the one
 * backup that mattered.
 *
 * @param {string} unitPath
 * @param {string} stamp - ISO-ish stamp, caller supplies it (keeps this pure)
 * @returns {string}
 */
export function backupUnitPath(unitPath, stamp) {
  return `${unitPath}.yos-bak-${String(stamp).replace(/[:.]/g, '-')}`;
}
