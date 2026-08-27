import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ContextMonitorBase } from '../context-monitor-base.js';

/**
 * Why this file exists.
 *
 * ContextMonitorBase is the only thing that decides "this session has to hand
 * over before it runs out of room". Nothing else watches. When it declines to
 * fire, the session keeps growing until the runtime hits its own wall, and the
 * customer's report is "the agent stopped making sense" — with no log line
 * anywhere saying the monitor had gone quiet.
 *
 * Three ways it could go quiet, all of them silent before 2026-08-27:
 *
 *   1. The cooldown was armed BEFORE the handler ran and regardless of what the
 *      handler reported. `enqueueContextRotationHandoff()` returns false when
 *      all three C4 enqueue attempts fail, and runtime-components.js dropped
 *      that boolean on the floor. A failed handoff therefore bought five
 *      minutes of silence at exactly the moment the context was already over
 *      the line. The Claude-side twin (skills/activity-monitor/scripts/
 *      context-monitor.js) had already been fixed for this — its comment reads
 *      "Only update cooldown after successful enqueue to avoid silent 5-min gap
 *      on failure". The copy in this class never got the same fix.
 *
 *   2. A usage reading of NaN (or a zero/negative ceiling) produced a NaN
 *      ratio. Every comparison against NaN is false, so the monitor "decided"
 *      not to fire, every 30 seconds, forever, without a word.
 *
 *   3. getUsage() returning null — no active session, no sqlite3, nothing on
 *      disk — was indistinguishable from "plenty of room left". A machine whose
 *      monitor can never read usage looks exactly like a healthy idle one.
 *
 * startPolling() also swallowed every error with `.catch(() => {})`.
 */

/** Monitor with a scriptable getUsage() and a captured log. */
function makeMonitor(opts = {}) {
  const lines = [];
  const clock = { ms: 1_000_000 };
  const usage = { next: { used: 0, ceiling: 200_000 }, throws: null, calls: 0 };

  class Fake extends ContextMonitorBase {
    async getUsage() {
      usage.calls += 1;
      if (usage.throws) throw usage.throws;
      return usage.next;
    }
  }

  const monitor = new Fake({
    threshold: 0.75,
    cooldownMs: 300_000,
    earlyCooldownMs: 600_000,
    log: (msg) => lines.push(msg),
    now: () => clock.ms,
    ...opts,
  });

  return { monitor, lines, clock, usage };
}

/** Percent of the ceiling, as a usage record. */
const at = (pct, ceiling = 200_000) => ({ used: Math.round(ceiling * pct / 100), ceiling });

