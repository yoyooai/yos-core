#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function gitStatus() {
  return run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { capture: true });
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

function verifyVersions() {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const fileVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  if (packageVersion !== fileVersion) {
    throw new Error(`version mismatch: package.json=${packageVersion}, VERSION=${fileVersion}`);
  }
  console.log(`[verify] version ${packageVersion}`);
}

function verifyAudits() {
  const lockRoots = findLockRoots(ROOT).sort();
  for (const lockRoot of lockRoots) {
    npm(['audit', '--audit-level=low', `--registry=${REGISTRY}`], { cwd: lockRoot });
  }
  console.log(`[verify] audited ${lockRoots.length} dependency roots`);
}

function verifyReproduciblePack() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-verify-pack-'));
  try {
    const outputs = [];
    for (const name of ['first', 'second']) {
      const destination = path.join(tempRoot, name);
      fs.mkdirSync(destination);
      npm(['pack', '--silent', '--pack-destination', destination], { capture: true });
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

const statusBefore = gitStatus();
let failed = false;

try {
  verifyVersions();
  npm(['test']);
  verifyAudits();
  verifyReproduciblePack();
} catch (error) {
  failed = true;
  console.error(`\n[verify] FAILED: ${error.message}`);
}

try {
  const statusAfter = gitStatus();
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

if (failed) process.exit(1);
console.log('\n[verify] PASS');
