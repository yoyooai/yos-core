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