describe('ContextMonitorBase — a failed handoff must not buy silence', () => {
  it('does not arm the cooldown when the handler reports failure', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = at(90);

    let calls = 0;
    const onExceed = async () => { calls += 1; return false; };

    await monitor.checkThreshold({ onExceed });
    await monitor.checkThreshold({ onExceed });
    await monitor.checkThreshold({ onExceed });

    assert.equal(calls, 3,
      'a handoff that failed to enqueue must be retried on the very next check, ' +
      'not five minutes later');
  });

  it('does not arm the cooldown when the handler throws', async () => {
    const { monitor, usage, lines } = makeMonitor();
    usage.next = at(90);

    let calls = 0;
    const onExceed = async () => { calls += 1; throw new Error('c4 unreachable'); };

    await monitor.checkThreshold({ onExceed });
    await monitor.checkThreshold({ onExceed });

    assert.equal(calls, 2, 'a thrown handler is a failed handoff, so retry immediately');
    assert.ok(lines.some((l) => l.includes('c4 unreachable')),
      'the reason the handoff failed must reach the log');
  });

  it('does arm the cooldown once the handler succeeds', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = at(90);

    let calls = 0;
    const onExceed = async () => { calls += 1; return true; };

    await monitor.checkThreshold({ onExceed });
    await monitor.checkThreshold({ onExceed });

    assert.equal(calls, 1, 'a successful handoff holds the cooldown as designed');
  });

  it('treats a handler that returns nothing as success (legacy callbacks)', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = at(90);

    let calls = 0;
    const onExceed = async () => { calls += 1; };

    await monitor.checkThreshold({ onExceed });
    await monitor.checkThreshold({ onExceed });

    assert.equal(calls, 1);
  });

  it('fires again once the cooldown really has expired', async () => {
    const { monitor, usage, clock } = makeMonitor();
    usage.next = at(90);

    let calls = 0;
    const onExceed = async () => { calls += 1; return true; };

    await monitor.checkThreshold({ onExceed });
    clock.ms += 299_000;
    await monitor.checkThreshold({ onExceed });
    assert.equal(calls, 1, 'still inside the cooldown');

    clock.ms += 2_000;
    await monitor.checkThreshold({ onExceed });
    assert.equal(calls, 2, 'cooldown elapsed — the session is still over the line, ask again');
  });

  it('applies the same rule to the early memory-sync handler', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = at(61); // between early (60%) and switch (75%)

    let calls = 0;
    const onEarlyThreshold = async () => { calls += 1; return false; };

    await monitor.checkThreshold({ onEarlyThreshold });
    await monitor.checkThreshold({ onEarlyThreshold });

    assert.equal(calls, 2, 'a memory sync that never got enqueued has not happened');
  });

  it('does not start a second handler while the first is still running', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = at(90);

    let running = 0;
    let overlapped = false;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const onExceed = async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await gate;
      running -= 1;
      return true;
    };

    const first = monitor.checkThreshold({ onExceed });
    const second = monitor.checkThreshold({ onExceed });
    release();
    await Promise.all([first, second]);

    assert.equal(overlapped, false,
      'the cooldown is now armed after the await, so an in-flight guard is what ' +
      'keeps a slow handoff from being enqueued twice');
  });
});

describe('ContextMonitorBase — an unreadable number is not "plenty of room"', () => {
  for (const [label, reading] of [
    ['NaN used', { used: NaN, ceiling: 200_000 }],
    ['string used', { used: 'lots', ceiling: 200_000 }],
    ['negative used', { used: -5, ceiling: 200_000 }],
    ['zero ceiling', { used: 150_000, ceiling: 0 }],
    ['negative ceiling', { used: 150_000, ceiling: -1 }],
    ['NaN ceiling', { used: 150_000, ceiling: NaN }],
    ['missing ceiling', { used: 150_000 }],
  ]) {
    it(`treats ${label} as no reading at all, not as a ratio`, async () => {
      const { monitor, usage } = makeMonitor();
      usage.next = reading;

      let calls = 0;
      await monitor.checkThreshold({ onExceed: async () => { calls += 1; } });

      assert.equal(calls, 0, 'must not act on a reading it cannot trust');
      assert.equal(await monitor.check(), null, 'check() must say "no data", not hand back NaN');
    });
  }

  it('still reports a real reading', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = { used: 50_000, ceiling: 200_000 };
    assert.deepEqual(await monitor.check(), { used: 50_000, ceiling: 200_000, ratio: 0.25 });
  });
});

