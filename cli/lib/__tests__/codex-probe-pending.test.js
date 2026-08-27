import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodexProbe } from '../heartbeat/codex-probe.js';

/**
 * These tests exist because readHeartbeatPending() is the only thing standing
 * between a corrupt state file and a needless restart of a healthy agent.
 *
 * HealthEngine consumes it like this (health-engine.js, the pending branch):
 *
 *     const pending = this.deps.readHeartbeatPending();
 *     if (pending) {
 *       const status = this.deps.getHeartbeatStatus(pending.control_id);
 *       const pendingAge = currentTime - (pending.created_at || 0);
 *       if (pendingAge >= 600 && status !== 'done') {
 *         this.onHeartbeatFailure(pending, 'stale_pending');   // ← kills the session
 *       }
 *     }
 *
 * So any truthy return value is taken as a real in-flight heartbeat. A record
 * with no usable `created_at` makes `pendingAge` equal the whole Unix epoch,
 * which is instantly >= 600, and a record with no usable `control_id` asks C4
 * about `undefined` and can never come back 'done'. The two combine into an
 * immediate, unconditional "stale_pending" restart of an agent that was never
 * asked anything.
 *
 * Until 2026-08-27 the function was a bare JSON.parse in a try/catch: it
 * rejected unparseable bytes but waved through every parseable shape. The cases
 * below are the shapes that reach production — a truncated or half-written
 * file, a file left by an older format, or a hand-edited one.
 */

let dir;
let pendingFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-'));
  pendingFile = path.join(dir, 'codex-heartbeat-pending.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const probe = () => createCodexProbe({ pendingFile });

/** Write raw bytes as the pending file, bypassing the probe's own writer. */
function writeRaw(text) {
  fs.writeFileSync(pendingFile, text);
}

describe('createCodexProbe().readHeartbeatPending', () => {
  it('returns null when the file does not exist', () => {
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('returns null when the file is not valid JSON', () => {
    writeRaw('{"control_id": 42,');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('returns a well-formed record unchanged', () => {
    const record = { control_id: 42, phase: 'recovery', created_at: 1_700_000_000 };
    writeRaw(JSON.stringify(record));
    assert.deepEqual(probe().readHeartbeatPending(), record);
  });

  // ── The misjudgements: parseable, but not a usable heartbeat record ────────

  it('rejects an empty object rather than reporting a heartbeat nobody sent', () => {
    // Reachable as a truncated/half-written file. Truthy today, so the engine
    // reads control_id=undefined and created_at=0 and restarts immediately.
    writeRaw('{}');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a JSON array', () => {
    writeRaw('[]');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a bare JSON string', () => {
    writeRaw('"pending"');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a bare JSON number', () => {
    writeRaw('42');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects JSON null without throwing', () => {
    writeRaw('null');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a record whose control_id is not a number', () => {
    // C4 is asked about a non-numeric id, which can never answer 'done'.
    writeRaw(JSON.stringify({ control_id: 'abc', created_at: 1_700_000_000 }));
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a record with no created_at', () => {
    // `pendingAge` would become the entire Unix epoch: an instant restart.
    writeRaw(JSON.stringify({ control_id: 42, phase: 'recovery' }));
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a record whose created_at is not a finite number', () => {
    writeRaw(JSON.stringify({ control_id: 42, created_at: 'yesterday' }));
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('round-trips what enqueueHeartbeat actually writes', () => {
    // Guards the reader against drifting away from the writer's shape.
    const written = { control_id: 7, phase: 'post_restart', created_at: 1_700_000_123 };
    writeRaw(JSON.stringify(written, null, 2));
    const read = probe().readHeartbeatPending();
    assert.equal(read.control_id, 7);
    assert.equal(read.phase, 'post_restart');
    assert.equal(read.created_at, 1_700_000_123);
  });

  it('clearHeartbeatPending removes the file and stays quiet when already gone', () => {
    writeRaw(JSON.stringify({ control_id: 1, created_at: 2 }));
    const p = probe();
    p.clearHeartbeatPending();
    assert.equal(fs.existsSync(pendingFile), false);
    assert.doesNotThrow(() => p.clearHeartbeatPending());
  });
});
