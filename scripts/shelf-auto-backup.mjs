#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCosPrefix } from './lib/cos-prefix.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REQUIRED_PATHS = ['localRepo', 'stateDir', 'restoreRoot'];
const SECRET_ASSIGNMENT = /[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|PRIVATE_KEY|SESSION_TOKEN|API_KEY)\s*=/i;
const AKID = /AKID[A-Za-z0-9]{12,}/;
const SECRET_VALUE = /(?:sk-|ghp_)[A-Za-z0-9_-]{16,}/i;

function fail(message) {
  throw new Error(message);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer`);
}

function isSecretKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return ['secret', 'password', 'token', 'secretid', 'secretkey', 'privatekey', 'sessiontoken']
    .some((suffix) => normalized.endsWith(suffix));
}

function inspectForSecrets(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectForSecrets(entry, [...trail, index]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'credentialCommand' && isSecretKey(key)) {
        fail(`configuration contains credential material at ${[...trail, key].join('.')}`);
      }
      inspectForSecrets(child, [...trail, key]);
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (SECRET_ASSIGNMENT.test(value) || AKID.test(value) || SECRET_VALUE.test(value)) {
    fail(`configuration contains credential material at ${trail.join('.')}`);
  }
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
      fail(`configuration contains credential material at ${trail.join('.')}`);
    }
  } catch (error) {
    if (/credential material/.test(error.message)) throw error;
  }
}

function assertCommand(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== 'string' || !part)) {
    fail(`${label} must be a non-empty string array`);
  }
  if (!path.isAbsolute(value[0])) fail(`${label}[0] must be an absolute executable path`);
}

export async function loadBackupConfig(configPath) {
  if (!path.isAbsolute(configPath)) fail('config path must be absolute');
  let config;
  try {
    const stat = await fsp.stat(configPath);
    if (!stat.isFile()) fail('backup config must be a regular file');
    if ((stat.mode & 0o022) !== 0) fail('backup config must not be group- or world-writable');
    config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (error) {
    fail(`could not read backup config: ${error.message}`);
  }
  assertPlainObject(config, 'config');
  inspectForSecrets(config);
  if (config.schemaVersion !== 1) fail('schemaVersion must be 1');
  for (const key of REQUIRED_PATHS) {
    if (!path.isAbsolute(config[key] ?? '')) fail(`${key} must be an absolute path`);
  }
  assertPlainObject(config.shelf, 'shelf');
  if (!config.shelf.sshTarget || /[\s\n\r]/.test(config.shelf.sshTarget) || config.shelf.sshTarget.startsWith('-')) {
    fail('shelf.sshTarget must be a single SSH target');
  }
  for (const key of ['nodePath', 'repoDir', 'root']) {
    if (!path.posix.isAbsolute(config.shelf[key] ?? '')) fail(`shelf.${key} must be an absolute POSIX path`);
  }
  assertPlainObject(config.cos, 'cos');
  if (!/^[a-z0-9][a-z0-9.-]+-\d+$/.test(config.cos.bucket ?? '')) fail('cos.bucket is invalid');
  if (!/^[a-z][a-z0-9-]+$/.test(config.cos.region ?? '')) fail('cos.region is invalid');
  config.cos.basePrefix = normalizeCosPrefix(config.cos.basePrefix);
  assertCommand(config.credentialCommand, 'credentialCommand');
  assertCommand(config.alertCommand, 'alertCommand');
  for (const key of ['keepSuccessful', 'restoreEvery', 'lockStaleSeconds', 'commandTimeoutSeconds']) {
    assertPositiveInteger(config[key], key);
  }
  return { ...config, configPath };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function credentialExports(credentials) {
  return [
    `export COS_SECRET_ID=${shellQuote(credentials.secretId)}`,
    `export COS_SECRET_KEY=${shellQuote(credentials.secretKey)}`,
    `export COS_SESSION_TOKEN=${shellQuote(credentials.token ?? '')}`,
  ].join('\n');
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function assertPass(report, label) {
  if (report?.pass !== true) {
    const details = Array.isArray(report?.problems)
      ? `: ${report.problems.slice(0, 3).map((problem) => problem.error ?? String(problem)).join('; ')}`
      : '';
    fail(`${label} failed${details}`);
  }
  return report;
}

function defaultRunProcess({
  command,
  args = [],
  stdin = '',
  env = {},
  stripEnv = [],
  timeout,
  label,
  includeStderr = true,
}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    for (const key of stripEnv) delete childEnv[key];
    const child = spawn(command, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeout);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errors = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        const detail = includeStderr && errors.trim() ? `: ${errors.trim().slice(0, 500)}` : '';
        reject(new Error(`${label} failed (${signal ?? `exit ${code}`})${detail}`));
      } else resolve({ stdout: output, stderr: errors });
    });
    child.stdin.end(stdin);
  });
}

function remoteScript(config, command, args, credentials = null) {
  const lines = ['set -euo pipefail'];
  if (credentials) lines.push(credentialExports(credentials));
  lines.push(`cd ${shellQuote(config.shelf.repoDir)}`);
  lines.push([
    'timeout', '--signal=TERM', '--kill-after=10s', `${config.commandTimeoutSeconds}s`,
    shellQuote(config.shelf.nodePath), shellQuote(command), ...args.map(shellQuote),
  ].join(' '));
  return `${lines.join('\n')}\n`;
}

function credentialEnv(credentials) {
  return {
    COS_SECRET_ID: credentials.secretId,
    COS_SECRET_KEY: credentials.secretKey,
    COS_SESSION_TOKEN: credentials.token ?? '',
  };
}

export function createDefaultOperations(config, { runProcess = defaultRunProcess } = {}) {
  const timeout = config.commandTimeoutSeconds * 1000;
  const shelfTool = path.join(config.localRepo, 'scripts', 'shelf-offsite.mjs');
  const verifier = path.join(config.localRepo, 'scripts', 'verify-public-shelf.mjs');
  const ssh = '/usr/bin/ssh';
  const runRemote = async (label, script) => runProcess({
    label,
    command: ssh,
    args: [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=30',
      '--', config.shelf.sshTarget, 'bash', '-s',
    ],
    stdin: script,
    timeout: timeout + 30_000,
  });
  const offsiteArgs = (action, locationFlag, location, prefix) => [
    shelfTool, action, locationFlag, location,
    '--bucket', config.cos.bucket,
    '--region', config.cos.region,
    '--prefix', prefix,
    '--json',
  ];

  return {
    async mintCredentials(prefix) {
      const [command, ...baseArgs] = config.credentialCommand;
      const { stdout } = await runProcess({
        label: 'mint_credentials', command, args: [...baseArgs, '--prefix', prefix, '--json'],
        stripEnv: [
          'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY',
          'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_SESSION_TOKEN',
        ],
        includeStderr: false,
        timeout,
      });
      const credentials = parseJson(stdout, 'credential command');
      for (const key of ['secretId', 'secretKey', 'token']) {
        if (!credentials[key]) fail(`credential command omitted ${key}`);
      }
      const expiration = Date.parse(credentials.expiration);
      if (!Number.isFinite(expiration) || expiration <= Date.now() + 5 * 60_000) {
        fail('credential command returned an absent, invalid, or nearly expired expiration');
      }
      return credentials;
    },
    async remoteAudit() {
      const script = remoteScript(config, 'scripts/verify-public-shelf.mjs', [
        '--local', config.shelf.root, '--full', '--json',
      ]);
      const { stdout } = await runRemote('audit_shelf', script);
      return parseJson(stdout, 'shelf audit');
    },
    async uploadShelf({ prefix, credentials }) {
      const script = remoteScript(config, 'scripts/shelf-offsite.mjs', [
        'upload', '--root', config.shelf.root,
        '--bucket', config.cos.bucket, '--region', config.cos.region,
        '--prefix', prefix, '--json',
      ], credentials);
      const { stdout } = await runRemote('upload_shelf', script);
      return parseJson(stdout, 'shelf upload');
    },
    async verifyShelf({ prefix, credentials }) {
      const script = remoteScript(config, 'scripts/shelf-offsite.mjs', [
        'verify', '--root', config.shelf.root,
        '--bucket', config.cos.bucket, '--region', config.cos.region,
        '--prefix', prefix, '--json',
      ], credentials);
      const { stdout } = await runRemote('verify_shelf', script);
      return parseJson(stdout, 'shelf verification');
    },
    async uploadMetadata({ prefix, credentials, root }) {
      const { stdout } = await runProcess({
        label: 'upload_metadata', command: process.execPath,
        args: offsiteArgs('upload', '--root', root, prefix),
        env: credentialEnv(credentials), timeout,
      });
      return parseJson(stdout, 'metadata upload');
    },
    async verifyMetadata({ prefix, credentials, root }) {
      const { stdout } = await runProcess({
        label: 'verify_metadata', command: process.execPath,
        args: offsiteArgs('verify', '--root', root, prefix),
        env: credentialEnv(credentials), timeout,
      });
      return parseJson(stdout, 'metadata verification');
    },
    async restoreShelf({ prefix, credentials, dest }) {
      const { stdout } = await runProcess({
        label: 'restore_shelf', command: process.execPath,
        args: offsiteArgs('restore', '--dest', dest, prefix),
        env: credentialEnv(credentials), timeout,
      });
      return parseJson(stdout, 'shelf restore');
    },
    async auditRestore({ dest }) {
      const { stdout } = await runProcess({
        label: 'audit_restore', command: process.execPath,
        args: [verifier, '--local', dest, '--full', '--json'], timeout,
      });
      return parseJson(stdout, 'restored shelf audit');
    },
    async alert(event) {
      const [command, ...args] = config.alertCommand;
      await runProcess({
        label: 'alert', command, args, stdin: `${JSON.stringify(event)}\n`,
        includeStderr: false,
        timeout: Math.min(timeout, 60_000),
      });
      return { pass: true };
    },
  };
}

function formatRunId(date, suffix) {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${suffix}`;
}

