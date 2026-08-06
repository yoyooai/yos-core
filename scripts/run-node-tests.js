#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatFailureReport, summarizeTapFailures } from './node-test-failure-report.js';

const ROOT = process.cwd();
const REPORTER_ARGS = process.argv.slice(2);
if (REPORTER_ARGS.some((arg) => arg !== '--test-reporter=tap')) {
  console.error('Unsupported test-runner argument.');
  process.exit(1);
}
const TEST_ROOTS = [
  path.join(ROOT, 'cli', 'lib', '__tests__'),
  path.join(ROOT, 'cli', 'lib', 'runtime', '__tests__'),
  path.join(ROOT, 'skills', 'activity-monitor', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'comm-bridge', 'scripts', '__tests__'),
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isNodeTest(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel.startsWith('cli/lib/__tests__/')) return true;
  if (rel.startsWith('cli/lib/runtime/__tests__/')) return true;
  if (rel.startsWith('skills/activity-monitor/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/comm-bridge/scripts/__tests__/')) return true;
  return false;
}

// A red run must leave behind enough to say WHICH test failed. Without this the
// full-suite TAP (tens of thousands of lines) scrolls away and a one-in-many
// failure becomes unidentifiable — see scripts/node-test-failure-report.js.
const LOG_DIR = path.join(ROOT, '.test-logs');
const LATEST_LOG = path.join(LOG_DIR, 'node-tests-latest.log');

function openFailureEvidence() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LATEST_LOG, '');
    return { logPath: LATEST_LOG };
  } catch {
    // Never let bookkeeping stop the tests from running.
    return { logPath: null };
  }
}

function reporterArgsFor(evidence) {
  if (!evidence.logPath) return REPORTER_ARGS;
  // Mirror node's own default (spec on a TTY, tap otherwise) so piping this
  // command keeps producing exactly what it produced before.
  const primary = REPORTER_ARGS.length > 0 || !process.stdout.isTTY ? 'tap' : 'spec';
  return [
    `--test-reporter=${primary}`,
    '--test-reporter-destination=stdout',
    '--test-reporter=tap',
    `--test-reporter-destination=${evidence.logPath}`,
  ];
}

function reportFailures(evidence) {
  if (!evidence.logPath) return;
  let tapText;
  try {
    tapText = fs.readFileSync(evidence.logPath, 'utf8');
  } catch {
    return;
  }

  let keptPath = evidence.logPath;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    keptPath = path.join(LOG_DIR, `node-tests-failed-${stamp}.log`);
    fs.copyFileSync(evidence.logPath, keptPath);
  } catch {
    keptPath = evidence.logPath;
  }

  // stderr, not stdout: callers parse stdout as TAP.
  console.error(formatFailureReport(summarizeTapFailures(tapText), {
    logPath: path.relative(ROOT, keptPath),
    root: ROOT,
  }));
}

const testFiles = TEST_ROOTS
  .flatMap((dir) => walk(dir))
  .filter(isNodeTest)
  .sort()
  .map((file) => path.relative(ROOT, file));

if (testFiles.length === 0) {
  console.error('No Node test files found.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} Node test files`);
const evidence = openFailureEvidence();
const result = spawnSync(process.execPath, [
  '--experimental-test-module-mocks',
  '--test',
  ...reporterArgsFor(evidence),
  ...testFiles,
], {
  stdio: 'inherit',
});

const status = result.status ?? 1;
if (status !== 0) reportFailures(evidence);
process.exit(status);
