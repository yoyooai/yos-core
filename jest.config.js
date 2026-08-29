export default {
  transform: {},
  // Jest covers the legacy suite under test/. npm test also runs a small
  // targeted node:test set for the Codex runtime follow-up fixes.
  testMatch: ['<rootDir>/test/**/*.test.js'],
  // Removes the temp directories handed out by test/helpers/temp-dir.js when
  // each test file finishes. Without it the suite left 6.2G in /tmp; see the
  // header of that helper.
  setupFilesAfterEnv: ['<rootDir>/test/setup/cleanup-temp-dirs.js'],
};