async function readState(statePath) {
  try {
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    if (!Array.isArray(state.history)) fail('state history is invalid');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, history: [] };
    fail(`state file is invalid: ${error.message}`);
  }
}

async function writeJsonAtomic(file, value, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fsp.rename(temp, file);
}

function safeMessage(error, credentials, config) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [credentials?.secretId, credentials?.secretKey, credentials?.token]) {
    if (value) message = message.replaceAll(value, '[REDACTED]');
  }
  const privatePaths = [
    config?.localRepo,
    config?.stateDir,
    config?.restoreRoot,
    config?.shelf?.nodePath,
    config?.shelf?.repoDir,
    config?.shelf?.root,
    process.env.HOME,
  ].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const privatePath of privatePaths) message = message.replaceAll(privatePath, '[PRIVATE_PATH]');
  return message
    .replace(AKID, '[REDACTED]')
    .split('\n')
    .filter((line) => !/^\s*at\s/.test(line))
    .join('\n');
}

async function acquireLock(config, startedAt) {
  const lock = path.join(config.stateDir, 'run.lock');
  await fsp.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  let staleLockRecovered = false;
  try {
    await fsp.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fsp.stat(lock);
    let owner = null;
    try {
      owner = JSON.parse(await fsp.readFile(path.join(lock, 'owner.json'), 'utf8'));
    } catch {
      // An unreadable owner can only be recovered after the age threshold.
    }
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        fail(`automatic shelf backup is already running (pid ${owner.pid})`);
      } catch (pidError) {
        if (!['ESRCH'].includes(pidError.code)) throw pidError;
      }
    }
    const age = startedAt.getTime() - stat.mtimeMs;
    if (age <= config.lockStaleSeconds * 1000) fail('automatic shelf backup is already running');
    await fsp.rm(lock, { recursive: true, force: true });
    await fsp.mkdir(lock, { mode: 0o700 });
    staleLockRecovered = true;
  }
  await writeJsonAtomic(path.join(lock, 'owner.json'), {
    pid: process.pid,
    startedAt: startedAt.toISOString(),
  });
  return { lock, staleLockRecovered };
}

