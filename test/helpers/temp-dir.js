/**
 * Temp directories that clean themselves up.
 *
 * On 2026-08-29 a routine disk check found the control machine's root filesystem
 * at 90% with only 6.0G free. /tmp held 19599 directories totalling 6.2G — every
 * one of them created by this test suite and never removed. Three days of
 * releases (0.1.19 through 0.1.25) had left 17000 of them behind, so the faster
 * we shipped, the faster the machine filled. Deleting them bought back 7G;
 * deleting them again next week would mean the leak was never fixed.
 *
 * The leak was not carelessness in one place. Eight test files each wrote
 * `fs.mkdtempSync(path.join(os.tmpdir(), ...))` inline and none of them had a
 * teardown, because nothing in the suite made cleanup the default. This module
 * makes it the default: every directory handed out here is recorded, and the
 * global `afterAll` installed by test/setup/cleanup-temp-dirs.js removes the
 * whole batch when the file finishes.
 *
 * The registry is per test file, not global. Jest gives each test file its own
 * module registry inside a worker, so a file only ever deletes directories it
 * created — a parallel worker's directories are invisible to it and cannot be
 * swept up by mistake.
 *
 * Reaching for `fs.mkdtempSync` directly in a test is what caused this, so
 * `verifyTempDirPolicy` in scripts/test-policy.js fails the suite if a test file
 * does it again.
 *
 * Both suites are covered, by different means. Under Jest the teardown is the
 * `afterAll` in test/setup/cleanup-temp-dirs.js, which runs as each test file
 * finishes. The node:test suites in cli/ and skills/ have no such hook, so this
 * module installs a process exit handler instead — later than afterAll, but the
 * same guarantee by the time the runner is done. The two biggest leaks found on
 * 2026-08-29 (2688 monitor-orchestrator directories, 1272 dist-integrity ones)
 * were both node:test, so covering only Jest would have fixed the smaller half.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directories created by the test file currently executing. */
const created = [];

// Jest supplies a per-file afterAll through setupFilesAfterEnv; registering an
// exit handler there too would add one listener per test file in the worker and
// trip Node's max-listeners warning for no gain.
if (process.env.JEST_WORKER_ID === undefined) {
  process.once('exit', () => {
    cleanupTempDirs();
  });
}

/**
 * Create a temp directory that will be removed when this test file finishes.
 *
 * @param {string} prefix mkdtemp prefix, e.g. 'yos-progress-'
 * @returns {string} absolute path to the new directory
 */
export function makeTempDir(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('makeTempDir needs a non-empty prefix');
  }
  if (prefix.includes('/') || prefix.includes(path.sep)) {
    throw new TypeError(`makeTempDir prefix must not contain a path separator: ${prefix}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Remove every directory handed out by makeTempDir in this test file.
 *
 * Cleanup must never be the reason a suite goes red — a directory the test
 * already moved, or one left behind by a killed child process, is not a test
 * failure. Removal errors are therefore swallowed, and the registry is cleared
 * either way so a retry does not try the same paths twice.
 *
 * @returns {string[]} the paths it attempted to remove, for assertions
 */
export function cleanupTempDirs() {
  const attempted = created.splice(0, created.length);
  for (const dir of attempted) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: see above.
    }
  }
  return attempted;
}

/** The directories still awaiting cleanup. Exported for the policy tests. */
export function pendingTempDirs() {
  return [...created];
}
