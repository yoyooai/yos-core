import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { registerService } from '../service.js';
import { RESTART_FLOOR } from '../restart-policy.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/**
 * A skill directory with an entry script, optionally with its own pm2 config.
 */
function makeSkillDir({ withOwnEcosystem = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-start-policy-'));
  tmpDirs.push(root);
  const skillDir = path.join(root, 'skill');
  fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'src', 'index.js'), 'process.exit(0);\n');
  if (withOwnEcosystem) {
    fs.writeFileSync(
      path.join(skillDir, 'ecosystem.config.cjs'),
      "module.exports = { apps: [{ name: 'yos-demo', script: 'src/index.js' }] };\n",
    );
  }
  const coreEcosystemPath = path.join(root, 'pm2', 'ecosystem.config.cjs');
  return { skillDir, coreEcosystemPath, root };
}

/**
 * Stand-in for pm2. `knows` decides whether `pm2 jlist` reports the process,
 * which is how "--only matched nothing" is distinguished from a real start.
 */
function fakePm2({ restartsByCall = [0, 0], status = 'online', knows = true, serviceName = 'yos-demo' } = {}) {
  const calls = [];
  let jlistCall = 0;
  return {
    calls,
    exec(command) {
      const cmd = String(command);
      calls.push(cmd);
      if (cmd.includes('pm2 jlist')) {
        if (!knows) return '[]';
        const restarts = restartsByCall[Math.min(jlistCall++, restartsByCall.length - 1)];
        return JSON.stringify([{ name: serviceName, pm2_env: { status, restart_time: restarts } }]);
      }
      return '';
    },
  };
}

function startCommands(pm2) {
  return pm2.calls.filter((call) => call.startsWith('pm2 start'));
}

describe('component services start the same way a reboot starts them', () => {
  it('starts through the core ecosystem file, which is where the restart floor lives', () => {
    // `pm2 start <script>` has no --min-uptime flag to pass, so a service
    // started that way can never be capped. The ecosystem file can.
    const dirs = makeSkillDir({ withOwnEcosystem: true });
    fs.mkdirSync(path.dirname(dirs.coreEcosystemPath), { recursive: true });
    fs.writeFileSync(dirs.coreEcosystemPath, 'module.exports = { apps: [] };\n');

    const pm2 = fakePm2();
    const result = registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec: pm2.exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    assert.equal(result.success, true);
    const starts = startCommands(pm2);
    assert.equal(starts.length, 1, `expected one start, got: ${starts.join(' | ')}`);
    assert.match(starts[0], /--only "yos-demo"/);
    assert.ok(
      starts[0].includes(dirs.coreEcosystemPath),
      'did not start from the core ecosystem file',
    );
    assert.ok(
      !starts[0].includes(path.join(dirs.skillDir, 'ecosystem.config.cjs')),
      'started from the component config while the core ecosystem was available',
    );
  });

  it('falls back when --only matches nothing, instead of reporting a phantom start', () => {
    // pm2 exits 0 when --only matches no app, so the ecosystem attempt can
    // silently start nothing — e.g. a component not yet in components.json.
    const dirs = makeSkillDir({ withOwnEcosystem: true });
    fs.mkdirSync(path.dirname(dirs.coreEcosystemPath), { recursive: true });
    fs.writeFileSync(dirs.coreEcosystemPath, 'module.exports = { apps: [] };\n');

    const pm2 = fakePm2({ knows: false });
    registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec: pm2.exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    const starts = startCommands(pm2);
    assert.equal(starts.length, 2, `expected a fallback start, got: ${starts.join(' | ')}`);
    assert.ok(starts[1].includes(path.join(dirs.skillDir, 'ecosystem.config.cjs')));
  });

  it('carries the cap on the last-resort bare start', () => {
    // Nothing else is available here; --max-restarts is all pm2's CLI offers.
    const dirs = makeSkillDir();
    const pm2 = fakePm2();
    registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec: pm2.exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    const starts = startCommands(pm2);
    assert.equal(starts.length, 1);
    assert.match(starts[0], new RegExp(`--max-restarts ${RESTART_FLOOR.max_restarts}\\b`));
  });

  it('watches the process name the component declared, not a guessed one', () => {
    // registerService used to assume "yos-<component>". A component whose
    // service is named anything else was checked — and would be stopped — under
    // a name that does not exist.
    const dirs = makeSkillDir();
    const pm2 = fakePm2({ serviceName: 'feishu-bridge' });
    const result = registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      serviceName: 'feishu-bridge',
      exec: pm2.exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    assert.equal(result.success, true);
    assert.ok(
      startCommands(pm2)[0].includes('--name "feishu-bridge"'),
      'started under a name the component did not declare',
    );
  });
});

describe('a crash loop is ended, not just reported', () => {
  it('stops the service it found looping', () => {
    // Reporting honestly and walking away leaves the customer's machine
    // burning CPU and filling the log disk for as long as the cap allows.
    const dirs = makeSkillDir();
    const pm2 = fakePm2({ restartsByCall: [0, 3] });
    const result = registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec: pm2.exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    assert.equal(result.crashLooping, true);
    assert.equal(result.success, false);
    assert.equal(result.stopped, true);
    assert.ok(
      pm2.calls.some((call) => call.includes('pm2 stop "yos-demo"')),
      `nothing stopped the loop: ${pm2.calls.join(' | ')}`,
    );
  });

  it('persists the process list after stopping, so a reboot does not restart the loop', () => {
    const dirs = makeSkillDir();
    const pm2 = fakePm2({ restartsByCall: [0, 3] });
    registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec: pm2.exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    const stoppedAt = pm2.calls.findIndex((call) => call.includes('pm2 stop'));
    const savedAt = pm2.calls.findIndex((call, i) => i > stoppedAt && call.includes('pm2 save'));
    assert.ok(stoppedAt >= 0, 'the loop was never stopped');
    assert.ok(savedAt > stoppedAt, 'the stop was never saved to the process list');
  });

  it('leaves a healthy service running', () => {
    const dirs = makeSkillDir();
    const pm2 = fakePm2({ restartsByCall: [2, 2] });
    const result = registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec: pm2.exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    assert.equal(result.success, true);
    assert.ok(
      !pm2.calls.some((call) => call.includes('pm2 stop')),
      'stopped a service that was staying up',
    );
  });

  it('still reports the loop when pm2 refuses to stop it', () => {
    const dirs = makeSkillDir();
    const calls = [];
    let jlistCall = 0;
    const exec = (command) => {
      const cmd = String(command);
      calls.push(cmd);
      if (cmd.includes('pm2 stop')) throw new Error('pm2 daemon gone');
      if (cmd.includes('pm2 jlist')) {
        const restarts = [0, 3][Math.min(jlistCall++, 1)];
        return JSON.stringify([{ name: 'yos-demo', pm2_env: { status: 'online', restart_time: restarts } }]);
      }
      return '';
    };

    const result = registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec,
      coreEcosystemPath: dirs.coreEcosystemPath,
    });

    assert.equal(result.crashLooping, true);
    assert.equal(result.stopped, false);
    assert.match(result.error, /restarted 3 time/);
  });
});
