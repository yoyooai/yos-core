#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadBackupConfig } from './shelf-auto-backup.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SERVICE = 'yos-shelf-backup.service';
const TIMER = 'yos-shelf-backup.timer';
const SYSTEM_UNIT_DIR = '/etc/systemd/system';
const MAX_PROCESS_STAGES = 9;
const SYSTEM_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function fail(message) {
  throw new Error(message);
}

function unitQuote(value) {
  if (/\r|\n/.test(value)) fail('systemd values cannot contain newlines');
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function commandResult(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function assertCommandSucceeded(result, description) {
  if (result.status !== 0) fail(`${description} failed (exit ${result.status})`);
}

function validateSystemOptions({ systemMode, systemUser, homeDir, pathEnv, additionalReadWritePaths = [] }) {
  if (!systemMode) return;
  if (!SYSTEM_USER_PATTERN.test(systemUser ?? '')) {
    fail('systemUser must be a valid local account name');
  }
  if (!path.isAbsolute(homeDir ?? '')) fail('homeDir must be an absolute path in system mode');
  if (!pathEnv || /[\r\n]/.test(pathEnv)) fail('pathEnv must be one non-empty line in system mode');
  for (const writablePath of additionalReadWritePaths) {
    if (!path.isAbsolute(writablePath ?? '')) fail('additionalReadWritePaths must contain absolute paths');
  }
}

// systemd's WorkingDirectory= takes its value literally: it neither strips
// quotes the way ExecStart= does, nor decodes \xNN escapes. Every encoding we
// tried on a real machine produced the same outcome — `systemd-analyze verify`
// exits 0 and the unit loads, then the service dies at startup with
// status=200/CHDIR and ExecStart never runs. That is the identical silent shape
// as the bug this code replaced, only later and harder to see: the timer stays
// green, no backup is ever written, and nothing alerts.
//
// Since no encoding works, refuse the input instead of pretending we encoded
// it. Rejecting at install time is loud, immediate, and costs nothing: real
// deployment paths contain none of these characters.
//
// ExecStart= and ReadWritePaths= are NOT affected — their quoted form is
// verified working on a real machine. Do not "fix" them to match this.
const WORKING_DIRECTORY_SAFE_CHAR = /[A-Za-z0-9/._:-]/;

function unitWorkingDirectory(value) {
  const raw = String(value);
  const offenders = [...new Set([...raw])].filter((char) => !WORKING_DIRECTORY_SAFE_CHAR.test(char));
  if (offenders.length > 0) {
    fail(
      `repoDir cannot be expressed in systemd WorkingDirectory=: unsupported character(s) ` +
        `${offenders.map((char) => JSON.stringify(char)).join(', ')}. ` +
        'systemd reads this field literally — both quoting and \\xNN escaping yield a unit that ' +
        'loads but fails at startup with status=200/CHDIR, so the backup would silently never run. ' +
        'Move the repository to a path built only from letters, digits and / . _ : -',
    );
  }
  return raw;
}

export async function buildSystemdUnits({
  configPath,
  repoDir,
  nodePath,
  onCalendar = '*-*-* 03:17:00',
  randomizedDelaySeconds = 1800,
  systemMode = false,
  systemUser,
  homeDir,
  pathEnv,
  additionalReadWritePaths = [],
}) {
  for (const [label, value] of Object.entries({ configPath, repoDir, nodePath })) {
    if (!path.isAbsolute(value ?? '')) fail(`${label} must be an absolute path`);
  }
  if (!onCalendar || /[\r\n]/.test(onCalendar)) fail('onCalendar must be one systemd calendar expression');
  if (!Number.isInteger(randomizedDelaySeconds) || randomizedDelaySeconds < 0) {
    fail('randomizedDelaySeconds must be a non-negative integer');
  }
  validateSystemOptions({ systemMode, systemUser, homeDir, pathEnv, additionalReadWritePaths });
  const config = await loadBackupConfig(configPath);
  const runner = path.join(repoDir, 'scripts', 'shelf-auto-backup.mjs');
  // Every child process has its own timeout. Keep the outer unit alive long
  // enough for the full restore run instead of killing it after one stage.
  const timeout = config.commandTimeoutSeconds * MAX_PROCESS_STAGES + 300;
  const identity = systemMode
    ? `User=${systemUser}\nEnvironment=${unitQuote(`HOME=${homeDir}`)}\nEnvironment=${unitQuote(`PATH=${pathEnv}`)}\n`
    : '';
  const writablePaths = [config.stateDir, config.restoreRoot, ...additionalReadWritePaths];
  return {
    service: `[Unit]\nDescription=YOS shelf off-site backup\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\n${identity}WorkingDirectory=${unitWorkingDirectory(repoDir)}\nExecStart=${unitQuote(nodePath)} ${unitQuote(runner)} --config ${unitQuote(configPath)}\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${writablePaths.map(unitQuote).join(' ')}\nTimeoutStartSec=${timeout}\n`,
    timer: `[Unit]\nDescription=Schedule YOS shelf off-site backup\n\n[Timer]\nOnCalendar=${onCalendar}\nPersistent=true\nRandomizedDelaySec=${randomizedDelaySeconds}\nUnit=${SERVICE}\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

async function writeAtomic(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(temp, contents, { mode: 0o600 });
  await fsp.rename(temp, file);
}

export async function installSystemdUnits(options) {
  const outputDir = options.outputDir;
  if (!path.isAbsolute(outputDir ?? '')) fail('outputDir must be an absolute path');
  const config = await loadBackupConfig(options.configPath);
  const units = await buildSystemdUnits(options);
  const servicePath = path.join(outputDir, SERVICE);
  const timerPath = path.join(outputDir, TIMER);
  for (const directory of [config.stateDir, config.restoreRoot]) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700);
  }
  await writeAtomic(servicePath, units.service);
  await writeAtomic(timerPath, units.timer);
  return { servicePath, timerPath };
}

async function captureFile(file) {
  try {
    const stat = await fsp.stat(file);
    return { exists: true, contents: await fsp.readFile(file), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function restoreFile(file, snapshot) {
  if (!snapshot.exists) {
    await fsp.rm(file, { force: true });
    return;
  }
  await writeAtomic(file, snapshot.contents);
  await fsp.chmod(file, snapshot.mode);
}

async function captureDirectory(directory) {
  try {
    const stat = await fsp.stat(directory);
    return { exists: true, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function restoreDirectory(directory, snapshot) {
  if (!snapshot.exists) {
    await fsp.rm(directory, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(directory)) return;
  await fsp.chown(directory, snapshot.uid, snapshot.gid);
  await fsp.chmod(directory, snapshot.mode);
}

function enabledState(result) {
  return result.status === 0 && /^(enabled|enabled-runtime|linked|linked-runtime)$/m.test(result.stdout.trim());
}

function activeState(result) {
  return result.status === 0 && result.stdout.trim() === 'active';
}

function serviceBusyState(result) {
  return /^(active|activating|reloading|deactivating)$/.test(result.stdout.trim());
}

async function rollbackSystemInstallation({
  servicePath,
  timerPath,
  previousService,
  previousTimer,
  wasEnabled,
  wasActive,
  previousDirectories,
  runCommand,
}) {
  const errors = [];
  const run = (args, description) => {
    const result = runCommand('systemctl', args);
    if (result.status !== 0) errors.push(`${description} failed (exit ${result.status})`);
  };

  run(['disable', '--now', TIMER], 'disable replacement timer');
  try {
    await restoreFile(servicePath, previousService);
    await restoreFile(timerPath, previousTimer);
    for (const [directory, snapshot] of previousDirectories) {
      await restoreDirectory(directory, snapshot);
    }
  } catch (error) {
    errors.push(`restore previous installation failed: ${error.message}`);
  }
  run(['daemon-reload'], 'reload restored units');
  if (wasEnabled) {
    run(wasActive ? ['enable', '--now', TIMER] : ['enable', TIMER], 'restore previous timer state');
  } else if (wasActive) {
    run(['start', TIMER], 'restore previous active timer');
  }
  return errors;
}

/**
 * Install system-level units and prove the real oneshot can complete before the
 * timer is accepted. A failed self-test restores the exact previous unit files
 * and enabled/active state; a fresh failed install leaves no units behind.
 */
export async function installAndVerifySystemdUnits(
  options,
  { runCommand = commandResult, systemUnitDir = SYSTEM_UNIT_DIR, signalSource = process } = {},
) {
  if (!options.systemMode) fail('--system is required for automatic backup installation');
  validateSystemOptions(options);
  const outputDir = options.outputDir;
  if (!path.isAbsolute(outputDir ?? '')) fail('outputDir must be an absolute path');
  if (outputDir !== systemUnitDir) {
    fail(`system mode must write to ${systemUnitDir} so systemctl tests the generated units`);
  }
  const servicePath = path.join(outputDir, SERVICE);
  const timerPath = path.join(outputDir, TIMER);
  const previousService = await captureFile(servicePath);
  const previousTimer = await captureFile(timerPath);
  const config = await loadBackupConfig(options.configPath);
  const previousDirectories = await Promise.all(
    [config.stateDir, config.restoreRoot].map(async (directory) => [directory, await captureDirectory(directory)]),
  );
  const wasEnabled = enabledState(runCommand('systemctl', ['is-enabled', TIMER]));
  const wasActive = activeState(runCommand('systemctl', ['is-active', TIMER]));
  const serviceState = runCommand('systemctl', ['show', SERVICE, '-p', 'ActiveState', '--value']);
  if (serviceBusyState(serviceState)) {
    fail('automatic backup service is already running; wait for it to finish, then retry installation');
  }

  const uidResult = runCommand('id', ['-u', options.systemUser]);
  const gidResult = runCommand('id', ['-g', options.systemUser]);
  assertCommandSucceeded(uidResult, `resolve uid for ${options.systemUser}`);
  assertCommandSucceeded(gidResult, `resolve gid for ${options.systemUser}`);
  const uid = Number(uidResult.stdout.trim());
  const gid = Number(gidResult.stdout.trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) fail(`could not resolve numeric identity for ${options.systemUser}`);
  const runtimeProbe = runCommand('runuser', [
    '-u', options.systemUser, '--', 'env',
    `HOME=${options.homeDir}`,
    `PATH=${options.pathEnv}`,
    'node', '--version',
  ]);
  assertCommandSucceeded(runtimeProbe, `resolve node from PATH for ${options.systemUser}`);
  for (const writablePath of options.additionalReadWritePaths ?? []) {
    if (!fs.existsSync(writablePath)) fail(`required write path does not exist: ${writablePath}`);
    const writable = runCommand('runuser', ['-u', options.systemUser, '--', 'test', '-w', writablePath]);
    if (writable.status !== 0) {
      fail(`${options.systemUser} cannot write required path: ${writablePath}`);
    }
  }

  let installed;
  let interruptedSignal;
  const onSigint = () => { interruptedSignal ??= 'SIGINT'; };
  const onSigterm = () => { interruptedSignal ??= 'SIGTERM'; };
  const throwIfInterrupted = () => {
    if (interruptedSignal) fail(`automatic backup installation interrupted by ${interruptedSignal}`);
  };
  const interruptCheckpoint = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    throwIfInterrupted();
  };
  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);
  try {
    await interruptCheckpoint();
    if (wasActive) {
      assertCommandSucceeded(runCommand('systemctl', ['stop', TIMER]), 'stop previous automatic backup timer');
      await interruptCheckpoint();
    }
    installed = await installSystemdUnits(options);
    await interruptCheckpoint();
    for (const directory of [config.stateDir, config.restoreRoot]) {
      await fsp.chown(directory, uid, gid);
      await interruptCheckpoint();
    }
    assertCommandSucceeded(runCommand('systemctl', ['daemon-reload']), 'systemd daemon-reload');
    await interruptCheckpoint();
    assertCommandSucceeded(
      runCommand('systemctl', ['start', SERVICE]),
      'real backup self-test',
    );
    await interruptCheckpoint();
    const serviceResult = runCommand('systemctl', ['show', SERVICE, '--property=Result', '--value']);
    assertCommandSucceeded(serviceResult, 'read real backup self-test result');
    await interruptCheckpoint();
    const result = serviceResult.stdout.trim();
    if (result !== 'success') fail(`real backup self-test reported Result=${result || 'unknown'}`);
    assertCommandSucceeded(
      runCommand('systemctl', ['enable', '--now', TIMER]),
      'enable automatic backup timer',
    );
    await interruptCheckpoint();
    return { ...installed, selfTested: true };
  } catch (error) {
    const rollbackErrors = await rollbackSystemInstallation({
      servicePath,
      timerPath,
      previousService,
      previousTimer,
      wasEnabled,
      wasActive,
      previousDirectories,
      runCommand,
    });
    const suffix = rollbackErrors.length > 0 ? `; rollback also failed: ${rollbackErrors.join('; ')}` : '';
    fail(`${error.message}${suffix}`);
  } finally {
    signalSource.off('SIGINT', onSigint);
    signalSource.off('SIGTERM', onSigterm);
  }
}

function parseCli(argv) {
  const options = { additionalReadWritePaths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) fail(`${arg} needs a value`);
      return value;
    };
    if (arg === '--config') options.configPath = next();
    else if (arg === '--repo') options.repoDir = next();
    else if (arg === '--node') options.nodePath = next();
    else if (arg === '--output-dir') options.outputDir = next();
    else if (arg === '--on-calendar') options.onCalendar = next();
    else if (arg === '--randomized-delay-seconds') options.randomizedDelaySeconds = Number(next());
    else if (arg === '--system') options.systemMode = true;
    else if (arg === '--user') options.systemUser = next();
    else if (arg === '--home') options.homeDir = next();
    else if (arg === '--path') options.pathEnv = next();
    else if (arg === '--read-write-path') options.additionalReadWritePaths.push(next());
    else fail(`unknown flag ${arg}`);
  }
  return options;
}

export async function runCli(argv, dependencies = {}) {
  const options = parseCli(argv);
  if (!options.systemMode) {
    fail('--system is required: user-level sandboxing can make SSH fail only when the timer fires');
  }
  if (options.outputDir !== SYSTEM_UNIT_DIR) {
    fail(`system mode must write to ${SYSTEM_UNIT_DIR} so systemctl tests the generated units`);
  }
  const getuid = dependencies.getuid ?? process.getuid;
  if (typeof getuid !== 'function' || getuid() !== 0) {
    fail('system mode must run as root so it can install and verify systemd units');
  }
  const result = await installAndVerifySystemdUnits(options, dependencies);
  console.log(`wrote ${result.servicePath}`);
  console.log(`wrote ${result.timerPath}`);
  console.log(`enabled ${TIMER}`);
  console.log(`real backup self-test passed via ${SERVICE}`);
  return result;
}

async function main() {
  await runCli(process.argv.slice(2));
}

const invokedScript = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (invokedScript === fs.realpathSync(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`automatic backup unit generation failed: ${error.message}`);
    process.exit(1);
  });
}
