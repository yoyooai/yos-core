/**
 * A machine that failed once has to be recoverable by the person who owns it.
 *
 * These were four separate customer-visible dead ends on 2026-08-05, all of the
 * same shape: something went wrong, the raw error of whatever tool noticed it
 * was printed, and the machine was left in a state its owner could not get out
 * of unaided.
 *
 * The wiring is pinned here (the flows themselves need a live pm2, npm and
 * network); the behavior is verified on a real machine per release.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { describeExtractFailure, extractTarball } from '../download.js';
import { refreshSplitInstructions } from '../runtime/instruction-builder.js';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

/** The thrown error itself is the subject here, so it has to be captured. */
function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal, got none');
}

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const initSource = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'init.js'), 'utf8');
const installSh = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tmpDir(prefix) {
  const dir = makeTempDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

describe('re-initializing a machine whose init stopped halfway', () => {
  it('names the files in the way and the commands that clear them', () => {
    // The old message was "initialize a fresh YOS installation" — no file, no
    // command, and no way to tell a half-finished init from a pre-split install.
    const yosDir = tmpDir('yos-halfinit-');
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), '# my own edits\n');
    fs.writeFileSync(path.join(yosDir, 'CLAUDE.md'), '# generated\n');

    const err = captureThrow(() => refreshSplitInstructions({ yosDir }));
    assert.match(err.message, /split marker is missing/);
    assert.match(err.message, new RegExp(`mv ${path.join(yosDir, 'YOS.md')} `));
    assert.match(err.message, new RegExp(`mv ${path.join(yosDir, 'CLAUDE.md')} `));
    assert.match(err.message, /yos init/);
    assert.match(err.message, /Nothing is deleted/);
  });

  it('does not invent files that are not there', () => {
    const yosDir = tmpDir('yos-halfinit-');
    fs.writeFileSync(path.join(yosDir, 'CLAUDE.md'), '# generated\n');

    const err = captureThrow(() => refreshSplitInstructions({ yosDir }));
    assert.match(err.message, /CLAUDE\.md/);
    assert.doesNotMatch(err.message, /mv .*YOS\.md/);
    assert.doesNotMatch(err.message, /AGENTS\.md/);
  });

  it('still refuses to convert on its own', () => {
    // YOS.md is the file the user edits and CLAUDE.md may be hand-maintained on
    // an older install. Guessing which situation this is would overwrite
    // content we did not write.
    const yosDir = tmpDir('yos-halfinit-');
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), '# my own edits\n');
    assert.throws(() => refreshSplitInstructions({ yosDir }));
    assert.equal(fs.readFileSync(path.join(yosDir, 'YOS.md'), 'utf8'), '# my own edits\n');
    assert.equal(fs.existsSync(path.join(yosDir, '.yos', 'instructions', 'meta.json')), false);
  });
});

describe('an incomplete download says so', () => {
  it('explains a truncated archive instead of forwarding tar output', () => {
    const file = path.join(tmpDir('yos-extract-'), 'archive.tar.gz');
    fs.writeFileSync(file, 'x'.repeat(4242));
    const err = Object.assign(new Error('Command failed: tar xzf /tmp/x/archive.tar.gz -C /tmp/y'), {
      stderr: 'gzip: stdin: unexpected end of file\ntar: Unexpected EOF in archive\n',
    });

    const message = describeExtractFailure(err, file);
    assert.match(message, /incomplete or corrupt/);
    assert.match(message, /4242 bytes/);
    assert.match(message, /Nothing has been changed/);
    assert.match(message, /run the same command again/);
    assert.doesNotMatch(message, /tar xzf/);
    assert.doesNotMatch(message, /Unexpected EOF/);
  });

  it('is what extracting an archive actually reports', () => {
    // Pinning the helper alone left the call site free to go back to forwarding
    // tar's stderr, with every test still green. This walks the real path: a
    // truncated archive on disk, through extractTarball.
    const dir = tmpDir('yos-extract-real-');
    const archive = path.join(dir, 'archive.tar.gz');
    // A real gzip header followed by nothing — what a cut-off download looks like.
    fs.writeFileSync(archive, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]));

    const result = extractTarball(archive, path.join(dir, 'out'));
    assert.equal(result.success, false);
    assert.match(result.error, /incomplete or corrupt/);
    assert.match(result.error, /Nothing has been changed/);
    assert.doesNotMatch(result.error, /tar xzf/);
  });

  it('separates running out of disk from a bad download', () => {
    const message = describeExtractFailure(new Error('ENOSPC: no space left on device'), '/nonexistent');
    assert.match(message, /disk space/);
    assert.match(message, /Nothing has been changed/);
  });

  it('keeps an unrecognized failure verbatim rather than mislabelling it', () => {
    const message = describeExtractFailure(new Error('tar: Cannot open: Permission denied'), '/nonexistent');
    assert.match(message, /Permission denied/);
    assert.doesNotMatch(message, /incomplete or corrupt/);
  });
});

