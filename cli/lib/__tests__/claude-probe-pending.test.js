import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClaudeProbe } from '../heartbeat/claude-probe.js';

/**
 * The Claude probe carried its own copy of the pending-state reader and so
 * carried the same defect as the Codex one: a bare JSON.parse that rejected
 * unparseable bytes but waved through every parseable shape.
 *
 * HealthEngine treats any truthy read as a real in-flight heartbeat, ages it by
 * `created_at`, and asks C4 about `control_id`. A record missing either field
 * produces an instant `stale_pending` verdict — a restart of an agent nobody
 * had asked anything.
 *
 * Both probes now share cli/lib/heartbeat/pending-state.js. These tests are the
 * half of the guard that keeps the Claude side from drifting back; the Codex
 * half lives in codex-probe-pending.test.js. Deleting the shared validation
 * turns both files red.
 */

let dir;
let pendingFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-probe-'));
  pendingFile = path.join(dir, 'claude-heartbeat-pending.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const probe = () => createClaudeProbe({ pendingFile });

function writeRaw(text) {
  fs.writeFileSync(pendingFile, text);
}

describe('createClaudeProbe().readHeartbeatPending', () => {
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

  it('rejects an empty object rather than reporting a heartbeat nobody sent', () => {
    writeRaw('{}');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a JSON array', () => {
    writeRaw('[]');
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a record whose control_id is not a number', () => {
    writeRaw(JSON.stringify({ control_id: 'abc', created_at: 1_700_000_000 }));
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('rejects a record with no created_at', () => {
    writeRaw(JSON.stringify({ control_id: 42, phase: 'recovery' }));
    assert.equal(probe().readHeartbeatPending(), null);
  });

  it('clearHeartbeatPending removes the file and stays quiet when already gone', () => {
    writeRaw(JSON.stringify({ control_id: 1, created_at: 2 }));
    const p = probe();
    p.clearHeartbeatPending();
    assert.equal(fs.existsSync(pendingFile), false);
    assert.doesNotThrow(() => p.clearHeartbeatPending());
  });
});
