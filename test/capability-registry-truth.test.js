import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  buildLocalCapabilityCatalog,
  discoverLocalCapabilityProviders,
} from '../cli/lib/capability-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SKILLS = path.join(ROOT, 'skills');

const catalogFor = activeRuntime => {
  const providers = discoverLocalCapabilityProviders({
    coreSkillsDir: CORE_SKILLS,
    installedSkillsDir: CORE_SKILLS,
    components: {},
    registry: {},
  });
  return buildLocalCapabilityCatalog({
    ...providers,
    coreVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    activeRuntime,
  });
};

/**
 * Why this file exists.
 *
 * The system prompt now sends the agent to `yos capability list` before it
 * does anything else with an open-ended request. That put this table on the
 * critical path, and a table on the critical path has to be true in two ways
 * it previously was not:
 *
 *   - Complete. Four core skills shipped with no declaration at all, so the
 *     list under-reported what the machine had while printing them under
 *     "Undeclared capabilities" — which reads to an agent as a defect rather
 *     than as an omission.
 *   - Applicable. Nothing expressed "this is only true on one runtime", so
 *     runtime-specific skills would either be missing from the table or
 *     advertised on a machine that cannot run them. Customers get Codex by
 *     default, so that second case was the common one, not the edge case.
 */
describe('the capability table is complete', () => {
  // Core skills that legitimately declare nothing. Empty on purpose: a new
  // core skill should have to justify its way onto this list rather than
  // quietly widening the gap between the table and the machine.
  const ALLOWED_UNDECLARED = new Set();

  it('has no core skill missing from the table', () => {
    const undeclared = catalogFor('codex').providers
      .filter(provider => provider.source === 'core' && provider.declarationStatus === 'undeclared')
      .map(provider => provider.id)
      .filter(id => !ALLOWED_UNDECLARED.has(id));

    expect(undeclared).toEqual([]);
  });

  it('names every core skill directory, so the check cannot pass by finding nothing', () => {
    // A discovery bug that returned zero providers would make the assertion
    // above vacuously true.
    const shipped = fs.readdirSync(CORE_SKILLS, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).length;

    expect(catalogFor('codex').providers.filter(p => p.source === 'core')).toHaveLength(shipped);
    expect(shipped).toBeGreaterThan(5);
  });
});

describe('the capability table only claims what this machine can do', () => {
  const ids = runtime => catalogFor(runtime).capabilities.map(capability => capability.id);

  it('leaves a Claude-only capability out on a Codex machine', () => {
    // restart-claude and upgrade-claude drive Claude Code and nothing else.
    // Codex is the default install, so this is the case that matters.
    expect(ids('codex')).not.toContain('runtime.lifecycle');
  });

  it('includes it on a Claude machine', () => {
    expect(ids('claude')).toContain('runtime.lifecycle');
  });

  it('shows everything when the runtime is unknown', () => {
    // Fail open. Hiding a capability the machine really has makes a working
    // product look broken, which is worse than listing one it does not.
    expect(ids(null)).toContain('runtime.lifecycle');
  });

  it('keeps the runtime-independent capabilities on both', () => {
    for (const shared of ['communication.message', 'task.schedule', 'runtime.session']) {
      expect(ids('codex')).toContain(shared);
      expect(ids('claude')).toContain(shared);
    }
  });

  it('drops the scoped capability without dropping its provider', () => {
    // The skill is still installed on a Codex machine — it just does not
    // advertise a capability there. Losing the provider would misreport what
    // is on disk.
    const providers = catalogFor('codex').providers.map(provider => provider.id);

    expect(providers).toContain('restart-claude');
    expect(providers).toContain('upgrade-claude');
  });
});

/**
 * The block above builds the catalog directly, so it proves the filter works
 * but not that anything connects the filter to the machine's actual runtime.
 * That wiring was missing from the first version of these tests, and a manual
 * run of the real CLI is what surfaced the gap. Reading the config is now
 * covered by driving the command itself.
 */
describe('the command reads the runtime off the machine it is running on', () => {
  const CLI = path.join(ROOT, 'cli', 'yos.js');
  const tmpDirs = [];

  afterAll(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  });

  const listWithConfig = config => {
    const yosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-cli-'));
    tmpDirs.push(yosDir);
    // The path is part of the contract being tested: config.json lives under
    // $YOS_DIR/.yos, not $HOME/.yos. Getting that wrong makes the filter look
    // broken when it is fine.
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    fs.writeFileSync(path.join(yosDir, '.yos', 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, [CLI, 'capability', 'list'], {
      encoding: 'utf8',
      env: { ...process.env, YOS_DIR: yosDir, HOME: yosDir },
      timeout: 60000,
    });
    expect(result.status).toBe(0);
    return result.stdout;
  };

  it('hides a Claude-only capability when the config says codex', () => {
    expect(listWithConfig({ runtime: 'codex' })).not.toMatch(/runtime\.lifecycle/);
  });

  it('shows it when the config says claude', () => {
    expect(listWithConfig({ runtime: 'claude' })).toMatch(/runtime\.lifecycle/);
  });

  it('shows it when the config names no runtime', () => {
    expect(listWithConfig({})).toMatch(/runtime\.lifecycle/);
  });

  it('prints no undeclared-capability line on either runtime', () => {
    // The line is not wrong in itself — it earns its place for third-party
    // components. It should simply have nothing of ours to report.
    for (const runtime of ['codex', 'claude']) {
      expect(listWithConfig({ runtime })).not.toMatch(/Undeclared capabilities/);
    }
  });
});

