import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { judgeSettle, readServiceState, registerService } from '../service.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/** A skill directory with an entry script, so registerService gets that far. */
function makeSkillDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-service-test-'));
  tmpDirs.push(root);
  const skillDir = path.join(root, 'skill');
  fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'src', 'index.js'), 'process.exit(0);\n');
  return { skillDir };
}

describe('a service only counts as started if it stays up', () => {
  it('accepts a process that is online and has not restarted', () => {
    const state = { status: 'online', restarts: 0 };
    assert.deepEqual(judgeSettle(state, state), { success: true });
  });

  it('rejects a process that restarted during the settle window', () => {
    // This is the case that used to be reported as "started": a component with
    // no credentials exits at once, pm2 restarts it, and the user walks away
    // believing the install finished while the loop burns on in the background.
    const verdict = judgeSettle({ status: 'online', restarts: 0 }, { status: 'online', restarts: 4 });
    assert.equal(verdict.success, false);
    assert.equal(verdict.crashLooping, true);
    assert.match(verdict.error, /restarted 4 time/);
  });

  it('counts only the restarts gained, so an old count is not held against it', () => {
    // Reinstalling a component that had crashed before must not be condemned
    // for the previous run's restarts.
    assert.deepEqual(
      judgeSettle({ status: 'online', restarts: 371 }, { status: 'online', restarts: 371 }),
      { success: true },
    );
  });

  it('rejects a process pm2 no longer reports as online', () => {
    const verdict = judgeSettle({ status: 'online', restarts: 0 }, { status: 'errored', restarts: 0 });
    assert.equal(verdict.success, false);
    assert.match(verdict.error, /errored/);
  });

  it('rejects a service pm2 does not know about at all', () => {
    const verdict = judgeSettle(null, null);
    assert.equal(verdict.success, false);
    assert.match(verdict.error, /does not report/);
  });

  it('treats a first sighting with no prior sample as zero restarts', () => {
    assert.deepEqual(judgeSettle(null, { status: 'online', restarts: 0 }), { success: true });
    assert.equal(judgeSettle(null, { status: 'online', restarts: 2 }).crashLooping, true);
  });
});

describe('reading pm2 state', () => {
  it('finds the named process and reports its status and restarts', () => {
    const exec = () => JSON.stringify([
      { name: 'yos-other', pm2_env: { status: 'online', restart_time: 1 } },
      { name: 'yos-feishu', pm2_env: { status: 'errored', restart_time: 371 } },
    ]);
    assert.deepEqual(readServiceState('yos-feishu', exec), { status: 'errored', restarts: 371 });
  });

  it('returns null when pm2 does not list the service', () => {
    assert.equal(readServiceState('yos-absent', () => '[]'), null);
  });

  it('returns null rather than throwing when pm2 cannot be read', () => {
    // A broken pm2 must not abort an install with a stack trace.
    assert.equal(readServiceState('yos-feishu', () => { throw new Error('pm2 missing'); }), null);
    assert.equal(readServiceState('yos-feishu', () => 'not json'), null);
  });
});

describe('registerService reports the settled outcome, not the start attempt', () => {
  /**
   * Stand-in for pm2. `restartsByCall` lets a run answer `pm2 jlist` differently
   * the second time, which is how a crash loop shows up: the process is there
   * both times, with a higher restart count on the way out.
   */
  function fakePm2({ restartsByCall = [0, 0], status = 'online' } = {}) {
    const calls = [];
    let jlistCall = 0;
    return {
      calls,
      exec(command) {
        calls.push(String(command));
        if (String(command).includes('pm2 jlist')) {
          const restarts = restartsByCall[Math.min(jlistCall++, restartsByCall.length - 1)];
          return JSON.stringify([{ name: 'yos-demo', pm2_env: { status, restart_time: restarts } }]);
        }
        return '';
      },
    };
  }

  function registerWith(pm2, dirs) {
    return registerService({
      name: 'demo',
      entry: 'src/index.js',
      skillDir: dirs.skillDir,
      type: 'pm2',
      exec: pm2.exec,
    });
  }

  it('fails when the service restarts during the settle window', () => {
    // Without this the caller is told "started" while pm2 restarts the process
    // forever — the exact report a user got for a component missing its keys.
    const dirs = makeSkillDir();
    const pm2 = fakePm2({ restartsByCall: [0, 3] });
    const result = registerWith(pm2, dirs);

    assert.equal(result.success, false);
    assert.equal(result.crashLooping, true);
  });

  it('succeeds when the service holds still', () => {
    const dirs = makeSkillDir();
    const result = registerWith(fakePm2({ restartsByCall: [2, 2] }), dirs);
    assert.deepEqual(result, { success: true });
  });

  it('actually inspects pm2 after starting, rather than assuming', () => {
    // Guards the wiring itself: dropping the settle call would leave a
    // registerService that never asks pm2 anything after `pm2 start`.
    const dirs = makeSkillDir();
    const pm2 = fakePm2();
    registerWith(pm2, dirs);

    const startedAt = pm2.calls.findIndex((call) => call.includes('pm2 start'));
    const inspectedAt = pm2.calls.findIndex((call, i) => i > startedAt && call.includes('pm2 jlist'));
    assert.ok(startedAt >= 0, 'service was never started');
    assert.ok(inspectedAt > startedAt, 'nothing checked the service after starting it');
  });
});
