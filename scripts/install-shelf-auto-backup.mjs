#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBackupConfig } from './shelf-auto-backup.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SERVICE = 'yos-shelf-backup.service';
const TIMER = 'yos-shelf-backup.timer';
const MAX_PROCESS_STAGES = 9;

function fail(message) {
  throw new Error(message);
}

function unitQuote(value) {
  if (/\r|\n/.test(value)) fail('systemd values cannot contain newlines');
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
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
}) {
  for (const [label, value] of Object.entries({ configPath, repoDir, nodePath })) {
    if (!path.isAbsolute(value ?? '')) fail(`${label} must be an absolute path`);
  }
  if (!onCalendar || /[\r\n]/.test(onCalendar)) fail('onCalendar must be one systemd calendar expression');
  if (!Number.isInteger(randomizedDelaySeconds) || randomizedDelaySeconds < 0) {
    fail('randomizedDelaySeconds must be a non-negative integer');
  }
  const config = await loadBackupConfig(configPath);
  const runner = path.join(repoDir, 'scripts', 'shelf-auto-backup.mjs');
  // Every child process has its own timeout. Keep the outer unit alive long
  // enough for the full restore run instead of killing it after one stage.
  const timeout = config.commandTimeoutSeconds * MAX_PROCESS_STAGES + 300;
  return {
    service: `[Unit]\nDescription=YOS shelf off-site backup\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${unitWorkingDirectory(repoDir)}\nExecStart=${unitQuote(nodePath)} ${unitQuote(runner)} --config ${unitQuote(configPath)}\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${unitQuote(config.stateDir)} ${unitQuote(config.restoreRoot)}\nTimeoutStartSec=${timeout}\n`,
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

function parseCli(argv) {
  const options = {};
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
    else fail(`unknown flag ${arg}`);
  }
  return options;
}

async function main() {
  const result = await installSystemdUnits(parseCli(process.argv.slice(2)));
  console.log(`wrote ${result.servicePath}`);
  console.log(`wrote ${result.timerPath}`);
  console.log('not enabled: review the units, then run systemctl --user daemon-reload and enable the timer');
}

const invokedScript = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
if (invokedScript === fs.realpathSync(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`automatic backup unit generation failed: ${error.message}`);
    process.exit(1);
  });
}
