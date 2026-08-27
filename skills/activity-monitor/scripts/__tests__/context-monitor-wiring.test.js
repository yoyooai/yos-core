import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { startContextMonitor } from '../adapters/runtime-components.js';
import { ContextMonitorBase } from '../../../../cli/lib/runtime/context-monitor-base.js';

/**
 * Why this file exists.
 *
 * ContextMonitorBase only stops arming a cooldown for a handoff that failed if
 * the handler actually reports the failure, and it can only say it has gone
 * blind if something gave it a logger. Both of those are promises made at this
 * wiring point, not inside the class — and a promise nobody keeps is exactly
 * how TD-271 happened (`sampleInterval` was made configurable and then never
 * configured by anyone).
 *
 * So: prove the wiring passes `log`, prove onExceed hands back what
 * enqueueContextRotationHandoff returned, and prove onEarlyThreshold reports a
 * failed enqueue as a failure.
 */

/** Adapter whose monitor records what it was constructed and started with. */
function fakeAdapter() {
  const seen = { opts: null, polling: null };
  return {
    seen,
    displayName: 'Fake',
    runtimeId: 'fake',
    getContextMonitor(opts = {}) {
      seen.opts = opts;
      const monitor = new ContextMonitorBase({ threshold: 0.75, ...opts });
      monitor.startPolling = (polling) => { seen.polling = polling; };
      return monitor;
    },
  };
}

function deps(overrides = {}) {
  return {
    getUnsummarizedCount: () => 100,
    checkpointThreshold: 10,
    getLastMemorySyncTriggerAt: () => 0,
    setLastMemorySyncTriggerAt: () => {},
    memorySyncCooldownSeconds: 600,
    c4ControlPath: '/nonexistent/c4-control.js',
    enqueueContextRotationHandoff: () => true,
    log: () => {},
    ...overrides,
  };
}

describe('startContextMonitor wiring', () => {
  it('gives the monitor a logger, so going blind can be said out loud', () => {
    const adapter = fakeAdapter();
    const lines = [];
    startContextMonitor(adapter, deps({ log: (m) => lines.push(m) }));

    assert.ok(adapter.seen.opts && typeof adapter.seen.opts.log === 'function',
      'without this the monitor is mute and a machine with no readable usage ' +
      'looks exactly like a healthy idle one');

    adapter.seen.opts.log('probe');
    assert.deepEqual(lines.filter((l) => l === 'probe'), ['probe'],
      'the logger handed over must be the real activity-monitor log');
  });

  it('returns null for an adapter that has no context monitor', () => {
    assert.equal(startContextMonitor({ getContextMonitor: () => null }, deps()), null);
  });

  it('reports a successful handoff as success', async () => {
    const adapter = fakeAdapter();
    startContextMonitor(adapter, deps({ enqueueContextRotationHandoff: () => true }));
    const outcome = await adapter.seen.polling.onExceed({ used: 9, ceiling: 10, ratio: 0.9 });
    assert.notEqual(outcome, false);
  });

  it('reports a handoff that never reached C4 as a failure', async () => {
    const adapter = fakeAdapter();
    startContextMonitor(adapter, deps({ enqueueContextRotationHandoff: () => false }));
    const outcome = await adapter.seen.polling.onExceed({ used: 9, ceiling: 10, ratio: 0.9 });
    assert.equal(outcome, false,
      'dropping this boolean is what let a failed handoff buy five minutes of silence');
  });

  it('reports a failed memory-sync enqueue as a failure', async () => {
    const adapter = fakeAdapter();
    // c4ControlPath does not exist, so execFileSync throws.
    startContextMonitor(adapter, deps());
    const outcome = await adapter.seen.polling.onEarlyThreshold({ used: 7, ceiling: 10, ratio: 0.7 });
    assert.equal(outcome, false);
  });

  it('holds the cooldown when it deliberately skips the sync', async () => {
    const adapter = fakeAdapter();
    startContextMonitor(adapter, deps({ getUnsummarizedCount: () => 1 }));
    const outcome = await adapter.seen.polling.onEarlyThreshold({ used: 7, ceiling: 10, ratio: 0.7 });
    assert.notEqual(outcome, false, 'nothing was owed, so nothing failed');
  });

  it('holds the cooldown while an earlier sync is still inside its window', async () => {
    const adapter = fakeAdapter();
    const now = Math.floor(Date.now() / 1000);
    startContextMonitor(adapter, deps({ getLastMemorySyncTriggerAt: () => now }));
    const outcome = await adapter.seen.polling.onEarlyThreshold({ used: 7, ceiling: 10, ratio: 0.7 });
    assert.notEqual(outcome, false);
  });

  it('polls every 30 seconds', () => {
    const adapter = fakeAdapter();
    startContextMonitor(adapter, deps());
    assert.equal(adapter.seen.polling.intervalMs, 30_000);
  });
});
