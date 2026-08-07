/**
 * `yos restart` has to restart the thing the user meant: the agent's main loop.
 *
 * The regression: restart cycled four PM2 services (activity-monitor, scheduler,
 * c4-dispatcher, web-console) and printed "Services restarted." None of those is
 * the agent — the main loop runs in a tmux session the guardian owns, and it was
 * never touched. Restarting the guardian does not restart the agent it guards,
 * because the guardian only relaunches a session that has stopped.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { restartRuntimeMainLoop } = await import('../../commands/service.js');

/**
 * Fake adapter whose session comes back after `relaunchAfter` polls.
 * `relaunchAfter: Infinity` models a guardian that never brings it back.
 */
function fakeAdapter({ running = true, relaunchAfter = 1 } = {}) {
  const state = { running, stopped: false, pollsSinceStop: 0 };
  return {
    state,
    async isRunning() {
      if (!state.stopped) return state.running;
      state.pollsSinceStop += 1;
      return state.pollsSinceStop >= relaunchAfter;
    },
    stop() { state.stopped = true; },
  };
}

/** Deterministic clock: no real waiting, and the deadline is reached honestly. */
function fakeClock(stepMs) {
  let t = 0;
  return { sleep: async () => { t += stepMs; }, now: () => t };
}

describe('restartRuntimeMainLoop', () => {
  test('stops the session so the guardian relaunches it', async () => {
    const adapter = fakeAdapter({ relaunchAfter: 1 });
    const clock = fakeClock(2000);

    const result = await restartRuntimeMainLoop({
      getAdapter: () => adapter, ...clock,
    });

    assert.equal(adapter.state.stopped, true, 'the main loop must actually be stopped');
    assert.equal(result.restarted, true);
  });

  test('waits across several polls for a slow relaunch', async () => {
    const adapter = fakeAdapter({ relaunchAfter: 5 });
    const clock = fakeClock(2000);

    const result = await restartRuntimeMainLoop({
      getAdapter: () => adapter, ...clock,
    });

    assert.equal(result.restarted, true);
    assert.ok(adapter.state.pollsSinceStop >= 5);
  });

  test('does NOT report success when the main loop never comes back', async () => {
    // The whole point: killing something is not restarting it. If the guardian
    // is broken, restart must say so rather than print a green line.
    const adapter = fakeAdapter({ relaunchAfter: Infinity });
    const clock = fakeClock(2000);

    const result = await restartRuntimeMainLoop({
      getAdapter: () => adapter, timeoutMs: 20_000, ...clock,
    });

    assert.equal(result.restarted, false);
    assert.equal(result.reason, 'guardian-did-not-relaunch');
  });

  test('reports a stopped main loop instead of pretending to cycle it', async () => {
    const adapter = fakeAdapter({ running: false });
    const result = await restartRuntimeMainLoop({
      getAdapter: () => adapter, ...fakeClock(2000),
    });

    assert.equal(result.restarted, false);
    assert.equal(result.reason, 'not-running');
    assert.equal(adapter.state.stopped, false, 'nothing to stop when it is already down');
  });

  test('survives a machine with no runtime configured', async () => {
    const result = await restartRuntimeMainLoop({
      getAdapter: () => { throw new Error('config.json absent'); },
      ...fakeClock(2000),
    });

    assert.equal(result.restarted, false);
    assert.equal(result.reason, 'no-runtime-configured');
  });

  test('a failing stop is reported, not swallowed', async () => {
    const adapter = fakeAdapter();
    adapter.stop = () => { throw new Error('tmux missing'); };

    const result = await restartRuntimeMainLoop({
      getAdapter: () => adapter, ...fakeClock(2000),
    });

    assert.equal(result.restarted, false);
    assert.match(result.reason, /stop-failed: tmux missing/);
  });

  test('a transient isRunning error during the wait does not end the wait', async () => {
    const adapter = fakeAdapter({ relaunchAfter: 3 });
    const realIsRunning = adapter.isRunning.bind(adapter);
    let calls = 0;
    adapter.isRunning = async () => {
      calls += 1;
      if (calls === 2) throw new Error('tmux hiccup');
      return realIsRunning();
    };

    const result = await restartRuntimeMainLoop({
      getAdapter: () => adapter, ...fakeClock(2000),
    });

    assert.equal(result.restarted, true, 'one bad poll must not be read as "never came back"');
  });
});
