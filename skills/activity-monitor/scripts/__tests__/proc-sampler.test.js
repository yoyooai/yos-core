import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProcSampler, readProcState } from '../proc-sampler.js';

/**
 * These tests exist because ProcSampler decides whether the agent is alive or
 * frozen, and the guardian acts on that answer: a wrong "frozen" restarts a
 * healthy agent, a wrong "alive" leaves a stuck one stuck. Until 2026-08-27 it
 * had no tests at all — the three cases below are the misjudgements that were
 * reachable in production.
 */

// tick() gates on (now - lastSampleAt) >= sampleInterval and lastSampleAt starts
// at 0, so tests must use realistic epoch seconds like the monitor loop does.
const T0 = 1_700_000_000;

/** A sampler wired to fake context-switch readings, no /proc and no tmux. */
function makeSampler({ readings, pid = 4242, ...opts } = {}) {
  const queue = Array.isArray(readings) ? [...readings] : [];
  const writes = [];
  const sampler = new ProcSampler({
    log: () => {},
    platform: 'linux',
    stateFile: '/dev/null/never-written',
    findPid: () => (typeof pid === 'function' ? pid() : pid),
    sampleCtxSwitches: () => (queue.length ? queue.shift() : null),
    writeState: (state) => writes.push(state),
    ...opts
  });
  return { sampler, writes };
}

describe('ProcSampler frozen accounting', () => {
  it('counts the real elapsed time between samples, not the nominal interval', () => {
    // The monitor loop is exactly what slows down when the box is in trouble,
    // so samples can arrive far later than sampleInterval. Charging a fixed
    // 10s per sample understates how long the agent has been wedged and
    // delays the rescue (a "should have saved it, didn't" failure).
    const { sampler } = makeSampler({
      readings: [1000, 1000, 1000],
      sampleInterval: 10,
      frozenThreshold: 60
    });

    sampler.tick(T0, { isActive: true });    // baseline
    sampler.tick(T0 + 100, { isActive: true });  // 100s later, no context switches
    assert.equal(sampler.getState().frozenCount, 100);
    assert.equal(sampler.isFrozen(), true);
    assert.equal(sampler.isAlive(), false);
  });

  it('still declares frozen at the threshold when samples arrive on time', () => {
    const { sampler } = makeSampler({
      readings: [500, 500, 500, 500, 500, 500, 500, 500],
      sampleInterval: 10,
      frozenThreshold: 60
    });

    sampler.tick(T0, { isActive: true }); // baseline
    for (let t = 10; t <= 50; t += 10) sampler.tick(T0 + t, { isActive: true });
    assert.equal(sampler.isFrozen(), false, 'must not fire before the threshold');

    sampler.tick(T0 + 60, { isActive: true });
    assert.equal(sampler.isFrozen(), true, 'must fire once the threshold is reached');
  });

  it('treats a backwards counter as a lost baseline, not as being frozen', () => {
    // Context-switch counters only ever climb for a given process. A smaller
    // reading means we are no longer looking at the same process (PID reuse,
    // a re-exec, a bad read) — the honest answer is "unknown", not "frozen".
    // Counting it toward frozen restarts a perfectly healthy agent.
    const { sampler } = makeSampler({
      readings: [10_000, 500, 900],
      sampleInterval: 10,
      frozenThreshold: 20
    });

    sampler.tick(T0, { isActive: true });   // baseline 10000
    sampler.tick(T0 + 10, { isActive: true });  // 500 — went backwards
    assert.equal(sampler.getState().frozenCount, 0, 'must not accumulate on a lost baseline');
    assert.equal(sampler.isFrozen(), false);
    assert.equal(sampler.isAlive(), null, 'unknown, not a verdict');

    // The new baseline must be the smaller reading, so real progress is seen.
    sampler.tick(T0 + 20, { isActive: true });  // 900 — progress from 500
    assert.equal(sampler.isAlive(), true);
    assert.equal(sampler.getState().frozenCount, 0);
  });

  it('does not accumulate while the agent is idle', () => {
    const { sampler } = makeSampler({
      readings: [7, 7, 7],
      sampleInterval: 10,
      frozenThreshold: 20
    });
    sampler.tick(T0, { isActive: false });
    sampler.tick(T0 + 100, { isActive: false });
    assert.equal(sampler.isFrozen(), false);
    assert.equal(sampler.isAlive(), true);
  });

  it('resets the verdict when the runtime process is replaced', () => {
    let pid = 1;
    const { sampler } = makeSampler({
      readings: [100, 100, 100, 50],
      sampleInterval: 10,
      frozenThreshold: 20,
      pid: () => pid
    });
    sampler.tick(T0, { isActive: true });
    sampler.tick(T0 + 30, { isActive: true });
    assert.equal(sampler.isFrozen(), true);

    pid = 2; // restarted underneath us
    sampler.tick(T0 + 40, { isActive: true });
    assert.equal(sampler.getState().frozenCount, 0, 'a new process starts clean');
    assert.equal(sampler.isFrozen(), false);
  });

  it('reports unknown rather than a verdict when the process cannot be found', () => {
    const { sampler } = makeSampler({
      readings: [1, 1],
      sampleInterval: 10,
      frozenThreshold: 20,
      pid: () => null
    });
    sampler.tick(T0, { isActive: true });
    assert.equal(sampler.isAlive(), null);
    assert.equal(sampler.isFrozen(), false);
  });
});

describe('proc-state freshness', () => {
  it('keeps state readable when the sampling interval is longer than 30s', () => {
    // The staleness cutoff used to be a hardcoded 30s while the interval is
    // configurable. Any interval above 30s made every read look stale, so the
    // dispatcher silently lost all liveness information.
    const now = Math.floor(Date.now() / 1000);
    const state = { pid: 9, alive: true, frozen: false, sampleInterval: 60, lastSampleAt: now - 45 };
    const read = readProcState({
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify(state)
      }
    });
    assert.ok(read, 'a 45s-old sample must still count as fresh on a 60s interval');
    assert.equal(read.pid, 9);
  });

  it('still discards genuinely stale state', () => {
    const now = Math.floor(Date.now() / 1000);
    const state = { pid: 9, alive: true, sampleInterval: 10, lastSampleAt: now - 400 };
    const read = readProcState({
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify(state)
      }
    });
    assert.equal(read, null);
  });

  it('falls back to the default cutoff when the file carries no interval', () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = readProcState({
      fsImpl: { existsSync: () => true, readFileSync: () => JSON.stringify({ pid: 1, lastSampleAt: now - 5 }) }
    });
    assert.ok(fresh);
    const stale = readProcState({
      fsImpl: { existsSync: () => true, readFileSync: () => JSON.stringify({ pid: 1, lastSampleAt: now - 90 }) }
    });
    assert.equal(stale, null);
  });

  it('records the sampling interval so readers can judge freshness', () => {
    const { sampler, writes } = makeSampler({ readings: [5, 9], sampleInterval: 25, frozenThreshold: 50 });
    sampler.tick(T0, { isActive: true });
    assert.ok(writes.length > 0, 'state must be written on every sample');
    assert.equal(writes[writes.length - 1].sampleInterval, 25);
  });
});
