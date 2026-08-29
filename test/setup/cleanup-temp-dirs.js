/**
 * Installs the teardown that makes test/helpers/temp-dir.js self-cleaning.
 *
 * Wired in through jest.config.js `setupFilesAfterEnv`, so it runs once per test
 * file after the test framework is installed — which is what lets it call
 * `afterAll`. A test file gets this for free: it imports `makeTempDir`, and the
 * directories go away when it finishes without the author writing a teardown.
 *
 * This is the safety net, not the rule. It can only remove what went through
 * `makeTempDir`, so a test file that calls `fs.mkdtempSync` directly still
 * leaks — that is the case `verifyTempDirPolicy` in scripts/test-policy.js
 * turns red.
 */

import { afterAll } from '@jest/globals';

import { cleanupTempDirs } from '../helpers/temp-dir.js';

afterAll(() => {
  cleanupTempDirs();
});
