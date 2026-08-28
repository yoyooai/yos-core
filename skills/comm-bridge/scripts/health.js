#!/usr/bin/env node
/**
 * Capability health probe for communication.message.
 *
 * Run by `yos doctor` (see cli/commands/doctor.js): exit 0 means the
 * capability is usable on this machine, any other exit means degraded.
 *
 * Deliberately narrow. It does NOT send a message — a probe that exercised
 * the real path would spam whoever is on the other end every time someone
 * ran doctor. It checks the one thing that fails silently: the message store
 * exists but cannot be read, which turns every later send into a mystery.
 *
 * A missing database is a PASS. On a machine that has not received a message
 * yet there is nothing to open, and reporting that as a fault would put a red
 * line on a healthy factory install — the exact failure this area exists to
 * prevent.
 */

import fs from 'node:fs';

import { DB_PATH } from './c4-config.js';

if (!fs.existsSync(DB_PATH)) process.exit(0);

try {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    // Reads the schema, so a corrupt header or truncated file fails here.
    db.prepare('select count(*) as n from sqlite_master').get();
  } finally {
    db.close();
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`message store unreadable at ${DB_PATH}: ${error?.message ?? error}\n`);
  process.exit(1);
}
