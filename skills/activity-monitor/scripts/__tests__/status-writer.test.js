import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildStatusPayload,
  publicHealth,
  readInitialStatus,
  writeStatus
} from '../status-writer.js';

function tempStatusFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yos-status-writer-')), 'agent-status.json');
}

describe('status-writer', () => {
  it('fails open to ok health when status file is missing or invalid', () => {
    const missingFile = tempStatusFile();
    assert.deepEqual(readInitialStatus({ statusFile: missingFile }), { health: 'ok' });

    fs.writeFileSync(missingFile, '{bad json');
    assert.deepEqual(readInitialStatus({ statusFile: missingFile }), { health: 'ok' });
  });

  it('reads existing health from status file', () => {
    const statusFile = tempStatusFile();
    fs.writeFileSync(statusFile, JSON.stringify({ health: 'recovering', reason: 'test' }));

    assert.deepEqual(readInitialStatus({ statusFile }), {
      health: 'recovering',
      reason: 'test',
    });
  });

  it('adds rate-limit and unavailable reason metadata', () => {
    const payload = buildStatusPayload({
      statusObj: { state: 'busy' },
      healthEngine: {
        health: 'rate_limited',
        rateLimitResetTime: '12:30',
        cooldownUntil: 1234,
        healthReason: 'rate_limit_detected',
      },
    });

    assert.deepEqual(payload, {
      state: 'busy',
      rate_limit_reset: '12:30',
      cooldown_until: 1234,
      unavailable_reason: 'rate_limit_detected',
      health: 'rate_limited',
    });
  });

  it('writes persistent self-heal telemetry into every status snapshot', () => {
    const payload = buildStatusPayload({
      statusObj: { state: 'offline' },
      healthEngine: {
        health: 'unavailable',
        healthReason: 'recovery_timeout',
        selfHealCount: 4,
        selfHealLastAt: 1234,
        selfHealLastReason: 'recovery_timeout',
        selfHealLastCleanup: { observed: 2, graceful: 1, forced: 1, remaining: 0 },
        selfHealRecentEvents: [1200, 1234],
        selfHealRecentCount: 2,
        selfHealAttentionRequired: true,
        selfHealAttentionSince: 1200,
      },
    });

    assert.deepEqual(payload, {
      state: 'offline',
      unavailable_reason: 'recovery_timeout',
      self_heal_count: 4,
      self_heal_last_at: 1234,
      self_heal_last_reason: 'recovery_timeout',
      self_heal_last_cleanup: { observed: 2, graceful: 1, forced: 1, remaining: 0 },
      self_heal_recent_events: [1200, 1234],
      self_heal_recent_count: 2,
      self_heal_attention_required: true,
      self_heal_attention_since: 1200,
      health: 'unavailable',
    });
  });

  it('normalizes legacy internal health states before writing public status', () => {
    assert.equal(publicHealth('recovering'), 'unavailable');
    assert.equal(publicHealth('down'), 'unavailable');
    assert.equal(publicHealth('unavailable'), 'unavailable');

    const payload = buildStatusPayload({
      statusObj: { state: 'busy' },
      healthEngine: {
        health: 'recovering',
        healthReason: 'heartbeat_timeout',
        unavailableSince: 1234,
      },
    });

    assert.deepEqual(payload, {
      state: 'busy',
      unavailable_reason: 'heartbeat_timeout',
      unavailable_since: 1234,
      health: 'unavailable',
    });
  });

  it('writes status atomically to the target file', () => {
    const statusFile = tempStatusFile();
    const ok = writeStatus({
      statusFile,
      statusObj: { state: 'idle' },
      healthEngine: { health: 'ok', healthReason: null },
    });

    assert.equal(ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(statusFile, 'utf8')), {
      state: 'idle',
      health: 'ok',
    });
  });
});