describe('ContextMonitorBase — going blind has to be visible', () => {
  it('says so after ten consecutive unreadable checks, not before', async () => {
    const { monitor, lines, usage } = makeMonitor();
    usage.next = null;

    for (let i = 0; i < 9; i++) await monitor.checkThreshold({});
    assert.deepEqual(lines, [], 'a few empty reads are normal — an idle box has no session');

    await monitor.checkThreshold({});
    assert.equal(lines.length, 1, 'ten in a row (five minutes) is worth one line');
    assert.match(lines[0], /unavailable for 10 consecutive checks/);
  });

  it('backs off instead of repeating every five minutes forever', async () => {
    const { monitor, lines, usage } = makeMonitor();
    usage.next = null;

    for (let i = 0; i < 40; i++) await monitor.checkThreshold({});

    assert.equal(lines.length, 2, 'reported at 10 and again at 40, not forty times');
    assert.match(lines[1], /unavailable for 40 consecutive checks/);
  });

  it('carries the reason, so the log says which way it went blind', async () => {
    const { monitor, lines, usage } = makeMonitor();
    usage.next = { used: 10, ceiling: 0 };

    for (let i = 0; i < 10; i++) await monitor.checkThreshold({});
    assert.match(lines[0], /ceiling/, 'a bad ceiling and an absent session are different faults');
  });

  it('reports a getUsage() that throws instead of swallowing it', async () => {
    const { monitor, lines, usage } = makeMonitor();
    usage.throws = new Error('sqlite3 missing');

    for (let i = 0; i < 10; i++) await monitor.checkThreshold({});
    assert.ok(lines.some((l) => l.includes('sqlite3 missing')));
  });

  it('says when the reading comes back', async () => {
    const { monitor, lines, usage } = makeMonitor();
    usage.next = null;
    for (let i = 0; i < 10; i++) await monitor.checkThreshold({});

    usage.next = at(10);
    await monitor.checkThreshold({});

    assert.equal(lines.length, 2);
    assert.match(lines[1], /readable again/);
  });

  it('does not announce a recovery that nobody was told about', async () => {
    const { monitor, lines, usage } = makeMonitor();
    usage.next = null;
    for (let i = 0; i < 3; i++) await monitor.checkThreshold({});

    usage.next = at(10);
    await monitor.checkThreshold({});

    assert.deepEqual(lines, [], 'three empty reads then a good one is an ordinary startup');
  });

  it('starts counting again from zero after a good reading', async () => {
    const { monitor, lines, usage } = makeMonitor();

    for (let i = 0; i < 9; i++) { usage.next = null; await monitor.checkThreshold({}); }
    usage.next = at(10);
    await monitor.checkThreshold({});
    for (let i = 0; i < 9; i++) { usage.next = null; await monitor.checkThreshold({}); }

    assert.deepEqual(lines, [], 'nine, a good one, nine again — never ten in a row');
  });
});

describe('ContextMonitorBase — polling does not eat its own errors', () => {
  it('logs instead of discarding a rejected check', async () => {
    const { monitor, lines } = makeMonitor();
    monitor.checkThreshold = async () => { throw new Error('boom'); };

    monitor.startPolling({ intervalMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    monitor.stopPolling();

    assert.ok(lines.some((l) => l.includes('boom')),
      'startPolling used to end in .catch(() => {}) — an exception there was ' +
      'the monitor dying quietly');
  });

  it('stopPolling stops it', async () => {
    const { monitor, usage } = makeMonitor();
    monitor.startPolling({ intervalMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    monitor.stopPolling();
    const seen = usage.calls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(usage.calls, seen);
  });

  it('startPolling twice does not double the poll rate', () => {
    const { monitor } = makeMonitor();
    monitor.startPolling({ intervalMs: 10_000 });
    const first = monitor._intervalId;
    monitor.startPolling({ intervalMs: 10_000 });
    assert.equal(monitor._intervalId, first);
    monitor.stopPolling();
  });
});

describe('ContextMonitorBase — thresholds', () => {
  it('derives the early threshold from the switch threshold', () => {
    const monitor = new ContextMonitorBase({ threshold: 0.75 });
    assert.ok(Math.abs(monitor.earlyThreshold - 0.6) < 1e-9);
  });

  it('prefers the session switch when both thresholds are crossed', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = at(90);

    let exceeded = 0;
    let early = 0;
    await monitor.checkThreshold({
      onExceed: async () => { exceeded += 1; },
      onEarlyThreshold: async () => { early += 1; },
    });

    assert.equal(exceeded, 1);
    assert.equal(early, 0, 'no point asking for a memory sync while handing the session over');
  });

  it('leaves both alone below the early threshold', async () => {
    const { monitor, usage } = makeMonitor();
    usage.next = at(59);

    let fired = 0;
    await monitor.checkThreshold({
      onExceed: async () => { fired += 1; },
      onEarlyThreshold: async () => { fired += 1; },
    });
    assert.equal(fired, 0);
  });

  it('getUsage() is abstract', async () => {
    await assert.rejects(
      () => new ContextMonitorBase().getUsage(),
      /must be implemented by subclass/
    );
  });
});
