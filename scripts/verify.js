#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findBlockedPackageEntries,
  packageContentDigest,
} from './package-policy.js';
import { verifyTestPolicy } from './test-policy.js';
import {
  loadApprovedTestBaselines,
  verifyJestResult,
  verifyNodeTapResult,
} from './test-baseline-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Security verification must not inherit a developer's local mirror, because
// many mirrors do not implement npm's audit API.
const REGISTRY = process.env.YOS_VERIFY_NPM_REGISTRY || 'https://registry.npmjs.org';

function printable(command, args) {
  return [command, ...args].map(value => JSON.stringify(value)).join(' ');
}

function run(command, args, { cwd = ROOT, capture = false } = {}) {
  console.log(`\n[verify] ${printable(command, args)} (${path.relative(ROOT, cwd) || '.'})`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return capture ? result.stdout.trim() : '';
}

function npm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function runCaptured(command, args, { cwd = ROOT } = {}) {
  console.log(`\n[verify] ${printable(command, args)} (${path.relative(ROOT, cwd) || '.'})`);
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function npmCaptured(args, options = {}) {
  if (process.env.npm_execpath) {
    return runCaptured(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return runCaptured(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function gitStatus(root = ROOT) {
  return run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    capture: true,
  });
}

function findLockRoots(dir, roots = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findLockRoots(fullPath, roots);
    } else if (entry.isFile() && entry.name === 'package-lock.json') {
      roots.push(path.dirname(fullPath));
    }
  }
  return roots;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyVersions(root = ROOT) {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const fileVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  if (packageVersion !== fileVersion) {
    throw new Error(`version mismatch: package.json=${packageVersion}, VERSION=${fileVersion}`);
  }
  console.log(`[verify] version ${packageVersion}`);
}

function verifyAudits(root = ROOT) {
  const lockRoots = findLockRoots(root).sort();
  for (const lockRoot of lockRoots) {
    npm(['audit', '--audit-level=low', `--registry=${REGISTRY}`], { cwd: lockRoot });
  }
  console.log(`[verify] audited ${lockRoots.length} dependency roots`);
}

function verifyExecutedTests(root = ROOT, baselines = loadApprovedTestBaselines(path.join(root, 'scripts', 'test-baselines.json'))) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-test-results-'));
  try {
    const jestOutput = path.join(tempRoot, 'jest-results.json');
    npm(['run', 'test:jest', '--', '--json', `--outputFile=${jestOutput}`], { cwd: root });
    if (!fs.existsSync(jestOutput)) throw new Error('Jest did not write its result file');
    const jestPassed = verifyJestResult(JSON.parse(fs.readFileSync(jestOutput, 'utf8')), baselines.jest);

    const nodeOutput = npmCaptured(['run', 'test:node', '--', '--test-reporter=tap'], { cwd: root });
    const nodePassed = verifyNodeTapResult(nodeOutput, baselines.node);
    console.log(`[verify] executed tests: Jest ${jestPassed}, Node ${nodePassed}`);
    return { jest: jestPassed, node: nodePassed };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function verifyExecutedTestCounts(counts, baselines) {
  for (const name of ['jest', 'node']) {
    const passed = counts?.[name];
    if (!Number.isInteger(passed) || passed < baselines[name].minimumPassed) {
      throw new Error(`${name} executed-test count is missing or below approved minimum ${baselines[name].minimumPassed}`);
    }
  }
  return counts;
}

export function executeTestGate({
  root,
  baselines,
  verifyExecutedTestsImpl,
}) {
  return verifyExecutedTestsImpl(root, baselines);
}

function verifyReproduciblePack(root = ROOT) {
  const manifestOutput = npm(['pack', '--json', '--dry-run', '--silent', '--ignore-scripts'], {
    cwd: root,
    capture: true,
  });
  const [manifest] = JSON.parse(manifestOutput);
  const packageEntries = manifest.files.map(file => file.path);
  const trackedFiles = new Set(
    run('git', ['ls-files', '-z'], { cwd: root, capture: true }).split('\0').filter(Boolean),
  );
  const blockedEntries = findBlockedPackageEntries(packageEntries, trackedFiles);
  if (blockedEntries.length > 0) {
    throw new Error(`package contains internal, local, or untracked files:\n${blockedEntries.join('\n')}`);
  }
  console.log(`[verify] package contents ${manifest.entryCount} entries`);
  console.log(`[verify] package content sha256 ${packageContentDigest(root, packageEntries)}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-verify-pack-'));
  try {
    const outputs = [];
    for (const name of ['first', 'second']) {
      const destination = path.join(tempRoot, name);
      fs.mkdirSync(destination);
      npm(
        ['pack', '--silent', '--ignore-scripts', '--dry-run=false', '--pack-destination', destination],
        { cwd: root, capture: true },
      );
      const archives = fs.readdirSync(destination).filter(file => file.endsWith('.tgz'));
      if (archives.length !== 1) {
        throw new Error(`expected one package archive in ${destination}, found ${archives.length}`);
      }
      outputs.push(path.join(destination, archives[0]));
    }
    const hashes = outputs.map(sha256);
    if (hashes[0] !== hashes[1]) {
      throw new Error(`package build is not reproducible: ${hashes.join(' != ')}`);
    }
    console.log(`[verify] reproducible package sha256 ${hashes[0]}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function runVerification({
  root = ROOT,
  runPrerequisites = true,
  gitStatusImpl = gitStatus,
  verifyTestPolicyImpl = verifyTestPolicy,
  verifyVersionsImpl = verifyVersions,
  verifyExecutedTestsImpl = verifyExecutedTests,
  verifyExecutedTestCountsImpl = verifyExecutedTestCounts,
  executeTestGateImpl = executeTestGate,
  testBaselines,
  verifyAuditsImpl = verifyAudits,
  verifyReproduciblePackImpl = verifyReproduciblePack,
} = {}) {
  let statusBefore;
  try {
    statusBefore = gitStatusImpl(root);
  } catch (error) {
    console.error(`\n[verify] FAILED to inspect working tree: ${error.message}`);
    return false;
  }
  let failed = false;
  let approvedBaselines = null;
  let counts = null;

  try {
    verifyTestPolicyImpl({ root });
    if (runPrerequisites) {
      verifyVersionsImpl(root);
      approvedBaselines = testBaselines ?? loadApprovedTestBaselines(path.join(root, 'scripts', 'test-baselines.json'));
      counts = executeTestGateImpl({
        root,
        baselines: approvedBaselines,
        verifyExecutedTestsImpl,
      });
    }
  } catch (error) {
    failed = true;
    console.error(`\n[verify] FAILED: ${error.message}`);
  }

  if (!failed && runPrerequisites) {
    try {
      verifyExecutedTestCountsImpl(counts, approvedBaselines);
    } catch (error) {
      failed = true;
      console.error(`\n[verify] FAILED: ${error.message}`);
    }
  }

  try {
    if (!failed && runPrerequisites) {
      verifyAuditsImpl(root);
    }
    if (!failed) {
      verifyReproduciblePackImpl(root);
    }
  } catch (error) {
    failed = true;
    console.error(`\n[verify] FAILED: ${error.message}`);
  }

  try {
    const statusAfter = gitStatusImpl(root);
    if (statusAfter !== statusBefore) {
      failed = true;
      console.error('\n[verify] FAILED: verification changed the working tree');
      console.error('[verify] before:\n' + (statusBefore || '(clean)'));
      console.error('[verify] after:\n' + (statusAfter || '(clean)'));
    }
  } catch (error) {
    failed = true;
    console.error(`\n[verify] FAILED to inspect working tree: ${error.message}`);
  }

  if (!failed) console.log('\n[verify] PASS');
  return !failed;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (!runVerification()) process.exit(1);
}
