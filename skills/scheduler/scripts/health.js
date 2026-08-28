#!/usr/bin/env node
/**
 * Capability health probe for task.schedule.
 *
 * Run by `yos doctor`: exit 0 means usable, anything else means degraded.
 *
 * It does not create, run, or cancel a task — a probe with side effects would
 * be worse than no probe. It opens the task store read-only, because a
 * scheduler whose database has gone bad keeps accepting work and silently
 * drops it.
 *
 * A missing database is a PASS: no task has ever been scheduled on this
 * machine, which is not a fault.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Resolved the same way scripts/database.js resolves it; keep the two in step.
const YOS_DIR = process.env.YOS_DIR || path.join(os.homedir(), 'yos');
const DB_PATH = path.join(YOS_DIR, 'scheduler', 'scheduler.db');

if (!fs.existsSync(DB_PATH)) process.exit(0);

// The driver is loaded on its own, because failing to load it says nothing
// about the store. Folding it into the same try reported a perfectly readable
// database as unreadable — a false alarm that also named the wrong cause, and
// so sent whoever read it to look at the wrong thing.
let Database;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (error) {
  process.stderr.write(
    `sqlite driver unavailable to this probe (${import.meta.dirname}): `
    + `${error?.message ?? error}\n`
    + `the store at ${DB_PATH} was not examined\n`,
  );
  process.exit(1);
}

try {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    db.prepare('select count(*) as n from sqlite_master').get();
  } finally {
    db.close();
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`task store unreadable at ${DB_PATH}: ${error?.message ?? error}\n`);
  process.exit(1);
}