describe('the installer does not stop on sudo asking for a password', () => {
  it('probes non-interactive sudo before using it', () => {
    assert.match(installSh, /sudo -n true 2>\/dev\/null/);
    const probeAt = installSh.indexOf('sudo -n true');
    const useAt = installSh.indexOf('sudo npm install -g');
    assert.ok(probeAt > 0 && useAt > probeAt, 'the probe must come before the sudo install');
  });

  it('names both ways forward', () => {
    assert.match(installSh, /npm config set prefix/);
    assert.match(installSh, /passwordless sudo/);
    assert.match(installSh, /re-run this installer/);
  });
});

describe('an interrupted install does not lock the machine out of retrying', () => {
  it('clears its own leftovers on every install path', () => {
    // npm leaves `.yos-XXXXXXXX` behind when it is interrupted, and a dangling
    // `yos` symlink survives an uninstall. Either one makes every later attempt
    // fail with a raw ENOTEMPTY/ENOTDIR from npm.
    assert.match(installSh, /clear_global_leftovers\(\) \{/);
    // Three ways yos gets installed: writable prefix, running as root, and via
    // sudo. A path that skips the cleanup is a path that can lock the machine.
    const installBlock = installSh.slice(
      installSh.indexOf('install_yos() {'),
      installSh.indexOf("ok \"yos: $(yos --version"),
    );
    const npmInstalls = installBlock.match(/npm install -g --install-links/g) || [];
    const cleanups = installBlock.match(/clear_global_leftovers /g) || [];
    assert.equal(npmInstalls.length, 3, 'install paths changed — recount the cleanups');
    assert.equal(cleanups.length, npmInstalls.length,
      `every install path needs the cleanup: ${cleanups.length} cleanups for ${npmInstalls.length} installs`);
  });

  it('only removes things that are unambiguously ours', () => {
    const fn = installSh.slice(
      installSh.indexOf('clear_global_leftovers() {'),
      installSh.indexOf('install_yos() {'),
    );
    assert.match(fn, /\$root"\/\.yos-\*/);
    assert.match(fn, /\[ -L "\$root\/yos" \] && \[ ! -e "\$root\/yos" \]/);
    assert.doesNotMatch(fn, /rm -rf "\$root"(\s|$)/);
  });
});

describe('yos init does not report success over a service that is down', () => {
  it('returns which services failed, not just how many started', () => {
    assert.match(initSource, /return \{ started, failed \};/);
    assert.match(initSource, /function reportServiceOutcome\(outcome/);
    assert.match(initSource, /service\(s\) did not start/);
  });

  it('feeds that into the exit code', () => {
    const uses = initSource.match(/exitCode = reportServiceOutcome\(serviceOutcome, \{ quiet \}\) \|\| exitCode;/g) || [];
    assert.equal(uses.length, 2, 'both init flows must account for a service that did not start');
  });

  it('does not print an unqualified success line when something is down', () => {
    assert.match(initSource, /serviceOutcome\.failed\.length === 0[\s\S]{0,200}initialized successfully/);
    assert.match(initSource, /not everything is running/);
  });

  it('judges services by whether they stay up, not by a snapshot', () => {
    // Verified on a real machine: with the console port taken, pm2 reports the
    // service `online` for the first moment and init printed a ✓ for something
    // that then crash looped on EADDRINUSE. Restarts gained over a window is
    // the only answer that is not a guess — the same check component services
    // already use.
    assert.match(initSource, /import \{ readServiceState, judgeSettle \} from '\.\.\/lib\/service\.js';/);
    assert.match(initSource, /const verdict = judgeSettle\(before\.get\(name\), after\);/);
    assert.doesNotMatch(initSource, /if \(status === 'online'\) \{\s*\n\s*console\.log\(`  \$\{success\(bold\(proc\.name\)\)\}`\)/);
  });

  it('settles the port before the Caddyfile and the services are written', () => {
    const settleAt = initSource.indexOf('await settleWebConsolePort({ quiet });\n\n  // Step 8');
    const caddyAt = initSource.indexOf('// Step 10: Caddy web server setup');
    const servicesAt = initSource.indexOf('// Step 11: Start services');
    assert.ok(settleAt > 0, 'the fresh install flow never settles the console port');
    assert.ok(caddyAt > settleAt, 'the Caddyfile is written before the port is known');
    assert.ok(servicesAt > settleAt, 'services start before the port is known');
  });

  it('names one port everywhere instead of five copies of 3456', () => {
    for (const file of ['cli/commands/init.js', 'cli/commands/service.js', 'cli/commands/doctor.js']) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.doesNotMatch(source, /WEB_CONSOLE_PORT \|\| '?3456'?/, `${file} still defaults the port on its own`);
      assert.match(source, /readRecordedConsolePort\(\)/, `${file} does not read the recorded port`);
    }
    const template = fs.readFileSync(path.join(ROOT, 'templates', 'pm2', 'ecosystem.config.cjs'), 'utf8');
    assert.match(template, /WEB_CONSOLE_PORT: readEnvValue\('WEB_CONSOLE_PORT', '3456'\)/);
  });

  it('the Docker entrypoint prints the port the console is actually on', () => {
    // The fifth copy of 3456: everything else read the recorded port while the
    // container's closing "YOS is ready" banner still printed the literal.
    // Docker documents WEB_CONSOLE_PORT, so this could hand out a dead URL.
    const entrypoint = fs.readFileSync(path.join(ROOT, 'docker', 'entrypoint.sh'), 'utf8');
    assert.doesNotMatch(entrypoint, /localhost:3456/, 'the entrypoint still hardcodes the console URL');
    assert.match(entrypoint, /Web console: http:\/\/localhost:\$\(recorded_console_port\)/);
  });
});

describe('the port the Docker entrypoint reports', () => {
  /** Run the entrypoint's own shell function against a fixture .env, for real. */
  function recordedConsolePort(envContent, env = {}) {
    const entrypoint = fs.readFileSync(path.join(ROOT, 'docker', 'entrypoint.sh'), 'utf8');
    const start = entrypoint.indexOf('recorded_console_port() {');
    const fn = entrypoint.slice(start, entrypoint.indexOf('\n}\n', start) + 3);
    assert.ok(start > 0, 'the entrypoint no longer defines recorded_console_port');

    const dir = tmpDir('yos-entrypoint-port-');
    const envFile = path.join(dir, '.env');
    if (envContent !== null) fs.writeFileSync(envFile, envContent);

    const result = spawnSync('bash', ['-c', `set -uo pipefail\nENV_FILE="$1"\n${fn}\nrecorded_console_port`, 'bash', envFile], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, WEB_CONSOLE_PORT: '', ...env },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  }

  it('reports the moved port that init recorded', () => {
    assert.equal(recordedConsolePort('YOS_WEB_PASSWORD=x\nWEB_CONSOLE_PORT=3459\n'), '3459');
  });

  it('prefers the environment over the recorded value, like the CLI does', () => {
    assert.equal(recordedConsolePort('WEB_CONSOLE_PORT=3459\n', { WEB_CONSOLE_PORT: '4000' }), '4000');
  });

  it('falls back to 3456 when nothing recorded a port', () => {
    assert.equal(recordedConsolePort('YOS_WEB_PASSWORD=x\n'), '3456');
    assert.equal(recordedConsolePort(null), '3456');
  });

  it('ignores a junk or out-of-range value instead of printing it', () => {
    assert.equal(recordedConsolePort('WEB_CONSOLE_PORT=not-a-port\n'), '3456');
    assert.equal(recordedConsolePort('WEB_CONSOLE_PORT=99999\n'), '3456');
    assert.equal(recordedConsolePort('WEB_CONSOLE_PORT=0\n'), '3456');
  });
});

describe('deciding whether npm can install without sudo', () => {
  /** Run the installer's own shell function against a path, for real. */
  function prefixInstallable(prefix) {
    const fn = installSh.slice(
      installSh.indexOf('prefix_installable() {'),
      installSh.indexOf('\n}\n', installSh.indexOf('prefix_installable() {')) + 3,
    );
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${fn}\nprefix_installable "$1" && echo yes || echo no`, 'bash', prefix], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim() === 'yes';
  }

  it('says yes for a directory it can write to', () => {
    assert.equal(prefixInstallable(tmpDir('yos-prefix-')), true);
  });

  it('says yes for a directory it is allowed to create', () => {
    // The whole reason this function exists: the installer tells people to
    // switch to ~/.local when sudo is unavailable, and on a fresh account that
    // directory does not exist yet. Testing -w on it answered "no", so our own
    // advice failed on the retry — verified on a real machine before the fix.
    const target = path.join(tmpDir('yos-prefix-'), 'nested', 'local');
    assert.equal(prefixInstallable(target), true);
    assert.equal(fs.existsSync(target), true, 'the prefix should be created, not just approved');
  });

  it('says no for a directory it cannot write to', () => {
    if (process.getuid?.() === 0) return;   // root ignores the permission bits
    const parent = tmpDir('yos-prefix-');
    const locked = path.join(parent, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o500);
    try {
      assert.equal(prefixInstallable(locked), false);
      assert.equal(prefixInstallable(path.join(locked, 'child')), false);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('says no for an empty prefix', () => {
    assert.equal(prefixInstallable(''), false);
  });

  it('is what the install path actually asks', () => {
    assert.match(installSh, /if prefix_installable "\$npm_prefix"; then/);
    assert.doesNotMatch(installSh, /\[ -n "\$npm_prefix" \] && \[ -w "\$npm_prefix" \]/);
  });
});
