#!/usr/bin/env node
/**
 * Capability health probe for runtime.monitor.
 *
 * Run by `yos doctor`: exit 0 means usable, anything else means degraded.
 *
 * The monitor's job is to notice when the agent has stopped and restart it,
 * and it decides that from the status file. A status file that cannot be
 * parsed is the failure worth catching: comm-bridge reads the same file and
 * fails open on it, so a malformed one degrades liveness detection without
 * anything visibly breaking.
 *
 * A missing status file is a PASS. The monitor writes it on first tick, so on
 * a machine that has only just been installed its absence says nothing.
 * Restarting the monitor is not this probe's business either — reporting the
 * fault is, and fixing it is doctor's.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const YOS_DIR = process.env.YOS_DIR || path.join(os.homedir(), 'yos');
const STATUS_FILE = path.join(YOS_DIR, 'activity-monitor', 'agent-status.json');

if (!fs.existsSync(STATUS_FILE)) process.exit(0);

try {
  const parsed = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('status file is not a JSON object');
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`monitor status unreadable at ${STATUS_FILE}: ${error?.message ?? error}\n`);
  process.exit(1);
}
