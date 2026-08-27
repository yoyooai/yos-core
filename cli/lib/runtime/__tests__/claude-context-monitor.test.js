import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeContextMonitor } from '../claude-context-monitor.js';
import { ClaudeAdapter } from '../claude.js';

/**
 * Why this file exists.
 *
 * Two separate things can decide to rotate a Claude session: the statusLine
 * hook (skills/activity-monitor/scripts/context-monitor.js, which reacts after
 * every turn) and this polling monitor. Exactly one of them may be armed —
 * both would race to hand the same session over. ClaudeAdapter settles it by
 * returning null, and the last test here is what keeps that from being
 * "fixed" by someone who sees an unused class and wires it up.
 *
 * The reading tests cover the other half: a statusline.json that is missing,
 * truncated mid-write, or carrying a percentage that is not a number must come
 * back as "no reading". A NaN would flow into the base class as a NaN ratio,
 * which compares false against every threshold — a decision never to rotate,
 * made silently.
 */

let dir;
let statuslineFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ctx-'));
  statuslineFile = path.join(dir, 'statusline.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const monitor = () => new ClaudeContextMonitor({ statuslineFile });

function writeStatus(status) {
  fs.writeFileSync(statuslineFile, typeof status === 'string' ? status : JSON.stringify(status));
}

describe('ClaudeContextMonitor — reading statusline.json', () => {
  it('converts the reported percentage into a token count', async () => {
    writeStatus({ context_window: { used_percentage: 68, context_window_size: 200_000 } });
    assert.deepEqual(await monitor().getUsage(), { used: 136_000, ceiling: 200_000 });
  });

  it('handles a fresh session at zero', async () => {
    writeStatus({ context_window: { used_percentage: 0, context_window_size: 200_000 } });
    assert.deepEqual(await monitor().getUsage(), { used: 0, ceiling: 200_000 });
  });

  it('rounds rather than emitting a fractional token', async () => {
    writeStatus({ context_window: { used_percentage: 33.3, context_window_size: 200_000 } });
    assert.deepEqual(await monitor().getUsage(), { used: 66_600, ceiling: 200_000 });
  });

  it('returns null when the file is absent', async () => {
    assert.equal(await monitor().getUsage(), null);
  });

  it('returns null when the file is half written', async () => {
    writeStatus('{"context_window":{"used_perce');
    assert.equal(await monitor().getUsage(), null);
  });

  it('returns null when there is no context_window block', async () => {
    writeStatus({ session_id: 'abc', cost: { total_cost_usd: 1.5 } });
    assert.equal(await monitor().getUsage(), null);
  });

  for (const [label, cw] of [
    ['percentage missing', { context_window_size: 200_000 }],
    ['percentage null', { used_percentage: null, context_window_size: 200_000 }],
    ['percentage a string', { used_percentage: '68', context_window_size: 200_000 }],
    ['percentage above 100', { used_percentage: 150, context_window_size: 200_000 }],
    ['percentage negative', { used_percentage: -1, context_window_size: 200_000 }],
    ['ceiling missing', { used_percentage: 68 }],
    ['ceiling zero', { used_percentage: 68, context_window_size: 0 }],
    ['ceiling a string', { used_percentage: 68, context_window_size: '200000' }],
  ]) {
    it(`returns null when the ${label}`, async () => {
      writeStatus({ context_window: cw });
      assert.equal(
        await monitor().getUsage(), null,
        'an unusable field must read as no data, never as a low ratio'
      );
    });
  }

  it('never hands the base class a NaN ratio', async () => {
    writeStatus({ context_window: { used_percentage: 'lots', context_window_size: 200_000 } });
    assert.equal(await monitor().check(), null);
  });

  it('a full window is reported as full', async () => {
    writeStatus({ context_window: { used_percentage: 100, context_window_size: 200_000 } });
    assert.deepEqual(await monitor().check(), { used: 200_000, ceiling: 200_000, ratio: 1 });
  });
});

describe('ClaudeContextMonitor — exactly one rotation mechanism on Claude', () => {
  it('the Claude runtime does not hand out a polling monitor', () => {
    assert.equal(
      new ClaudeAdapter().getContextMonitor(), null,
      'the statusLine hook already enqueues the handoff after every turn; arming ' +
      'this monitor as well puts two mechanisms on the same session'
    );
  });

  it('startContextMonitor therefore starts nothing for Claude', async () => {
    const { startContextMonitor } = await import(
      '../../../../skills/activity-monitor/scripts/adapters/runtime-components.js'
    );
    const started = startContextMonitor(new ClaudeAdapter(), { log: () => {} });
    // Stop first, assert second: if this ever does return a monitor it has a
    // live 30s interval holding the event loop open, and the test would hang
    // instead of failing.
    started?.stopPolling?.();
    assert.equal(started, null);
  });

  it('claude.js does not import the class it deliberately does not use', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../claude.js', import.meta.url)), 'utf8'
    );
    assert.equal(
      source.includes('ClaudeContextMonitor'), false,
      'an unused import is what makes dead wiring look live'
    );
  });
});
