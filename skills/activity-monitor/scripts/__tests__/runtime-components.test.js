import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHealthEngine } from '../adapters/runtime-components.js';

describe('runtime component wiring', () => {
  it('restores persisted self-heal telemetry into HealthEngine', () => {
    const initialStatus = {
      health: 'degraded',
      unavailable_reason: 'recovery_timeout',
      self_heal_count: 7,
      self_heal_last_at: 29_000,
      self_heal_last_reason: 'recovery_timeout',
      self_heal_last_cleanup: {
        observed: 2,
        graceful: 2,
        forced: 0,
        remaining: 0,
      },
      self_heal_recent_events: [],
      self_heal_attention_required: true,
      self_heal_attention_since: 28_000,
    };
    const activeAdapter = {
      getHeartbeatDeps: () => ({}),
      stop: () => ({ observed: 0, graceful: 0, forced: 0, remaining: 0 }),
      checkAuth: () => ({ status: 'success', reason: 'test' }),
    };

    const engine = createHealthEngine(activeAdapter, initialStatus, {
      log: () => {},
      rateLimitDefaultCooldown: 60,
      userMessageRecoveryCooldown: 60,
    });

    assert.equal(engine.selfHealCount, 7);
    assert.equal(engine.selfHealLastAt, 29_000);
    assert.equal(engine.selfHealLastReason, 'recovery_timeout');
    assert.deepEqual(engine.selfHealLastCleanup, initialStatus.self_heal_last_cleanup);
    assert.equal(engine.selfHealAttentionRequired, true);
    assert.equal(engine.selfHealAttentionSince, 28_000);
  });
});