/**
 * A declared capability used to mean "somebody wrote a line of YAML". The
 * `health` field and `yos doctor`'s runner for it both already existed, and
 * not one of the shipped declarations used them — an alarm wired to nothing.
 *
 * Probes are only attached where a capability can be installed and still be
 * broken: a store that exists but cannot be read. The code-only capabilities
 * (skill authoring, component management, session rotation) get none, because
 * a probe that cannot fail is decoration and would make this look better
 * covered than it is.
 */
describe('capability health probes report the truth about this machine', () => {
  // Restates each probe's target on purpose: the duplication is the check. A
  // probe quietly pointed at a different file would stop failing here.
  const PROBES = [
    { capabilityId: 'communication.message', dataPath: 'comm-bridge/c4.db', kind: 'sqlite' },
    { capabilityId: 'task.schedule', dataPath: 'scheduler/scheduler.db', kind: 'sqlite' },
    { capabilityId: 'runtime.monitor', dataPath: 'activity-monitor/agent-status.json', kind: 'json' },
  ];

  const tmpDirs = [];
  afterAll(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  });

  const tmpYosDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-probe-'));
    tmpDirs.push(dir);
    return dir;
  };

  const probePath = capabilityId => {
    const check = catalogFor('codex').healthChecks.find(entry => entry.capabilityId === capabilityId);
    expect(check).toBeDefined();
    return check.path;
  };

  const runProbe = (capabilityId, yosDir) => spawnSync(
    process.execPath,
    [probePath(capabilityId)],
    { encoding: 'utf8', env: { ...process.env, YOS_DIR: yosDir }, timeout: 30000 },
  );

  it('attaches a probe to every capability that can break, and only those', () => {
    const withProbes = catalogFor('codex').healthChecks.map(check => check.capabilityId).sort();

    expect(withProbes).toEqual(PROBES.map(probe => probe.capabilityId).sort());
  });

  test.each(PROBES)('$capabilityId passes on a machine that has never used it', ({ capabilityId }) => {
    // The store is absent on a fresh install. Reporting that as a fault would
    // put a red line on a healthy factory machine.
    expect(runProbe(capabilityId, tmpYosDir()).status).toBe(0);
  });

  test.each(PROBES)('$capabilityId passes on a healthy store', ({ capabilityId, dataPath, kind }) => {
    const yosDir = tmpYosDir();
    const target = path.join(yosDir, dataPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (kind === 'sqlite') {
      const require = createRequire(path.join(ROOT, 'skills', 'comm-bridge', 'package.json'));
      const Database = require('better-sqlite3');
      const db = new Database(target);
      db.exec('create table probe_fixture (a)');
      db.close();
    } else {
      fs.writeFileSync(target, JSON.stringify({ health: 'ok' }));
    }

    expect(runProbe(capabilityId, yosDir).status).toBe(0);
  });

  test.each(PROBES)('$capabilityId fails on a store it cannot read', ({ capabilityId, dataPath }) => {
    // The point of the whole exercise: a probe that cannot go red is
    // decoration. Verified by breaking the file it watches, not by trusting
    // the code to be right.
    const yosDir = tmpYosDir();
    const target = path.join(yosDir, dataPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'this is not a database or a json object');

    const result = runProbe(capabilityId, yosDir);
    expect(result.status).not.toBe(0);
    // And it must say which file, or the report is unactionable.
    expect(result.stderr).toContain(dataPath.split('/').pop());
  });

  test.each(PROBES)('$capabilityId neither writes nor reaches the network', ({ capabilityId }) => {
    // `yos doctor` may be run at any time on a customer machine. A probe that
    // sent a message or wrote to a store would make diagnosis a side effect.
    const source = fs.readFileSync(probePath(capabilityId), 'utf8');

    for (const forbidden of [/writeFile/, /appendFile/, /mkdir/, /unlink/, /\bfetch\(/, /node:http/, /node:net/]) {
      expect(source).not.toMatch(forbidden);
    }
    // Read-only is asserted positively too, where the API supports saying so.
    if (/better-sqlite3/.test(source)) expect(source).toMatch(/readonly:\s*true/);
  });
});
