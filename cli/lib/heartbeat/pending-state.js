/**
 * pending-state.js — the on-disk record of a heartbeat that is still in flight.
 *
 * Both runtime probes (Claude, Codex) keep the same small record, and
 * HealthEngine treats any truthy read as a real in-flight heartbeat: it asks C4
 * about `control_id`, and it ages the record by `created_at`.
 *
 * That makes a half-formed record worse than no record at all. With no usable
 * `created_at`, the computed age becomes the whole Unix epoch — instantly past
 * the 600s ceiling — and with no usable `control_id`, C4 is asked about
 * `undefined` and can never answer 'done'. Together they produce an immediate
 * `stale_pending` verdict and a restart of an agent that was never asked
 * anything.
 *
 * So the contract here is deliberately narrow: a record comes back only when
 * the engine can both query it and age it. Everything else reads as "nothing in
 * flight", which costs one heartbeat interval — always cheaper than restarting
 * a healthy agent. The next enqueue overwrites the bad file, so this also
 * self-heals without deleting state a human might want to look at.
 *
 * This module exists because the two probes each carried their own copy of the
 * reader and drifted into the same defect; keeping one copy is what stops a
 * third runtime from reintroducing it.
 */

import fs from 'node:fs';

/**
 * Is this a record HealthEngine can actually act on?
 * @param {unknown} value
 * @returns {boolean}
 */
function isUsableRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  // Number.isFinite rejects strings, NaN and Infinity — all of which would
  // survive a plain `typeof === 'number'` or a truthiness check.
  if (!Number.isFinite(value.control_id)) return false;
  if (!Number.isFinite(value.created_at)) return false;
  return true;
}

/**
 * Read the pending heartbeat record.
 *
 * @param {string} file - Path to the pending-state file.
 * @returns {{ control_id: number, phase?: string, created_at: number } | null}
 *   The record, or null when there is nothing usable in flight.
 */
export function readPendingRecord(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing file, unreadable file, or bytes that are not JSON.
    return null;
  }
  return isUsableRecord(parsed) ? parsed : null;
}

/**
 * Write the pending heartbeat record atomically.
 *
 * Refuses to persist a record the reader would reject, so a bad write fails
 * loudly at the call site instead of becoming a restart later.
 *
 * @param {string} file
 * @param {{ control_id: number, phase?: string, created_at: number }} record
 * @returns {boolean} true when the record is on disk.
 */
export function writePendingRecord(file, record) {
  if (!isUsableRecord(record)) return false;
  try {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the pending heartbeat record. Already-gone is success.
 * @param {string} file
 */
export function clearPendingRecord(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}