export async function runAutomaticBackup(config, operations, runtime = {}) {
  const now = runtime.now ?? (() => new Date());
  const randomId = runtime.randomId ?? (() => crypto.randomBytes(4).toString('hex'));
  const startedAt = now();
  const statePath = path.join(config.stateDir, 'state.json');
  const runId = formatRunId(startedAt, randomId());
  const runPrefix = `${config.cos.basePrefix}${runId}/`;
  const runRoot = path.join(config.stateDir, 'runs', runId);
  const metaRoot = path.join(runRoot, 'meta');
  const restoreDest = path.join(config.restoreRoot, runId);
  let state = { schemaVersion: 1, history: [] };
  let stage = 'acquire_lock';
  let credentials;
  let lock = null;
  let staleLockRecovered = false;

  try {
    const acquired = await acquireLock(config, startedAt);
    lock = acquired.lock;
    staleLockRecovered = acquired.staleLockRecovered;
  } catch (error) {
    const message = safeMessage(error, null, config);
    const failure = {
      type: 'yos_shelf_backup_failed', runId, prefix: runPrefix,
      startedAt: startedAt.toISOString(), failedAt: now().toISOString(),
      pass: false, stage, error: message,
    };
    try {
      await operations.alert(failure);
    } catch (alertError) {
      throw new Error(`${message}; alert failed: ${safeMessage(alertError, null, config)}`);
    }
    throw new Error(message);
  }

  try {
    stage = 'load_state';
    state = await readState(statePath);
    stage = 'audit_shelf';
    const audit = assertPass(await operations.remoteAudit(), 'audit shelf');
    stage = 'mint_credentials';
    credentials = await operations.mintCredentials(runPrefix);
    stage = 'upload_shelf';
    const upload = assertPass(await operations.uploadShelf({
      prefix: `${runPrefix}shelf/`, credentials,
    }), 'upload shelf');
    stage = 'verify_shelf';
    const verify = assertPass(await operations.verifyShelf({
      prefix: `${runPrefix}shelf/`, credentials,
    }), 'verify shelf');
    stage = 'audit_shelf_after_upload';
    const auditAfterUpload = assertPass(await operations.remoteAudit(), 'audit shelf after upload');
    if (
      auditAfterUpload.indexSha256 !== audit.indexSha256
      || auditAfterUpload.buildId !== audit.buildId
    ) {
      fail('shelf identity changed during backup');
    }

    const successfulBefore = state.history.filter((entry) => entry.pass).length;
    const shouldRestore = successfulBefore % config.restoreEvery === 0;
    let restoreEvidence = null;
    if (shouldRestore) {
      stage = 'restore_shelf';
      await fsp.rm(restoreDest, { recursive: true, force: true });
      const restore = assertPass(await operations.restoreShelf({
        prefix: `${runPrefix}shelf/`, credentials, dest: restoreDest,
      }), 'restore shelf');
      stage = 'audit_restore';
      const restoredAudit = assertPass(await operations.auditRestore({ dest: restoreDest }), 'audit restore');
      if (restoredAudit.indexSha256 !== audit.indexSha256 || restoredAudit.buildId !== audit.buildId) {
        fail('restored shelf identity differs from the source audit');
      }
      restoreEvidence = {
        objectsFound: restore.objectsFound,
        restoredVerified: restore.restoredVerified,
        matchedFiles: restoredAudit.matchedFiles,
        buildId: restoredAudit.buildId,
        indexSha256: restoredAudit.indexSha256,
      };
    }

    const evidence = {
      runId,
      prefix: runPrefix,
      startedAt: startedAt.toISOString(),
      completedAt: now().toISOString(),
      backupVerified: true,
      staleLockRecovered,
      shelf: {
        filesWalked: upload.filesWalked,
        uploadedVerified: upload.uploadedVerified,
        objectsFound: verify.objectsFound,
        matched: verify.matched,
        registeredFiles: audit.registeredFiles,
        matchedFiles: audit.matchedFiles,
        buildId: audit.buildId,
        indexSha256: audit.indexSha256,
      },
      restore: restoreEvidence,
    };
    await fsp.mkdir(metaRoot, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(metaRoot, 'run.json'), evidence);
    stage = 'upload_metadata';
    assertPass(await operations.uploadMetadata({
      prefix: `${runPrefix}meta/`, credentials, root: metaRoot,
    }), 'upload metadata');
    stage = 'verify_metadata';
    assertPass(await operations.verifyMetadata({
      prefix: `${runPrefix}meta/`, credentials, root: metaRoot,
    }), 'verify metadata');

    const entry = { ...evidence, pass: true };
    state.history.push(entry);
    const successful = state.history.filter((item) => item.pass);
    const retentionCandidates = successful
      .slice(0, Math.max(0, successful.length - config.keepSuccessful))
      .map((item) => item.prefix);
    state.lastSuccess = entry;
    state.lastFailure = null;
    state.retentionCandidates = retentionCandidates;
    await writeJsonAtomic(statePath, state);
    return {
      ...entry,
      restored: Boolean(restoreEvidence),
      retentionCandidates,
    };
  } catch (error) {
    const message = safeMessage(error, credentials, config);
    const failure = {
      runId,
      prefix: runPrefix,
      startedAt: startedAt.toISOString(),
      failedAt: now().toISOString(),
      pass: false,
      stage,
      error: message,
    };
    let evidenceError = null;
    try {
      if (stage === 'load_state') {
        await writeJsonAtomic(path.join(config.stateDir, 'last-failure.json'), failure);
      } else {
        state.lastFailure = failure;
        await writeJsonAtomic(statePath, state);
      }
    } catch (writeError) {
      evidenceError = safeMessage(writeError, credentials, config);
    }
    let alertError = null;
    try {
      await operations.alert({ type: 'yos_shelf_backup_failed', ...failure });
    } catch (errorFromAlert) {
      alertError = safeMessage(errorFromAlert, credentials, config);
    }
    const details = [
      message,
      evidenceError ? `failure evidence write failed: ${evidenceError}` : null,
      alertError ? `alert failed: ${alertError}` : null,
    ].filter(Boolean);
    throw new Error(details.join('; '));
  } finally {
    credentials = undefined;
    await fsp.rm(restoreDest, { recursive: true, force: true });
    if (lock) await fsp.rm(lock, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) {
    fail('usage: node scripts/shelf-auto-backup.mjs --config /absolute/path/config.json');
  }
  return argv[1];
}

async function main() {
  const config = await loadBackupConfig(parseCli(process.argv.slice(2)));
  const report = await runAutomaticBackup(config, createDefaultOperations(config));
  console.log(JSON.stringify(report));
}

const invokedScript = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (invokedScript === fs.realpathSync(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`shelf automatic backup failed: ${error.message}`);
    process.exit(1);
  });
}
